import { expect, it } from 'vitest';
import type { PoolClient } from '../../src/pool.ts';
import { dbSuite, errorKey } from './support/pg.ts';

/**
 * «Отрицательный остаток клиентского счёта невозможен» — на живой базе.
 */
const suite = await dbSuite('неотрицательный остаток');

const ENTRY = `INSERT INTO sdelka.ledger_entry (entry_id, occurred_at, kind, memo_key)
               VALUES ($1, $2, 'settlement', 'ledger.entry.client_top_up')`;

const POSTING = `INSERT INTO sdelka.ledger_posting
  (entry_id, ord, account_kind, account_currency, client_key, direction, currency,
   amount_minor, attribution_client_key)
  VALUES ($1, $2, $3, $4, $5, $6, 'GEL', $7, 'c1')`;

suite.run(suite.title, () => {
  const pool = suite.pool;

  /**
   * Ключ нарушения или `null`, если проверки прошли.
   *
   * Проверки принудительно доводятся до немедленных (`SET CONSTRAINTS ALL
   * IMMEDIATE`) **вместо** коммита: отложенный триггер срабатывает в тот же
   * момент, что и на коммите, но база остаётся чистой. Настоящий `COMMIT` здесь
   * оставлял бы за собой строки, а удалить их нельзя — журнал только
   * дополняется, и `DELETE` запрещён и грантами, и триггером. Второй прогон
   * тестов падал бы на дубликате ключа, и чинилось бы это пересозданием базы.
   */
  async function violation(
    body: (client: PoolClient) => Promise<void>,
  ): Promise<string | null> {
    if (pool === null) return null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await body(client);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      return null;
    } catch (error) {
      return errorKey(error);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  it('вывести свободную часть счёта клиента в минус нельзя', async () => {
    if (pool === null) return;
    const failure = await violation(async (client) => {
      await client.query(ENTRY, ['neg-1', '2026-09-03T10:00:00Z']);
      // Дт client:c1:free / Кт bank:nominal — счёт клиента, на котором ничего
      // не было, уходит в минус.
      await client.query(POSTING, ['neg-1', 0, 'client_free', null, 'c1', 'debit', '100000']);
      await client.query(POSTING, ['neg-1', 1, 'bank_nominal', 'GEL', null, 'credit', '100000']);
    });
    expect(failure).toBe('ledger.invariant.negative_client_balance');
  });

  it('тот же минус, закрытый встречной проводкой в той же записи, проходит', async () => {
    if (pool === null) return;
    // Это и есть причина отложенности: внутри записи счёт законно проваливается
    // ниже нуля между проводками. Немедленная проверка запретила бы половину
    // законных записей.
    const failure = await violation(async (client) => {
      await client.query(ENTRY, ['ok-1', '2026-09-03T10:00:00Z']);
      await client.query(POSTING, ['ok-1', 0, 'client_free', null, 'c1', 'debit', '100000']);
      await client.query(POSTING, ['ok-1', 1, 'bank_nominal', 'GEL', null, 'credit', '100000']);
      await client.query(POSTING, ['ok-1', 2, 'bank_nominal', 'GEL', null, 'debit', '100000']);
      await client.query(POSTING, ['ok-1', 3, 'client_free', null, 'c1', 'credit', '100000']);
    });
    expect(failure).toBeNull();
  });

  it('овердрафта по операционному счёту нет', async () => {
    if (pool === null) return;
    // Прямой случай — довнесение недостачи с пустого операционного счёта:
    // дыра в клиентских средствах закрыта обещанием, за которым ничего нет.
    const failure = await violation(async (client) => {
      await client.query(ENTRY, ['bank-1', '2026-09-03T10:00:00Z']);
      await client.query(POSTING, ['bank-1', 0, 'bank_nominal', 'GEL', null, 'debit', '5000']);
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, account_currency, direction, currency, amount_minor)
         VALUES ('bank-1', 1, 'bank_operating', 'GEL', 'credit', 'GEL', 5000)`,
      );
    });
    expect(failure).toBe('ledger.invariant.negative_bank_balance');
  });

  it('удержание комиссии без начисления уводит требование в минус', async () => {
    if (pool === null) return;
    const failure = await violation(async (client) => {
      await client.query(ENTRY, ['fee-1', '2026-09-03T10:00:00Z']);
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, direction, currency, amount_minor,
            attribution_deal_id, attribution_tranche_id)
         VALUES ('fee-1', 0, 'fee_receivable', 'credit', 'GEL', 2000, 'd1', 't1'),
                ('fee-1', 1, 'transit_fee', 'debit', 'GEL', 2000, 'd1', 't1')`,
      );
    });
    // Отдельный код: «банковский счёт в минусе» на требовании по начисленной
    // комиссии было бы ложным сообщением дежурному.
    expect(failure).toBe('ledger.invariant.platform_asset_negative');
  });

  it('отрицательный остаток счёта дохода нарушением не является', async () => {
    if (pool === null) return;
    // Реверс начисления законно уводит доход ниже нуля, а знак
    // `fx:accounting:diff` вообще несёт направление (`FUNCTIONAL.md` §3.1).
    const failure = await violation(async (client) => {
      await client.query(ENTRY, ['inc-1', '2026-09-03T10:00:00Z']);
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, direction, currency, amount_minor,
            attribution_deal_id, attribution_tranche_id)
         VALUES ('inc-1', 0, 'fee_income', 'debit', 'GEL', 2000, 'd1', 't1'),
                ('inc-1', 1, 'fee_receivable', 'credit', 'GEL', 2000, 'd1', 't1')`,
      );
    });
    // Требование тоже уходит в минус — это и есть ожидаемое расхождение; счёт
    // дохода сам по себе молчит.
    expect(failure).toBe('ledger.invariant.platform_asset_negative');
  });
});
