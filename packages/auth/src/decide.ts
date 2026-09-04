import { type Result, failure, ok } from '@sdelka/domain';
import type { Instant } from '@sdelka/domain';
import { type Capability, CAPABILITY_SPECS } from './capabilities';
import { type AuthReasonKey, AUTH_REASON_KEYS } from './keys';
import type { AccountId, ActorRef, PersonId, SessionId } from './ids';
import { type CapabilityOf, type RoleId, effectiveCapabilities } from './roles';
import {
  type ActionContext,
  type SodViolation,
  EMPTY_CONTEXT,
  evaluateSeparation,
} from './separation';
import {
  type RoleSession,
  type Session,
  type SessionPolicy,
  policyForRole,
  sessionActor,
  sessionRejection,
  sessionStatus,
  stepUpSatisfied,
} from './session';

/**
 * Решение о полномочии. Логика, и только логика: ни сети, ни базы, ни времени
 * из системных часов — момент приходит аргументом, как в `packages/domain`.
 */

/**
 * Доказательство полномочия.
 *
 * Форма повторяет `Authority<C>` из `packages/compliance` намеренно: там уже
 * заведено правило «функция, меняющая периметр, принимает доказательство, а не
 * актора», и второй формы того же доказательства в проекте быть не должно.
 * Отличия два, и оба из `ACTORS.md`: здесь есть `personId` (§9 случай 4 —
 * ограничение человека, а не учётной записи) и `sessionId` (журнал входов
 * обязан связывать действие со входом).
 *
 * Подделать нельзя, не выписав; выписать нельзя иначе как через `decide`.
 */
export interface Grant<C extends Capability> {
  readonly accountId: AccountId;
  readonly personId: PersonId;
  readonly roleId: RoleId;
  readonly sessionId: SessionId;
  readonly capability: C;
  readonly onDuty: boolean;
  readonly decidedAt: Instant;
  /** Попадает ли применение в журнал отдельной записью — `CAPABILITY_SPECS`. */
  readonly journaled: boolean;
}

export interface Denial {
  readonly capability: Capability;
  readonly reason: AuthReasonKey;
  /** Все нарушенные несовместимости, а не первое. Пусто — отказ не из-за них. */
  readonly violations: readonly SodViolation[];
}

function denial(
  capability: Capability,
  reason: AuthReasonKey,
  violations: readonly SodViolation[] = [],
): Denial {
  return Object.freeze({ capability, reason, violations: Object.freeze([...violations]) });
}

export interface AuthorizationRequest {
  readonly session: Session;
  readonly capability: Capability;
  readonly now: Instant;
  readonly context?: ActionContext;
  readonly policy?: SessionPolicy;
}

/**
 * Порядок проверок задан ценой ошибки, а не удобством:
 *
 * 1. сессия жива — иначе всё остальное считается по данным умершего входа;
 * 2. полномочие выдано роли — рантайм-дубль компиляционного рубежа: тип не
 *    переживает границу процесса, роль приходит из базы;
 * 3. второй фактор — до разделения обязанностей, потому что несовместимость
 *    проверяет, **тот ли человек**, а фактор — **человек ли это вообще**;
 * 4. разделение обязанностей.
 */
export function decideCapability(request: AuthorizationRequest): Result<Grant<Capability>, Denial> {
  const { session, capability, now } = request;
  const policy = request.policy ?? policyForRole(session.roleId);
  const context = request.context ?? EMPTY_CONTEXT;

  const status = sessionStatus(session, policy, now);
  const statusReason = sessionRejection(status);
  if (statusReason !== null) {
    return failure(denial(capability, statusReason));
  }

  const granted = effectiveCapabilities(session.roleId, session.onDuty);
  if (!granted.includes(capability)) {
    return failure(denial(capability, AUTH_REASON_KEYS.capabilityNotGranted));
  }

  const spec = CAPABILITY_SPECS[capability];
  if (spec.secondFactor === 'step_up') {
    const stepUp = stepUpSatisfied(session, policy, now);
    if (!stepUp.ok) {
      return failure(denial(capability, stepUp.error));
    }
  }

  const actor: ActorRef = sessionActor(session);
  const violations = evaluateSeparation(capability, session.roleId, actor, context);
  const first = violations[0];
  if (first !== undefined) {
    return failure(denial(capability, first.reason, violations));
  }

  return ok(
    Object.freeze({
      accountId: session.accountId,
      personId: session.personId,
      roleId: session.roleId,
      sessionId: session.sessionId,
      capability,
      onDuty: session.onDuty,
      decidedAt: now,
      journaled: spec.journaled,
    }),
  );
}

/**
 * То же решение, но с компиляционным рубежом.
 *
 * `C extends CapabilityOf<R>` — единственная причина существования
 * `RoleSession<R>`: критерий приёмки `ACTORS.md` §10 требует, чтобы вызов
 * `write_beneficiary` **оператором не компилировался**, а не отклонялся в
 * рантайме. Сессия, поднятая из хранилища, имеет тип `Session` с ролью-объединением,
 * и для неё остаётся `decideCapability` с рантайм-проверкой — второй рубеж
 * нужен ровно потому, что типы не переживают границу процесса.
 */
export function decide<R extends RoleId, C extends CapabilityOf<R>>(
  session: RoleSession<R>,
  capability: C,
  now: Instant,
  context: ActionContext = EMPTY_CONTEXT,
  policy: SessionPolicy = policyForRole(session.roleId),
): Result<Grant<C>, Denial> {
  const decided = decideCapability({ session, capability, now, context, policy });
  if (!decided.ok) return decided;
  return ok(decided.value as Grant<C>);
}
