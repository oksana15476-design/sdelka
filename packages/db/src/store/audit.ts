import {
  type AuditBody,
  type AuditChain,
  type AuditRecord,
  type AuditRef,
  type AuditRoleId,
  type RefScope,
  AuditError,
  AuditErrorCode,
  auditInstant,
  auditRef,
  recordDigest,
  sha256Hex,
  verifyChain,
} from '@sdelka/audit';
import { DbError, DbErrorCode } from '../errors.ts';
import type { PoolClient } from '../pool.ts';
import { fromJson, toJson } from './audit-json.ts';
import { translating } from './errors.ts';
import type { WriteOutcome } from './port.ts';

/**
 * Журнал аудита в базе и обратно.
 *
 * **Что проверяет база и что проверяет код** — разделение взято из
 * `0007_audit.sql` дословно и здесь не пересматривается. База держит сцепку,
 * нумерацию, монотонность времени и append-only; значение хеша она не
 * пересчитывает, потому что для этого нужна вторая реализация `canonical.ts` на
 * PL/pgSQL — ровно тот дрейф двух моделей, который в этом проекте уже случался.
 *
 * Отсюда договор чтения: **круг замыкается хешом**. Запись, поднятая из
 * колонок, немедленно прогоняется через `recordDigest`, и результат сверяется с
 * `record_hash`. Хеш считается по канонической форме всего конверта — версия,
 * цепочка, номер, актор, субъект, связанные, тело, — поэтому совпадение
 * доказывает, что чтение вернуло **ту же запись до последнего поля**, а не
 * похожую. Никакой ручной сверки полей для этого не нужно, и это важно: ручная
 * сверка проверяла бы те поля, которые автор вспомнил.
 */

interface RecordRow {
  readonly chain_id: string;
  readonly seq: number;
  readonly record_id: string;
  readonly version: number;
  readonly prev_hash: string;
  readonly record_hash: string;
  readonly recorded_at: Date;
  readonly actor_id: string;
  readonly role_id: string;
  readonly capability: string | null;
  readonly subject_scope: string;
  readonly subject_id: string;
  readonly related: unknown;
  readonly kind: string;
  readonly body: unknown;
}

function refsOf(value: unknown): readonly AuditRef[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.map((item) => {
      const ref = item as { scope?: unknown; id?: unknown };
      return auditRef(ref.scope as RefScope, String(ref.id));
    }),
  );
}

function recordOfRow(row: RecordRow): AuditRecord {
  const record: AuditRecord = Object.freeze({
    version: row.version,
    chainId: row.chain_id,
    seq: row.seq,
    recordId: row.record_id,
    prevHash: sha256Hex(row.prev_hash),
    // `AuditInstant` — миллисекунды; в базе `timestamptz`. Драйвер отдаёт
    // `Date`, из него берём то же число, которое туда положили.
    recordedAt: auditInstant(row.recorded_at.getTime()),
    actor: Object.freeze({
      actorId: row.actor_id,
      roleId: row.role_id as AuditRoleId,
      capability: row.capability,
    }),
    subject: auditRef(row.subject_scope as RefScope, row.subject_id),
    related: refsOf(fromJson(row.related)),
    // Приведение тела — единственное место, где разбор `jsonb` объявляется
    // доменным значением, и оно **немедленно доказывается** сверкой хеша ниже.
    // Разбирать тело поштучно по одиннадцати видам записей значило бы завести
    // вторую реализацию `record.ts`, которая разойдётся с первой.
    body: fromJson(row.body) as AuditBody,
    recordHash: sha256Hex(row.record_hash),
  });
  if (recordDigest(record) !== record.recordHash) {
    throw new DbError(DbErrorCode.auditRecordHashMismatch, {
      chainId: row.chain_id,
      seq: String(row.seq),
      recordId: row.record_id,
    });
  }
  return record;
}

const INSERT_RECORD = `
  INSERT INTO sdelka.audit_record (
    chain_id, seq, record_id, version, prev_hash, record_hash, recorded_at,
    actor_id, role_id, capability, subject_scope, subject_id, related, kind, body
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb)
  ON CONFLICT (chain_id, seq) DO NOTHING
  RETURNING record_hash`;

const SELECT_HASH = `
  SELECT record_hash FROM sdelka.audit_record WHERE chain_id = $1 AND seq = $2`;

const SELECT_CHAIN = `
  SELECT chain_id, seq, record_id, version, prev_hash, record_hash, recorded_at,
         actor_id, role_id, capability, subject_scope, subject_id, related, kind, body
    FROM sdelka.audit_record
   WHERE chain_id = $1
   ORDER BY seq`;

/**
 * Повтор распознаётся **до** вставки, и это не оптимизация.
 *
 * `assert_audit_chain` — `BEFORE INSERT`-триггер, а Postgres выполняет такие
 * триггеры для каждой строки, предложенной ко вставке, **до** разрешения
 * `ON CONFLICT`. Значит повторная подача уже лежащей записи доходит до триггера
 * с номером, который давно не следующий, и он честно отвечает
 * `db.audit.chain_gap`. Ответ верный по букве и бесполезный по делу: «повтор»
 * и «дыра в нумерации» превращаются в одно сообщение.
 *
 * Поэтому занятость места проверяется запросом, и `ON CONFLICT` ниже остаётся
 * вторым контуром на случай гонки.
 *
 * ⚠ Гонка двух одновременных дописываний в одну цепочку разрешается не здесь, а
 * тем же триггером: он берёт `FOR UPDATE` на последнюю запись, поэтому вставки
 * выстраиваются в очередь, и проигравший получает `db.audit.chain_gap`. Двух
 * записей на одном месте не появляется ни при каком исходе.
 */
async function occupiedBy(client: PoolClient, record: AuditRecord): Promise<string | null> {
  const existing = await client.query<{ record_hash: string }>(SELECT_HASH, [
    record.chainId,
    record.seq,
  ]);
  return existing.rows[0]?.record_hash ?? null;
}

async function appendOne(client: PoolClient, record: AuditRecord): Promise<boolean> {
  const occupied = await occupiedBy(client, record);
  if (occupied !== null) {
    if (occupied === record.recordHash) return false;
    throw new DbError(DbErrorCode.stepConflict, {
      relation: 'audit_record',
      chainId: record.chainId,
      seq: String(record.seq),
    });
  }
  const inserted = await client.query<{ record_hash: string }>(INSERT_RECORD, [
    record.chainId,
    record.seq,
    record.recordId,
    record.version,
    record.prevHash,
    record.recordHash,
    new Date(record.recordedAt).toISOString(),
    record.actor.actorId,
    record.actor.roleId,
    record.actor.capability,
    record.subject.scope,
    record.subject.id,
    JSON.stringify(toJson(record.related)),
    record.body.kind,
    JSON.stringify(toJson(record.body)),
  ]);
  if (inserted.rowCount !== 0) return true;
  // Место занято тем, чего секунду назад не было: гонка. Повтор — это когда
  // занято **той же самой** записью, и сравнивать для этого достаточно хеш: он
  // покрывает весь конверт. Другой хеш на том же месте — подмена звена.
  if ((await occupiedBy(client, record)) === record.recordHash) return false;
  throw new DbError(DbErrorCode.stepConflict, {
    relation: 'audit_record',
    chainId: record.chainId,
    seq: String(record.seq),
  });
}

export async function appendAudit(
  client: PoolClient,
  records: readonly AuditRecord[],
): Promise<WriteOutcome> {
  return translating(async () => {
    let written = 0;
    let repeated = 0;
    for (const record of records) {
      if (await appendOne(client, record)) written += 1;
      else repeated += 1;
    }
    return Object.freeze({ written, repeated });
  });
}

/**
 * Разрыв цепочки на чтении — ошибка **с именем**, а не отчёт.
 *
 * `verifyChain` намеренно не бросает: аудитору нужно досье вместе с отметкой
 * «здесь не сходится». Но здесь другая ситуация: цепочка только что прочитана
 * из хранилища, и если она порвана, то дальше по ней ничего считать нельзя.
 * Каждому виду разрыва соответствует ключ, который уже есть либо у базы
 * (`0007_audit.sql` поднимает те же три при вставке), либо у журнала.
 */
function breakToError(kind: string, chainId: string): Error {
  switch (kind) {
    case 'genesis_missing':
      return new DbError(DbErrorCode.auditGenesisRequired, { chainId });
    case 'seq_gap':
    case 'seq_duplicate':
      return new DbError(DbErrorCode.auditChainGap, { chainId });
    case 'prev_hash_mismatch':
      return new DbError(DbErrorCode.auditPrevHashMismatch, { chainId });
    case 'hash_mismatch':
      return new DbError(DbErrorCode.auditRecordHashMismatch, { chainId });
    case 'chain_id_mismatch':
      return new AuditError(AuditErrorCode.chainIdMismatch, { chainId });
    default:
      return new AuditError(AuditErrorCode.recordTimeRegression, { chainId });
  }
}

export async function readChain(client: PoolClient, chainId: string): Promise<AuditChain> {
  return translating(async () => {
    const result = await client.query<RecordRow>(SELECT_CHAIN, [chainId]);
    const chain: AuditChain = Object.freeze({
      chainId,
      records: Object.freeze(result.rows.map(recordOfRow)),
    });
    const integrity = verifyChain(chain);
    if (!integrity.intact) {
      throw breakToError(integrity.firstBreak.kind, chainId);
    }
    return chain;
  });
}
