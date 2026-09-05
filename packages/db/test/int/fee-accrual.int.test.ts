import { expect, it } from 'vitest';
import type { PoolClient } from '../../src/pool.ts';
import { dbSuite, errorKey, withRollback } from './support/pg.ts';

/**
 * Идемпотентность начисления комиссии — на живой базе.
 *
 * Правило живёт в коде (`ledger/src/journal.ts`, `assertFeeAccruedOnce`), но до
 * `0016` пары в схеме у него не было ни одной: две записи «Дт fee:receivable /
 * Кт fee:income» по одному траншу принимались, а `v_ledger_invariant_violation`
 * при этом оставалась пуста — доход признан дважды, и не видит этого никто.
 * Роль приложения имеет право `INSERT` в журнал, поэтому запись может лечь мимо
 * `appendEntry`, и здесь проверяется, что тогда её останавливает база — тем же
 * ключом, что и код.
 */
const suite = await dbSuite('одно начисление комиссии на транш');

const ENTRY = `INSERT INTO sdelka.ledger_entry (entry_id, occurred_at, kind, memo_key, corrects_entry_id)
               VALUES ($1, '2026-09-05T10:00:00Z', $2, 'ledger.entry.fee_accrued', $3)`;

const POSTING = `INSERT INTO sdelka.ledger_posting
  (entry_id, ord, account_kind, direction, currency, amount_minor,
   attribution_deal_id, attribution_tranche_id)
  VALUES ($1, $2, $3, $4, 'GEL', $5, $6, $7)`;

const FEE = '50000';

suite.run(suite.title, () => {
  const pool = suite.pool;

  /** Начисление: чистый дебет требования, отнесённый к траншу. */
  async function accrue(
    client: PoolClient,
    entryId: string,
    tranche = 't1',
    amount = FEE,
  ): Promise<void> {
    await client.query(ENTRY, [entryId, 'settlement', null]);
    await client.query(POSTING, [entryId, 0, 'fee_receivable', 'debit', amount, 'A', tranche]);
    await client.query(POSTING, [entryId, 1, 'fee_income', 'credit', amount, 'A', tranche]);
  }

  /** Реверс начисления (`reverseFeeAccrual`): зеркало своей цели. */
  async function reverse(
    client: PoolClient,
    entryId: string,
    target: string,
    tranche = 't1',
  ): Promise<void> {
    await client.query(ENTRY, [entryId, 'correction', target]);
    await client.query(POSTING, [entryId, 0, 'fee_receivable', 'credit', FEE, 'A', tranche]);
    await client.query(POSTING, [entryId, 1, 'fee_income', 'debit', FEE, 'A', tranche]);
  }

  async function expectRefused(client: PoolClient, key: string, hint: string): Promise<void> {
    let failed = false;
    try {
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    } catch (error) {
      failed = true;
      expect(errorKey(error), hint).toBe(key);
    }
    expect(failed, hint).toBe(true);
  }

  it('одно начисление проходит', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await accrue(client, 'fee-ok');
      // Именно здесь отложенные проверки и срабатывают.
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });

  it('второе начисление по тому же траншу отвергается на коммите', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await accrue(client, 'fee-1');
      await accrue(client, 'fee-2');
      await expectRefused(
        client,
        'ledger.journal.fee_accrued_twice',
        '«начислено» — величина транша, а не счётчик вызовов',
      );
    });
  });

  it('другая сумма второго начисления его не спасает', async () => {
    if (pool === null) return;
    // Ключ идемпотентности — пара «сделка, транш», а не сумма: второе
    // начисление «по другому тарифу» это не второй тариф, а расхождение.
    await withRollback(pool, async (client) => {
      await accrue(client, 'fee-a');
      await accrue(client, 'fee-b', 't1', '1');
      await expectRefused(client, 'ledger.journal.fee_accrued_twice', 'сумма ключом не является');
    });
  });

  it('начисление по другому траншу проходит', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await accrue(client, 'fee-t1', 't1');
      await accrue(client, 'fee-t2', 't2');
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });

  it('реверс начисления начислением не считается', async () => {
    if (pool === null) return;
    // §4.4: уход в возвратную ветвь снимает начисление исправлением. Возврат
    // снятого требования структурно неотличим от начисления — тот же дебет
    // `fee:receivable`, — и различает их только цель исправления.
    await withRollback(pool, async (client) => {
      await accrue(client, 'fee-r');
      await reverse(client, 'fee-r-undo', 'fee-r');
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });

  it('после реверса начислить по тому же траншу снова нельзя', async () => {
    if (pool === null) return;
    // Строгость названа в коде: транш не возвращается в `release_pending`
    // после отмены, и послабление здесь обязано быть именным, а не тихим
    // следствием обнулившегося счётчика.
    await withRollback(pool, async (client) => {
      await accrue(client, 'fee-s');
      await reverse(client, 'fee-s-undo', 'fee-s');
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await accrue(client, 'fee-s-again');
      await expectRefused(
        client,
        'ledger.journal.fee_accrued_twice',
        'счётчик обнулился, право начислить — нет',
      );
    });
  });

  it('проводка, дописанная к лежащей записи, тоже проверяется', async () => {
    if (pool === null) return;
    // Журнал дополняется, но не запечатывается: пара проводок, дописанная к
    // старой записи отдельной транзакцией, делает вторым начислением **её**, а
    // не ту, что легла позже. Проверка «только против более ранних» этого не
    // увидела бы.
    await withRollback(pool, async (client) => {
      await client.query(ENTRY, ['fee-old', 'settlement', null]);
      await client.query(POSTING, ['fee-old', 0, 'fee_receivable', 'debit', FEE, 'A', 't9']);
      await client.query(POSTING, ['fee-old', 1, 'fee_income', 'credit', FEE, 'A', 't9']);
      await accrue(client, 'fee-new', 't1');
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(POSTING, ['fee-new', 2, 'fee_receivable', 'debit', FEE, 'A', 't9']);
      await client.query(POSTING, ['fee-new', 3, 'fee_income', 'credit', FEE, 'A', 't9']);
      await expectRefused(client, 'ledger.journal.fee_accrued_twice', 'дописка обязана быть видна');
    });
  });

  it('требование по комиссии без отнесения к траншу не вставляется вовсе', async () => {
    if (pool === null) return;
    // Зеркало `assertFeeAccrualAttributed`. Проверка немедленная, а не
    // отложенная: без отнесения начисление не видит ни один из трёх отчётов по
    // комиссии, то есть правило выше обходится молча.
    await withRollback(pool, async (client) => {
      await client.query(ENTRY, ['fee-bare', 'settlement', null]);
      let failed = false;
      try {
        await client.query(POSTING, ['fee-bare', 0, 'fee_receivable', 'debit', FEE, null, null]);
      } catch (error) {
        failed = true;
        expect(String(error)).toContain('ledger_posting_fee_attributed');
      }
      expect(failed).toBe(true);
    });
  });

  it('доходная нога начисления обязана назвать тот же файл', async () => {
    if (pool === null) return;
    // Вторая половина того же правила: `fee:income` без отнесения в записи, где
    // есть требование, дала бы «не удержано 500» при «начислено 0».
    await withRollback(pool, async (client) => {
      await client.query(ENTRY, ['fee-half', 'settlement', null]);
      await client.query(POSTING, ['fee-half', 0, 'fee_receivable', 'debit', FEE, 'A', 't1']);
      await client.query(POSTING, ['fee-half', 1, 'fee_income', 'credit', FEE, null, null]);
      await expectRefused(
        client,
        'ledger.posting.fee_without_tranche_attribution',
        'доход без файла — начисление, которого не видит отчёт',
      );
    });
  });
});
