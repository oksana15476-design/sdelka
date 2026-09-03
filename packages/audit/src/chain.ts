import { AuditError, AuditErrorCode } from './errors';
import { type Sha256Hex, ZERO_HASH } from './hash';
import type { AuditInstant } from './instant';
import {
  type AuditActor,
  type AuditBody,
  type AuditRecord,
  RECORD_FORMAT_VERSION,
  recordDigest,
} from './record';
import { type AuditRef, assertNoRawIdentifiers, auditRef, auditToken } from './values';

/**
 * Цепочка записей.
 *
 * Append-only выражено тем, что в пакете нет ни одной функции, меняющей запись
 * или массив записей: `appendRecord` возвращает **новую** цепочку, а обе —
 * старая и новая — заморожены. Тест `chain.test.ts` перебирает экспорты и
 * проверяет это перебором, а не на глаз.
 *
 * Гранулярность цепочки пакет не навязывает: `chainId` — параметр. Но он входит
 * в хеш каждой записи, поэтому перенос записи из одной цепочки в другую
 * обнаруживается. Выбор «одна цепочка на систему или по цепочке на сделку»
 * остаётся за владельцем вместе с частотой якоря (E7-5).
 */
export interface AuditChain {
  readonly chainId: string;
  readonly records: readonly AuditRecord[];
}

export interface AuditRecordInput {
  readonly recordId: string;
  readonly recordedAt: AuditInstant;
  readonly actor: AuditActor;
  readonly subject: AuditRef;
  readonly related?: readonly AuditRef[];
  readonly body: AuditBody;
}

function sealed(chainId: string, records: readonly AuditRecord[]): AuditChain {
  return Object.freeze({ chainId, records: Object.freeze(records) });
}

function build(
  chainId: string,
  seq: number,
  prevHash: Sha256Hex,
  input: AuditRecordInput,
): AuditRecord {
  const related = Object.freeze([...(input.related ?? [])]);
  // Единственная точка, где проверяется отсутствие сырых идентификаторов.
  // Запись, не прошедшую её, собрать нельзя, а собранную — уже не изменить.
  assertNoRawIdentifiers(
    { actor: input.actor, subject: input.subject, related, body: input.body },
    '$',
  );
  const envelope = {
    version: RECORD_FORMAT_VERSION,
    chainId,
    seq,
    recordId: auditToken(input.recordId),
    prevHash,
    recordedAt: input.recordedAt,
    actor: Object.freeze({ ...input.actor }),
    subject: input.subject,
    related,
    body: Object.freeze({ ...input.body }) as AuditBody,
  };
  return Object.freeze({ ...envelope, recordHash: recordDigest(envelope) });
}

/**
 * Начало цепочки — явная запись `seq: 0` с нулевым предыдущим хешом.
 *
 * Спека начала цепочки не описывает. Без явного генезиса «пустая цепочка» и
 * «цепочка, у которой отрезали начало» неразличимы, а вторая — ровно та порча,
 * которую журнал обязан ловить. Поэтому отсутствие генезиса — отдельный вид
 * разрыва, а не молчаливая целостность (см. `verify.ts`).
 */
export function genesisChain(chainId: string, at: AuditInstant, actor: AuditActor): AuditChain {
  const id = auditToken(chainId);
  const record = build(id, 0, ZERO_HASH, {
    recordId: `${id}:0`,
    recordedAt: at,
    actor,
    subject: auditRef('chain', id),
    body: {
      kind: 'chain_opened',
      chainId: id,
      formatVersion: RECORD_FORMAT_VERSION,
    },
  });
  return sealed(id, [record]);
}

export function chainHead(chain: AuditChain): Sha256Hex | null {
  const last = chain.records[chain.records.length - 1];
  return last === undefined ? null : last.recordHash;
}

export function findRecord(chain: AuditChain, recordId: string): AuditRecord | null {
  return chain.records.find((record) => record.recordId === recordId) ?? null;
}

/**
 * Добавление записи. Возвращает новую цепочку; переданная не меняется.
 *
 * Немонотонное время отвергается **при построении**, а не только при проверке:
 * «запись не правилась задним числом» обязано быть невозможно совершить, а не
 * только заметно постфактум.
 */
export function appendRecord(chain: AuditChain, input: AuditRecordInput): AuditChain {
  const last = chain.records[chain.records.length - 1];
  if (last === undefined) {
    throw new AuditError(AuditErrorCode.chainEmpty, { chainId: chain.chainId });
  }
  if (findRecord(chain, input.recordId) !== null) {
    throw new AuditError(AuditErrorCode.recordIdDuplicate, { recordId: input.recordId });
  }
  if (input.recordedAt < last.recordedAt) {
    throw new AuditError(AuditErrorCode.recordTimeRegression, {
      recordId: input.recordId,
      previousAt: last.recordedAt.toString(),
      recordedAt: input.recordedAt.toString(),
    });
  }
  if (input.body.kind === 'correction') {
    if (input.body.correctsRecordId === input.recordId) {
      throw new AuditError(AuditErrorCode.correctionSelfReference, { recordId: input.recordId });
    }
    if (findRecord(chain, input.body.correctsRecordId) === null) {
      throw new AuditError(AuditErrorCode.correctionTargetMissing, {
        correctsRecordId: input.body.correctsRecordId,
      });
    }
  }
  if (input.body.kind === 'timestamp_token') {
    const covered = findRecord(chain, input.body.coversRecordId);
    // Метка, покрывающая не тот хеш, доказывает не ту запись. Проверяем здесь,
    // потому что после сборки записи это уже неисправимо.
    if (covered === null || covered.recordHash !== input.body.coveredHash) {
      throw new AuditError(AuditErrorCode.timestampTargetMissing, {
        coversRecordId: input.body.coversRecordId,
      });
    }
  }
  const record = build(chain.chainId, last.seq + 1, last.recordHash, input);
  return sealed(chain.chainId, [...chain.records, record]);
}
