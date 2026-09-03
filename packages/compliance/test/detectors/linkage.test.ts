import { describe, expect, it } from 'vitest';
import { type LinkageFacts, type PartySignals, assessLinkage } from '../../src/index';
import {
  ACCOUNT_OTHER,
  ACCOUNT_SOURCE,
  ADDRESS_SHARED,
  DEVICE_SHARED,
  evidence,
  NOW,
  PHONE_SHARED,
  POLICY_VERSION,
} from '../support/fixtures';

function party(partyId: string, overrides: Partial<PartySignals> = {}): PartySignals {
  return {
    partyId,
    accounts: [],
    devices: [],
    networkAddresses: [],
    phones: [],
    ...overrides,
  };
}

const assess = (facts: Partial<LinkageFacts>) =>
  assessLinkage(
    { parties: [], declaredRelationships: [], evidence: [evidence(1)], ...facts },
    POLICY_VERSION,
    NOW,
  );

describe('совпадение устройства и реквизитов у независимых покупателей', () => {
  it('не срабатывает при отсутствии общих сигналов', () => {
    const result = assess({
      parties: [
        party('a', { accounts: [ACCOUNT_SOURCE] }),
        party('b', { accounts: [ACCOUNT_OTHER] }),
      ],
    });
    expect(result.outcome).toBe('clear');
    expect(result.links).toHaveLength(0);
    expect(result.reasons).toContain('compliance.linkage.none');
  });

  it('общее устройство — задача в очередь', () => {
    const result = assess({
      parties: [party('a', { devices: [DEVICE_SHARED] }), party('b', { devices: [DEVICE_SHARED] })],
    });
    expect(result.outcome).toBe('review');
    expect(result.reasons).toContain('compliance.linkage.shared_device');
    expect(result.links[0]?.partyIds).toEqual(['a', 'b']);
  });

  it('общий сетевой адрес и телефон — задача в очередь', () => {
    const result = assess({
      parties: [
        party('a', { networkAddresses: [ADDRESS_SHARED], phones: [PHONE_SHARED] }),
        party('b', { networkAddresses: [ADDRESS_SHARED], phones: [PHONE_SHARED] }),
      ],
    });
    expect(result.outcome).toBe('review');
    expect(result.reasons).toContain('compliance.linkage.shared_network_address');
    expect(result.reasons).toContain('compliance.linkage.shared_phone');
  });

  it('общий счёт — удержание, а не задача', () => {
    const result = assess({
      parties: [
        party('a', { accounts: [ACCOUNT_SOURCE] }),
        party('b', { accounts: [ACCOUNT_SOURCE] }),
      ],
    });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.linkage.shared_account');
  });

  it('заявленное и подтверждённое родство исключается из срабатывания', () => {
    const result = assess({
      parties: [
        party('a', { accounts: [ACCOUNT_SOURCE], phones: [PHONE_SHARED] }),
        party('b', { accounts: [ACCOUNT_SOURCE], phones: [PHONE_SHARED] }),
      ],
      declaredRelationships: [['a', 'b']],
    });
    expect(result.outcome).toBe('clear');
    expect(result.links[0]?.declared).toBe(true);
    expect(result.reasons).toContain('compliance.linkage.declared_relationship');
  });

  it('в отчёт попадает метка отпечатка, а не сам отпечаток', () => {
    const result = assess({
      parties: [party('a', { devices: [DEVICE_SHARED] }), party('b', { devices: [DEVICE_SHARED] })],
    });
    const label = result.links[0]?.shared[0]?.label ?? '';
    expect(label).toHaveLength(8);
    expect(JSON.stringify(result.links)).not.toContain(DEVICE_SHARED);
  });
});
