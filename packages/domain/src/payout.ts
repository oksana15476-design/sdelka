import { payoutIdempotencyKey } from './ids';
import type { Intent } from './intents';
import { type Rejection, type Result, RejectionCode, failure, ok, rejection } from './result';

/** Состояния выплаты — STATE-MACHINES.md §2.1. */
export const PAYOUT_STATUSES = ['created', 'submitted', 'settled', 'rejected', 'unknown'] as const;

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const TERMINAL_PAYOUT_STATUSES = ['settled', 'rejected'] as const;

export type TerminalPayoutStatus = (typeof TERMINAL_PAYOUT_STATUSES)[number];

export function isTerminalPayoutStatus(status: PayoutStatus): status is TerminalPayoutStatus {
  return (TERMINAL_PAYOUT_STATUSES as readonly string[]).includes(status);
}

/**
 * События выплаты. Сетевые исходы (`timeout`, `network_error`, `response_lost`)
 * ведут только в `unknown`: ни один адаптер не возвращает `rejected` при сетевой
 * ошибке — отказ это явный ответ провайдера, а не отсутствие ответа (§2.2).
 */
export type PayoutEvent =
  | { readonly type: 'payout_submitted' }
  | { readonly type: 'provider_confirms' }
  | { readonly type: 'provider_rejects' }
  | { readonly type: 'timeout' }
  | { readonly type: 'network_error' }
  | { readonly type: 'response_lost' }
  | { readonly type: 'reconciliation_found_in_statement' }
  | { readonly type: 'reconciliation_absent_from_statement' };

export type PayoutEventType = PayoutEvent['type'];

export interface PayoutState {
  readonly status: PayoutStatus;
  /** Ключ детерминирован по траншу: ни попытки, ни времени в нём нет. */
  readonly idempotencyKey: string;
  readonly trancheId: string;
}

export interface PayoutTransition {
  readonly from: PayoutStatus;
  readonly to: PayoutStatus;
  readonly event: PayoutEventType;
}

const t = (from: PayoutStatus, event: PayoutEventType, to: PayoutStatus): PayoutTransition =>
  Object.freeze({ from, event, to });

/**
 * Таблица переходов выплаты.
 *
 * Из `unknown` нет перехода в `created` или `submitted`, и это выражено
 * отсутствием строки в таблице, а не проверкой в обработчике: обработчик можно
 * обойти новым вызовом, таблицу — нет. Это единственная защита от двойной
 * выплаты при сетевом сбое (§2.2, §4).
 */
export const PAYOUT_TRANSITIONS: readonly PayoutTransition[] = Object.freeze([
  t('created', 'payout_submitted', 'submitted'),
  t('submitted', 'provider_confirms', 'settled'),
  t('submitted', 'provider_rejects', 'rejected'),
  t('submitted', 'timeout', 'unknown'),
  t('submitted', 'network_error', 'unknown'),
  t('submitted', 'response_lost', 'unknown'),
  t('unknown', 'reconciliation_found_in_statement', 'settled'),
  t('unknown', 'reconciliation_absent_from_statement', 'rejected'),
]);

/**
 * Активные статусы выплаты. `unknown` — активный: пока сверка не сказала
 * обратного, деньги, возможно, ушли, и вторая выплата по тому же траншу
 * запрещена (FUNCTIONAL.md инвариант 9, STATE-MACHINES.md §4).
 */
export const ACTIVE_PAYOUT_STATUSES = ['created', 'submitted', 'unknown'] as const;

export function isActivePayout(state: PayoutState): boolean {
  return (ACTIVE_PAYOUT_STATUSES as readonly string[]).includes(state.status);
}

export function activePayoutsForTranche(
  payouts: readonly PayoutState[],
  trancheId: string,
): readonly PayoutState[] {
  return payouts.filter((payout) => payout.trancheId === trancheId && isActivePayout(payout));
}

/** Больше одной активной выплаты по траншу — нарушение, а не редкость. */
export function violatesSingleActivePayout(
  payouts: readonly PayoutState[],
  trancheId: string,
): boolean {
  return activePayoutsForTranche(payouts, trancheId).length > 1;
}

export function createPayout(trancheId: string): PayoutState {
  return Object.freeze({
    status: 'created',
    idempotencyKey: payoutIdempotencyKey(trancheId),
    trancheId,
  });
}

export interface PayoutTransitionResult {
  readonly state: PayoutState;
  /** У выплаты нет действий при входе: их держит транш. Форма общая ради журнала команд. */
  readonly intents: readonly Intent[];
}

export function reducePayout(
  state: PayoutState,
  event: PayoutEvent,
): Result<PayoutTransitionResult, Rejection> {
  if (isTerminalPayoutStatus(state.status)) {
    return failure(rejection(RejectionCode.terminalState, [], { status: state.status }));
  }
  const candidate = PAYOUT_TRANSITIONS.find(
    (item) => item.from === state.status && item.event === event.type,
  );
  if (candidate === undefined) {
    return failure(
      rejection(RejectionCode.transitionNotAllowed, [], {
        status: state.status,
        event: event.type,
      }),
    );
  }
  return ok({
    state: Object.freeze({
      status: candidate.to,
      idempotencyKey: state.idempotencyKey,
      trancheId: state.trancheId,
    }),
    intents: Object.freeze([]),
  });
}
