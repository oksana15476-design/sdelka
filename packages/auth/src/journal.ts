import type { Instant } from '@sdelka/domain';
import { AuthError, AuthErrorCode } from './errors';
import type { AuthEventKind, SessionDeniedEvent, SessionEstablishedEvent } from './events';
import type { AccountId, Fingerprint, SessionId } from './ids';
import { type LegacyRoleId, LEGACY_ROLE_MAP } from './legacy';
import type { NonHumanActorId, RoleId } from './roles';
import { NON_HUMAN_ACTORS, ROLE_IDS } from './roles';
import type { PrimaryMethod, SecondFactorKind } from './second-factor';

/**
 * Куда ложатся события этого пакета.
 *
 * `events.ts` объявляет события и прямо оговаривает, чего в нём нет: записи в
 * цепочку. Это остаётся так — зависимости на `@sdelka/audit` в рабочем коде
 * пакета нет и не появляется: журнал обязан пережить переделку аутентификации,
 * а обратная зависимость замкнула бы цикл. Здесь — **карта**, по которой
 * событие превращается в запись, и она устроена так же, как карта ролей в
 * `legacy.ts`: имена чужого перечня записаны литералами, а сверку с настоящим
 * перечнем ведёт `test/journal.test.ts` — тот файл видит оба пакета
 * (`@sdelka/audit` в `devDependencies`).
 *
 * Что даёт эта карта, чего не давало молчание: событие, которому в журнале нет
 * места, названо поимённо, а не теряется. Шесть таких событий сегодня есть, и
 * `unjournaledAuthEventKinds` их перечисляет.
 */
export type AuthAuditRecordKind = 'session_established' | 'session_denied' | 'role_changed';

/**
 * Событие → вид записи журнала. `null` — вида нет, и это факт, а не умолчание.
 *
 * `role_assigned` и `role_revoked` ведут в **одну** запись `role_changed`:
 * прежняя и новая роль стоят в ней рядом. Пара событий описывает ту же смену с
 * двух сторон (`roleChanged` в `events.ts`), запись же обязана читаться сама по
 * себе — иначе восстановление состояния зависит от порядка чтения.
 */
const JOURNAL_TARGETS = {
  session_established: 'session_established',
  session_denied: 'session_denied',
  /**
   * Отзыв сессии, подтверждение второго фактора, дежурство и итог авторизации
   * вида записи не имеют. Подложить их под `session_established` или
   * `decision_made` нельзя: у первого обязателен срок действия сессии, у
   * второго — версия политики и непустой пакет доказательств, и подставлять их
   * ради формы значит врать журналу.
   */
  session_revoked: null,
  second_factor_verified: null,
  duty_started: null,
  duty_ended: null,
  role_assigned: 'role_changed',
  role_revoked: 'role_changed',
  authorization_granted: null,
  authorization_denied: null,
} as const satisfies Record<AuthEventKind, AuthAuditRecordKind | null>;

export const AUTH_EVENT_JOURNAL: Readonly<Record<AuthEventKind, AuthAuditRecordKind | null>> =
  Object.freeze(JOURNAL_TARGETS);

/** Виды событий, которым в журнале места нет. Пусто — все виды покрыты. */
export function unjournaledAuthEventKinds(): readonly AuthEventKind[] {
  return Object.freeze(
    (Object.keys(AUTH_EVENT_JOURNAL) as AuthEventKind[]).filter(
      (kind) => AUTH_EVENT_JOURNAL[kind] === null,
    ),
  );
}

/* ------------------------------------------------------------------------- */
/* Роль в записи журнала                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Роль этого пакета → роль журнала.
 *
 * Обратная сторона `LEGACY_ROLE_MAP`: там сказано, куда переезжает каждое
 * прежнее значение, здесь — каким прежним значением записывается каждое
 * нынешнее. Карта одна, вторая выводится из неё, поэтому разойтись они не могут.
 *
 * ⚠ Отображение **неполно, и это не дефект карты**. `AUDIT_ROLES` — восемь
 * значений; `principal`, `auditor`, `client_counsel`, `compliance_officer` и
 * `oracle_operator` в них не переезжают никуда, а `financial_controller` и
 * `head_of_operations` оба записываются как `approver`. Это расхождение
 * `ACTORS.md` §13 (миграция `sdelka.audit_role` — правка `packages/audit`,
 * `packages/compliance` и `packages/db` одним коммитом). Практическое
 * следствие: **изменение настройки владельцем сегодня записать нечем** — у
 * `principal` нет роли журнала, а актор записи обязателен. Молчания здесь нет:
 * `auditRoleFor` возвращает `null`, `requireAuditRole` бросает, а
 * `rolesWithoutAuditRole` перечисляет пробел поимённо.
 */
function invertLegacyMap(): Readonly<Record<RoleId | NonHumanActorId, LegacyRoleId | null>> {
  const inverted = new Map<string, LegacyRoleId>();
  for (const [legacy, targets] of Object.entries(LEGACY_ROLE_MAP) as [
    LegacyRoleId,
    readonly (RoleId | NonHumanActorId)[],
  ][]) {
    for (const target of targets) {
      // Первое вхождение выигрывает; двух прежних значений на одну нынешнюю
      // роль в карте нет, и `danglingLegacyTargets` следит, чтобы цели
      // существовали.
      if (!inverted.has(target)) inverted.set(target, legacy);
    }
  }
  const out = {} as Record<RoleId | NonHumanActorId, LegacyRoleId | null>;
  for (const role of [...ROLE_IDS, ...NON_HUMAN_ACTORS]) {
    out[role] = inverted.get(role) ?? null;
  }
  return Object.freeze(out);
}

export const AUDIT_ROLE_BY_ROLE: Readonly<Record<RoleId | NonHumanActorId, LegacyRoleId | null>> =
  invertLegacyMap();

/** Роль журнала для роли доступа. `null` — соответствия нет, см. оговорку выше. */
export function auditRoleFor(roleId: RoleId | NonHumanActorId): LegacyRoleId | null {
  return AUDIT_ROLE_BY_ROLE[roleId];
}

/**
 * То же, но отказом.
 *
 * Запись журнала без актора невозможна, поэтому «роли журнала нет» обязано
 * останавливать запись, а не превращаться в подходящую по форме чужую роль:
 * `principal`, записанный как `operator`, — это ложь в вечном журнале.
 */
export function requireAuditRole(roleId: RoleId | NonHumanActorId): LegacyRoleId {
  const mapped = auditRoleFor(roleId);
  if (mapped === null) {
    throw new AuthError(AuthErrorCode.auditRoleUnmapped, { roleId });
  }
  return mapped;
}

/** Роли, которые сегодня нечем записать в журнал. Пусто — расхождение закрыто. */
export function rolesWithoutAuditRole(): readonly (RoleId | NonHumanActorId)[] {
  return Object.freeze(
    [...ROLE_IDS, ...NON_HUMAN_ACTORS].filter((role) => AUDIT_ROLE_BY_ROLE[role] === null),
  );
}

/* ------------------------------------------------------------------------- */
/* Заготовка записи                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Заготовка записи журнала: ровно те поля, которых требует тело записи, и ни
 * одного лишнего.
 *
 * Значения примитивны намеренно. Отпечаток, момент времени и ключ в журнале —
 * размеченные типы `@sdelka/audit`, построить их можно только его же
 * конструкторами (`auditFingerprint`, `auditInstant`, `auditToken`), а они
 * принимают `string`/`number`. Поэтому заготовка собирается здесь, а разметка —
 * на границе, у того, кто пишет в цепочку. Пропущенное поле обнаруживается
 * компилятором в `test/journal.test.ts`, а не в проде на первом входе.
 */
export interface SessionEstablishedJournalEntry {
  readonly recordKind: 'session_established';
  /** Субъект записи: учётная запись (`ref_scope` `account`). */
  readonly subjectAccount: AccountId;
  readonly recordedAt: Instant;
  readonly sessionId: SessionId;
  readonly primaryMethod: PrimaryMethod;
  readonly secondFactor: SecondFactorKind | null;
  readonly expiresAt: Instant;
  readonly device: Fingerprint | null;
  readonly network: Fingerprint | null;
}

export interface SessionDeniedJournalEntry {
  readonly recordKind: 'session_denied';
  readonly subjectAccount: AccountId;
  readonly recordedAt: Instant;
  readonly primaryMethod: PrimaryMethod;
  readonly reasonKey: string;
  /** Обязательны, как и в событии: пустыми они получались молчанием. */
  readonly device: Fingerprint | null;
  readonly network: Fingerprint | null;
}

/**
 * Ключи причин смены роли — закрытый перечень, выводимый из самой смены.
 *
 * Свободной строки здесь нет ни на входе, ни на выходе: причина вычисляется из
 * пары «была роль — стала роль», поэтому вызывающий не может ни выдумать
 * формулировку, ни оставить поле пустым (`CLAUDE.md`, «Три языка»: текст живёт
 * в словарях, в коде — ключи).
 */
export const ROLE_CHANGE_REASON_KEYS = {
  granted: 'access.role.granted',
  reassigned: 'access.role.reassigned',
  revoked: 'access.role.revoked',
} as const;

export type RoleChangeReasonKey =
  (typeof ROLE_CHANGE_REASON_KEYS)[keyof typeof ROLE_CHANGE_REASON_KEYS];

/**
 * Чьим распоряжением сменилась роль.
 *
 * `RoleChangeEvent.orderedBy` допускает `null` — «распоряжение вне системы».
 * В журнале пустым это поле быть не может: смена роли, которую никто не
 * распорядился, и есть тихая раздача доступа. Поэтому внешнее распоряжение
 * выражено отдельной ветвью, и запись по ней требует **документа**
 * (`RoleChangeOrder` в `@sdelka/audit`): приказ или решение владельца прилагает
 * тот, кто пишет в цепочку, — сырых ответов источников этот пакет не держит.
 */
export type RoleChangeOrderRef =
  | { readonly kind: 'ordered_by'; readonly accountId: AccountId; readonly roleId: RoleId }
  | { readonly kind: 'external_order' };

export interface RoleChangeJournalEntry {
  readonly recordKind: 'role_changed';
  readonly subjectAccount: AccountId;
  readonly recordedAt: Instant;
  /** Роли журнала, а не доступа: перечни разные, см. `AUDIT_ROLE_BY_ROLE`. */
  readonly previous: LegacyRoleId | null;
  readonly next: LegacyRoleId | null;
  readonly order: RoleChangeOrderRef;
  readonly reasonKey: RoleChangeReasonKey;
}

export function sessionEstablishedEntry(
  event: SessionEstablishedEvent,
): SessionEstablishedJournalEntry {
  return Object.freeze({
    recordKind: 'session_established' as const,
    subjectAccount: event.actor.accountId,
    recordedAt: event.at,
    sessionId: event.sessionId,
    primaryMethod: event.primaryMethod,
    secondFactor: event.secondFactor,
    expiresAt: event.expiresAt,
    device: event.device,
    network: event.network,
  });
}

export function sessionDeniedEntry(event: SessionDeniedEvent): SessionDeniedJournalEntry {
  return Object.freeze({
    recordKind: 'session_denied' as const,
    subjectAccount: event.actor.accountId,
    recordedAt: event.at,
    primaryMethod: event.primaryMethod,
    reasonKey: event.reason,
    device: event.device,
    network: event.network,
  });
}

/**
 * Заготовка записи о смене роли — **из самой смены, а не из одного события пары**.
 *
 * `roleChanged` возвращает два события: снятие прежней роли и назначение новой.
 * Запись журнала одна, и в ней обе роли, поэтому вход здесь тот же, что у
 * `roleChanged`, а не одно из его событий: собрать запись из половины пары
 * значило бы записать смену без второй её стороны.
 *
 * Смена «из роли в ту же роль» отвергается ещё здесь: сменой она не является, и
 * цепочка такую запись всё равно не примет.
 */
export function roleChangeEntry(input: {
  readonly account: AccountId;
  readonly from: RoleId | null;
  readonly to: RoleId | null;
  readonly order: RoleChangeOrderRef;
  readonly at: Instant;
}): RoleChangeJournalEntry {
  if (input.from === input.to) {
    throw new AuthError(AuthErrorCode.roleChangeIsNoop, { roleId: String(input.to) });
  }
  const previous = input.from === null ? null : requireAuditRole(input.from);
  const next = input.to === null ? null : requireAuditRole(input.to);
  if (previous === next) {
    // Разные роли доступа, одна роль журнала: `financial_controller` и
    // `head_of_operations` обе записываются как `approver`. Записывать это
    // сменой нельзя — в журнале ничего не поменялось бы, и цепочка отвергла бы
    // запись как пустую. Расхождение перечней (`ACTORS.md` §13) обязано быть
    // видно здесь, а не превращаться в тихо потерянную смену роли.
    throw new AuthError(AuthErrorCode.auditRoleUnmapped, {
      from: String(input.from),
      to: String(input.to),
      auditRole: String(next),
    });
  }
  return Object.freeze({
    recordKind: 'role_changed' as const,
    subjectAccount: input.account,
    recordedAt: input.at,
    previous,
    next,
    order: input.order,
    reasonKey:
      input.from === null
        ? ROLE_CHANGE_REASON_KEYS.granted
        : input.to === null
          ? ROLE_CHANGE_REASON_KEYS.revoked
          : ROLE_CHANGE_REASON_KEYS.reassigned,
  });
}
