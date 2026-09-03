import { describe, expect, it } from 'vitest';
import { type RefundFacts, assessRefundDestination } from '../../src/index';
import {
  ACCOUNT_OTHER,
  ACCOUNT_SOURCE,
  BUYER_DOCUMENT,
  evidence,
  NOW,
  OTHER_DOCUMENT,
  POLICY_VERSION,
} from '../support/fixtures';

function facts(overrides: Partial<RefundFacts> = {}): RefundFacts {
  return {
    sourceAccount: ACCOUNT_SOURCE,
    sourceHolder: BUYER_DOCUMENT,
    requestedAccount: ACCOUNT_SOURCE,
    requestedHolder: BUYER_DOCUMENT,
    sanctionsFrozen: false,
    evidence: [evidence(1)],
    ...overrides,
  };
}

const assess = (overrides: Partial<RefundFacts> = {}) =>
  assessRefundDestination(facts(overrides), POLICY_VERSION, NOW);

describe('возврат только на счёт-источник, на имя плательщика', () => {
  it('счёт-источник и тот же владелец — пропускается', () => {
    const result = assess();
    expect(result.outcome).toBe('clear');
    expect(result.reasons).toContain('compliance.refund.to_source_account');
  });

  it('другой счёт — блок', () => {
    const result = assess({ requestedAccount: ACCOUNT_OTHER });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.refund.account_differs');
  });

  it('тот же счёт, другой владелец — блок', () => {
    const result = assess({ requestedHolder: OTHER_DOCUMENT });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.refund.holder_differs');
  });

  it('владелец не установлен — блок', () => {
    const result = assess({ requestedHolder: null });
    expect(result.outcome).toBe('block');
  });

  it('счёт-источник неизвестен — блок, а не «наверное этот»', () => {
    const result = assess({ sourceAccount: null, sourceHolder: null });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.refund.source_account_unknown');
  });

  it('санкционная заморозка имеет приоритет над возвратом по умолчанию', () => {
    const result = assess({ sanctionsFrozen: true });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.refund.sanctions_freeze_precedence');
  });
});
