import { AuditError, AuditErrorCode } from './errors';
import { type Sha256Hex, canonicalDigest } from './digest';
import type { AuditInstant } from './instant';
import type { Anchor, TimestampToken } from './ports';
import type { RawSourceRef } from './raw-source';
import type { AuditAmount, AuditAttributes, AuditFingerprint, AuditRef } from './values';

/* ------------------------------------------------------------------------- */
/* Версия политики                                                           */
/* ------------------------------------------------------------------------- */

/**
 * `CORE.md` Ф11 и `FUNCTIONAL.md` инвариант 23: каждое решение хранит версию
 * политики, действовавшую в момент принятия. Здесь это поле обязательного типа —
 * тела решения без него не существует, собрать его не даст компилятор.
 *
 * Формат совместим с `PolicyVersionId` из `compliance/src/decision.ts`
 * (`compliance/2026-09-03.1`), поэтому значение оттуда ложится сюда без
 * преобразования. Домен слева обобщён: тарифы и редакции юридических текстов
 * лягут в тот же формат с другим доменом.
 */
export type PolicyRef = string & { readonly __policyRef: unique symbol };

const POLICY_REF = /^[a-z][a-z0-9_]*\/\d{4}-\d{2}-\d{2}\.\d+$/u;

export function policyRef(value: string): PolicyRef {
  if (!POLICY_REF.test(value)) {
    throw new AuditError(AuditErrorCode.policyRefInvalid, { value });
  }
  return value as PolicyRef;
}

/* ------------------------------------------------------------------------- */
/* Актор                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Роли. Источник истины — `compliance/src/roles.ts` (`RoleId`); дубль вынужден
 * тем, что пакет аудита не зависит от `compliance`. Добавлены две роли, которых
 * там нет и быть не может: `system` — переход по дедлайну и прочее действие без
 * человека, `oracle` — наблюдение из реестра (`STATE-MACHINES.md` §8: событие
 * `condition_established` порождается оракулом, а не оператором).
 *
 * Расхождение перечней молчаливое: сверить их тестом отсюда нельзя, для этого
 * нужен пакет, видящий оба. См. отчёт по задаче.
 */
export const AUDIT_ROLES = [
  'operator',
  'approver',
  'compliance_analyst',
  'support',
  'representative',
  'client',
  'system',
  'oracle',
] as const;
export type AuditRoleId = (typeof AUDIT_ROLES)[number];

export interface AuditActor {
  readonly actorId: string;
  readonly roleId: AuditRoleId;
  /** Полномочие, под которым совершено действие. `null` для `system` и `oracle`. */
  readonly capability: string | null;
}

export function auditActor(
  actorId: string,
  roleId: AuditRoleId,
  capability: string | null = null,
): AuditActor {
  return Object.freeze({ actorId, roleId, capability });
}

/* ------------------------------------------------------------------------- */
/* Виды записей                                                              */
/* ------------------------------------------------------------------------- */

export const AUDIT_RECORD_KINDS = [
  'chain_opened',
  'decision_made',
  'state_transition',
  'condition_act_recorded',
  'evidence_attached',
  'payout_ordered',
  'payout_result',
  'beneficiary_changed',
  'personal_data_viewed',
  'correction',
  'timestamp_token',
  'anchor_published',
] as const;
export type AuditRecordKind = (typeof AUDIT_RECORD_KINDS)[number];

/** Непустой набор. Обязательность «хотя бы одного» выражена типом, не проверкой. */
export type NonEmpty<T> = readonly [T, ...T[]];

export interface ChainOpenedBody {
  readonly kind: 'chain_opened';
  readonly chainId: string;
  readonly formatVersion: number;
}

/**
 * Решение. Ни версии политики, ни доказательств пропустить нельзя: первое —
 * инвариант 23, второе — то, без чего решение не восстанавливается через год.
 */
export interface DecisionMadeBody {
  readonly kind: 'decision_made';
  readonly outcomeKey: string;
  readonly policy: PolicyRef;
  readonly reasonKeys: readonly string[];
  readonly evidence: NonEmpty<RawSourceRef>;
}

export interface StateTransitionBody {
  readonly kind: 'state_transition';
  readonly machine: 'tranche' | 'payout' | 'deal' | 'party_check' | 'oracle_observation';
  readonly from: string;
  readonly to: string;
  readonly eventKey: string;
  readonly failedGuards: readonly string[];
}

/**
 * Тип условия — закрытый перечень внешних фактов (`STATE-MACHINES.md` §8).
 * Строковый тип условия в коде запрещён тем документом прямо; перечень
 * расширяется только его правкой.
 */
export const RELEASE_CONDITION_KINDS = [
  'registration_transfer',
  'registration_preliminary',
  'calendar_date',
] as const;
export type ReleaseConditionKind = (typeof RELEASE_CONDITION_KINDS)[number];

/**
 * Акт получателя об условии (`CORE.md` Ф13). Редакция текста условия хранится
 * как версия политики: «текст условия хранится в версии, действовавшей на
 * момент акта» — иначе через год нечем показать, на что именно согласились.
 */
export interface ConditionActRecordedBody {
  readonly kind: 'condition_act_recorded';
  readonly conditionType: ReleaseConditionKind;
  readonly actorSide: 'recipient' | 'payer';
  readonly act: RawSourceRef;
  readonly policy: PolicyRef;
}

export interface EvidenceAttachedBody {
  readonly kind: 'evidence_attached';
  readonly evidence: RawSourceRef;
}

/**
 * Поручение на выплату. Пакет доказательств — непустой по типу: красная линия
 * №5, «кнопки просто выплатить не существует».
 */
export interface PayoutOrderedBody {
  readonly kind: 'payout_ordered';
  readonly idempotencyKey: string;
  readonly amount: AuditAmount;
  readonly beneficiary: AuditFingerprint;
  readonly policy: PolicyRef;
  readonly evidencePackage: NonEmpty<RawSourceRef>;
}

/**
 * Результат выплаты.
 *
 * `STATE-MACHINES.md` §2: «неизвестно» — легальное состояние, и оно наступает
 * ровно тогда, когда ответа нет. Требовать сырой ответ у `unknown` значит либо
 * запретить легальное состояние, либо заставить адаптер выдумать ответ. Поэтому
 * объединение разделено: у `settled` и `rejected` ответ обязателен типом, у
 * `unknown` он допустимо отсутствует, но обязателен ключ причины.
 */
export type PayoutResultBody =
  | {
      readonly kind: 'payout_result';
      readonly outcome: 'settled' | 'rejected';
      readonly response: RawSourceRef;
      readonly reasonKey: string | null;
    }
  | {
      readonly kind: 'payout_result';
      readonly outcome: 'unknown';
      readonly response: RawSourceRef | null;
      readonly reasonKey: string;
    };

export interface BeneficiaryChangedBody {
  readonly kind: 'beneficiary_changed';
  /** `null` — первичное внесение реквизитов. */
  readonly previous: AuditFingerprint | null;
  readonly next: AuditFingerprint;
  readonly approvedBy: AuditActor;
  readonly policy: PolicyRef;
}

/** `FUNCTIONAL.md` инвариант 24: просмотр документа и персональных данных логируется. */
export interface PersonalDataViewedBody {
  readonly kind: 'personal_data_viewed';
  readonly purposeKey: string;
  readonly fields: readonly string[];
}

/**
 * Исправление. Красная линия №11 и инвариант 22: журнал не редактируется,
 * исправление — только новой записью со ссылкой на предыдущую. Ссылка
 * обязательна типом, существование цели проверяется при добавлении в цепочку.
 */
export interface CorrectionBody {
  readonly kind: 'correction';
  readonly correctsRecordId: string;
  readonly reasonKey: string;
  readonly attributes: AuditAttributes;
}

/**
 * Метка времени независимого поставщика — отдельной записью, а не полем в
 * покрытой записи. Токен приходит асинхронно, а дописать поле в уже
 * запечатанную запись значит её изменить; мутации в пакете нет ни одной.
 */
export interface TimestampTokenBody {
  readonly kind: 'timestamp_token';
  readonly coversRecordId: string;
  readonly coveredHash: Sha256Hex;
  readonly timestamp: TimestampToken;
}

export interface AnchorPublishedBody {
  readonly kind: 'anchor_published';
  readonly anchor: Anchor;
}

export type AuditBody =
  | ChainOpenedBody
  | DecisionMadeBody
  | StateTransitionBody
  | ConditionActRecordedBody
  | EvidenceAttachedBody
  | PayoutOrderedBody
  | PayoutResultBody
  | BeneficiaryChangedBody
  | PersonalDataViewedBody
  | CorrectionBody
  | TimestampTokenBody
  | AnchorPublishedBody;

/* ------------------------------------------------------------------------- */
/* Запись                                                                    */
/* ------------------------------------------------------------------------- */

export const RECORD_FORMAT_VERSION = 1;

/**
 * Запись журнала. Ни одной операции, меняющей её, в пакете нет: всё, что здесь
 * происходит, — построение новой записи. Объект заморожен.
 */
export interface AuditRecord {
  readonly version: number;
  readonly chainId: string;
  readonly seq: number;
  readonly recordId: string;
  readonly prevHash: Sha256Hex;
  readonly recordedAt: AuditInstant;
  readonly actor: AuditActor;
  /** О чём запись. По этому полю восстанавливается досье. */
  readonly subject: AuditRef;
  /** Связанные сущности: транш поручения, сделка транша. */
  readonly related: readonly AuditRef[];
  readonly body: AuditBody;
  readonly recordHash: Sha256Hex;
}

export type AuditRecordEnvelope = Omit<AuditRecord, 'recordHash'>;

/**
 * Хеш записи. Считается по канонической форме всего конверта, включая `chainId`
 * и `seq`: поэтому запись нельзя перенести в другую цепочку или на другое место
 * в этой, не сломав хеш.
 */
export function recordDigest(envelope: AuditRecordEnvelope): Sha256Hex {
  return canonicalDigest({
    version: envelope.version,
    chainId: envelope.chainId,
    seq: envelope.seq,
    recordId: envelope.recordId,
    prevHash: envelope.prevHash,
    recordedAt: envelope.recordedAt,
    actor: envelope.actor,
    subject: envelope.subject,
    related: envelope.related,
    body: envelope.body,
  });
}
