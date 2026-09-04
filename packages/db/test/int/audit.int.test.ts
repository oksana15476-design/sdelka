import {
  type AuditBody,
  type AuditChain,
  type AuditRecord,
  ZERO_HASH,
  appendRecord,
  auditActor,
  auditAmount,
  auditFingerprint,
  auditInstant,
  auditRef,
  genesisChain,
  policyRef,
  rawSourceRef,
  recordDigest,
} from '@sdelka/audit';
import { expect, it } from 'vitest';
import type { PoolClient } from '../../src/pool.ts';
import { fromJson, toJson } from './support/audit-json.ts';
import { dbSuite, errorKey, sqlState, withRollback } from './support/pg.ts';

/**
 * Инвариант 21 — **гранты**, и цепочка записей.
 *
 * Главное здесь — `SQLSTATE 42501`. Если тест примет любую ошибку, он останется
 * зелёным на одном триггере, а утверждение `CORE.md` Ф11 «проверяется грантами
 * базы, а не кодом» станет ложью.
 */
const suite = await dbSuite('журнал аудита: цепочка и гранты');

const CHAIN = 'chain-1';
const actor = auditActor('operator-1', 'operator', 'payout.approve');

const evidence = rawSourceRef({
  sourceKind: 'payment_provider_response',
  storageRef: 'documents/psp/2026/09/03/1',
  mediaType: 'application/json',
  byteLength: 512,
  digest: 'b'.repeat(64),
  receivedAt: auditInstant(Date.UTC(2026, 8, 3, 10, 0, 0)),
  provider: 'psp.acme',
});

function orderedBody(): AuditBody {
  return {
    kind: 'payout_ordered',
    idempotencyKey: 'idem.payout.tranche-1',
    // Сумма — `bigint`. Именно она и проверяет round-trip: приведение к `number`
    // здесь запрещено красной линией №4, а поломка хеша была бы тихой.
    amount: auditAmount('GEL', 9_223_372_036_854_775_808n),
    beneficiary: auditFingerprint('account', 'c'.repeat(64)),
    policy: policyRef('payout/2026-01-01.1'),
    evidencePackage: [evidence],
  };
}

function chainOfTwo(): AuditChain {
  const genesis = genesisChain(CHAIN, auditInstant(Date.UTC(2026, 8, 3, 9, 0, 0)), actor);
  return appendRecord(genesis, {
    recordId: `${CHAIN}:1`,
    recordedAt: auditInstant(Date.UTC(2026, 8, 3, 10, 0, 0)),
    actor,
    subject: auditRef('payout', 'pay-1'),
    related: [auditRef('tranche', 't1')],
    body: orderedBody(),
  });
}

const INSERT = `INSERT INTO sdelka.audit_record
  (chain_id, seq, record_id, version, prev_hash, record_hash, recorded_at,
   actor_id, role_id, capability, subject_scope, subject_id, related, kind, body)
  VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7::numeric / 1000),$8,$9,$10,$11,$12,$13,$14,$15)`;

async function insertRecord(
  client: PoolClient,
  record: AuditRecord,
  override: Partial<Record<'seq' | 'prevHash' | 'recordId' | 'recordedAt', unknown>> = {},
): Promise<void> {
  await client.query(INSERT, [
    record.chainId,
    override.seq ?? record.seq,
    override.recordId ?? record.recordId,
    record.version,
    override.prevHash ?? record.prevHash,
    record.recordHash,
    String(override.recordedAt ?? record.recordedAt),
    record.actor.actorId,
    record.actor.roleId,
    record.actor.capability,
    record.subject.scope,
    record.subject.id,
    JSON.stringify(toJson(record.related)),
    record.body.kind,
    JSON.stringify(toJson(record.body)),
  ]);
}

suite.run(suite.title, () => {
  const pool = suite.pool;

  it('роль приложения не может править и удалять журнал: SQLSTATE 42501', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      for (const record of chainOfTwo().records) {
        await insertRecord(client, record);
      }
      await client.query('SET ROLE sdelka_app');
      for (const statement of [
        `UPDATE sdelka.audit_record SET actor_id = 'someone-else'`,
        `DELETE FROM sdelka.audit_record`,
      ]) {
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
        await client.query('SET ROLE sdelka_app');
      }
    });
  });

  it('роль приложения не владелец, не суперпользователь и без BYPASSRLS', async () => {
    if (pool === null) return;
    // Гранты имеют смысл только у роли, которая не может их себе вернуть.
    const roles = await pool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
    }>(`SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = 'sdelka_app'`);
    expect(roles.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
    });

    const owned = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'sdelka'
          AND pg_get_userbyid(c.relowner) <> 'sdelka_owner'`,
    );
    expect(owned.rows).toEqual([]);

    const member = await pool.query<{ ok: boolean }>(
      `SELECT pg_has_role('sdelka_app', 'sdelka_owner', 'MEMBER') AS ok`,
    );
    expect(member.rows[0]?.ok, 'роль приложения не член роли владельца').toBe(false);
  });

  it('владельца схемы от правки журнала держит триггер', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      for (const record of chainOfTwo().records) {
        await insertRecord(client, record);
      }
      let failed = false;
      try {
        await client.query(`UPDATE sdelka.audit_record SET actor_id = 'someone-else'`);
      } catch (error) {
        failed = true;
        expect(errorKey(error)).toBe('db.audit.append_only');
      }
      expect(failed).toBe(true);
    });
  });

  it('цепочка обязана открываться генезисом', async () => {
    if (pool === null) return;
    // Без явного генезиса «пустая цепочка» и «цепочка с отрезанным началом»
    // неразличимы, а вторая — та самая порча, которую журнал обязан ловить.
    await withRollback(pool, async (client) => {
      const records = chainOfTwo().records;
      const second = records[1];
      expect(second).toBeDefined();
      if (second === undefined) return;
      let failed = false;
      try {
        await insertRecord(client, second);
      } catch (error) {
        failed = true;
        expect(errorKey(error)).toBe('db.audit.genesis_required');
      }
      expect(failed).toBe(true);
    });
  });

  it('разрыв нумерации и подмена предыдущего хеша отвергаются', async () => {
    if (pool === null) return;
    const records = chainOfTwo().records;
    const [genesis, second] = records;
    expect(genesis).toBeDefined();
    expect(second).toBeDefined();
    if (genesis === undefined || second === undefined) return;

    await withRollback(pool, async (client) => {
      await insertRecord(client, genesis);
      let failed = false;
      try {
        await insertRecord(client, second, { seq: 5, recordId: `${CHAIN}:5` });
      } catch (error) {
        failed = true;
        expect(errorKey(error)).toBe('db.audit.chain_gap');
      }
      expect(failed).toBe(true);
    });

    await withRollback(pool, async (client) => {
      await insertRecord(client, genesis);
      let failed = false;
      try {
        await insertRecord(client, second, { prevHash: ZERO_HASH });
      } catch (error) {
        failed = true;
        expect(errorKey(error)).toBe('db.audit.prev_hash_mismatch');
      }
      expect(failed).toBe(true);
    });
  });

  it('запись задним числом отвергается', async () => {
    if (pool === null) return;
    const records = chainOfTwo().records;
    const [genesis, second] = records;
    if (genesis === undefined || second === undefined) return;
    await withRollback(pool, async (client) => {
      await insertRecord(client, genesis);
      let failed = false;
      try {
        await insertRecord(client, second, { recordedAt: genesis.recordedAt - 1 });
      } catch (error) {
        failed = true;
        expect(errorKey(error)).toBe('audit.record.time_regression');
      }
      expect(failed).toBe(true);
    });
  });

  it('запись, поднятая из базы, даёт тот же record_hash', async () => {
    if (pool === null) return;
    const records = chainOfTwo().records;
    const second = records[1];
    if (second === undefined) return;

    await withRollback(pool, async (client) => {
      for (const record of records) {
        await insertRecord(client, record);
      }
      const rows = await client.query<{
        chain_id: string;
        seq: string;
        record_id: string;
        version: number;
        prev_hash: string;
        record_hash: string;
        recorded_at: Date;
        actor_id: string;
        role_id: string;
        capability: string | null;
        subject_scope: string;
        subject_id: string;
        related: unknown;
        body: unknown;
      }>(`SELECT * FROM sdelka.audit_record WHERE seq = 1`);
      const row = rows.rows[0];
      expect(row).toBeDefined();
      if (row === undefined) return;

      // Конверт собирается **из колонок**, а не из исходного объекта: иначе
      // проверялось бы равенство значения самому себе.
      const rebuilt = {
        version: row.version,
        chainId: row.chain_id,
        seq: Number(row.seq),
        recordId: row.record_id,
        prevHash: row.prev_hash,
        recordedAt: row.recorded_at.getTime(),
        actor: {
          actorId: row.actor_id,
          roleId: row.role_id,
          capability: row.capability,
        },
        subject: { kind: 'ref', scope: row.subject_scope, id: row.subject_id },
        related: fromJson(row.related),
        body: fromJson(row.body),
      };

      expect(recordDigest(rebuilt as unknown as Parameters<typeof recordDigest>[0])).toBe(
        second.recordHash,
      );
    });
  });
});
