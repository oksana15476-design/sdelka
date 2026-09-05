import {
  ACTIVE_PAYOUT_STATUSES,
  PAYOUT_STATUSES,
  TERMINAL_PAYOUT_STATUSES,
  payoutIdempotencyKey,
  refundIdempotencyKey,
} from '@sdelka/domain';
import { expect, it } from 'vitest';
import type { PoolClient } from '../../src/pool.ts';
import { dbSuite, sqlState, withRollback } from './support/pg.ts';

/**
 * «Не более одной выплаты по траншу в активных статусах» — на живой базе.
 */
const suite = await dbSuite('частичный уникальный индекс выплат');

const KEY = payoutIdempotencyKey('t1');
const REFUND_KEY = refundIdempotencyKey('t1');

async function seed(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO sdelka.party (party_id, account_key) VALUES
       ('p-buyer', 'buyer-1'), ('p-seller', 'seller-1')`,
  );
  await client.query(
    `INSERT INTO sdelka.deal (deal_id, status, buyer_party_id, seller_party_id)
     VALUES ('d1', 'settling', 'p-buyer', 'p-seller')`,
  );
  await client.query(
    `INSERT INTO sdelka.condition_act
       (deal_id, tranche_id, recipient_party_id, agreed_at, condition_text_version, condition_type)
     VALUES ('d1', 't1', 'p-seller', '2026-09-03T10:00:00Z', 'condition/2026-01-01.1',
             'registration_transfer')`,
  );
  await client.query(
    `INSERT INTO sdelka.tranche
       (deal_id, tranche_id, status, deadline_at, entered_at, condition_act_agreed_at)
     VALUES ('d1', 't1', 'paying_out', '2026-09-10T10:00:00Z', '2026-09-03T10:00:00Z',
             '2026-09-03T10:00:00Z')`,
  );
}

/**
 * Нога — обязательное поле строки (`0018`), умолчания у неё нет ни здесь, ни в
 * домене: она выбирается тем, какое обязательство исполняется. Ключ
 * идемпотентности при этом функция **транша и ноги**, а не одного транша.
 */
async function insertPayout(
  client: PoolClient,
  payoutId: string,
  status: string,
  provider: string | null = null,
  leg: 'release' | 'refund' = 'release',
): Promise<void> {
  await client.query(
    `INSERT INTO sdelka.payout
       (payout_id, deal_id, tranche_id, status, leg, idempotency_key, evidence_bundle_id,
        amount_minor, currency, beneficiary_party_id, provider_reference)
     VALUES ($1, 'd1', 't1', $2, $3, $4, 'evidence-1', 100000, 'GEL', 'p-seller', $5)`,
    [payoutId, status, leg, leg === 'refund' ? REFUND_KEY : KEY, provider],
  );
}

suite.run(suite.title, () => {
  const pool = suite.pool;

  for (const status of ACTIVE_PAYOUT_STATUSES) {
    it(`вторая выплата по траншу при статусе ${status} отвергается`, async () => {
      if (pool === null) return;
      await withRollback(pool, async (client) => {
        await seed(client);
        await insertPayout(client, 'pay-1', status);
        let failed = false;
        try {
          await insertPayout(client, 'pay-2', 'created');
        } catch (error) {
          failed = true;
          // 23505 — нарушение уникальности, а не срабатывание триггера.
          expect(sqlState(error)).toBe('23505');
          expect(String(error)).toContain('payout_one_active_per_tranche');
        }
        expect(failed).toBe(true);
      });
    });
  }

  for (const status of PAYOUT_STATUSES.filter(
    (item) => !(ACTIVE_PAYOUT_STATUSES as readonly string[]).includes(item),
  )) {
    it(`после ${status} новая выплата с тем же ключом создаётся`, async () => {
      if (pool === null) return;
      // Ключ идемпотентности — функция транша (`payoutIdempotencyKey`), поэтому
      // повтор несёт **тот же** ключ. Глобальный `UNIQUE` на нём запретил бы
      // задокументированный путь восстановления после `rejected`
      // (`STATE-MACHINES.md` §1.4).
      await withRollback(pool, async (client) => {
        await seed(client);
        await insertPayout(client, 'pay-1', status, 'psp-ref-1');
        await insertPayout(client, 'pay-2', 'created');
        const rows = await client.query<{ idempotency_key: string }>(
          `SELECT idempotency_key FROM sdelka.payout ORDER BY payout_id`,
        );
        expect(rows.rows.map((row) => row.idempotency_key)).toEqual([KEY, KEY]);
      });
    });
  }

  it('выплата без ссылки на пакет доказательств не заводится', async () => {
    if (pool === null) return;
    // Красная линия №5: кнопки «просто выплатить» не существует.
    await withRollback(pool, async (client) => {
      await seed(client);
      let failed = false;
      try {
        await client.query(
          `INSERT INTO sdelka.payout
             (payout_id, deal_id, tranche_id, status, idempotency_key, evidence_bundle_id,
              amount_minor, currency, beneficiary_party_id)
           VALUES ('pay-x', 'd1', 't1', 'created', $1, NULL, 100000, 'GEL', 'p-seller')`,
          [KEY],
        );
      } catch (error) {
        failed = true;
        expect(sqlState(error)).toBe('23502');
      }
      expect(failed).toBe(true);
    });
  });

  for (const status of PAYOUT_STATUSES.filter(
    (item) => !(TERMINAL_PAYOUT_STATUSES as readonly string[]).includes(item),
  )) {
    it(`ссылка на ответ провайдера при статусе ${status} отвергается`, async () => {
      if (pool === null) return;
      // `STATE-MACHINES.md` §2.2: отказ — это явный ответ провайдера, а не
      // отсутствие ответа. Пока ответа нет, ссылаться не на что: ни у
      // `created`, ни у `submitted`, ни у `unknown` ответа нет по определению.
      await withRollback(pool, async (client) => {
        await seed(client);
        let failed = false;
        try {
          await insertPayout(client, 'pay-u', status, 'psp-ref-1');
        } catch (error) {
          failed = true;
          expect(sqlState(error)).toBe('23514');
          expect(String(error)).toContain('payout_response_only_when_answered');
        }
        expect(failed, `${status} со ссылкой на ответ обязан отвергаться`).toBe(true);
      });
    });
  }

  it('сеть отвалилась: перевод отправленного поручения в «неизвестно» записывается', async () => {
    if (pool === null) return;
    // Красная линия №8: «неизвестно» — легальное состояние. До `0018` строка
    // `submitted` **со ссылкой на ответ** принималась, а `UPDATE` её в
    // `unknown` падал: обязательный по §2.2 переход становился незаписываемым,
    // и записать его можно было, только стерев след. Теперь ссылка не ложится
    // на `submitted` вовсе, и переход всегда выразим.
    await withRollback(pool, async (client) => {
      await seed(client);
      await insertPayout(client, 'pay-n', 'submitted');
      await client.query(`UPDATE sdelka.payout SET status = 'unknown' WHERE payout_id = 'pay-n'`);
      const rows = await client.query<{ status: string; provider_reference: string | null }>(
        `SELECT status, provider_reference FROM sdelka.payout WHERE payout_id = 'pay-n'`,
      );
      expect(rows.rows[0]).toEqual({ status: 'unknown', provider_reference: null });
    });
  });

  it('сверка закрывает «неизвестно» без ответа провайдера', async () => {
    if (pool === null) return;
    // `unknown --reconciliation_found_in_statement--> settled`: основание —
    // выписка, а не ответ провайдера. Ограничение, требующее ссылку у
    // терминального статуса, сделало бы этот путь незаписываемым, поэтому
    // ссылка **возможна**, но не обязательна нигде.
    await withRollback(pool, async (client) => {
      await seed(client);
      await insertPayout(client, 'pay-r', 'unknown');
      await client.query(`UPDATE sdelka.payout SET status = 'settled' WHERE payout_id = 'pay-r'`);
      const rows = await client.query<{ status: string }>(
        `SELECT status FROM sdelka.payout WHERE payout_id = 'pay-r'`,
      );
      expect(rows.rows[0]?.status).toBe('settled');
    });
  });

  it('нога перевода обязательна: умолчания у неё нет', async () => {
    if (pool === null) return;
    // Домен отказывается выбирать ногу умолчанием (`createPayout` и
    // `createRefundPayout` — две функции, а не аргумент со значением по
    // умолчанию). База отказывается ровно так же.
    await withRollback(pool, async (client) => {
      await seed(client);
      let failed = false;
      try {
        await client.query(
          `INSERT INTO sdelka.payout
             (payout_id, deal_id, tranche_id, status, idempotency_key, evidence_bundle_id,
              amount_minor, currency, beneficiary_party_id)
           VALUES ('pay-l', 'd1', 't1', 'created', $1, 'evidence-1', 100000, 'GEL', 'p-seller')`,
          [KEY],
        );
      } catch (error) {
        failed = true;
        expect(sqlState(error)).toBe('23502');
      }
      expect(failed).toBe(true);
    });
  });

  it('вторая нога наружу по тем же деньгам отвергается, пока первая активна', async () => {
    if (pool === null) return;
    // Инвариант 9 ногу не различает, и домен тоже: `activePayoutsForTranche`
    // считает выплаты по траншу целиком. Возврат покупателю, выпущенный, пока
    // расчёт продавцу стоит в `unknown`, — это двойная выплата по тем же
    // запертым деньгам, как бы ни назывались обе ноги.
    await withRollback(pool, async (client) => {
      await seed(client);
      await insertPayout(client, 'pay-release', 'unknown');
      let failed = false;
      try {
        await insertPayout(client, 'pay-refund', 'created', null, 'refund');
      } catch (error) {
        failed = true;
        expect(sqlState(error)).toBe('23505');
        expect(String(error)).toContain('payout_one_active_per_tranche');
      }
      expect(failed).toBe(true);
    });
  });

  it('после отклонённого расчёта возврат выпускается со своим ключом', async () => {
    if (pool === null) return;
    // `rejected` терминален, активной выплаты по траншу нет — возврат законен.
    // Ключ у него **другой**: банк гасит по ключу, и поручение на возврат с
    // ключом отклонённого расчёта он вправе счесть повтором уже обработанного.
    await withRollback(pool, async (client) => {
      await seed(client);
      await insertPayout(client, 'pay-release', 'rejected', 'psp-ref-1');
      await insertPayout(client, 'pay-refund', 'created', null, 'refund');
      const rows = await client.query<{ leg: string; idempotency_key: string }>(
        `SELECT leg, idempotency_key FROM sdelka.payout ORDER BY payout_id`,
      );
      expect(rows.rows).toEqual([
        { leg: 'refund', idempotency_key: REFUND_KEY },
        { leg: 'release', idempotency_key: KEY },
      ]);
      expect(REFUND_KEY).not.toBe(KEY);
    });
  });

  it('второй незавершённый вывод по счёту клиента отвергается', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seed(client);
      const insert = `INSERT INTO sdelka.withdrawal
        (withdrawal_id, party_id, status, idempotency_key, amount_minor, currency,
         source_account_fingerprint)
        VALUES ($1, 'p-buyer', $2, $3, 100000, 'GEL', $4)`;
      const fingerprint = 'a'.repeat(64);
      await client.query(insert, ['w1', 'requested', KEY, fingerprint]);
      let failed = false;
      try {
        await client.query(insert, ['w2', 'requested', KEY, fingerprint]);
      } catch (error) {
        failed = true;
        expect(sqlState(error)).toBe('23505');
        expect(String(error)).toContain('withdrawal_one_active_per_party');
      }
      expect(failed).toBe(true);
    });
  });
});
