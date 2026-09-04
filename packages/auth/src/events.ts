import type { Instant } from '@sdelka/domain';
import type { Capability } from './capabilities';
import type { Grant, Denial } from './decide';
import type { AuthReasonKey } from './keys';
import type { AccountId, Fingerprint, PersonId, SessionId } from './ids';
import type { RoleId } from './roles';
import type { PrimaryMethod, SecondFactorKind } from './second-factor';
import type { Session } from './session';

/**
 * Журнал входов и смен роли — событиями для аудита.
 *
 * Что здесь есть: типы событий и чистые построители. Чего нет и не будет: записи
 * в цепочку. Цепочка, хеши, метки времени и якорь живут в `packages/audit`, и
 * зависеть от неё этому пакету незачем — событие это значение, а кто и куда его
 * положит, решает вызывающий.
 *
 * ⚠ **`AUDIT_RECORD_KINDS` в `packages/audit` этих видов не содержит.**
 * Двенадцать видов записей там описывают деньги, решения и просмотр
 * персональных данных; вход, отказ во входе и смена роли не описаны ни одним.
 * Класть их под `decision_made` нельзя: у того тела обязательны версия политики
 * и непустой пакет доказательств, и подставлять их ради формы значит врать
 * журналу. Пакет аудита — не наш; правка названа в отчёте.
 *
 * Персональных данных здесь нет ни в одном поле: идентификаторы непрозрачны
 * (`ids.ts`), устройство и сеть — отпечатки. Журнал не редактируется никем
 * (красная линия №11), поэтому попавшее в него не убрать — проверять состав
 * надо на входе, а не на выходе.
 */
export const AUTH_EVENT_KINDS = [
  'session_established',
  'session_denied',
  'session_revoked',
  'second_factor_verified',
  'duty_started',
  'duty_ended',
  'role_assigned',
  'role_revoked',
  'authorization_granted',
  'authorization_denied',
] as const;

export type AuthEventKind = (typeof AUTH_EVENT_KINDS)[number];

export interface AuthEventActor {
  readonly accountId: AccountId;
  readonly personId: PersonId;
  /** `null` там, где роль ещё не установлена: отказ во входе до её разбора. */
  readonly roleId: RoleId | null;
  readonly onDuty: boolean;
}

export interface AuthEventBase {
  readonly kind: AuthEventKind;
  readonly at: Instant;
  readonly actor: AuthEventActor;
  readonly sessionId: SessionId | null;
  readonly device: Fingerprint | null;
  readonly network: Fingerprint | null;
}

export interface SessionEstablishedEvent extends AuthEventBase {
  readonly kind: 'session_established';
  readonly sessionId: SessionId;
  readonly primaryMethod: PrimaryMethod;
  readonly secondFactor: SecondFactorKind | null;
  readonly expiresAt: Instant;
}

export interface SessionDeniedEvent extends AuthEventBase {
  readonly kind: 'session_denied';
  readonly primaryMethod: PrimaryMethod;
  readonly reason: AuthReasonKey;
}

export interface SessionRevokedEvent extends AuthEventBase {
  readonly kind: 'session_revoked';
  readonly sessionId: SessionId;
  readonly reason: AuthReasonKey;
}

export interface SecondFactorVerifiedEvent extends AuthEventBase {
  readonly kind: 'second_factor_verified';
  readonly factor: SecondFactorKind;
}

export interface DutyEvent extends AuthEventBase {
  readonly kind: 'duty_started' | 'duty_ended';
  readonly roleId: RoleId;
}

/**
 * Смена роли.
 *
 * Роль меняется **у учётной записи**, а не внутри сессии: переключателя ролей
 * нет ни у клиента (`CABINETS.md` §0 п.4), ни у сотрудника (§9 случай 2 —
 * сотрудник со своей личной сделкой заводит отдельную клиентскую запись).
 * Поэтому смена роли всегда сопровождается отзывом действующих сессий, и это
 * записано двумя событиями, а не одним: `role_revoked` со старой ролью и
 * `role_assigned` с новой.
 */
export interface RoleChangeEvent extends AuthEventBase {
  readonly kind: 'role_assigned' | 'role_revoked';
  readonly roleId: RoleId;
  /** Кто распорядился. `null` — распоряжение вне системы, см. `manage_access`. */
  readonly orderedBy: AccountId | null;
}

export interface AuthorizationEvent extends AuthEventBase {
  readonly kind: 'authorization_granted' | 'authorization_denied';
  readonly capability: Capability;
  readonly reason: AuthReasonKey | null;
}

export type AuthEvent =
  | SessionEstablishedEvent
  | SessionDeniedEvent
  | SessionRevokedEvent
  | SecondFactorVerifiedEvent
  | DutyEvent
  | RoleChangeEvent
  | AuthorizationEvent;

/* ------------------------------------------------------------------------- */
/* Построители                                                               */
/* ------------------------------------------------------------------------- */

function actorOf(session: Session): AuthEventActor {
  return Object.freeze({
    accountId: session.accountId,
    personId: session.personId,
    roleId: session.roleId,
    onDuty: session.onDuty,
  });
}

export function sessionEstablished(
  session: Session,
  secondFactor: SecondFactorKind | null,
): SessionEstablishedEvent {
  return Object.freeze({
    kind: 'session_established',
    at: session.issuedAt,
    actor: actorOf(session),
    sessionId: session.sessionId,
    device: session.primary.device,
    network: session.primary.network,
    primaryMethod: session.primary.method,
    secondFactor,
    expiresAt: session.expiresAt,
  });
}

/**
 * Отказ во входе.
 *
 * Отпечатки устройства и сети — **обязательные аргументы без умолчания**.
 * Умолчание `null` означало «отпечатка нет», и получалось оно молчанием: ровно
 * в записи, ради которой журнал входов и ведётся (§4.1 A2 — подбор пароля,
 * вход из чужой сети), поле оказывалось пустым не потому, что отпечатка не
 * было, а потому, что его забыли передать. Журнал не редактируется — дописать
 * потом нельзя. `null` остаётся законным ответом, но теперь его надо написать.
 */
export function sessionDenied(
  actor: AuthEventActor,
  primaryMethod: PrimaryMethod,
  reason: AuthReasonKey,
  at: Instant,
  device: Fingerprint | null,
  network: Fingerprint | null,
): SessionDeniedEvent {
  return Object.freeze({
    kind: 'session_denied',
    at,
    actor,
    sessionId: null,
    device,
    network,
    primaryMethod,
    reason,
  });
}

export function sessionRevoked(
  session: Session,
  reason: AuthReasonKey,
  at: Instant,
): SessionRevokedEvent {
  return Object.freeze({
    kind: 'session_revoked',
    at,
    actor: actorOf(session),
    sessionId: session.sessionId,
    device: session.primary.device,
    network: session.primary.network,
    reason,
  });
}

export function dutyChanged(session: Session, started: boolean, at: Instant): DutyEvent {
  return Object.freeze({
    kind: started ? 'duty_started' : 'duty_ended',
    at,
    actor: actorOf(session),
    sessionId: session.sessionId,
    device: null,
    network: null,
    roleId: session.roleId,
  });
}

/**
 * Смена роли учётной записи: два события, одна метка времени.
 *
 * Порядок в паре значим для восстановления состояния по журналу: сначала снятие
 * прежней роли, потом назначение новой. Обратный порядок дал бы момент, в
 * который у записи две роли, — а такого состояния не существует.
 */
export function roleChanged(
  account: AccountId,
  person: PersonId,
  from: RoleId | null,
  to: RoleId | null,
  orderedBy: AccountId | null,
  at: Instant,
): readonly RoleChangeEvent[] {
  const events: RoleChangeEvent[] = [];
  const base = {
    at,
    sessionId: null,
    device: null,
    network: null,
    orderedBy,
  } as const;
  if (from !== null) {
    events.push(
      Object.freeze({
        ...base,
        kind: 'role_revoked' as const,
        actor: Object.freeze({ accountId: account, personId: person, roleId: from, onDuty: false }),
        roleId: from,
      }),
    );
  }
  if (to !== null) {
    events.push(
      Object.freeze({
        ...base,
        kind: 'role_assigned' as const,
        actor: Object.freeze({ accountId: account, personId: person, roleId: to, onDuty: false }),
        roleId: to,
      }),
    );
  }
  return Object.freeze(events);
}

/**
 * Событие по итогу решения.
 *
 * Успех логируется **не всегда**: `journaled` в `CAPABILITY_SPECS`. Запись о
 * каждом открытии карточки сделки топит журнал и делает его непригодным для
 * того, ради чего он ведётся. Отказ логируется **всегда**: отказ — это либо
 * попытка обойти разделение обязанностей, либо сломанное право у своего же
 * сотрудника, и оба случая надо видеть.
 */
export function authorizationOutcome(
  session: Session,
  outcome: { readonly ok: true; readonly value: Grant<Capability> } | { readonly ok: false; readonly error: Denial },
  at: Instant,
): AuthorizationEvent | null {
  if (outcome.ok) {
    if (!outcome.value.journaled) return null;
    return Object.freeze({
      kind: 'authorization_granted',
      at,
      actor: actorOf(session),
      sessionId: session.sessionId,
      device: session.primary.device,
      network: session.primary.network,
      capability: outcome.value.capability,
      reason: null,
    });
  }
  return Object.freeze({
    kind: 'authorization_denied',
    at,
    actor: actorOf(session),
    sessionId: session.sessionId,
    device: session.primary.device,
    network: session.primary.network,
    capability: outcome.error.capability,
    reason: outcome.error.reason,
  });
}
