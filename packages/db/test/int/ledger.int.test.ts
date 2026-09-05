import { expect, it } from 'vitest';
import { ACCOUNT_KINDS, sampleAccountCode } from '../../src/accounts.ts';
import { dbSuite, errorDetail, errorKey, sqlState, withRollback } from './support/pg.ts';

/**
 * Триггер нулевой суммы, форма счёта и append-only — на живой базе.
 */
const suite = await dbSuite('журнал учёта в базе');

const ENTRY = `INSERT INTO sdelka.ledger_entry (entry_id, occurred_at, kind, memo_key)
               VALUES ($1, '2026-09-03T10:00:00Z', 'settlement', 'ledger.entry.client_top_up')`;

const NOMINAL = `INSERT INTO sdelka.ledger_posting
  (entry_id, ord, account_kind, account_currency, direction, currency, amount_minor,
   attribution_client_key)
  VALUES ($1, $2, 'bank_nominal', $3, $4, $3, $5, 'c1')`;

const CLIENT_FREE = `INSERT INTO sdelka.ledger_posting
  (entry_id, ord, account_kind, client_key, direction, currency, amount_minor,
   attribution_client_key)
  VALUES ($1, $2, 'client_free', 'c1', $3, $4, $5, 'c1')`;

suite.run(suite.title, () => {
  const pool = suite.pool;

  it('сбалансированная запись из двух проводок проходит', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(ENTRY, ['ok-1']);
      await client.query(NOMINAL, ['ok-1', 0, 'GEL', 'debit', '100000']);
      await client.query(CLIENT_FREE, ['ok-1', 1, 'credit', 'GEL', '100000']);
      // Именно здесь отложенные проверки и срабатывают.
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });

  it('несбалансированная запись падает на коммите, а не на вставке', async () => {
    if (pool === null) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(ENTRY, ['bad-1']);
      await client.query(NOMINAL, ['bad-1', 0, 'GEL', 'debit', '100000']);
      // Вставка второй проводки **проходит**: до неё запись не сходится тем
      // более. Отложенность — не оптимизация, а единственный способ разрешить
      // законную запись собираться по строкам.
      await client.query(CLIENT_FREE, ['bad-1', 1, 'credit', 'GEL', '99999']);
      let failed = false;
      try {
        await client.query('COMMIT');
      } catch (error) {
        failed = true;
        expect(errorKey(error)).toBe('ledger.invariant.entry_unbalanced');
      }
      expect(failed, 'нарушение обязано всплыть на COMMIT').toBe(true);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('мультивалютная запись балансируется по каждой валюте отдельно', async () => {
    if (pool === null) return;
    // Сходится «в пересчёте по курсу дня», но не по валютам. Пересчёт зависит
    // от курса, а курс — отдельная проводка (`FUNCTIONAL.md` §3.3).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(ENTRY, ['fx-bad']);
      await client.query(NOMINAL, ['fx-bad', 0, 'GEL', 'debit', '100000']);
      await client.query(CLIENT_FREE, ['fx-bad', 1, 'credit', 'USD', '100000']);
      let failed = false;
      try {
        await client.query('COMMIT');
      } catch (error) {
        failed = true;
        expect(errorKey(error)).toBe('ledger.invariant.entry_unbalanced');
      }
      expect(failed).toBe(true);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('запись из одной проводки — не двойная запись', async () => {
    if (pool === null) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(ENTRY, ['single']);
      await client.query(NOMINAL, ['single', 0, 'GEL', 'debit', '100000']);
      let failed = false;
      try {
        await client.query('COMMIT');
      } catch (error) {
        failed = true;
        expect(errorKey(error)).toBe('ledger.entry.too_few_postings');
      }
      expect(failed).toBe(true);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('форма счёта проверяется сразу, а не на коммите', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(ENTRY, ['shape-1']);
      // Номинальный счёт без валюты: код счёта из такой строки не собрать.
      let failed = false;
      try {
        await client.query(
          `INSERT INTO sdelka.ledger_posting
             (entry_id, ord, account_kind, direction, currency, amount_minor)
           VALUES ('shape-1', 0, 'bank_nominal', 'debit', 'GEL', 1)`,
        );
      } catch (error) {
        failed = true;
        expect(errorKey(error)).toBe('db.posting.account_shape');
      }
      expect(failed).toBe(true);
    });
  });

  it('код счёта в базе совпадает с accountCode() по каждому виду', async () => {
    if (pool === null) return;
    // Вычисляемая колонка — зеркало `accountCode()`. Проверяется по всем видам
    // сразу: перечень видов полон по типу (`src/accounts.ts`), поэтому новый
    // вид счёта без строки в `CASE` уронит этот тест.
    await withRollback(pool, async (client) => {
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(ENTRY, ['codes']);
      let ord = 0;
      for (const kind of ACCOUNT_KINDS) {
        await client.query(
          `INSERT INTO sdelka.ledger_posting
             (entry_id, ord, account_kind, account_currency, client_key,
              account_deal_id, account_tranche_id, conversion_id,
              direction, currency, amount_minor,
              attribution_deal_id, attribution_tranche_id)
           SELECT 'codes', $1, k.kind,
                  CASE WHEN k.needs_currency THEN 'GEL' END,
                  CASE WHEN k.needs_client THEN 'client-sample' END,
                  CASE WHEN k.needs_tranche THEN 'deal-sample' END,
                  CASE WHEN k.needs_tranche THEN 'tranche-sample' END,
                  CASE WHEN k.needs_conversion THEN 'conversion-sample' END,
                  'debit', 'GEL', 1,
                  -- Требование по комиссии живёт только с отнесением к траншу
                  -- (ledger_posting_fee_attributed, 0016): у него нет файла в
                  -- коде счёта, и без отнесения его не видит ни один из трёх
                  -- отчётов по комиссии.
                  CASE WHEN k.kind = 'fee_receivable' THEN 'deal-sample' END,
                  CASE WHEN k.kind = 'fee_receivable' THEN 'tranche-sample' END
             FROM sdelka.account_kind k WHERE k.kind = $2`,
          [ord, kind],
        );
        ord += 1;
      }
      const rows = await client.query<{ account_kind: string; account_code: string }>(
        `SELECT account_kind, account_code FROM sdelka.ledger_posting WHERE entry_id = 'codes'`,
      );
      const actual = new Map(rows.rows.map((row) => [row.account_kind, row.account_code]));
      for (const kind of ACCOUNT_KINDS) {
        expect(actual.get(kind), kind).toBe(sampleAccountCode(kind));
      }
    });
  });

  it('журнал только дополняется: роль приложения не может править и удалять', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(ENTRY, ['append-1']);
      await client.query(NOMINAL, ['append-1', 0, 'GEL', 'debit', '100000']);
      await client.query(CLIENT_FREE, ['append-1', 1, 'credit', 'GEL', '100000']);
      await client.query('SET ROLE sdelka_app');
      for (const statement of [
        `UPDATE sdelka.ledger_entry SET memo_key = 'ledger.entry.overpayment'`,
        `DELETE FROM sdelka.ledger_entry`,
        `UPDATE sdelka.ledger_posting SET amount_minor = 1`,
        `DELETE FROM sdelka.ledger_posting`,
      ]) {
        let failed = false;
        try {
          await client.query(statement);
        } catch (error) {
          failed = true;
          // Именно 42501: отказ по грантам, а не срабатывание триггера. Если
          // тест примет любую ошибку, он останется зелёным на одном триггере, и
          // утверждение «проверяется грантами» станет ложью.
          expect(sqlState(error), statement).toBe('42501');
        }
        expect(failed, statement).toBe(true);
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query('SET ROLE sdelka_app');
      }
    });
  });

  it('журнал не опустошается: TRUNCATE отвергается и у владельца схемы', async () => {
    if (pool === null) return;
    // Второй контур append-only заявлен как ловящий **владельца**, которого
    // гранты не ограничивают. Построчный триггер на `TRUNCATE` не срабатывает
    // — эту операцию видят только операторные (`0019`). Проверять надо именно
    // от имени владельца: у роли приложения `TRUNCATE` отобран грантами, и
    // тест от её имени был бы зелёным при полностью снятом триггере.
    for (const relation of ['ledger_entry', 'ledger_posting']) {
      await withRollback(pool, async (client) => {
        await client.query(ENTRY, ['truncate-1']);
        await client.query(NOMINAL, ['truncate-1', 0, 'GEL', 'debit', '100000']);
        await client.query(CLIENT_FREE, ['truncate-1', 1, 'credit', 'GEL', '100000']);
        // Отложенные события надо разрядить до `TRUNCATE`: пока очередь не
        // пуста, PostgreSQL отвечает своим отказом («pending trigger events»),
        // и тест был бы зелёным при полностью снятом триггере. Эта защита
        // действует только внутри той же транзакции — из следующей журнал
        // опустошается без единого возражения, если операторного триггера нет.
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        await client.query('SET ROLE sdelka_owner');
        let failed = false;
        try {
          await client.query(`TRUNCATE sdelka.${relation} CASCADE`);
        } catch (error) {
          failed = true;
          expect(errorKey(error), relation).toBe('db.ledger.append_only');
          expect(errorDetail(error), relation).toContain('operation=TRUNCATE');
        }
        expect(failed, relation).toBe(true);
      });
    }
  });

  it('владельца схемы от правки журнала держит триггер, а не гранты', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(ENTRY, ['owner-1']);
      await client.query(NOMINAL, ['owner-1', 0, 'GEL', 'debit', '100000']);
      await client.query(CLIENT_FREE, ['owner-1', 1, 'credit', 'GEL', '100000']);
      await client.query('SET LOCAL ROLE sdelka_owner');
      let failed = false;
      try {
        await client.query(`UPDATE sdelka.ledger_entry SET memo_key = 'ledger.entry.overpayment'`);
      } catch (error) {
        failed = true;
        expect(errorKey(error)).toBe('db.ledger.append_only');
      }
      expect(failed, 'второй контур обязан ловить и владельца').toBe(true);
    });
  });
});
