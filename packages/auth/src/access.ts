import { type Instant, type Result, failure, ok } from '@sdelka/domain';
import type { Grant } from './decide';
import { type AuthReasonKey, AUTH_REASON_KEYS } from './keys';
import type { AccountId, PersonId } from './ids';
import type { RoleId } from './roles';
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

export function changeAccountRole(
  authority: Grant<'manage_access'>,
  current: RoleAssignment | null,
  request: RoleChangeRequest,
  at: Instant,
): Result<RoleChangeOutcome, AuthReasonKey> {
  // Роль себе не назначают: это обход всей матрицы одной кнопкой.
  if (authority.accountId === request.accountId || authority.personId === request.personId) {
    return failure(AUTH_REASON_KEYS.sodSelfApproval);
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
