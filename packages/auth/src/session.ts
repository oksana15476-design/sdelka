import { type DurationMs, type Instant, type Result, duration, failure, ok } from '@sdelka/domain';
import { type AuthReasonKey, AUTH_REASON_KEYS } from './keys';
import type { AccountId, ActorRef, PersonId, SessionId } from './ids';
import { actorRef } from './ids';
import { type RoleId, ROLE_SPECS } from './roles';
import {
  type FactorStrength,
  type PrimaryAuthentication,
  type SecondFactorAssertion,
  atLeastAsStrong,
  freshestAssertion,
} from './second-factor';

/**
 * Личность и сессия: **кто вошёл, чем подтвердил, когда истекает**.
 *
 * Хранилища здесь нет — ни на чтение, ни на запись. Сессия это значение;
 * положить его куда-то и достать обратно — задача адаптера, и порт для этого
 * объявлен ниже. Всё, что умеет пакет, он умеет над значением, поэтому
 * проверяется без сети и без базы.
 */

export type SessionStatus = 'active' | 'expired' | 'idle' | 'revoked';

export interface Session {
  readonly sessionId: SessionId;
  readonly accountId: AccountId;
  /** Человек за учётной записью — второй рубеж разделения обязанностей, см. `ids.ts`. */
  readonly personId: PersonId;
  readonly roleId: RoleId;
  /**
   * Дежурство — **режим поверх роли, а не роль** (`ACTORS.md` §7.1). Флаг на
   * сессии, включаемый расписанием на интервал; добавляет три сужающих
   * полномочия и ноль полей данных.
   */
  readonly onDuty: boolean;
  /** Чем подтвердил вход. */
  readonly primary: PrimaryAuthentication;
  /** Подтверждения второго фактора, накопленные сессией. Порядок не значим. */
  readonly factors: readonly SecondFactorAssertion[];
  readonly issuedAt: Instant;
  /** Абсолютный срок. Продлению не подлежит: продлеваемый абсолютный срок — не срок. */
  readonly expiresAt: Instant;
  /** Последнее действие. По нему считается простой. */
  readonly lastSeenAt: Instant;
  readonly revokedAt: Instant | null;
}

/**
 * Сессия с известной на этапе компиляции ролью.
 *
 * Ради неё и существует разделение: сессия, пришедшая из хранилища, имеет тип
 * `Session` и проверяется в рантайме; сессия, собранная в коде под конкретную
 * роль, проверяется компилятором — `decide(operatorSession, 'write_beneficiary')`
 * не собирается, потому что такого члена нет в `OperatorCapability`.
 */
export interface RoleSession<R extends RoleId> extends Session {
  readonly roleId: R;
}

export interface SessionPolicy {
  /** Абсолютный срок жизни сессии. */
  readonly maxTtl: DurationMs;
  /** Простой, после которого сессия перестаёт действовать. */
  readonly idleTtl: DurationMs;
  /**
   * Возраст подтверждения второго фактора, при котором оно ещё подтверждает
   * того, кто за клавиатурой **сейчас**. Для действий с пометкой `step_up`.
   */
  readonly stepUpMaxAge: DurationMs;
  /** Минимальная сила фактора при выдаче сессии. */
  readonly minimumFactorStrength: FactorStrength;
  /** Требуется ли второй фактор для самой выдачи сессии. */
  readonly secondFactorAtLogin: boolean;
}

/**
 * Политика консоли. Второй фактор обязателен на входе, фактор — устойчивый к
 * фишингу.
 *
 * Строгость выбрана намеренно и является развилкой владельца: `webauthn` на
 * пилоте означает ключи или платформенные аутентификаторы у шести сотрудников;
 * `totp` дешевле и слабее ровно против того нападения, которое нас и ждёт
 * (`CABINETS.md` §0 п.3). Цена каждой стороны — в отчёте.
 */
export const CONSOLE_SESSION_POLICY: SessionPolicy = Object.freeze({
  maxTtl: duration(8 * 60 * 60 * 1000),
  idleTtl: duration(15 * 60 * 1000),
  stepUpMaxAge: duration(5 * 60 * 1000),
  minimumFactorStrength: 'phishing_resistant',
  secondFactorAtLogin: true,
});

/**
 * Политика кабинета стороны. Второй фактор на входе не требуется, но требуется
 * на действиях с реквизитами (`CABINETS.md` §4.1) — это `step_up` в
 * `CAPABILITY_SPECS`, а не свойство сессии.
 */
export const CLIENT_SESSION_POLICY: SessionPolicy = Object.freeze({
  maxTtl: duration(24 * 60 * 60 * 1000),
  idleTtl: duration(60 * 60 * 1000),
  stepUpMaxAge: duration(5 * 60 * 1000),
  minimumFactorStrength: 'possession',
  secondFactorAtLogin: false,
});

/**
 * Политика внешнего читателя: аудитор и юрист клиента. Действий у них нет,
 * поэтому опасен не поступок, а чтение — отсюда короткий простой.
 */
export const EXTERNAL_SESSION_POLICY: SessionPolicy = Object.freeze({
  maxTtl: duration(4 * 60 * 60 * 1000),
  idleTtl: duration(15 * 60 * 1000),
  stepUpMaxAge: duration(5 * 60 * 1000),
  minimumFactorStrength: 'possession',
  secondFactorAtLogin: true,
});

export function policyForRole(roleId: RoleId): SessionPolicy {
  switch (ROLE_SPECS[roleId].audience) {
    case 'console':
      return CONSOLE_SESSION_POLICY;
    case 'client':
      return CLIENT_SESSION_POLICY;
    case 'external':
      return EXTERNAL_SESSION_POLICY;
  }
}

export interface SessionRequest {
  readonly sessionId: SessionId;
  readonly accountId: AccountId;
  readonly personId: PersonId;
  readonly roleId: RoleId;
  readonly onDuty: boolean;
  readonly primary: PrimaryAuthentication;
  readonly factors: readonly SecondFactorAssertion[];
  readonly requestedTtl: DurationMs;
}

/**
 * Выдача сессии.
 *
 * Отказ — значение, а не исключение: у каждого отказа есть ключ причины, он
 * уходит в журнал входов, и вызывающий обязан его разобрать. Молчаливого
 * «сессия не выдалась» здесь нет.
 */
export function establishSession(
  request: SessionRequest,
  policy: SessionPolicy,
  now: Instant,
): Result<Session, AuthReasonKey> {
  const spec = ROLE_SPECS[request.roleId];

  // Ссылка в письме для консоли — Р6 B: почта и есть компрометируемый канал.
  if (spec.audience === 'console' && request.primary.method === 'magic_link') {
    return failure(AUTH_REASON_KEYS.primaryMethodNotAllowedForConsole);
  }

  // Дежурство — режим поверх ОП, ФК, РО и больше ни поверх чего (§7.1).
  if (request.onDuty && !spec.dutyEligible) {
    return failure(AUTH_REASON_KEYS.dutyRoleNotEligible);
  }

  if (policy.secondFactorAtLogin) {
    const freshest = freshestAssertion(request.factors);
    if (freshest === null) {
      return failure(AUTH_REASON_KEYS.secondFactorMissing);
    }
    if (!atLeastAsStrong(freshest.kind, policy.minimumFactorStrength)) {
      return failure(AUTH_REASON_KEYS.secondFactorTooWeak);
    }
  }

  if (request.requestedTtl > policy.maxTtl) {
    return failure(AUTH_REASON_KEYS.sessionTtlTooLong);
  }

  return ok(
    Object.freeze({
      sessionId: request.sessionId,
      accountId: request.accountId,
      personId: request.personId,
      roleId: request.roleId,
      onDuty: request.onDuty,
      primary: request.primary,
      factors: Object.freeze([...request.factors]),
      issuedAt: now,
      expiresAt: (now + request.requestedTtl) as Instant,
      lastSeenAt: now,
      revokedAt: null,
    }),
  );
}

export function sessionStatus(session: Session, policy: SessionPolicy, now: Instant): SessionStatus {
  if (session.revokedAt !== null && now >= session.revokedAt) return 'revoked';
  if (now >= session.expiresAt) return 'expired';
  if (now - session.lastSeenAt >= policy.idleTtl) return 'idle';
  return 'active';
}

/** Ключ причины по состоянию. `active` причины не имеет — она не отказ. */
export function sessionRejection(status: SessionStatus): AuthReasonKey | null {
  switch (status) {
    case 'active':
      return null;
    case 'expired':
      return AUTH_REASON_KEYS.sessionExpired;
    case 'idle':
      return AUTH_REASON_KEYS.sessionIdle;
    case 'revoked':
      return AUTH_REASON_KEYS.sessionRevoked;
  }
}

/**
 * Отметка активности. Абсолютный срок не двигается — двигается только простой.
 * Сессия, которую можно продлевать бесконечно, не имеет срока.
 */
export function touch(session: Session, now: Instant): Session {
  return Object.freeze({ ...session, lastSeenAt: now });
}

export function revoke(session: Session, at: Instant): Session {
  return Object.freeze({ ...session, revokedAt: at });
}

/** Добавить подтверждение фактора. Прежние сохраняются: журнал, а не замена. */
export function withAssertion(session: Session, assertion: SecondFactorAssertion): Session {
  return Object.freeze({ ...session, factors: Object.freeze([...session.factors, assertion]) });
}

/**
 * Достаточно ли свеж второй фактор для действия с пометкой `step_up`.
 *
 * Свежесть считается от `verifiedAt`, а не от выдачи сессии: подтверждение
 * восьмичасовой давности подтверждает того, кто входил утром, а не того, кто
 * нажимает «утвердить» сейчас.
 */
export function stepUpSatisfied(
  session: Session,
  policy: SessionPolicy,
  now: Instant,
): Result<SecondFactorAssertion, AuthReasonKey> {
  const freshest = freshestAssertion(session.factors);
  if (freshest === null) {
    return failure(AUTH_REASON_KEYS.secondFactorMissing);
  }
  if (!atLeastAsStrong(freshest.kind, policy.minimumFactorStrength)) {
    return failure(AUTH_REASON_KEYS.secondFactorTooWeak);
  }
  if (now - freshest.verifiedAt > policy.stepUpMaxAge) {
    return failure(AUTH_REASON_KEYS.secondFactorStale);
  }
  return ok(freshest);
}

export function sessionActor(session: Session): ActorRef {
  return actorRef(session.accountId, session.personId);
}

/**
 * Порт хранилища сессий. Объявлен, чтобы граница была видна; реализации в этом
 * пакете нет — задача прямо это исключает, и правильно: пакет, который умеет
 * читать сессию из базы, невозможно тестировать без базы.
 */
export interface SessionStorePort {
  load(id: SessionId): Promise<Session | null>;
  save(session: Session): Promise<void>;
  revokeAllForAccount(account: AccountId, at: Instant): Promise<number>;
}
