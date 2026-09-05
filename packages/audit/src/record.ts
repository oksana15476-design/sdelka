import { AuditError, AuditErrorCode } from './errors';
import { type Sha256Hex, canonicalDigest } from './digest';
import type { AuditInstant } from './instant';
import type { Anchor, TimestampToken } from './ports';
import type { RawSourceRef } from './raw-source';
import type {
  AuditAmount,
  AuditAttributes,
  AuditFingerprint,
  AuditRef,
  AuditSettingValue,
  AuditToken,
} from './values';

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
  /**
   * События безопасности и изменения настроек. Дописаны **в конец**: порядок
   * меток зеркалится в `sdelka.audit_record_kind`, а `ALTER TYPE ... ADD VALUE`
   * умеет только дописывать в конец (см. `application_card` в `raw-source.ts`).
   *
   * До них двенадцать видов описывали деньги, решения и просмотр персональных
   * данных: вход, отказ во входе, смена роли и изменение настройки не
   * описывались ни одним, и `packages/auth` порождал события, которым было
   * некуда лечь (`auth/src/events.ts`). Класть их под `decision_made` нельзя —
   * у того тела обязательны версия политики и непустой пакет доказательств, и
   * подставлять их ради формы значит врать журналу.
   */
  'session_established',
  'session_denied',
  'role_changed',
  'setting_changed',
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
 *
 * **Исправление не подменяет исходную запись.** `correctionsOf` собирает
 * исправления рядом с ней, `effectiveView` отдаёт пару «исходная плюс цепочка
 * исправлений», а `reconstructPayout` считает `result`, `decisions`, `policies`
 * по **исходным** записям и после исправления. То есть это утверждение о
 * записи, а не её новая редакция, и никакой выведенный ответ им не двигается.
 * Из этого следует граница применимости: исправлять можно то, что было
 * **сказано**, а не то, что было **сделано**. Решение человека отменяется новым
 * решением; исход, двигавший деньги, — событием автомата (`reconciliation_
 * resolved`, красная линия №8), а не пометкой на полях.
 *
 * **Основание обязательно типом** — по тому же доводу, по которому оно
 * обязательно у решения (`DecisionMadeBody.evidence`): `CORE.md` Ф11,
 * «разобранные поля без исходника суд не убедит». Исправление без основания —
 * это мнение, дописанное в вечный журнал: через год отличить его от подгонки
 * будет нечем. Служебная записка оператора выразима видом `operator_note`
 * (`RAW_SOURCE_KINDS`), поэтому «основания не бывает» — не случай, а пропуск.
 */
export interface CorrectionBody {
  readonly kind: 'correction';
  readonly correctsRecordId: string;
  /** Почему исправляем — ключ локализации. Пустая строка невыразима: `AUDIT_TOKEN`. */
  readonly reasonKey: string;
  /** На основании чего. Сырой ответ источника, а не пересказ. */
  readonly basis: RawSourceRef;
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

/* ------------------------------------------------------------------------- */
/* События безопасности                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Способ первичного подтверждения входа и вид второго фактора.
 *
 * Дубль `PRIMARY_METHODS` и `SECOND_FACTOR_KINDS` из
 * `auth/src/second-factor.ts` — вынужденный по той же причине, что и
 * `AUDIT_ROLES`: пакет аудита не зависит ни от кого, журнал обязан пережить
 * переделку аутентификации. Молчаливым расхождение не является: сверку ведёт
 * `auth/test/journal.test.ts` — тот пакет видит оба перечня.
 *
 * Значение в журнале осмысленно и через год: `magic_link` у консольной роли —
 * это `ACTORS.md` §11 Р6 B, то есть попытка войти по компрометируемому каналу,
 * а `sms` вторым фактором — подменяемая SIM.
 */
export const AUDIT_PRIMARY_METHODS = ['passkey', 'password', 'federated', 'magic_link'] as const;
export type AuditPrimaryMethod = (typeof AUDIT_PRIMARY_METHODS)[number];

export const AUDIT_SECOND_FACTOR_KINDS = ['webauthn', 'totp', 'push', 'sms', 'email'] as const;
export type AuditSecondFactorKind = (typeof AUDIT_SECOND_FACTOR_KINDS)[number];

/**
 * Отпечатки устройства и сети — **обязательные поля, а не необязательные**.
 *
 * Дословно перенесённое требование `auth/src/events.ts`: умолчание `null`
 * означало «отпечатка нет», и получалось оно молчанием — ровно в записи, ради
 * которой журнал входов и ведётся (`ACTORS.md` §4.1 A2: подбор пароля, вход из
 * чужой сети). `null` остаётся законным ответом, но его надо написать. Журнал
 * не редактируется, дописать поле потом нельзя.
 *
 * Сырых значений тут нет и быть не может: только `AuditFingerprint`
 * (`FINGERPRINT_SUBJECTS`: `device`, `network_address`).
 */
export interface AuditOrigin {
  readonly device: AuditFingerprint | null;
  readonly network: AuditFingerprint | null;
}

/** Вход. Субъект записи — учётная запись (`ref_scope` `account`), см. `chain.ts`. */
export interface SessionEstablishedBody extends AuditOrigin {
  readonly kind: 'session_established';
  readonly sessionId: AuditToken;
  readonly primaryMethod: AuditPrimaryMethod;
  /** `null` — второй фактор при входе не требовался политикой кабинета. */
  readonly secondFactor: AuditSecondFactorKind | null;
  readonly expiresAt: AuditInstant;
}

/**
 * Отказ во входе.
 *
 * Идентификатора сессии здесь нет и не появится: сессии не возникло. Причина —
 * ключ (`AUTH_REASON_KEYS`), а не текст: `CLAUDE.md`, ни одной строки
 * пользовательского текста в коде.
 */
export interface SessionDeniedBody extends AuditOrigin {
  readonly kind: 'session_denied';
  readonly primaryMethod: AuditPrimaryMethod;
  readonly reasonKey: string;
}

/**
 * Чьим распоряжением сменилась роль.
 *
 * Два варианта, и оба обязаны быть названы. `auth/src/events.ts` допускает
 * `orderedBy: null` — «распоряжение вне системы»; в журнале это не может быть
 * пустым полем: смена роли без указания, кто её распорядился, и есть тихая
 * раздача доступа. Поэтому распоряжение извне выражено **ссылкой на документ**:
 * приказ, служебная записка, решение владельца — тот самый сырой ответ, без
 * которого «разобранные поля суд не убедят» (`CORE.md` Ф11).
 */
export type RoleChangeOrder =
  | { readonly kind: 'ordered_by'; readonly actor: AuditActor }
  | { readonly kind: 'external_order'; readonly document: RawSourceRef };

/**
 * Смена роли учётной записи.
 *
 * Одной записью, а не парой «снял — назначил»: пара оставляла момент, в который
 * прежней роли уже нет, а новой ещё нет, и восстановление состояния по журналу
 * зависело от порядка чтения. Здесь прежнее и новое значение стоят рядом, и
 * запись читается сама по себе.
 *
 * Ветви разделены типом: первичное назначение (`previous: null`) и смена или
 * снятие (`previous` — роль). Пары `null → null` не существует, и собрать её
 * нельзя. Совпадение `previous` и `next` отвергается при добавлении в цепочку
 * (`chain.ts`): запись о смене, в которой ничего не сменилось, — ложь.
 *
 * ⚠ Роль здесь — `AuditRoleId`, восемь значений. Перечень `auth` шире
 * (двенадцать плюс два нечеловеческих актора), и `financial_controller` с
 * `head_of_operations` оба отображаются в `approver`, а `principal`, `auditor`,
 * `client_counsel`, `compliance_officer` и `oracle_operator` не отображаются
 * никуда. Это известное расхождение `ACTORS.md` §13 (миграция
 * `sdelka.audit_role`), а не свойство этой записи; сверка — в
 * `auth/src/journal.ts` и `auth/test/journal.test.ts`.
 */
export type RoleChangedBody =
  | {
      readonly kind: 'role_changed';
      /** Первичное назначение: прежней роли не было. */
      readonly previous: null;
      readonly next: AuditRoleId;
      readonly order: RoleChangeOrder;
      readonly reasonKey: string;
    }
  | {
      readonly kind: 'role_changed';
      readonly previous: AuditRoleId;
      /** `null` — роль снята без замены: доступа у записи больше нет. */
      readonly next: AuditRoleId | null;
      readonly order: RoleChangeOrder;
      readonly reasonKey: string;
    };

/**
 * Изменение управляемой настройки: тариф, наценка к курсу, перечень валют,
 * пороги (`BACKLOG.md` E16-4…E16-7, E16-11, E16-12; `FX.md` §7.1).
 *
 * `BACKLOG.md`: «настройка, которую можно поменять без следа и задним числом, —
 * это не настройка, а способ переписать историю денег». Отсюда состав полей, и
 * каждое из них обязательно типом:
 *
 * - **что изменено** — `setting`, ключ настройки (не текст);
 * - **прежнее значение** — `previous`, и `null` в нём невыразим (см.
 *   `AuditSettingValue`); отсутствие прежнего значения — отдельная ветвь
 *   `introduced`;
 * - **новое значение** — `next`;
 * - **кто** — `orderedBy`, распорядившийся. Актор конверта отвечает на другой
 *   вопрос: кто внёс. Совпадение допустимо, но названо, а не подразумевается;
 * - **на каком основании** — `reasonKey` и `policy`: ключ причины и редакция
 *   настройки, которую это изменение вводит (`fx/2026-09-04.1` — формат
 *   `PolicyRef` совпадает с `FxMarkupPolicy.version` из `FX.md` §7.1);
 * - **с какого момента действует** — `effectiveFrom`. Момент раньше момента
 *   записи отвергается при добавлении в цепочку (`chain.ts`): «пересчёт задним
 *   числом невозможен, а не запрещён правилом» (`ROADMAP.md` И16.2).
 */
export type SettingChangedBody =
  | {
      readonly kind: 'setting_changed';
      /** Настройка вводится впервые: прежнего значения нет и подставить его нечем. */
      readonly change: 'introduced';
      /** `never` закрывает лазейку союза: у этой ветви поля нет вовсе. */
      readonly previous?: never;
      readonly setting: AuditToken;
      readonly next: AuditSettingValue;
      readonly orderedBy: AuditActor;
      readonly reasonKey: string;
      readonly policy: PolicyRef;
      readonly effectiveFrom: AuditInstant;
    }
  | {
      readonly kind: 'setting_changed';
      readonly change: 'updated';
      readonly previous: AuditSettingValue;
      readonly setting: AuditToken;
      readonly next: AuditSettingValue;
      readonly orderedBy: AuditActor;
      readonly reasonKey: string;
      readonly policy: PolicyRef;
      readonly effectiveFrom: AuditInstant;
    };

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
  | AnchorPublishedBody
  | SessionEstablishedBody
  | SessionDeniedBody
  | RoleChangedBody
  | SettingChangedBody;

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
