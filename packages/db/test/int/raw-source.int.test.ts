import { auditInstant, captureRawSource } from '@sdelka/audit';
import { expect, it } from 'vitest';
import type { PoolClient } from '../../src/pool.ts';
import { dbSuite, sqlState, withRollback } from './support/pg.ts';

/**
 * «Разобранные поля без исходника суд не убедит» (`CORE.md` Ф11) — на живой базе.
 *
 * Отпечаток сырого ответа в `registry_observation` был обязателен формой: 64
 * знака шестнадцатеричного SHA-256, и ничем больше. Наблюдение с правдоподобным
 * отпечатком, за которым нет ни одного полученного ответа, вставлялось молча.
 * Здесь проверяется вторая половина требования: ссылка обязана ссылаться.
 *
 * Красная линия №5 и `CLAUDE.md`, «инварианты, проверяемые базой»: это внешний
 * ключ, а не проверка в коде приложения.
 */
const suite = await dbSuite('сырой ответ источника: ссылка обязана ссылаться');

const RESPONSE = captureRawSource({
  sourceKind: 'registry_extract',
  storageRef: 'documents/registry/2026/09/04/1',
  mediaType: 'application/json',
  receivedAt: auditInstant(Date.UTC(2026, 8, 4, 10, 0, 0)),
  provider: 'registry',
  bytes: new TextEncoder().encode('{"cadastral":"01.10.14.005.041","registered":true}'),
});

const OBSERVED = '2026-09-04T10:00:00Z';
/** Форма верная, ответа за ним нет — ровно то, что проходило раньше. */
const UNBACKED_DIGEST = 'b'.repeat(64);

async function seed(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO sdelka.party (party_id, account_key) VALUES
       ('p-buyer', 'buyer-1'), ('p-seller', 'seller-1')`,
  );
  await client.query(
    `INSERT INTO sdelka.deal (deal_id, status, buyer_party_id, seller_party_id)
     VALUES ('d1', 'funded', 'p-buyer', 'p-seller')`,
  );
  await client.query(
    `INSERT INTO sdelka.condition_act
       (deal_id, tranche_id, recipient_party_id, agreed_at, condition_text_version, condition_type)
     VALUES ('d1', 't1', 'p-seller', $1, 'condition/2026-01-01.1', 'registration_transfer')`,
    [OBSERVED],
  );
  await client.query(
    `INSERT INTO sdelka.tranche
       (deal_id, tranche_id, status, deadline_at, entered_at, condition_act_agreed_at)
     VALUES ('d1', 't1', 'collecting', '2026-09-20T10:00:00Z', $1, $1)`,
    [OBSERVED],
  );
}

async function recordSource(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO sdelka.raw_source
       (digest, source_kind, storage_ref, media_type, byte_length, received_at, provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      RESPONSE.digest,
      RESPONSE.sourceKind,
      RESPONSE.storageRef,
      RESPONSE.mediaType,
      String(RESPONSE.byteLength),
      OBSERVED,
      RESPONSE.provider,
    ],
  );
}

async function insertObservation(client: PoolClient, digest: string): Promise<void> {
  await client.query(
    `INSERT INTO sdelka.registry_observation
       (observation_id, deal_id, tranche_id, level, condition_type, source_key,
        cadastral_code, field_cadastral_code, field_owner_document_number,
        field_share, field_basis, field_no_unexpected_encumbrances,
        owner_check, observed_at, raw_source_digest)
     VALUES ('o1', 'd1', 't1', 'L3', 'registration_transfer', 'registry.extract',
             '01.10.14.005.041', true, true, true, true, true,
             'established', $1, $2)`,
    [OBSERVED, digest],
  );
}

suite.run(suite.title, () => {
  const pool = suite.pool;

  it('наблюдение с отпечатком, за которым нет ответа: SQLSTATE 23503', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seed(client);
      let failed = false;
      try {
        await insertObservation(client, UNBACKED_DIGEST);
      } catch (error) {
        failed = true;
        // Именно нарушение внешнего ключа. Любая ошибка сгодилась бы и от
        // опечатки в запросе — тогда тест остался бы зелёным без инварианта.
        expect(sqlState(error)).toBe('23503');
        expect(String(error)).toContain('registry_observation_raw_source');
      }
      expect(failed, 'наблюдение без записанного ответа обязано не вставляться').toBe(true);
    });
  });

  it('наблюдение с записанным ответом вставляется', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seed(client);
      await recordSource(client);
      await insertObservation(client, RESPONSE.digest);
      const rows = await client.query<{ raw_source_digest: string }>(
        `SELECT raw_source_digest FROM sdelka.registry_observation WHERE observation_id = 'o1'`,
      );
      expect(rows.rows[0]?.raw_source_digest).toBe(RESPONSE.digest);
    });
  });

  it('карточка заявления без записанного ответа не вставляется', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seed(client);
      let failed = false;
      try {
        await client.query(
          `INSERT INTO sdelka.registry_filing
             (filing_id, deal_id, tranche_id, source, claimed_at, raw_source_digest)
           VALUES ('f1', 'd1', 't1', 'application_card', $1, $2)`,
          [OBSERVED, UNBACKED_DIGEST],
        );
      } catch (error) {
        failed = true;
        expect(sqlState(error)).toBe('23503');
      }
      expect(failed).toBe(true);
    });
  });

  it('слово стороны отпечатка не имеет и внешним ключом не связано', async () => {
    if (pool === null) return;
    // `NULL` внешний ключ не проверяет: «сторона назвала номер» остаётся
    // выразимым состоянием (И3.2), а карточка без ответа — нет.
    await withRollback(pool, async (client) => {
      await seed(client);
      await client.query(
        `INSERT INTO sdelka.registry_filing
           (filing_id, deal_id, tranche_id, source, claimed_at, raw_source_digest)
         VALUES ('f1', 'd1', 't1', 'party_claim', $1, NULL)`,
        [OBSERVED],
      );
    });
  });

  it('роль приложения не может править и удалять записанный ответ: SQLSTATE 42501', async () => {
    if (pool === null) return;
    // Правка ответа задним числом рвала бы связь с наблюдениями, которые на
    // него ссылаются: тот же довод, что у append-only журнала (инвариант 21).
    await withRollback(pool, async (client) => {
      await recordSource(client);
      for (const statement of [
        `UPDATE sdelka.raw_source SET storage_ref = 'documents/elsewhere'`,
        `DELETE FROM sdelka.raw_source`,
      ]) {
        await client.query('SET ROLE sdelka_app');
        let failed = false;
        try {
          await client.query(statement);
        } catch (error) {
          failed = true;
          expect(sqlState(error), statement).toBe('42501');
        }
        expect(failed, statement).toBe(true);
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await recordSource(client);
      }
    });
  });

  it('вид ответа «карточка заявления» база принимает', async () => {
    if (pool === null) return;
    // Иначе карточку пришлось бы записывать платной выпиской — и восстановление
    // истории через год соврало бы об уровне доверия (`ORACLE.md` §2).
    await withRollback(pool, async (client) => {
      await client.query(
        `INSERT INTO sdelka.raw_source
           (digest, source_kind, storage_ref, media_type, byte_length, received_at, provider)
         VALUES ($1, 'application_card', 'documents/registry/card/1', 'application/json',
                 42, $2, 'registry')`,
        ['c'.repeat(64), OBSERVED],
      );
    });
  });
});
