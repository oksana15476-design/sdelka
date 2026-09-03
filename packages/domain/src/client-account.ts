import { type CurrencyCode, type Money, compare, isPositive, money } from '@sdelka/money';
import type { Approval } from './guards';
import { withdrawalIdempotencyKey } from './ids';
import type { Instant } from './instant';
import { type Rejection, type Result, RejectionCode, failure, ok, rejection } from './result';
import type { PayoutOutcome, ReconciliationOutcome } from './tranche-events';

/**
 * Счёт клиента со стороны домена — CORE.md Ф14, ROADMAP.md И12.1–И12.4.
 *
 * Домен остатки **не считает**: их считает `@sdelka/ledger`
 * (`freeBalance`, `clientStatement`), домен читает готовое — ровно как с
 * `facts.coverageOk`. Здесь живут только решения: можно ли вывести, можно ли
 * направить свободные деньги на другую сделку, и в каком состоянии вывод.
 */

/**
 * Счёт-источник **движения**, а не личности (ROADMAP.md И12.2, крайний случай).
 *
 * Для денег, пришедших от расчёта по сделке, где клиент был получателем,
 * «счёт-источник» — это реквизиты выплаты того участия, а не карта, с которой он
 * когда-то платил как покупатель. Поэтому источник — свойство движения и
 * приходит в фактах вывода, а не выводится из профиля.
 */
export interface SourceAccountRef {
  /** Непрозрачный ключ реквизитов. Номера счёта в домене нет и быть не должно. */
  readonly accountRef: string;
  /**
   * Имя владельца счёта-источника совпадает с плательщиком.
   * FUNCTIONAL.md инвариант 20: возврат только на счёт-источник **на имя
   * плательщика**. Совпадения счёта недостаточно — счёт может быть чужим.
   */
  readonly holderIsPayer: boolean;
}

/** Часть остатка, запертая под конкретный транш, и до какого момента. */
export interface LockedPortion {
  readonly dealId: string;
  readonly trancheId: string;
  readonly amount: Money<CurrencyCode>;
  /** Отсечка **этой** сделки, а не «до расчёта» вообще (И12.1). */
  readonly until: Instant;
}

/**
 * Порог утверждений для вывода: две подписи (ROADMAP.md И12.2 — «поручение на
 * возврат через тот же ручной контур, что и выплата, две подписи»).
 *
 * ⚠ **[открыто]** Лестница `DEFAULT_APPROVAL_POLICY` привязана к сумме
 * **сделки**; у вывода сделки нет. Применяется ли лестница к сумме вывода или у
 * вывода фиксированные две подписи независимо от суммы — документом не задано.
 * Здесь выбрано фиксированное значение: оно строже лестницы на малых суммах и
 * никогда не мягче, то есть ошибка в эту сторону не стоит денег.
 */
export const WITHDRAWAL_REQUIRED_APPROVALS = 2;

export interface ClientAccountFacts {
  /** Свободная часть остатка. Считает ledger (`freeBalance`), домен читает. */
  readonly free: Money<CurrencyCode>;
  /** Запертые части: у каждой свой транш и своя отсечка. */
  readonly locked: readonly LockedPortion[];
  /** Сумма, которую просят вывести или направить на сделку. */
  readonly requestedAmount: Money<CurrencyCode>;
  /** `null` — счёт-источник неизвестен. Отказ закрытый, а не «куда-нибудь». */
  readonly sourceAccount: SourceAccountRef | null;
  /** Учётная запись, готовившая вывод: она не может быть утверждающей. */
  readonly preparedBy: string | null;
  readonly approvals: readonly Approval[];
  /** Число выводов этого клиента в активных статусах. */
  readonly activeWithdrawals: number;
}

/* ------------------------------------------------------------------------- */
/* Guard'ы вывода                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Guard'ы вывода — свой перечень, а не перечень транша: события и факты другие.
 * Имена совпадают там, где совпадает правило (`g_source_account_known` — это
 * тот же инвариант 20), и это намеренно: §9 требует единого словаря.
 *
 * ⚠ **`g_coverage_ok` здесь нет и не должно быть.** ROADMAP.md И12.2: при
 * остановке приёма новых сделок стоп-краном вывод и возвраты **продолжают
 * исполняться**, иначе стоп-кран превращается в удержание чужих денег (красная
 * линия №7). Это ровно то место, где guard однажды поставят «за компанию» —
 * `withdrawal.test.ts` держит на этом тест-надгробие.
 */
export const WITHDRAWAL_GUARD_IDS = [
  'g_free_balance_sufficient',
  'g_source_account_known',
  'g_approvals_sufficient',
  'g_withdrawal_approvers_distinct',
  'g_no_active_withdrawal',
] as const;

export type WithdrawalGuardId = (typeof WITHDRAWAL_GUARD_IDS)[number];

function distinctApprovers(facts: ClientAccountFacts): number {
  const approvers = new Set<string>();
  for (const approval of facts.approvals) {
    if (approval.userId !== facts.preparedBy) {
      approvers.add(approval.userId);
    }
  }
  return approvers.size;
}

export const WITHDRAWAL_GUARDS: Readonly<
  Record<WithdrawalGuardId, (facts: ClientAccountFacts) => boolean>
> = Object.freeze({
  /**
   * Свободного остатка хватает. Запертая часть в сравнении не участвует вовсе:
   * она лежит на другом счёте (`client:{клиент}:tranche:{сделка}:{транш}`), и
   * красная линия №1 держится этим, а не проверкой. Сравнение — в одной валюте:
   * остаток в другой валюте это не «мало», а «несравнимо», отказ закрытый.
   */
  g_free_balance_sufficient: (facts) => {
    if (facts.free.currency !== facts.requestedAmount.currency) return false;
    if (!isPositive(facts.requestedAmount)) return false;
    return compare(facts.free, facts.requestedAmount) >= 0;
  },
  // Инвариант 20: возврат только на счёт-источник, на имя плательщика.
  g_source_account_known: (facts) =>
    facts.sourceAccount !== null &&
    facts.sourceAccount.accountRef.length > 0 &&
    facts.sourceAccount.holderIsPayer,
  g_approvals_sufficient: (facts) => distinctApprovers(facts) >= WITHDRAWAL_REQUIRED_APPROVALS,
  g_withdrawal_approvers_distinct: (facts) => distinctApprovers(facts) === facts.approvals.length,
  g_no_active_withdrawal: (facts) => facts.activeWithdrawals === 0,
});

export function evaluateWithdrawalGuard(
  guard: WithdrawalGuardId,
  facts: ClientAccountFacts,
): boolean {
  return WITHDRAWAL_GUARDS[guard](facts);
}

/* ------------------------------------------------------------------------- */
/* Машина вывода                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Состояния вывода со счёта клиента.
 *
 * Исходящая нога не переизобретается: `paying_out` здесь означает ровно то же,
 * что у транша, — поручение ушло, исход ведёт машина «Выплата» (`payout.ts`) с
 * её легальным `unknown` и запретом повтора без сверки (§2.2). У вывода только
 * своё начало: остаток, источник и две подписи.
 */
export const WITHDRAWAL_STATUSES = [
  'requested',
  'approved',
  'paying_out',
  'paid_out',
  'blocked',
  'cancelled',
] as const;

export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

export const TERMINAL_WITHDRAWAL_STATUSES = ['paid_out', 'cancelled'] as const;

export type TerminalWithdrawalStatus = (typeof TERMINAL_WITHDRAWAL_STATUSES)[number];

export function isTerminalWithdrawalStatus(
  status: WithdrawalStatus,
): status is TerminalWithdrawalStatus {
  return (TERMINAL_WITHDRAWAL_STATUSES as readonly string[]).includes(status);
}

export type WithdrawalEvent =
  | { readonly type: 'withdrawal_approved' }
  | { readonly type: 'withdrawal_blocked'; readonly reason: string }
  | { readonly type: 'withdrawal_dispatched' }
  | { readonly type: 'withdrawal_cancelled' }
  | { readonly type: 'payout_result'; readonly outcome: PayoutOutcome }
  | { readonly type: 'reconciliation_resolved'; readonly outcome: ReconciliationOutcome };

export type WithdrawalEventType = WithdrawalEvent['type'];

export interface WithdrawalTransition {
  readonly from: WithdrawalStatus;
  readonly to: WithdrawalStatus;
  readonly event: WithdrawalEventType;
  readonly guards: readonly WithdrawalGuardId[];
  readonly negatedGuards: readonly WithdrawalGuardId[];
  readonly outcome: PayoutOutcome | null;
}

function transition(
  from: WithdrawalStatus,
  event: WithdrawalEventType,
  to: WithdrawalStatus,
  guards: readonly WithdrawalGuardId[] = [],
  negatedGuards: readonly WithdrawalGuardId[] = [],
  outcome: PayoutOutcome | null = null,
): WithdrawalTransition {
  return Object.freeze({ from, to, event, guards, negatedGuards, outcome });
}

const APPROVAL_GUARDS: readonly WithdrawalGuardId[] = [
  'g_free_balance_sufficient',
  'g_source_account_known',
  'g_approvals_sufficient',
  'g_withdrawal_approvers_distinct',
];

export const WITHDRAWAL_TRANSITIONS: readonly WithdrawalTransition[] = Object.freeze([
  transition('requested', 'withdrawal_approved', 'approved', APPROVAL_GUARDS),
  // Счёт-источник неизвестен — вывод не создаётся, задача уходит оператору с
  // причиной (И12.2). Та же форма, что у `refund_pending → release_blocked` у
  // транша: неизвестный источник это не отказ клиенту, а работа человека.
  transition('requested', 'withdrawal_approved', 'blocked', [], ['g_source_account_known']),
  transition('requested', 'withdrawal_blocked', 'blocked'),
  transition('requested', 'withdrawal_cancelled', 'cancelled'),

  transition('approved', 'withdrawal_dispatched', 'paying_out', ['g_no_active_withdrawal']),
  transition('approved', 'withdrawal_blocked', 'blocked'),
  transition('approved', 'withdrawal_cancelled', 'cancelled'),

  transition('paying_out', 'payout_result', 'paid_out', [], [], 'settled'),
  transition('paying_out', 'payout_result', 'blocked', [], [], 'rejected'),
  // «Неизвестно» оставляет вывод здесь: повтор запрещён без сверки (§2.2).
  transition('paying_out', 'payout_result', 'paying_out', [], [], 'unknown'),
  transition('paying_out', 'reconciliation_resolved', 'paid_out', [], [], 'settled'),
  transition('paying_out', 'reconciliation_resolved', 'blocked', [], [], 'rejected'),

  transition('blocked', 'withdrawal_approved', 'approved', APPROVAL_GUARDS),
  transition('blocked', 'withdrawal_cancelled', 'cancelled'),
]);

export interface WithdrawalState {
  readonly status: WithdrawalStatus;
  readonly withdrawalId: string;
  /** Ключ детерминирован по выводу: ни попытки, ни времени в нём нет. */
  readonly idempotencyKey: string;
}

export function createWithdrawal(withdrawalId: string): WithdrawalState {
  return Object.freeze({
    status: 'requested',
    withdrawalId,
    idempotencyKey: withdrawalIdempotencyKey(withdrawalId),
  });
}

export interface WithdrawalTransitionResult {
  readonly state: WithdrawalState;
  readonly failedGuards: readonly WithdrawalGuardId[];
}

function eventOutcome(event: WithdrawalEvent): PayoutOutcome | null {
  if (event.type === 'payout_result') return event.outcome;
  if (event.type === 'reconciliation_resolved') return event.outcome;
  return null;
}

export function reduceWithdrawal(
  state: WithdrawalState,
  event: WithdrawalEvent,
  facts: ClientAccountFacts,
): Result<WithdrawalTransitionResult, Rejection> {
  if (isTerminalWithdrawalStatus(state.status)) {
    return failure(rejection(RejectionCode.terminalState, [], { status: state.status }));
  }
  const outcome = eventOutcome(event);
  const candidates = WITHDRAWAL_TRANSITIONS.filter(
    (item) =>
      item.from === state.status && item.event === event.type && item.outcome === outcome,
  );
  if (candidates.length === 0) {
    return failure(
      rejection(RejectionCode.transitionNotAllowed, [], {
        status: state.status,
        event: event.type,
      }),
    );
  }
  let firstFailure: readonly WithdrawalGuardId[] = [];
  for (const candidate of candidates) {
    const failed: WithdrawalGuardId[] = [];
    for (const guard of candidate.guards) {
      if (!evaluateWithdrawalGuard(guard, facts)) failed.push(guard);
    }
    for (const guard of candidate.negatedGuards) {
      if (evaluateWithdrawalGuard(guard, facts)) failed.push(guard);
    }
    if (failed.length > 0) {
      if (firstFailure.length === 0) firstFailure = failed;
      continue;
    }
    return ok({
      state: Object.freeze({ ...state, status: candidate.to }),
      failedGuards: Object.freeze([]),
    });
  }
  return failure(
    rejection(RejectionCode.guardFailed, firstFailure, {
      status: state.status,
      event: event.type,
    }),
  );
}

/* ------------------------------------------------------------------------- */
/* Движение свободного остатка на другую сделку (И12.4)                      */
/* ------------------------------------------------------------------------- */

export interface AllocationRequest {
  readonly dealId: string;
  readonly trancheId: string;
  readonly amount: Money<CurrencyCode>;
}

/**
 * Направить свободные деньги на свою сделку — И12.4.
 *
 * Функция смотрит **только** на свободную часть. Запертая под сделку А часть на
 * сделку Б не пойдёт не потому, что здесь стоит проверка, а потому, что она
 * лежит на другом счёте и в это сравнение не входит: красная линия №1 говорит
 * про обязательства, а не про людей, и свой собственный резерв на свою вторую
 * сделку не идёт — сделка А может откатиться, и деньги обязаны вернуться.
 *
 * Отказ при недостатке свободного остатка обязателен именно **на момент
 * применения**: И12.2 задаёт порядок «резерв выигрывает, вывод создаётся на
 * остаток после резерва», и между запросом и применением свободная часть могла
 * уменьшиться.
 */
export function planAllocationToDeal(
  facts: ClientAccountFacts,
  request: AllocationRequest,
): Result<AllocationRequest, Rejection> {
  if (facts.requestedAmount.currency !== request.amount.currency) {
    return failure(rejection(RejectionCode.guardFailed, ['g_free_balance_sufficient'], {
      reason: 'currency_mismatch',
    }));
  }
  if (compare(facts.requestedAmount, request.amount) !== 0) {
    // Запрос и факты обязаны говорить об одной сумме: иначе проверка остатка
    // относилась бы к одному числу, а движение — к другому.
    return failure(rejection(RejectionCode.guardFailed, ['g_free_balance_sufficient'], {
      reason: 'amount_mismatch',
    }));
  }
  if (!evaluateWithdrawalGuard('g_free_balance_sufficient', facts)) {
    return failure(
      rejection(RejectionCode.guardFailed, ['g_free_balance_sufficient'], {
        dealId: request.dealId,
        trancheId: request.trancheId,
      }),
    );
  }
  return ok(request);
}

/**
 * Сумма запертого по одной валюте. Пересчёта между валютами здесь нет: И12.1
 * требует показывать обе величины, а не приводить одну к другой «для удобства».
 */
export function lockedTotal(
  facts: ClientAccountFacts,
  currency: CurrencyCode,
): Money<CurrencyCode> {
  const minor = facts.locked
    .filter((portion) => portion.amount.currency === currency)
    .reduce((total, portion) => total + portion.amount.minor, 0n);
  return money(currency, minor);
}
