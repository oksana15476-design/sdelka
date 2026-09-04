import { type Instant, type Result, failure, ok } from '@sdelka/domain';
import type { Grant } from './decide';
import { type AuthReasonKey, AUTH_REASON_KEYS } from './keys';
import type { AccountId, PersonId, UnknownFact } from './ids';
import { UNKNOWN_FACT } from './ids';
import type { RoleId } from './roles';
import { policyForRole } from './session';
import { type RoleChangeEvent, roleChanged } from './events';

/**
 * Назначение роли учётной записи.
 *
 * **У учётной записи ровно одна роль.** Не список: `ACTORS.md` §9 случай 2 —
 * сотрудник, оказавшийся стороной по своей личной сделке, заводит **отдельную
 * клиентскую учётную запись**, а не вторую роль на существующей; §9 случай 4 —
 * «вторая шляпа» запрещена человеку, а не записи. Роль-список отменил бы обе
 * несовместимости молча: набор ролей на одной записи — это набор уровней
 * утверждения на одном человеке.
 *
 * ⚠ Выписать `Grant<'manage_access'>` сегодня **нельзя ни одной ролью** —
 * см. комментарий у `manage_access` в `capabilities.ts`. Функция существует и
 * проверена в части, не требующей грант; кому выдать полномочие — развилка
 * владельца.
 */
export interface RoleAssignment {
  readonly accountId: AccountId;
  readonly personId: PersonId;
  readonly roleId: RoleId;
  readonly assignedAt: Instant;
  /** Кто распорядился. `null` — распоряжение вне системы, с записью в журнал. */
  readonly assignedBy: AccountId | null;
}

export interface RoleChangeRequest {
  readonly accountId: AccountId;
  readonly personId: PersonId;
  readonly roleId: RoleId;
}

export interface RoleChangeOutcome {
  readonly assignment: RoleAssignment;
  readonly events: readonly RoleChangeEvent[];
  /**
   * Смена роли отзывает действующие сессии всегда.
   *
   * Иначе роль в выданной сессии осталась бы прежней до её истечения, то есть
   * снятое полномочие продолжало бы действовать до восьми часов. Отзыв — не
   * оптимизация, а часть смены; поэтому поле неотключаемое, а не булево.
   */
  readonly revokeSessionsFor: AccountId;
}

/**
 * Смена роли учётной записи.
 *
 * `current` отвечает на вопрос «какая роль у записи сейчас» тремя значениями:
 * назначение, `null` («роли ещё не было» — первое назначение) и `UNKNOWN_FACT`
 * («не выясняли»). Третье добавлено потому, что `null` покрывал и его: не
 * посмотрев прежнюю роль, вызывающий получал журнал без `role_revoked`, то есть
 * запись о снятии полномочий просто не появлялась. Журнал не редактируется
 * (красная линия №11) — пропущенную запись потом не добавить.
 */
export function changeAccountRole(
  authority: Grant<'manage_access'>,
  current: RoleAssignment | null | UnknownFact,
  request: RoleChangeRequest,
  at: Instant,
): Result<RoleChangeOutcome, AuthReasonKey> {
  // Роль себе не назначают: это обход всей матрицы одной кнопкой.
  if (authority.accountId === request.accountId || authority.personId === request.personId) {
    return failure(AUTH_REASON_KEYS.sodSelfApproval);
  }

  /*
   * Доказательство полномочия — значение, и живёт оно ровно столько, сколько
   * живёт подтверждение, которым получено. Без этой проверки `Grant` был
   * бессрочным: выписанный утром, он менял роли вечером, пережив и простой
   * сессии, и её отзыв. Срок берётся из политики роли (`stepUpMaxAge`), потому
   * что `manage_access` помечен `step_up` в `CAPABILITY_SPECS`, — своей
   * константы здесь нет и быть не должно.
   */
  const age = at - authority.decidedAt;
  if (age < 0 || age > policyForRole(authority.roleId).stepUpMaxAge) {
    return failure(AUTH_REASON_KEYS.authorityStale);
  }

  if (current === UNKNOWN_FACT) {
    return failure(AUTH_REASON_KEYS.accessCurrentRoleUnknown);
  }

  // Чужое назначение в роли «текущего» даёт пару событий про разные записи.
  if (
    current !== null &&
    (current.accountId !== request.accountId || current.personId !== request.personId)
  ) {
    return failure(AUTH_REASON_KEYS.accessCurrentRoleMismatch);
  }

  const assignment: RoleAssignment = Object.freeze({
    accountId: request.accountId,
    personId: request.personId,
    roleId: request.roleId,
    assignedAt: at,
    assignedBy: authority.accountId,
  });

  return ok(
    Object.freeze({
      assignment,
      events: roleChanged(
        request.accountId,
        request.personId,
        current === null ? null : current.roleId,
        request.roleId,
        authority.accountId,
        at,
      ),
      revokeSessionsFor: request.accountId,
    }),
  );
}
