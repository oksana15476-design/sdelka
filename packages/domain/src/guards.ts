import { type CurrencyCode, type Money, compare } from '@sdelka/money';
import { type Instant, HOUR } from './instant';
import type { TrancheEvent } from './tranche-events';

/**
 * Guard'ы транша — STATE-MACHINES.md §1.3, идентификаторы буква в букву.
 *
 * Два guard'а помечены как введённые кодом: документ формулирует условие прозой
 * («расхождение снято», «два разных пользователя») и не даёт ему имени. Имя
 * нужно, чтобы условие было тестируемо поимённо, как требует §7.
 */
export const GUARD_IDS = [
  'g_amount_sufficient',
  'g_payer_matches',
  'g_evidence_present',
  'g_fields_match',
  'g_owner_matches',
  'g_approvals_sufficient',
  'g_beneficiary_locked',
  'g_no_active_payout',
  'g_coverage_ok',
  'g_source_account_known',
  /** введено кодом: §1.4 «release_blocked → release_pending on approval_added ∧ расхождение снято» */
  'g_mismatch_resolved',
  /** введено кодом: §1.4 «write_off_approved(два разных пользователя)» */
  'g_write_off_approvers_distinct',
] as const;

export type GuardId = (typeof GUARD_IDS)[number];

/** Пять полей выписки из FUNCTIONAL.md §3.5. Проверяются поимённо, а не счётчиком. */
export interface StatementFields {
  readonly cadastralCode: boolean;
  /** Собственник сверяется по номеру документа, не по имени: латинизация необратима. */
  readonly ownerDocumentNumber: boolean;
  readonly share: boolean;
  readonly basis: boolean;
  readonly noUnexpectedEncumbrances: boolean;
}

export interface BeneficiaryLock {
  readonly locked: boolean;
  readonly lastChangedAt: Instant | null;
}

export interface ApprovalTier {
  /** Верхняя граница включительно в минорных единицах; `null` — всё, что выше. */
  readonly upToMinor: bigint | null;
  /** `null` — сумма не берётся вообще (FUNCTIONAL.md §3.5: свыше 500 000 ₾ на пилоте не берём). */
  readonly requiredApprovals: number | null;
}

export interface ApprovalPolicy {
  readonly currency: CurrencyCode;
  readonly tiers: readonly ApprovalTier[];
}

/** Пороги утверждения из FUNCTIONAL.md §3.5, в тетри. */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = Object.freeze({
  currency: 'GEL',
  tiers: Object.freeze([
    Object.freeze({ upToMinor: 3_000_000n, requiredApprovals: 0 }),
    Object.freeze({ upToMinor: 15_000_000n, requiredApprovals: 1 }),
    Object.freeze({ upToMinor: 50_000_000n, requiredApprovals: 2 }),
    Object.freeze({ upToMinor: null, requiredApprovals: null }),
  ]),
});

/** Период охлаждения реквизитов: 72 часа (FUNCTIONAL.md инвариант 18). */
export const BENEFICIARY_COOLDOWN_MS = 72 * HOUR;

export interface Approval {
  readonly userId: string;
}

/**
 * Факты, на которых стоят guard'ы. Домен их не добывает: реестр, банк и
 * учёт — за портами. Здесь только значения, приведённые к решению.
 */
export interface TrancheFacts {
  readonly requiredAmount: Money<CurrencyCode>;
  readonly collectedAmount: Money<CurrencyCode> | null;
  /** Ключ плательщика-покупателя, с которым сверяется отправитель платежа. */
  readonly buyerPayerKey: string;
  readonly evidenceBundleId: string | null;
  readonly statementFields: StatementFields;
  readonly ownerDocumentMatches: boolean;
  readonly beneficiary: BeneficiaryLock;
  /** Учётная запись, готовившая операцию: она не может быть утверждающей. */
  readonly preparedBy: string | null;
  readonly approvals: readonly Approval[];
  readonly approvalPolicy: ApprovalPolicy;
  readonly activePayouts: number;
  /** Результат проверки покрытия из учёта: считает ledger, домен только читает. */
  readonly coverageOk: boolean;
  readonly sourceAccountKnown: boolean;
  readonly mismatchResolved: boolean;
}

export interface GuardInput {
  readonly facts: TrancheFacts;
  readonly event: TrancheEvent;
  readonly now: Instant;
}

function requiredApprovals(policy: ApprovalPolicy, amount: Money<CurrencyCode>): number | null {
  if (amount.currency !== policy.currency) {
    // Fail-closed: пороги заданы в одной валюте, пересчёт по курсу здесь
    // означал бы, что порог утверждения плавает вместе с рынком.
    return null;
  }
  for (const tier of policy.tiers) {
    if (tier.upToMinor === null || amount.minor <= tier.upToMinor) {
      return tier.requiredApprovals;
    }
  }
  return null;
}

function distinctApprovers(facts: TrancheFacts): number {
  const approvers = new Set<string>();
  for (const approval of facts.approvals) {
    if (approval.userId !== facts.preparedBy) {
      approvers.add(approval.userId);
    }
  }
  return approvers.size;
}

export const GUARDS: Readonly<Record<GuardId, (input: GuardInput) => boolean>> = Object.freeze({
  g_amount_sufficient: ({ facts, event }) => {
    if (event.type !== 'funds_received') return false;
    if (event.amount.currency !== facts.requiredAmount.currency) return false;
    return compare(event.amount, facts.requiredAmount) >= 0;
  },
  g_payer_matches: ({ facts, event }) => {
    if (event.type !== 'funds_received') return false;
    // Инвариант 19: несовпадение имени отправителя — удержание при любой сумме.
    return event.sender === facts.buyerPayerKey;
  },
  g_evidence_present: ({ facts }) =>
    facts.evidenceBundleId !== null && facts.evidenceBundleId.length > 0,
  g_fields_match: ({ facts }) =>
    facts.statementFields.cadastralCode &&
    facts.statementFields.ownerDocumentNumber &&
    facts.statementFields.share &&
    facts.statementFields.basis &&
    facts.statementFields.noUnexpectedEncumbrances,
  g_owner_matches: ({ facts }) => facts.ownerDocumentMatches,
  g_approvals_sufficient: ({ facts }) => {
    const required = requiredApprovals(facts.approvalPolicy, facts.requiredAmount);
    if (required === null) return false;
    return distinctApprovers(facts) >= required;
  },
  g_beneficiary_locked: ({ facts, now }) => {
    if (!facts.beneficiary.locked) return false;
    const changedAt = facts.beneficiary.lastChangedAt;
    if (changedAt === null) return true;
    return now - changedAt >= BENEFICIARY_COOLDOWN_MS;
  },
  g_no_active_payout: ({ facts }) => facts.activePayouts === 0,
  g_coverage_ok: ({ facts }) => facts.coverageOk,
  g_source_account_known: ({ facts }) => facts.sourceAccountKnown,
  g_mismatch_resolved: ({ facts }) => facts.mismatchResolved,
  g_write_off_approvers_distinct: ({ facts, event }) => {
    if (event.type !== 'write_off_approved') return false;
    const approvers = new Set(event.userIds.filter((userId) => userId !== facts.preparedBy));
    return approvers.size >= 2;
  },
});

export function evaluateGuard(guard: GuardId, input: GuardInput): boolean {
  return GUARDS[guard](input);
}
