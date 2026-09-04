import { describe, expect, it } from 'vitest';
import { ACCOUNT_KINDS, ACCOUNT_KIND_ROWS, sampleAccountCode } from '../src/accounts.ts';
import { CODE_SQL } from './support/sql.ts';

/**
 * Справочник `sdelka.account_kind` — построчное зеркало `ACCOUNT_NATURE`.
 *
 * Природа каждого вида **спрашивается у учёта** (`accountNature`), а не
 * переписывается сюда: копии таблицы в `packages/db` нет. Полнота держится
 * типом (`src/accounts.ts`), значения — этим тестом.
 */
interface SeedRow {
  readonly kind: string;
  readonly values: readonly (string | null)[];
}

function parseSeed(sql: string): readonly SeedRow[] {
  const start = sql.indexOf('INSERT INTO sdelka.account_kind');
  expect(start, 'засев справочника не найден').toBeGreaterThan(-1);
  const end = sql.indexOf(';', start);
  const body = sql.slice(start, end);
  return [...body.matchAll(/\(\s*'([a-z_]+)',([^)]*)\)/gu)].map((match) => {
    const values = (match[2] ?? '')
      .split(',')
      .map((item) => item.trim())
      .map((item) => (item === 'NULL' ? null : item.replace(/^'|'$/gu, '')));
    return { kind: match[1] ?? '', values };
  });
}

describe('справочник видов счёта', () => {
  const seed = parseSeed(CODE_SQL);

  it('перечисляет ровно те же виды и в том же порядке', () => {
    expect(seed.map((row) => row.kind)).toEqual([...ACCOUNT_KINDS]);
  });

  for (const expected of ACCOUNT_KIND_ROWS) {
    it(`${expected.kind} — природа совпадает с ACCOUNT_NATURE`, () => {
      const row = seed.find((item) => item.kind === expected.kind);
      expect(row, expected.kind).toBeDefined();
      expect(row?.values).toEqual([
        expected.acctType,
        expected.funds,
        expected.platformRole,
        expected.fileScope,
        expected.poolDirection,
        String(expected.needsCurrency),
        String(expected.needsClient),
        String(expected.needsTranche),
        String(expected.needsConversion),
      ]);
    });
  }

  it('вычисляемая колонка кода счёта разбирает каждый вид', () => {
    // Выражение `account_code` — единственное место в схеме, где виды счетов
    // перечислены поимённо, и это неизбежно: оно и есть зеркало
    // `accountCode()`. Здесь проверяется полнота перечня, а совпадение самих
    // кодов — интеграционным тестом по каждому виду.
    const generated = CODE_SQL.slice(
      CODE_SQL.indexOf('account_code text GENERATED'),
      CODE_SQL.indexOf(') STORED'),
    );
    for (const kind of ACCOUNT_KINDS) {
      expect(generated, kind).toMatch(new RegExp(`WHEN '${kind}'\\s+THEN`, 'u'));
    }
  });

  it('фиксированные сегменты кода на месте', () => {
    // Без сегментов `free` и `tranche` сделка с идентификатором `free` давала
    // бы код чужого счёта (`FUNCTIONAL.md` §3.1).
    expect(sampleAccountCode('client_free')).toMatch(/:free$/u);
    expect(sampleAccountCode('client_locked')).toContain(':tranche:');
  });
});
