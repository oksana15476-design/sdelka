import { describe, expect, it } from 'vitest';
import {
  type Grant,
  AUTH_REASON_KEYS,
  ROLE_IDS,
  UNKNOWN_FACT,
  accountId,
  changeAccountRole,
  decideCapability,
  personId,
  roleHasCapability,
  sessionId,
} from '../src/index';
import { NOW, at, context, sessionFor } from './support';

describe('назначение роли', () => {
  it('полномочия manage_access сегодня нет ни у одной роли', () => {
    // Умышленный тупик, а не забытая строка: `ACTORS.md` §5 не называет никого,
    // кто вправе назначить роль. «Может кто угодно» отменяет всю матрицу разом,
    // поэтому здесь «не может никто», а развилка — в отчёте владельцу.
    for (const roleId of ROLE_IDS) {
      expect(roleHasCapability(roleId, 'manage_access')).toBe(false);
    }
  });

  it('решение о нём отказывает любой роли, включая владельца', () => {
    for (const roleId of ['principal', 'head_of_operations', 'compliance_officer'] as const) {
      const result = decideCapability({
        session: sessionFor(roleId, `acc-${roleId}`),
        capability: 'manage_access',
        now: NOW,
        context: context(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.reason).toBe(AUTH_REASON_KEYS.capabilityNotGranted);
    }
  });
});

describe('смена роли, когда полномочие будет выдано', () => {
  /*
   * ⚠ Приведение здесь — не небрежность, а следствие того, что `manage_access`
   * не выдан ни одной роли: `decideCapability` такой грант не выпишет никогда,
   * а проверить остальную часть `changeAccountRole` надо. Метка `grantBrand`
   * ровно для того и заведена, чтобы этот литерал нельзя было написать нигде
   * больше — приведение видно, и оно одно на весь проект вне `decide.ts`.
   */
  const authority = Object.freeze({
    accountId: accountId('acc-admin'),
    personId: personId('per-admin'),
    roleId: 'head_of_operations',
    sessionId: sessionId('s-admin'),
    capability: 'manage_access',
    onDuty: false,
    decidedAt: NOW,
    journaled: true,
  }) as unknown as Grant<'manage_access'>;

  it('роль себе не назначают', () => {
    const result = changeAccountRole(
      authority,
      null,
      { accountId: accountId('acc-admin'), personId: personId('per-admin'), roleId: 'principal' },
      NOW,
    );
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.sodSelfApproval });
  });

  it('и не назначают другой своей учётной записи — человек тот же', () => {
    const result = changeAccountRole(
      authority,
      null,
      { accountId: accountId('acc-other'), personId: personId('per-admin'), roleId: 'operator' },
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it('доказательство полномочия не бессрочно', () => {
    // Грант — значение; без срока он переживал и простой сессии, и её отзыв.
    // Срок берётся из `stepUpMaxAge` политики роли: `manage_access` — step_up.
    const result = changeAccountRole(
      authority,
      null,
      { accountId: accountId('acc-1'), personId: personId('per-1'), roleId: 'operator' },
      at(6 * 60 * 1000),
    );
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.authorityStale });
  });

  it('в пределах свежести подтверждения — проходит', () => {
    const result = changeAccountRole(
      authority,
      null,
      { accountId: accountId('acc-1'), personId: personId('per-1'), roleId: 'operator' },
      at(4 * 60 * 1000),
    );
    expect(result.ok).toBe(true);
  });

  it('невыясненная действующая роль — отказ, а не первое назначение', () => {
    // `null` покрывал и «роли не было», и «не смотрели». Во втором случае в
    // журнал не попадало `role_revoked`, а журнал не редактируется.
    const result = changeAccountRole(
      authority,
      UNKNOWN_FACT,
      { accountId: accountId('acc-1'), personId: personId('per-1'), roleId: 'operator' },
      NOW,
    );
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.accessCurrentRoleUnknown });
  });

  it('чужое назначение в роли действующего не принимается', () => {
    const result = changeAccountRole(
      authority,
      {
        accountId: accountId('acc-2'),
        personId: personId('per-2'),
        roleId: 'operator',
        assignedAt: NOW,
        assignedBy: null,
      },
      { accountId: accountId('acc-1'), personId: personId('per-1'), roleId: 'support' },
      NOW,
    );
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.accessCurrentRoleMismatch });
  });

  it('смена роли отзывает сессии и пишет два события', () => {
    const result = changeAccountRole(
      authority,
      {
        accountId: accountId('acc-1'),
        personId: personId('per-1'),
        roleId: 'operator',
        assignedAt: NOW,
        assignedBy: null,
      },
      {
        accountId: accountId('acc-1'),
        personId: personId('per-1'),
        roleId: 'financial_controller',
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revokeSessionsFor).toBe(accountId('acc-1'));
    expect(result.value.events.map((item) => item.kind)).toEqual([
      'role_revoked',
      'role_assigned',
    ]);
    expect(result.value.assignment.roleId).toBe('financial_controller');
  });
});
