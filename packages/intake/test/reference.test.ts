import { describe, expect, it } from 'vitest';
import {
  type IntakePolicy,
  INTAKE_REASON_KEYS,
  REFERENCE_LENGTH,
  matchReference,
  normalizeReference,
  parseReference,
  paymentReference,
  referenceCheckCharacter,
} from '../src/index';
import { POLICY } from './support/fixtures';

const REFERENCE = paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T1' });

/** Политика с заданным порогом искажения: остальное берётся из предложенной. */
function withDamagedThreshold(valueBp: number): IntakePolicy {
  return Object.freeze({
    ...POLICY,
    matching: Object.freeze({
      ...POLICY.matching,
      damagedReferenceThreshold: Object.freeze({ valueBp, rationaleDocRef: 'docs/product/INTAKE.md' }),
    }),
  });
}

describe('референс уникален по траншу', () => {
  it('разные транши одной сделки дают разные референсы', () => {
    const first = paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T1' });
    const second = paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T2' });
    expect(first).not.toBe(second);
  });

  it('референс детерминирован: одна и та же пара кодов даёт одно значение', () => {
    expect(paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T1' })).toBe(REFERENCE);
  });

  it('значение референса зафиксировано буквально', () => {
    // Референс уходит наружу: он напечатан в инструкции на перевод и живёт в
    // назначении платежа неделями. Смена схемы контрольного знака — а её видно
    // только по значению — обесценивает все выданные ранее референсы разом, и
    // сопоставление по ним перестаёт сходиться. Сверка «сам с собой» этого не
    // ловит: генерация и проверка сдвинутся вместе.
    expect(paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T1' })).toBe('SDD7K2M9Q4T16');
    expect(paymentReference({ dealCode: 'ZZZZZZZZ', trancheCode: '99' })).toBe('SDZZZZZZZZ99Z');
  });

  it('код длиннее поля обрезается с конца, а не с начала', () => {
    // Хвост кода информативнее головы: у последовательных сделок различаются
    // младшие разряды. Срез не с той стороны склеил бы разные сделки в один
    // референс.
    const reference = paymentReference({ dealCode: 'XY' + 'D7K2M9Q4', trancheCode: 'T1' });
    expect(reference).toBe(REFERENCE);
  });

  it('код короче поля дополняется нулями слева', () => {
    expect(parseReference(paymentReference({ dealCode: '7', trancheCode: '1' }))?.parts).toEqual({
      dealCode: '00000007',
      trancheCode: '01',
    });
  });

  it('пустой код отвергается', () => {
    expect(() => paymentReference({ dealCode: '   ', trancheCode: 'T1' })).toThrow();
  });
});

describe('нормализация переживает путь через назначение платежа', () => {
  it('регистр, пробелы и дефисы выбрасываются', () => {
    const raw = ` ${REFERENCE.slice(0, 4)}-${REFERENCE.slice(4)} `.toLowerCase();
    expect(normalizeReference(raw)).toBe(REFERENCE as string);
  });

  it('сопоставление после нормализации даёт точное совпадение', () => {
    const raw = `оплата по договору ${REFERENCE}`;
    expect(matchReference(REFERENCE, raw, POLICY).degree).toBe('exact');
  });
});

describe('контрольный знак', () => {
  it('референс собирается с сошедшимся контрольным знаком', () => {
    const parsed = parseReference(REFERENCE);
    expect(parsed).not.toBeNull();
    expect(parsed?.checksumValid).toBe(true);
    expect(REFERENCE.length).toBe(REFERENCE_LENGTH);
  });

  it('ловит любую одиночную ошибку знака', () => {
    const payload = (REFERENCE as string).slice(0, REFERENCE_LENGTH - 1);
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let checked = 0;
    // Позиции считаются с нуля, включая префикс: контрольный знак обязан
    // зависеть от каждого знака нагрузки. Пропусти первый — и ошибка в нём
    // останется незамеченной, а сама схема этого не покажет.
    for (let position = 0; position < payload.length; position += 1) {
      const original = payload[position];
      for (const replacement of alphabet) {
        if (replacement === original) continue;
        const broken = `${payload.slice(0, position)}${replacement}${payload.slice(position + 1)}`;
        expect(referenceCheckCharacter(broken)).not.toBe(
          (REFERENCE as string).slice(REFERENCE_LENGTH - 1),
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('ловит перестановку соседних различных знаков', () => {
    const payload = (REFERENCE as string).slice(0, REFERENCE_LENGTH - 1);
    let swapsChecked = 0;
    for (let position = 0; position + 1 < payload.length; position += 1) {
      const left = payload[position];
      const right = payload[position + 1];
      if (left === undefined || right === undefined || left === right) continue;
      const swapped = `${payload.slice(0, position)}${right}${left}${payload.slice(position + 2)}`;
      expect(referenceCheckCharacter(swapped)).not.toBe(
        (REFERENCE as string).slice(REFERENCE_LENGTH - 1),
      );
      swapsChecked += 1;
    }
    expect(swapsChecked).toBeGreaterThan(0);
  });
});

describe('искажённый референс не выдаётся за точный', () => {
  it('одна изменённая буква даёт «искажён», а не «совпал»', () => {
    const broken = `${(REFERENCE as string).slice(0, 5)}X${(REFERENCE as string).slice(6)}`;
    const match = matchReference(REFERENCE, broken, POLICY);
    expect(match.degree).toBe('damaged');
    expect(match.checksumValid).toBe(false);
    // Обе причины и в этом порядке: сначала «знак не сошёлся» — это факт о
    // самой строке, — потом «похоже на искажение» — это уже суждение о том,
    // чей референс перед нами. Подмена любой из них меняет то, что оператор
    // будет искать в выписке.
    expect(match.reasons).toEqual([
      INTAKE_REASON_KEYS.referenceChecksumFailed,
      INTAKE_REASON_KEYS.referenceDamaged,
    ]);
  });

  it('искажение с сошедшимся знаком не тянет за собой причину о знаке', () => {
    // Референс соседнего транша той же сделки: собран нами, знак сходится, но
    // это не ожидаемый референс. Сходство выше порога — «искажён»; причина о
    // контрольном знаке здесь была бы неправдой, и оператор пошёл бы искать
    // ошибку переноса там, где её нет.
    const neighbour = paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T2' });
    const match = matchReference(REFERENCE, neighbour, POLICY);
    expect(match.degree).toBe('damaged');
    expect(match.checksumValid).toBe(true);
    expect(match.reasons).toEqual([INTAKE_REASON_KEYS.referenceDamaged]);
  });

  it('точное совпадение: сходство полное, знак сошёлся, причина одна', () => {
    const match = matchReference(REFERENCE, REFERENCE, POLICY);
    expect(match.degree).toBe('exact');
    expect(match.similarityBp).toBe(10_000);
    // Контрольный знак у точного совпадения сошёлся по определению: строка та
    // же самая. Ложь здесь превратила бы законное поступление в кандидата на
    // ручной разбор.
    expect(match.checksumValid).toBe(true);
    expect(match.reasons).toEqual([INTAKE_REASON_KEYS.referenceExact]);
  });

  it('референс чужой сделки не считается искажением своей', () => {
    const foreign = paymentReference({ dealCode: 'ZZZZZZZZ', trancheCode: '99' });
    const match = matchReference(REFERENCE, foreign, POLICY);
    expect(match.degree).toBe('foreign');
    // Знак у чужого референса сошёлся — он собран той же схемой, — поэтому
    // причина о знаке не добавляется.
    expect(match.checksumValid).toBe(true);
    // ⚠️ Чужой референс отчитывается ключом `absent`: отдельного ключа
    // «референс другой сделки» в реестре нет. Тест фиксирует то, что есть
    // сегодня, а не то, что стоило бы показывать оператору, — расхождение
    // вынесено в отчёт по пакету.
    expect(match.reasons).toEqual([INTAKE_REASON_KEYS.referenceAbsent]);
  });

  it('референса нет вовсе', () => {
    for (const raw of [null, '   ']) {
      const match = matchReference(REFERENCE, raw, POLICY);
      expect(match.degree).toBe('absent');
      // Сходства нет — ноль, а не «немного похоже»: вес признака считается от
      // этого числа, и любое ненулевое даёт вес референсу, которого не было.
      expect(match.similarityBp).toBe(0);
      // Знак не сошёлся не потому, что сломан, а потому, что проверять нечего.
      // `true` здесь означало бы «референс проверен и верен» на пустом месте.
      expect(match.checksumValid).toBe(false);
      expect(match.reasons).toEqual([INTAKE_REASON_KEYS.referenceAbsent]);
    }
  });

  it('сходство ровно на пороге читается как искажение, ниже — как чужой', () => {
    // Порог отделяет «прочитали почти правильно» от «это референс другой
    // сделки», и сторона границы у него включающая: равенство порогу — ещё
    // искажение. Ошибка на единицу здесь отправляет свой платёж в чужие.
    const damaged = `${(REFERENCE as string).slice(0, 4)}XYZ${(REFERENCE as string).slice(7)}`;
    const similarityBp = matchReference(REFERENCE, damaged, withDamagedThreshold(0)).similarityBp;
    expect(similarityBp).toBeGreaterThan(0);
    expect(similarityBp).toBeLessThan(10_000);

    expect(matchReference(REFERENCE, damaged, withDamagedThreshold(similarityBp)).degree).toBe(
      'damaged',
    );
    expect(matchReference(REFERENCE, damaged, withDamagedThreshold(similarityBp + 1)).degree).toBe(
      'foreign',
    );
  });
});

describe('разбор', () => {
  it('строка не той длины на референс не похожа', () => {
    expect(parseReference('SD123')).toBeNull();
    // Длиннее ожидаемого — тоже не референс: разбор по фиксированным позициям
    // молча отрезал бы хвост и выдал чужую пару кодов за свою.
    expect(parseReference(`${REFERENCE}0`)).toBeNull();
  });

  it('референс с несошедшимся знаком разбирается, но помечается', () => {
    const broken = `${(REFERENCE as string).slice(0, REFERENCE_LENGTH - 1)}0`;
    const parsed = parseReference(broken);
    expect(parsed).not.toBeNull();
    expect(parsed?.checksumValid).toBe(
      (REFERENCE as string).slice(REFERENCE_LENGTH - 1) === '0',
    );
  });

  it('коды сделки и транша достаются из фиксированных позиций', () => {
    const parsed = parseReference(REFERENCE);
    expect(parsed?.parts.dealCode).toBe('D7K2M9Q4');
    expect(parsed?.parts.trancheCode).toBe('T1');
  });
});
