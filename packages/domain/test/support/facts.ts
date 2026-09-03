import { type CurrencyCode, type IsoDate, type Money, isoDate, money } from '@sdelka/money';
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

/** Дата создания транша: к ней привязан курс пересчёта порогов (§4.3.1). */
export const CREATED_ON: IsoDate = isoDate('2026-09-03');

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
    createdOn: CREATED_ON,
    // Транш в лари: пересчитывать нечего, курс не нужен (§4.3.1).
    officialRateAtCreation: null,
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
