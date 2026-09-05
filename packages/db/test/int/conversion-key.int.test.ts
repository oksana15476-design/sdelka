import { expect, it } from 'vitest';
import type { PoolClient } from '../../src/pool.ts';
import { dbSuite, errorKey, withRollback } from './support/pg.ts';

/**
 * Ключ конверсии называет один обмен — на живой базе.
 *
 * Правило живёт в коде (`ledger/src/journal.ts`,
 * `assertConversionKeyNotReused`), а в базе до `0017` не имело ни одного
 * соответствия. Проба: обмен пройден целиком, позиция схлопнулась — и вторая
 * запись под тем же ключом принимается. Подлежащее `v_fx_position` — код счёта,
 * ключ конверсии входит в код счёта, поэтому два обмена становятся неразличимы
 * в журнале навсегда.
 *
 * Каждый сценарий начинается с законного пути целиком: деньги сперва приходят
 * на номинальный счёт. Иначе первым сработал бы отрицательный остаток
 * клиентского счёта — и тест был бы красным не по той причине, по которой
 * написан.
 */
const suite = await dbSuite('ключ конверсии называет один обмен');

const ENTRY = `INSERT INTO sdelka.ledger_entry (entry_id, occurred_at, kind, memo_key)
               VALUES ($1, '2026-09-05T10:00:00Z', 'settlement', 'ledger.entry.fx_executed')`;

const POSTING = `INSERT INTO sdelka.ledger_posting
  (entry_id, ord, account_kind, account_currency, client_key, conversion_id,
   direction, currency, amount_minor, attribution_client_key)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'c1')`;

const USD = '10000';
const GEL = '26000';
const EUR = '9000';

suite.run(suite.title, () => {
  const pool = suite.pool;

  async function entry(client: PoolClient, id: string): Promise<void> {
    await client.query(ENTRY, [id]);
  }

  async function bank(
    client: PoolClient,
    id: string,
    ord: number,
    direction: string,
    currency: string,
    minor: string,
  ): Promise<void> {
    await client.query(POSTING, [
      id,
      ord,
      'bank_nominal',
      currency,
      null,
      null,
      direction,
      currency,
      minor,
    ]);
  }

  async function free(
    client: PoolClient,
    id: string,
    ord: number,
    direction: string,
    currency: string,
    minor: string,
  ): Promise<void> {
    await client.query(POSTING, [id, ord, 'client_free', null, 'c1', null, direction, currency, minor]);
  }

  async function fx(
    client: PoolClient,
    id: string,
    ord: number,
    key: string,
    direction: string,
    currency: string,
    minor: string,
  ): Promise<void> {
    await client.query(POSTING, [
      id,
      ord,
      'fx_settlement',
      null,
      'c1',
      key,
      direction,
      currency,
      minor,
    ]);
  }

  /** Пополнение счёта клиента (`clientTopUp`). */
  async function topUp(
    client: PoolClient,
    id: string,
    currency: string,
    minor: string,
  ): Promise<void> {
    await entry(client, id);
    await bank(client, id, 0, 'debit', currency, minor);
    await free(client, id, 1, 'credit', currency, minor);
  }

  /** Момент 1: исходная валюта отдана контрагенту (`sendForConversion`). */
  async function send(client: PoolClient, id: string, key: string, minor = USD): Promise<void> {
    await entry(client, id);
    await bank(client, id, 0, 'credit', 'USD', minor);
    await fx(client, id, 1, key, 'debit', 'USD', minor);
  }

  /** Момент 2: обмен исполнен (`executeConversion`). */
  async function execute(client: PoolClient, id: string, key: string): Promise<void> {
    await entry(client, id);
    await free(client, id, 0, 'debit', 'USD', USD);
    await fx(client, id, 1, key, 'credit', 'USD', USD);
    await fx(client, id, 2, key, 'debit', 'GEL', GEL);
    await free(client, id, 3, 'credit', 'GEL', GEL);
  }

  /** Момент 3: встречная валюта поставлена (`receiveConversion`). */
  async function receive(client: PoolClient, id: string, key: string): Promise<void> {
    await entry(client, id);
    await bank(client, id, 0, 'debit', 'GEL', GEL);
    await fx(client, id, 1, key, 'credit', 'GEL', GEL);
  }

  /** Обмен целиком: позиция по ключу схлопнулась. */
  async function fullExchange(client: PoolClient, prefix: string, key: string): Promise<void> {
    await topUp(client, `${prefix}-0`, 'USD', USD);
    await send(client, `${prefix}-1`, key);
    await execute(client, `${prefix}-2`, key);
    await receive(client, `${prefix}-3`, key);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
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

  it('обмен целиком проходит: три момента одного ключа', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await fullExchange(client, 'fx-ok', 'k1');
    });
  });

  it('открытая позиция ложной тревоги не даёт', async () => {
    if (pool === null) return;
    // M1 и M2 без M3 — это «встречная валюта не поставлена», законное
    // состояние. Ловит его возраст позиции, а не ограничение.
    await withRollback(pool, async (client) => {
      await topUp(client, 'fx-open-0', 'USD', USD);
      await send(client, 'fx-open-1', 'k1');
      await execute(client, 'fx-open-2', 'k1');
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });

  it('схлопнувшийся ключ потрачен: второй обмен под ним отвергается', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await fullExchange(client, 'fx-spent', 'k1');
      await topUp(client, 'fx-spent-4', 'USD', USD);
      await send(client, 'fx-spent-5', 'k1');
      await expectRefused(
        client,
        'ledger.journal.conversion_key_reused',
        'обмен закрыт — новому нужен свой ключ',
      );
    });
  });

  it('свой ключ у второго обмена проходит', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await fullExchange(client, 'fx-two', 'k1');
      await topUp(client, 'fx-two-4', 'USD', USD);
      await send(client, 'fx-two-5', 'k2');
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });

  it('третья валюта на счёте обмена отвергается', async () => {
    if (pool === null) return;
    // За всю жизнь счёта обмена на нём бывает ровно пара валют: M1 отдаёт
    // исходную, M2 меняет одну на другую, M3 принимает встречную. Третья — это
    // другой обмен под тем же ключом, и позиции двух обменов сложились бы в
    // одну.
    await withRollback(pool, async (client) => {
      await topUp(client, 'fx-cur-0', 'USD', USD);
      await send(client, 'fx-cur-1', 'k1');
      await execute(client, 'fx-cur-2', 'k1');
      await topUp(client, 'fx-cur-3', 'EUR', EUR);
      await entry(client, 'fx-cur-4');
      await bank(client, 'fx-cur-4', 0, 'credit', 'EUR', EUR);
      await fx(client, 'fx-cur-4', 1, 'k1', 'debit', 'EUR', EUR);
      await expectRefused(
        client,
        'ledger.journal.conversion_key_reused',
        'пара валют у обмена одна',
      );
    });
  });

  it('две конверсии в одной записи отвергаются', async () => {
    if (pool === null) return;
    // `assertConversionDeclared`, правило 2: счёт обмена в записи один. Иначе
    // запись гасит позицию одного обмена ногой другого.
    await withRollback(pool, async (client) => {
      await topUp(client, 'fx-mix-0', 'USD', USD);
      await entry(client, 'fx-mix-1');
      await bank(client, 'fx-mix-1', 0, 'credit', 'USD', USD);
      await fx(client, 'fx-mix-1', 1, 'k1', 'debit', 'USD', '6000');
      await fx(client, 'fx-mix-1', 2, 'k2', 'debit', 'USD', '4000');
      await expectRefused(
        client,
        'ledger.entry.conversion_undeclared',
        'два обмена в одной записи неразличимы',
      );
    });
  });

  it('ключи двух клиентов не сливаются: сверяется код счёта, а не ключ', async () => {
    if (pool === null) return;
    // Владелец входит в код счёта (`fx:settlement:{клиент}:{ключ}`), поэтому
    // одинаково названные обмены двух клиентов — это два разных счёта.
    await withRollback(pool, async (client) => {
      await fullExchange(client, 'fx-own', 'k1');
      await client.query(ENTRY, ['fx-own-4']);
      await client.query(POSTING, [
        'fx-own-4',
        0,
        'bank_nominal',
        'USD',
        null,
        null,
        'debit',
        'USD',
        USD,
      ]);
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, client_key, direction, currency, amount_minor,
            attribution_client_key)
         VALUES ('fx-own-4', 1, 'client_free', 'c2', 'credit', 'USD', $1, 'c2')`,
        [USD],
      );
      await client.query(ENTRY, ['fx-own-5']);
      await client.query(POSTING, [
        'fx-own-5',
        0,
        'bank_nominal',
        'USD',
        null,
        null,
        'credit',
        'USD',
        USD,
      ]);
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, client_key, conversion_id, direction, currency,
            amount_minor, attribution_client_key)
         VALUES ('fx-own-5', 1, 'fx_settlement', 'c2', 'k1', 'debit', 'USD', $1, 'c2')`,
        [USD],
      );
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });
});
