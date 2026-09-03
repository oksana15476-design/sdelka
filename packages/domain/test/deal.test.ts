import { describe, expect, it } from 'vitest';
import {
  type ConditionAct,
  type DealContext,
  type DealEvent,
  type DealState,
  type DealStatus,
  type TrancheStatus,
  DEAL_STATUSES,
  RejectionCode,
  dealState,
  initialDealState,
  reduceDeal,
} from '../src/index';
import { CONDITION_ACT, NOW } from './support/facts';

function context(
  trancheStatuses: readonly TrancheStatus[] = [],
  preparedBy: string | null = null,
  conditionAct: ConditionAct | null = CONDITION_ACT,
): DealContext {
  return { dealId: 'deal-1', now: NOW, facts: { trancheStatuses, preparedBy, conditionAct } };
}

function step(state: DealState, event: DealEvent, ctx: DealContext = context()): DealState {
  const result = reduceDeal(state, event, ctx);
  if (!result.ok) {
    throw new Error(`unexpected rejection: ${result.error.code} ${result.error.failedGuards.join(',')}`);
  }
  return result.value.state;
}

describe('сделка: оркестрация', () => {
  it('runs draft → parties_pending → property_pending → ready → funding → funded → filed → settling → settled', () => {
    let state = initialDealState;
    state = step(state, { type: 'parties_check_started' });
    state = step(state, { type: 'parties_verified' });
    state = step(state, { type: 'property_verified' });
    expect(state.status).toBe('ready');
    state = step(state, { type: 'funds_received' });
    expect(state.status).toBe('funding');
    state = step(state, { type: 'tranches_reserved' }, context(['reserved', 'reserved']));
    expect(state.status).toBe('funded');
    state = step(state, { type: 'filing_registered', applicationId: 'app-1' });
    state = step(state, { type: 'condition_established', conditionType: 'registration_transfer' });
    expect(state.status).toBe('settling');
    state = step(state, { type: 'tranches_settled' }, context(['paid_out', 'paid_out']));
    expect(state.status).toBe('settled');
  });

  it('keeps funding as a separate state between ready and funded', () => {
    expect(DEAL_STATUSES).toContain('funding');
    const result = reduceDeal(dealState('ready'), { type: 'tranches_reserved' }, context(['reserved']));
    expect(result.ok).toBe(false);
  });

  it('unwinds from funding on deadline or revocation', () => {
    expect(step(dealState('funding'), { type: 'deadline_reached' }).status).toBe('unwinding');
    expect(step(dealState('funding'), { type: 'revocation_requested' }).status).toBe('unwinding');
    expect(
      step(dealState('unwinding'), { type: 'tranches_refunded' }, context(['refunded'])).status,
    ).toBe('unwound');
  });

  it('refuses to settle while a tranche is still alive', () => {
    const result = reduceDeal(
      dealState('settling'),
      { type: 'tranches_settled' },
      context(['paid_out', 'refunding']),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RejectionCode.guardFailed);
    }
  });

  it('refuses to settle a deal without tranches at all', () => {
    const result = reduceDeal(dealState('settling'), { type: 'tranches_settled' }, context([]));
    expect(result.ok).toBe(false);
  });

  it('refuses the unconfirmed release condition at the deal level too', () => {
    const result = reduceDeal(
      dealState('filed'),
      { type: 'condition_established', conditionType: 'registration_preliminary' },
      context(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RejectionCode.releaseConditionRequiresConfirmation);
    }
  });
});

describe('сделка: заморозка', () => {
  const nonTerminal: readonly DealStatus[] = [
    'draft',
    'parties_pending',
    'property_pending',
    'ready',
    'funding',
    'funded',
    'filed',
    'settling',
    'unwinding',
  ];

  it('freezes from any non-terminal state on hold or dispute', () => {
    for (const status of nonTerminal) {
      expect(step(dealState(status), { type: 'compliance_hold', reason: 'r' }).status).toBe('frozen');
      expect(step(dealState(status), { type: 'dispute_raised', reason: 'r' }).status).toBe('frozen');
    }
  });

  it('unfreezes only with two distinct users and only into settling or unwinding', () => {
    const ctx = context([], 'operator-1');
    expect(
      step(dealState('frozen'), { type: 'unfreeze', userIds: ['a', 'b'], resume: 'settling' }, ctx).status,
    ).toBe('settling');
    expect(
      step(dealState('frozen'), { type: 'unfreeze', userIds: ['a', 'b'], resume: 'unwinding' }, ctx).status,
    ).toBe('unwinding');

    const sameUser = reduceDeal(
      dealState('frozen'),
      { type: 'unfreeze', userIds: ['a', 'a'], resume: 'settling' },
      ctx,
    );
    expect(sameUser.ok).toBe(false);

    const preparerApproves = reduceDeal(
      dealState('frozen'),
      { type: 'unfreeze', userIds: ['operator-1', 'b'], resume: 'settling' },
      ctx,
    );
    expect(preparerApproves.ok).toBe(false);
  });

  it('refuses events in terminal states', () => {
    for (const status of ['settled', 'unwound', 'cancelled'] as const) {
      const result = reduceDeal(dealState(status), { type: 'compliance_hold', reason: 'r' }, context());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(RejectionCode.terminalState);
      }
    }
  });
});
