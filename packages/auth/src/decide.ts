import { type Result, failure, ok } from '@sdelka/domain';
import type { Instant } from '@sdelka/domain';
import { type Capability, CAPABILITY_SPECS } from './capabilities';
import { type AuthReasonKey, AUTH_REASON_KEYS } from './keys';
import type { AccountId, ActorRef, PersonId, SessionId } from './ids';
import { type CapabilityOf, type RoleId, effectiveCapabilities } from './roles';
import { type ActionContext, type SodViolation, evaluateSeparation } from './separation';
import {
  type RoleSession,
  type Session,
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
 *
 * ⚠ **Утверждение выше держалось прозой, а не типом.** Все поля примитивны, и
 * `const grant: Grant<'approve_payout'> = { … }` собирался у любого вызывающего:
 * доказательство полномочия изготавливалось на месте применения, ровно там, где
 * его надо было предъявить. Поэтому у записи есть метка `grantBrand` —
 * объявленный, но не существующий символ. Значения у него нет и быть не может,
 * литерал с ним не собирается, и единственный способ получить `Grant` — пройти
 * через `decideCapability`, где стоит приведение (одно на пакет, ниже).
 */
declare const grantBrand: unique symbol;

export interface Grant<C extends Capability> {
  /** Метка происхождения: значения не существует, литералом не собирается. */
  readonly [grantBrand]: 'decided';
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
  /**
   * Факты, по которым проверяется разделение обязанностей. **Обязателен.**
   *
   * Был необязательным, и это делало разделение обязанностей дисциплиной, а не
   * правом: вызов без поля не отказывал — он молча получал четыре пустых
   * перечня и проходил Н1, Н2, Н4 и Н5 насквозь. Ошибиться так можно было
   * невнимательностью, а увидеть — только чтением чужого кода.
   *
   * Теперь незнание выражается значением (`UNKNOWN_CONTEXT`) и отказывает, а
   * умолчания нет вовсе.
   */
  readonly context: ActionContext;
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
 *
 * Политика сессии здесь **не аргумент**: она берётся по роли (`policyForRole`).
 * Аргументом она была подменяема — консольной сессии можно было передать
 * политику кабинета и получить пятнадцатиминутный простой длиной в час, а
 * требование устойчивого к фишингу фактора — сниженным до кода в SMS. Ослабить
 * проверку значением аргумента больше нечем.
 */
export function decideCapability(request: AuthorizationRequest): Result<Grant<Capability>, Denial> {
  const { session, capability, now, context } = request;

  const status = sessionStatus(session, now);
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
    const stepUp = stepUpSatisfied(session, now);
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

  /*
   * Единственное приведение к `Grant` в проекте. Метка `grantBrand` не имеет
   * значения, поэтому объект-литерал ей не удовлетворяет ни здесь, ни у
   * вызывающего; разница в том, что здесь над ним уже отработали четыре
   * проверки выше, а у вызывающего — ни одной.
   */
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
    }) as unknown as Grant<Capability>,
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
 *
 * `context` — обязательный четвёртый аргумент **без умолчания**. Умолчание здесь
 * было тем же дефектом, что и необязательное поле запроса: короткий вызов
 * `decide(session, 'approve_payout', now)` компилировался и утверждал выплату,
 * ни с чем её не разведя.
 */
export function decide<R extends RoleId, C extends CapabilityOf<R>>(
  session: RoleSession<R>,
  capability: C,
  now: Instant,
  context: ActionContext,
): Result<Grant<C>, Denial> {
  const decided = decideCapability({ session, capability, now, context });
  if (!decided.ok) return decided;
  return ok(decided.value as Grant<C>);
}
