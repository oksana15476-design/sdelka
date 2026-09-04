import { describe, expect, it } from 'vitest';
import {
  type Grant,
  AUTH_REASON_KEYS,
  ROLE_IDS,
  accountId,
  changeAccountRole,
  decideCapability,
  personId,
  roleHasCapability,
  sessionId,
} from '../src/index';
import { NOW, sessionFor } from './support';

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
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.reason).toBe(AUTH_REASON_KEYS.capabilityNotGranted);
    }
  });
});

describe('смена роли, когда полномочие будет выдано', () => {
  const authority: Grant<'manage_access'> = Object.freeze({
    accountId: accountId('acc-admin'),
    personId: personId('per-admin'),
    roleId: 'head_of_operations',
    sessionId: sessionId('s-admin'),
    capability: 'manage_access',
    onDuty: false,
    decidedAt: NOW,
    journaled: true,
  });

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
