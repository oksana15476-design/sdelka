import { canonicalDigest } from './digest';
import { AuditError, AuditErrorCode } from './errors';
import { type Sha256Hex, ZERO_HASH } from './hash';
import type { AuditInstant } from './instant';
import {
  type AuditActor,
  type AuditBody,
  type AuditRecord,
  RECORD_FORMAT_VERSION,
  assertWritableAuditRole,
  recordDigest,
} from './record';
import type { AuditMinted } from './minted';
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
  /**
   * Чем отчеканены **наши собственные** детерминированные ключи этой записи:
   * ключ идемпотентности выплаты, возврата, вывода (`minted.ts`).
   *
   * Это пропуск на входе, а не поле журнала: в запись заявка не попадает, в
   * канонический вид и хеш — тоже. Иначе правка меняла бы прочтение уже
   * записанного, а журнал не редактируется (красная линия №11).
   *
   * Заявка не «разрешает строку», а доказывает её пересчётом: `auditMinted`
   * значение не принимает, он его вычисляет из схемы и входа. Объявить своим
   * произвольное значение, пришедшее снаружи, этим путём нельзя.
   */
  readonly minted?: readonly AuditMinted[];
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
    input.minted ?? [],
  );
  // Та же дверь и для выведенных из употребления ролей. Тип отсекает их у
  // `auditActor`, но актор доезжает сюда и из хранилища, и из чужого адаптера,
  // где типов нет; а генезис цепочки мимо `checkBodyInvariants` вообще идёт.
  assertWritableAuditRole(input.actor.roleId, 'actor.roleId');
  if (input.body.kind === 'role_changed') {
    if (input.body.previous !== null) {
      assertWritableAuditRole(input.body.previous, 'body.previous');
    }
    if (input.body.next !== null) assertWritableAuditRole(input.body.next, 'body.next');
    if (input.body.order.kind === 'ordered_by') {
      assertWritableAuditRole(input.body.order.actor.roleId, 'body.order.actor.roleId');
    }
  }
  if (input.body.kind === 'beneficiary_changed') {
    assertWritableAuditRole(input.body.approvedBy.roleId, 'body.approvedBy.roleId');
  }
  if (input.body.kind === 'setting_changed') {
    assertWritableAuditRole(input.body.orderedBy.roleId, 'body.orderedBy.roleId');
  }
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
 * Проверки, которые нельзя выразить типом, — на входе в цепочку.
 *
 * Здесь, а не у вызывающего: после сборки запись заморожена и её хеш посчитан,
 * а журнал не редактируется (красная линия №11). Всё, что не отвергнуто до
 * `build`, остаётся в цепочке навсегда — включая ложь.
 *
 * Виды событий безопасности и настроек встроены в ту же дверь, что и остальные:
 * отдельного пути в цепочку у них нет, поэтому сцепка, монотонность времени и
 * запрет сырых идентификаторов действуют на них ровно так же.
 */
function checkBodyInvariants(input: AuditRecordInput): void {
  const body = input.body;
  const scope = input.subject.scope;

  if (
    body.kind === 'session_established' ||
    body.kind === 'session_denied' ||
    body.kind === 'role_changed'
  ) {
    // Субъект события безопасности — учётная запись, и только она. Запись о
    // входе, поданная под сделкой, сделала бы выборку по субъекту ложью, а
    // досье по сделке — засоренным чужими событиями.
    if (scope !== 'account') {
      throw new AuditError(AuditErrorCode.subjectScopeMismatch, {
        kind: body.kind,
        scope,
      });
    }
  }

  if (body.kind === 'role_changed' && body.previous === body.next) {
    // Роль не менялась. Запись о смене, в которой ничего не сменилось, —
    // это либо ошибка вызывающего, либо попытка спрятать настоящую смену
    // среди пустых; отличить их через год будет нечем.
    throw new AuditError(AuditErrorCode.roleChangeIsNoop, { roleId: String(body.next) });
  }

  if (body.kind === 'setting_changed') {
    if (scope !== 'setting') {
      throw new AuditError(AuditErrorCode.subjectScopeMismatch, { kind: body.kind, scope });
    }
    if (input.subject.id !== body.setting) {
      // Изменение настройки A, поданное под настройкой B, — не запись, а
      // подмена: искать её будут по субъекту.
      throw new AuditError(AuditErrorCode.settingSubjectMismatch, {
        setting: body.setting,
        subjectId: input.subject.id,
      });
    }
    if (body.effectiveFrom < input.recordedAt) {
      // `ROADMAP.md` И16.2: «пересчёт задним числом невозможен, а не запрещён
      // правилом». Настройка, введённая в действие раньше собственной записи,
      // — и есть пересчёт задним числом.
      throw new AuditError(AuditErrorCode.settingEffectiveFromBackdated, {
        effectiveFrom: body.effectiveFrom.toString(),
        recordedAt: input.recordedAt.toString(),
      });
    }
    if (
      body.change === 'updated' &&
      canonicalDigest(body.previous) === canonicalDigest(body.next)
    ) {
      // Сравнение по канонической форме, а не по ссылке: `{a:1,b:2}` и
      // `{b:2,a:1}` — одно и то же значение настройки, и запись об их «смене»
      // была бы шумом в журнале, который читают ради денежных решений.
      throw new AuditError(AuditErrorCode.settingChangeIsNoop, { setting: body.setting });
    }
  }
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
  checkBodyInvariants(input);
  const record = build(chain.chainId, last.seq + 1, last.recordHash, input);
  return sealed(chain.chainId, [...chain.records, record]);
}
