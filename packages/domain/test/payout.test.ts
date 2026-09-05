import { describe, expect, it } from 'vitest';
import {
  type PayoutEvent,
  type PayoutState,
  type PayoutStatus,
  ACTIVE_PAYOUT_STATUSES,
  PAYOUT_TRANSITIONS,
  RejectionCode,
  activePayoutsForTranche,
  createPayout,
  isActivePayout,
  payoutIdempotencyKey,
  reducePayout,
  violatesSingleActivePayout,
} from '../src/index';

function at(status: PayoutStatus): PayoutState {
  return {
    status,
    idempotencyKey: payoutIdempotencyKey('tranche-1'),
    trancheId: 'tranche-1',
    leg: 'release',
  };
}

function step(state: PayoutState, event: PayoutEvent): PayoutState {
  const result = reducePayout(state, event);
  if (!result.ok) {
    throw new Error(`unexpected rejection: ${result.error.code}`);
  }
  return result.value.state;
}

describe('выплата: обычные исходы', () => {
  it('goes created → submitted → settled', () => {
    const payout = createPayout('tranche-1');
    expect(payout.status).toBe('created');
    expect(step(step(payout, { type: 'payout_submitted' }), { type: 'provider_confirms' }).status).toBe(
      'settled',
    );
  });

  it('goes submitted → rejected only on an explicit provider answer', () => {
    expect(step(at('submitted'), { type: 'provider_rejects' }).status).toBe('rejected');
    for (const event of ['timeout', 'network_error', 'response_lost'] as const) {
      expect(step(at('submitted'), { type: event }).status).toBe('unknown');
    }
    // Ни одно сетевое событие не ведёт в rejected — только в unknown (§2.2).
    const networkEdges = PAYOUT_TRANSITIONS.filter((item) =>
      ['timeout', 'network_error', 'response_lost'].includes(item.event),
    );
    expect(networkEdges.every((item) => item.to === 'unknown')).toBe(true);
    expect(networkEdges).toHaveLength(3);
  });
});

describe('выплата: из unknown нет пути в повтор', () => {
  it('has no transition back to created or submitted in the table', () => {
    const fromUnknown = PAYOUT_TRANSITIONS.filter((item) => item.from === 'unknown');
    expect(fromUnknown.map((item) => item.to)).not.toContain('created');
    expect(fromUnknown.map((item) => item.to)).not.toContain('submitted');
  });

  it('refuses every event that is not reconciliation', () => {
    const events: readonly PayoutEvent[] = [
      { type: 'payout_submitted' },
      { type: 'provider_confirms' },
      { type: 'provider_rejects' },
      { type: 'timeout' },
      { type: 'network_error' },
      { type: 'response_lost' },
    ];
    for (const event of events) {
      const result = reducePayout(at('unknown'), event);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(RejectionCode.transitionNotAllowed);
      }
    }
  });

  it('leaves unknown only through reconciliation with the statement', () => {
    expect(step(at('unknown'), { type: 'reconciliation_found_in_statement' }).status).toBe('settled');
    expect(step(at('unknown'), { type: 'reconciliation_absent_from_statement' }).status).toBe(
      'rejected',
    );
  });

  it('keeps the idempotency key through every transition', () => {
    const payout = createPayout('tranche-1');
    const unknown = step(step(payout, { type: 'payout_submitted' }), { type: 'timeout' });
    const settled = step(unknown, { type: 'reconciliation_found_in_statement' });
    expect(settled.idempotencyKey).toBe(payout.idempotencyKey);
  });

  it('refuses events in terminal states', () => {
    for (const status of ['settled', 'rejected'] as const) {
      const result = reducePayout(at(status), { type: 'payout_submitted' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(RejectionCode.terminalState);
      }
    }
  });
});

describe('не более одной активной выплаты по траншу', () => {
  it('counts unknown as active: пока сверка не сказала обратного, деньги могли уйти', () => {
    expect(ACTIVE_PAYOUT_STATUSES).toEqual(['created', 'submitted', 'unknown']);
    expect(isActivePayout(at('unknown'))).toBe(true);
    expect(isActivePayout(at('settled'))).toBe(false);
    expect(isActivePayout(at('rejected'))).toBe(false);
  });

  it('detects a second active payout on the same tranche', () => {
    const payouts: readonly PayoutState[] = [at('unknown'), at('created')];
    expect(activePayoutsForTranche(payouts, 'tranche-1')).toHaveLength(2);
    expect(violatesSingleActivePayout(payouts, 'tranche-1')).toBe(true);
    expect(violatesSingleActivePayout([at('unknown'), at('settled')], 'tranche-1')).toBe(false);
    expect(violatesSingleActivePayout(payouts, 'tranche-2')).toBe(false);
  });
});
