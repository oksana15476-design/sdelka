import { describe, expect, it } from 'vitest';
import { CODE_SQL } from './support/sql.ts';

/**
 * Персональных данных в открытом виде в схеме нет.
 *
 * `compliance/src/pii.ts`: номер документа и личный номер — специальные
 * категории по нашей юрисдикции, и внутрь решений они не попадают вовсе; пакет
 * оперирует **отпечатками**, полученными снаружи с перцем из окружения
 * (красная линия №12). Инвариант 24 требует логировать просмотр персональных
 * данных — логировать нечего, если хранить нечего.
 *
 * Тест смотрит на **имена колонок**, а не на данные: колонку с таким именем
 * заводят раньше, чем начинают в неё писать, и поймать это надо в тот момент.
 */
const FORBIDDEN_COLUMN = [
  'document_number',
  'passport_number',
  'personal_number',
  'iban',
  'account_number',
  'card_number',
  'full_name',
  'first_name',
  'last_name',
  'owner_name',
  'payer_name',
  'birth_date',
  'address_line',
  'phone_number',
  'email',
];

/** Имена колонок: строка вида `  <имя> <тип>` внутри CREATE TABLE. */
function columnNames(sql: string): readonly string[] {
  return [...sql.matchAll(/^\s{2}([a-z][a-z0-9_]*)\s+(?!TABLE|INDEX|VIEW)[a-z]/gmu)].map(
    (item) => item[1] ?? '',
  );
}

describe('в схеме нет места для сырых персональных данных', () => {
  const columns = columnNames(CODE_SQL);

  it('колонки вообще нашлись', () => {
    expect(columns.length).toBeGreaterThan(20);
  });

  for (const forbidden of FORBIDDEN_COLUMN) {
    it(`нет колонки ${forbidden}`, () => {
      // Отпечаток — можно: `payer_name_fingerprint` содержит `payer_name`, но
      // хранит хеш, а не имя. Поэтому сверка по полному имени колонки.
      expect(columns).not.toContain(forbidden);
    });
  }

  /**
   * Исключения — поимённо и с причиной. Список исключений без причин
   * превращается в место, куда дописывают всё подряд.
   */
  const ALLOWED = new Map<string, string>([
    // Булев результат сверки, а не сам номер: сошлось поле выписки или нет
    // (`StatementFields`, CORE.md Ф7). Номера здесь нет и не появится.
    ['field_owner_document_number', 'булев результат сверки поля выписки'],
  ]);

  it('всё, что похоже на документ, имя или реквизит, хранится отпечатком', () => {
    const suspicious = columns.filter(
      (name) =>
        /(^|_)(document|passport|iban|birth|email|phone|address|name)(_|$)/u.test(name) &&
        !name.endsWith('_fingerprint') &&
        !ALLOWED.has(name),
    );
    expect(suspicious).toEqual([]);
  });

  it('отпечаток объявлен ограничением формы, а не просто текстом', () => {
    const fingerprints = [...CODE_SQL.matchAll(/([a-z_]*fingerprint|[a-z_]*digest|[a-z_]*hash)\s+text/gu)]
      .map((item) => item[1] ?? '');
    expect(fingerprints.length).toBeGreaterThan(0);
    for (const column of fingerprints) {
      // Каждая колонка отпечатка обязана нести проверку формы: 64 знака
      // шестнадцатеричного SHA-256. Без неё в неё ляжет что угодно, в том числе
      // сырой номер.
      const pattern = new RegExp(`${column}[^,]*\\^\\[0-9a-f\\]\\{64\\}\\$`, 'u');
      expect(CODE_SQL, column).toMatch(pattern);
    }
  });
});
