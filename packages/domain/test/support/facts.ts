import { type CurrencyCode, type Money, money } from '@sdelka/money';
import {
  type DeadlinePolicy,
  type Instant,
  type TrancheContext,
  type TrancheFacts,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_DEADLINE_POLICY,
  instant,
} from '../../src/index';

export const NOW: Instant = instant(Date.UTC(2026, 8, 3, 10, 0, 0));

export const DEAL_ID = 'deal-1';
export const TRANCHE_ID = 'tranche-1';

export const AMOUNT: Money<CurrencyCode> = money('GEL', 1_000_000n);

/** Все пять полей выписки совпали (FUNCTIONAL.md §3.5). */
export const MATCHING_STATEMENT = {
  cadastralCode: true,
  ownerDocumentNumber: true,
  share: true,
  basis: true,
  noUnexpectedEncumbrances: true,
} as const;

export function facts(overrides: Partial<TrancheFacts> = {}): TrancheFacts {
  return {
    requiredAmount: AMOUNT,
    collectedAmount: AMOUNT,
    buyerPayerKey: 'buyer-1',
    evidenceBundleId: 'evidence-1',
    statementFields: MATCHING_STATEMENT,
    registryOwnerIsBuyer: true,
    beneficiary: { locked: true, lastChangedAt: null },
    preparedBy: 'operator-1',
    approvals: [],
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
    activePayouts: 0,
    coverageOk: true,
    sourceAccountKnown: true,
    mismatchResolved: true,
    ...overrides,
  };
}

export function context(
  overrides: Partial<TrancheFacts> = {},
  now: Instant = NOW,
  deadlinePolicy: DeadlinePolicy = DEFAULT_DEADLINE_POLICY,
): TrancheContext {
  return {
    now,
    dealId: DEAL_ID,
    trancheId: TRANCHE_ID,
    facts: facts(overrides),
    deadlinePolicy,
  };
}
