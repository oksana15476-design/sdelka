import { money } from '@sdelka/money';
import { expect, it } from 'vitest';
import { FLOAT_PARSER_MESSAGE, toBigInt } from '../../src/pool.ts';
import { dbSuite, withRollback } from './support/pg.ts';

/**
 * Денежная точность через драйвер.
 *
 * Красная линия №4 живёт в типах ровно до границы процесса. За ней её держат
 * разборщики `pg` (`src/pool.ts`), и проверяются они здесь: `numeric` и `int8`
 * обязаны приезжать строкой, а не числом, иначе выше 2^53 сумма портится молча.
 */
const suite = await dbSuite('деньги через драйвер');

/** Больше, чем помещается в `int8`: `bigint` базы такую сумму уже не хранит. */
const HUGE = 9_223_372_036_854_775_808n;

suite.run(suite.title, () => {
  const pool = suite.pool;

  it('сумма больше int8 проходит round-trip без потери', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(
        `INSERT INTO sdelka.ledger_entry (entry_id, occurred_at, kind, memo_key)
         VALUES ('huge', '2026-09-03T10:00:00Z', 'settlement', 'ledger.entry.client_top_up')`,
      );
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, account_currency, direction, currency, amount_minor,
            attribution_client_key)
         VALUES ('huge', 0, 'bank_nominal', 'JPY', 'debit', 'JPY', $1, 'c1')`,
        [HUGE.toString()],
      );
      const rows = await client.query<{ amount_minor: unknown }>(
        `SELECT amount_minor FROM sdelka.ledger_posting WHERE entry_id = 'huge'`,
      );
      const raw = rows.rows[0]?.amount_minor;
      // Именно строка: `number` здесь означал бы, что разборщик заменён и
      // точность уже потеряна.
      expect(typeof raw).toBe('string');
      expect(toBigInt(raw)).toBe(HUGE);
      expect(money('JPY', toBigInt(raw)).minor).toBe(HUGE);
    });
  });

  it('int8 тоже приезжает строкой', async () => {
    if (pool === null) return;
    // `seq` записи и `remaining_ms` транша объявлены `bigint`. По умолчанию
    // драйвер отдал бы их строкой, но умолчание — не гарантия: гарантия здесь.
    const rows = await pool.query<{ value: unknown }>(`SELECT 9007199254740993::bigint AS value`);
    const raw = rows.rows[0]?.value;
    expect(typeof raw).toBe('string');
    expect(toBigInt(raw)).toBe(9_007_199_254_740_993n);
  });

  it('плавающая точка из базы не разбирается вовсе', async () => {
    if (pool === null) return;
    // В денежной схеме таких колонок нет по построению (тест дрейфа их
    // запрещает). Если такая колонка когда-нибудь появится, узнать об этом надо
    // здесь, а не в проде.
    let failed = false;
    try {
      await pool.query(`SELECT 1.5::double precision AS value`);
    } catch (error) {
      failed = true;
      expect(error instanceof Error ? error.message : '').toBe(FLOAT_PARSER_MESSAGE);
    }
    expect(failed).toBe(true);
  });

  it('отношение покрытия отдаётся двумя целыми, а не дробью', async () => {
    if (pool === null) return;
    // `CoverageByCurrency.ratio` в TS — `Rational`, а не число: деление здесь
    // не нужно и вредно. Представление отдаёт обе части остатками, из которых
    // отношение и складывается.
    const columns = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'sdelka' AND table_name = 'v_coverage'`,
    );
    for (const column of columns.rows) {
      expect(column.data_type, column.column_name).not.toMatch(/double|real/u);
    }
  });
});
