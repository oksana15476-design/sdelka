import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  can,
  overlappingCapabilities,
  unassignedCapabilities,
} from './owner-role';

/**
 * Разделение ролей проверяется как свойство, а не как список: перечень
 * полномочий будет расти, и правило обязано пережить каждое добавление.
 */
describe('роль владельца отдельна от операционной', () => {
  it('пересечения полномочий нет ни одного', () => {
    expect(overlappingCapabilities()).toEqual([]);
  });

  it('каждое полномочие принадлежит ровно одной роли', () => {
    expect(unassignedCapabilities()).toEqual([]);
    const assigned = [...ROLE_CAPABILITIES.owner, ...ROLE_CAPABILITIES.operator];
    expect(assigned).toHaveLength(CAPABILITIES.length);
  });

  it('владелец не утверждает выплату и не работает с очередью', () => {
    expect(can('owner', 'approve_payout')).toBe(false);
    expect(can('owner', 'work_queue')).toBe(false);
  });

  it('оператор не видит деньги компании и тариф', () => {
    expect(can('operator', 'view_company_money')).toBe(false);
    expect(can('operator', 'view_tariff')).toBe(false);
  });

  it('владелец не видит остатки клиента: это операционное полномочие', () => {
    expect(can('owner', 'view_client_account')).toBe(false);
  });
});
