import { type CurrencyCode, type IsoDate, type Money, isoDate, money } from '@sdelka/money';
import {
  type ConditionAct,
  type DeadlinePolicy,
  type Instant,
  type PartyRef,
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

export const BUYER_PARTY_ID = 'party-buyer-1';
export const RECIPIENT_PARTY_ID = 'party-seller-1';

/**
 * Покупатель и получатель — по одному значению на каждого.
 *
 * Форма ключа счёта — алфавит `@sdelka/ledger` (`[A-Za-z0-9._-]`): двоеточие
 * там разделитель кода счёта, поэтому ключ личности приходит в учёт с точками.
 */
export const BUYER: PartyRef = Object.freeze({
  partyId: BUYER_PARTY_ID,
  accountKey: 'ge.passport.buyer-1',
});

export const RECIPIENT: PartyRef = Object.freeze({
  partyId: RECIPIENT_PARTY_ID,
  accountKey: 'ge.passport.seller-1',
});

/** Владелец обязательства по траншу — он же покупатель, он же плательщик. */
export const PAYER_CLIENT_KEY = BUYER.accountKey;
export const RECIPIENT_CLIENT_KEY = RECIPIENT.accountKey;

/**
 * Акт получателя об условии (CORE.md Ф13). Совершён до NOW: акт, датированный
 * будущим, не принимается.
 */
export const CONDITION_ACT: ConditionAct = Object.freeze({
  recipient: RECIPIENT,
  agreedAt: instant(Date.UTC(2026, 8, 3, 9, 0, 0)),
  conditionTextVersion: 'condition.registration_transfer.v1',
  conditionType: 'registration_transfer',
});

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
    buyer: BUYER,
    conditionAct: CONDITION_ACT,
    evidenceBundleId: 'evidence-1',
    statementFields: MATCHING_STATEMENT,
    registryOwnerIsBuyer: true,
    // Базовая фикстура описывает счастливый путь: владение счётом доказано.
    // `name_consistent` здесь поставить нельзя — это увело бы каждый тест в
    // отказ по `g_beneficiary_verified`; отдельные проверки статуса живут в
    // `beneficiary-status.test.ts`.
    beneficiary: { status: 'verified', locked: true, lastChangedAt: null },
    preparedBy: 'operator-1',
    // Нулевой ступени в лестнице нет: любая выплата требует человека, поэтому
    // базовая фикстура несёт одно утверждение. Утверждающий отличается от
    // готовившего операцию — это проверяет сам guard.
    approvals: [{ userId: 'approver-1' }],
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
