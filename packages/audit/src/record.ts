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
 * Роли журнала. Дубль перечня ролей доступа (`auth/src/roles.ts`) вынужден тем,
 * что пакет аудита не зависит ни от кого: журнал обязан пережить переделку
 * доступа. Молчаливым расхождение не является — сверку ведёт
 * `auth/test/legacy.test.ts`, тот пакет видит оба перечня, и значение,
 * появившееся здесь без строки в карте, роняет его.
 *
 * Две метки человеку не принадлежат и в перечне доступа быть не могут:
 * `system` — переход по дедлайну и прочее действие без человека, `oracle` —
 * наблюдение из реестра (`STATE-MACHINES.md` §8: `condition_established`
 * порождается источником, а не оператором).
 *
 * ## Семь меток дописаны в конец (`0023`), и ни одна не переписана
 *
 * До этого перечень был восьмизначным, и пять ролей доступа —
 * `oracle_operator`, `compliance_officer`, `principal`, `auditor`,
 * `client_counsel` — не отображались в него никуда: действие такой роли
 * записать было **нечем** (`ACTORS.md` §13). Практическое следствие было не
 * крайним случаем, а обычным путём: `manage_settings` есть ровно у `principal`,
 * то есть изменение настройки владельцем не записывалось вовсе (E16-12).
 *
 * Порядок меток — зеркало `sdelka.audit_role`, а `ALTER TYPE ... ADD VALUE`
 * умеет только дописывать в конец. Поэтому новые семь стоят после прежних
 * восьми, а не на своих местах по смыслу (та же оговорка у `application_card` в
 * `raw-source.ts` и у видов записей выше).
 */
export const AUDIT_ROLES = [
  'operator',
  /** Прежняя метка обоих уровней утверждения. Читается, не пишется — см. ниже. */
  'approver',
  'compliance_analyst',
  'support',
  'representative',
  'client',
  'system',
  'oracle',
  /* --- Дописаны миграцией `0023`, порядком `ROLE_IDS` из `auth`. --- */
  'oracle_operator',
  'compliance_officer',
  'financial_controller',
  'head_of_operations',
  'principal',
  'auditor',
  'client_counsel',
] as const;
export type AuditRoleId = (typeof AUDIT_ROLES)[number];

/**
 * Метки, которые больше **не пишутся**, но обязаны читаться.
 *
 * `approver` был одной ролью на оба уровня утверждения, а уровня два и они
 * принадлежат разным людям с разными полномочиями (`ACTORS.md` §1 расхождение
 * №5 — класс «дефект», §5.2 — **[решение]**: `financial_controller` даёт
 * уровень 1, `head_of_operations` — уровень 2, ни одна роль не даёт оба).
 * Запись «утвердил approver» не отвечает на вопрос, кто утвердил, — то есть не
 * доказывает «четыре глаза» ровно там, где журнал ради этого и ведётся.
 *
 * Почему метка остаётся в перечне, а не переименовывается: **журнал не
 * редактируется** (красная линия №11). `ALTER TYPE ... RENAME VALUE` переписал
 * бы уже записанные строки — не текст записи, так её прочтение, а прочтение
 * записи задним числом и есть её правка. Прежние записи остаются как есть и
 * читаются как есть; новые пишутся под настоящей ролью.
 *
 * Что из этого следует и не лечится: **какие именно два уровня стоят за старой
 * записью `approver`, восстановить нечем.** Это цена того, что расщепление
 * сделано после первых записей, а не до них; чинить её задним числом
 * запрещено той же красной линией.
 */
export const RETIRED_AUDIT_ROLES = ['approver'] as const;
export type RetiredAuditRoleId = (typeof RETIRED_AUDIT_ROLES)[number];

/** Роль, под которой можно записать **новое** действие. */
export type WritableAuditRoleId = Exclude<AuditRoleId, RetiredAuditRoleId>;

export function isRetiredAuditRole(roleId: string): roleId is RetiredAuditRoleId {
  return (RETIRED_AUDIT_ROLES as readonly string[]).includes(roleId);
}

export interface AuditActor {
  /**
   * Роль **прочитанной** записи: перечень полный, включая выведенные из
   * употребления метки. Иначе запись, сделанную до `0023`, нельзя было бы
   * поднять из хранилища, не солгав о ней.
   */
  readonly actorId: string;
  readonly roleId: AuditRoleId;
  /** Полномочие, под которым совершено действие. `null` для `system` и `oracle`. */
  readonly capability: string | null;
}

/**
 * Актор новой записи. Роль — только та, под которой сегодня пишут.
 *
 * Рубежа два, и второй не лишний: тип отсекает `approver` на сборке, проверка —
 * на границе процесса, где типов нет (роль, приехавшая строкой из хранилища или
 * из чужого адаптера). Ошибка здесь неисправима по построению: запись,
 * прошедшая в цепочку, остаётся в ней навсегда.
 */
export function auditActor(
  actorId: string,
  roleId: WritableAuditRoleId,
  capability: string | null = null,
): AuditActor {
  assertWritableAuditRole(roleId, 'actor');
  return Object.freeze({ actorId, roleId, capability });
}

/** Отказ, а не подстановка похожей роли: `ACTORS.md` §K5, красная линия №11. */
export function assertWritableAuditRole(roleId: string, field: string): void {
  if (isRetiredAuditRole(roleId)) {
    throw new AuditError(AuditErrorCode.auditRoleRetired, { roleId, field });
  }
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

/**
 * Покрытие клиентских средств по одной валюте — **двумя целыми**, а не дробью
 * (красная линия №4). Числа переезжают в запись такими, какими их посчитал
 * учёт: сравнение `custody >= obligations` целочисленное, а отношение нужно
 * только читающему.
 */
export interface CoverageMeasurement {
  readonly currency: string;
  readonly custody: AuditAmount;
  readonly obligations: AuditAmount;
}

/**
 * Переход автомата.
 *
 * Ветвь `intake` — **остановка приёма новых сделок** (красная линия №3,
 * `ACTORS.md` §7.4: «с записью `state_transition` от `system`»). Она отделена
 * от прочих машин не ради разметки, а ради одного обязательного поля: остановка
 * без **чисел покрытия** через год не восстанавливает решение — «приём
 * остановился» без ответа на вопрос «насколько не сошлось» читается как сбой, а
 * не как измерение. У пяти машин сделки таких чисел нет и быть не может,
 * поэтому поле обязательно ровно в той ветви, где оно осмысленно, а не
 * необязательно во всех.
 */
export type StateTransitionBody =
  | {
      readonly kind: 'state_transition';
      readonly machine: 'tranche' | 'payout' | 'deal' | 'party_check' | 'oracle_observation';
      readonly from: string;
      readonly to: string;
      readonly eventKey: string;
      readonly failedGuards: readonly string[];
    }
  | {
      readonly kind: 'state_transition';
      readonly machine: 'intake';
      /** `accepting` или `halted`: третьего состояния у приёма нет. */
      readonly from: 'accepting' | 'halted';
      readonly to: 'accepting' | 'halted';
      readonly eventKey: string;
      /** Коды нарушенных инвариантов учёта. Пусто у стоп-крана, нажатого человеком. */
      readonly failedGuards: readonly string[];
      /** Числа покрытия на момент измерения. Пустым не бывает: измерение было. */
      readonly coverage: readonly CoverageMeasurement[];
    };

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
 * Роль здесь — `WritableAuditRoleId`: **новая** запись о смене роли пишется
 * только под ролью, которая сегодня существует. Прежние записи, где стоит
 * выведенная из употребления метка, читаются как есть — тип прочитанной записи
 * шире типа записываемой, и это разделение проходит через весь пакет
 * (`AuditActor.roleId` против аргумента `auditActor`).
 *
 * Расхождение перечней `ACTORS.md` §13 закрыто миграцией `0023`: каждая роль
 * доступа имеет роль журнала, сверка — в `auth/src/journal.ts` и
 * `auth/test/journal.test.ts`.
 */
export type RoleChangedBody =
  | {
      readonly kind: 'role_changed';
      /** Первичное назначение: прежней роли не было. */
      readonly previous: null;
      readonly next: WritableAuditRoleId;
      readonly order: RoleChangeOrder;
      readonly reasonKey: string;
    }
  | {
      readonly kind: 'role_changed';
      readonly previous: WritableAuditRoleId;
      /** `null` — роль снята без замены: доступа у записи больше нет. */
      readonly next: WritableAuditRoleId | null;
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
