import { type ConditionAct, isConditionActValid } from './condition-act';
import type { Instant } from './instant';
import type { Intent } from './intents';
import { RELEASE_CONDITIONS } from './release-condition';
import { type Rejection, type Result, RejectionCode, failure, ok, rejection } from './result';
import type { ReleaseConditionType } from './release-condition';
import { type TrancheStatus, isTerminalTrancheStatus } from './tranche';

/** Состояния сделки — STATE-MACHINES.md §3.1, включая `funding` между `ready` и `funded`. */
export const DEAL_STATUSES = [
  'draft',
  'parties_pending',
  'property_pending',
  'ready',
  'funding',
  'funded',
  'filed',
  'settling',
  'settled',
  'unwinding',
  'unwound',
  'cancelled',
  'frozen',
] as const;

export type DealStatus = (typeof DEAL_STATUSES)[number];

export const TERMINAL_DEAL_STATUSES = ['settled', 'unwound', 'cancelled'] as const;

export type TerminalDealStatus = (typeof TERMINAL_DEAL_STATUSES)[number];

export function isTerminalDealStatus(status: DealStatus): status is TerminalDealStatus {
  return (TERMINAL_DEAL_STATUSES as readonly string[]).includes(status);
}

/**
 * События сделки. §3.2 задаёт большинство переходов условием в скобках и не
 * называет события; имена ниже введены кодом и вынесены в отчёт.
 */
export type DealEvent =
  | { readonly type: 'parties_check_started' }
  | { readonly type: 'parties_verified' }
  | { readonly type: 'property_verified' }
  | { readonly type: 'funds_received' }
  | { readonly type: 'tranches_reserved' }
  | { readonly type: 'filing_registered'; readonly applicationId: string }
  | { readonly type: 'condition_established'; readonly conditionType: ReleaseConditionType }
  | { readonly type: 'condition_failed' }
  | { readonly type: 'deadline_reached' }
  | { readonly type: 'revocation_requested' }
  | { readonly type: 'tranches_settled' }
  | { readonly type: 'tranches_refunded' }
  | { readonly type: 'compliance_hold'; readonly reason: string }
  | { readonly type: 'dispute_raised'; readonly reason: string }
  | {
      readonly type: 'unfreeze';
      readonly userIds: readonly string[];
      readonly resume: 'settling' | 'unwinding';
    }
  | { readonly type: 'cancellation_requested' };

export type DealEventType = DealEvent['type'];

export const DEAL_GUARD_IDS = [
  /**
   * Акт получателя об условии совершён — CORE.md Ф13. Стоит на `ready →
   * funding`: сделка не открывает приём средств, пока получатель не определил
   * обстоятельство. Тот же guard стоит на `pending → collecting` у транша —
   * деньги приходят по траншу, а состояние сделки двигается первым поступлением,
   * и закрыть нужно оба входа.
   */
  'g_condition_agreed',
  'g_all_tranches_reserved',
  'g_all_tranches_paid_out',
  'g_all_tranches_refunded',
  'g_no_live_tranche',
  'g_unfreeze_approvers_distinct',
] as const;

export type DealGuardId = (typeof DEAL_GUARD_IDS)[number];

export interface DealFacts {
  readonly trancheStatuses: readonly TrancheStatus[];
  /** Учётная запись, готовившая заморозку: разморозка невозможна ею же. */
  readonly preparedBy: string | null;
  /** Акт получателя об условии (CORE.md Ф13). `null` — приём средств закрыт. */
  readonly conditionAct: ConditionAct | null;
}

export interface DealContext {
  readonly dealId: string;
  readonly facts: DealFacts;
  /** Нужен для проверки акта: акт, датированный будущим, не принимается. */
  readonly now: Instant;
}

const DEAL_GUARDS: Readonly<
  Record<DealGuardId, (facts: DealFacts, event: DealEvent, now: Instant) => boolean>
> = Object.freeze({
  g_condition_agreed: (facts, _event, now) => isConditionActValid(facts.conditionAct, now),
  g_all_tranches_reserved: (facts) =>
    facts.trancheStatuses.length > 0 &&
    facts.trancheStatuses.every((status) => status === 'reserved'),
  g_all_tranches_paid_out: (facts) =>
    facts.trancheStatuses.length > 0 &&
    facts.trancheStatuses.every((status) => status === 'paid_out'),
  g_all_tranches_refunded: (facts) =>
    facts.trancheStatuses.length > 0 &&
    facts.trancheStatuses.every((status) => status === 'refunded'),
  // §3.3: сделка не закрывается, пока жив хотя бы один транш.
  g_no_live_tranche: (facts) => facts.trancheStatuses.every(isTerminalTrancheStatus),
  g_unfreeze_approvers_distinct: (facts, event) => {
    if (event.type !== 'unfreeze') return false;
    const approvers = new Set(event.userIds.filter((userId) => userId !== facts.preparedBy));
    return approvers.size >= 2;
  },
});

export interface DealTransition {
  readonly from: DealStatus;
  readonly to: DealStatus;
  readonly event: DealEventType;
  readonly guards: readonly DealGuardId[];
  /** Различитель для `unfreeze`: документ разрешает два исхода. */
  readonly resume: 'settling' | 'unwinding' | null;
}

function transition(
  from: DealStatus,
  event: DealEventType,
  to: DealStatus,
  guards: readonly DealGuardId[] = [],
  resume: 'settling' | 'unwinding' | null = null,
): DealTransition {
  return Object.freeze({ from, to, event, guards, resume });
}

const NON_TERMINAL_DEAL_STATUSES = DEAL_STATUSES.filter(
  (status) => !isTerminalDealStatus(status) && status !== 'frozen',
);

/**
 * Отмена разрешена только до внесения денег.
 *
 * Расхождение внутри документа: §3.2 пишет «любое до funded → cancelled», что
 * включает `funding`, а §3.1 определяет `cancelled` как «отменена до внесения
 * денег». В `funding` деньги уже внесены. Выбрана формулировка §3.1: из
 * `funding` выход — `unwinding` с возвратом покупателю (красная линия №7).
 */
const CANCELLABLE_DEAL_STATUSES: readonly DealStatus[] = [
  'draft',
  'parties_pending',
  'property_pending',
  'ready',
];

export const DEAL_TRANSITIONS: readonly DealTransition[] = Object.freeze([
  transition('draft', 'parties_check_started', 'parties_pending'),
  transition('parties_pending', 'parties_verified', 'property_pending'),
  transition('property_pending', 'property_verified', 'ready'),
  transition('ready', 'funds_received', 'funding', ['g_condition_agreed']),
  transition('funding', 'tranches_reserved', 'funded', ['g_all_tranches_reserved']),
  transition('funding', 'deadline_reached', 'unwinding'),
  transition('funding', 'revocation_requested', 'unwinding'),
  transition('funded', 'filing_registered', 'filed'),
  transition('filed', 'condition_established', 'settling'),
  transition('filed', 'condition_failed', 'unwinding'),
  transition('filed', 'deadline_reached', 'unwinding'),
  transition('settling', 'tranches_settled', 'settled', ['g_all_tranches_paid_out', 'g_no_live_tranche']),
  transition('unwinding', 'tranches_refunded', 'unwound', ['g_all_tranches_refunded', 'g_no_live_tranche']),
  ...NON_TERMINAL_DEAL_STATUSES.map((status) => transition(status, 'compliance_hold', 'frozen')),
  ...NON_TERMINAL_DEAL_STATUSES.map((status) => transition(status, 'dispute_raised', 'frozen')),
  transition('frozen', 'unfreeze', 'settling', ['g_unfreeze_approvers_distinct'], 'settling'),
  transition('frozen', 'unfreeze', 'unwinding', ['g_unfreeze_approvers_distinct'], 'unwinding'),
  ...CANCELLABLE_DEAL_STATUSES.map((status) =>
    transition(status, 'cancellation_requested', 'cancelled'),
  ),
]);

export interface DealState {
  readonly status: DealStatus;
}

export function dealState(status: DealStatus): DealState {
  return Object.freeze({ status });
}

export const initialDealState: DealState = dealState('draft');

export interface DealTransitionResult {
  readonly state: DealState;
  readonly intents: readonly Intent[];
}

export function reduceDeal(
  state: DealState,
  event: DealEvent,
  context: DealContext,
): Result<DealTransitionResult, Rejection> {
  if (isTerminalDealStatus(state.status)) {
    return failure(rejection(RejectionCode.terminalState, [], { status: state.status }));
  }
  if (event.type === 'condition_established') {
    const meta = RELEASE_CONDITIONS[event.conditionType];
    if (meta === undefined) {
      return failure(
        rejection(RejectionCode.releaseConditionUnknown, [], { conditionType: event.conditionType }),
      );
    }
    if (meta.requiresConfirmation) {
      return failure(
        rejection(RejectionCode.releaseConditionRequiresConfirmation, [], {
          conditionType: event.conditionType,
        }),
      );
    }
  }
  const resume = event.type === 'unfreeze' ? event.resume : null;
  const candidates = DEAL_TRANSITIONS.filter(
    (item) => item.from === state.status && item.event === event.type && item.resume === resume,
  );
  if (candidates.length === 0) {
    return failure(
      rejection(RejectionCode.transitionNotAllowed, [], {
        status: state.status,
        event: event.type,
      }),
    );
  }
  let firstFailure: readonly DealGuardId[] = [];
  for (const candidate of candidates) {
    const failed = candidate.guards.filter(
      (guard) => !DEAL_GUARDS[guard](context.facts, event, context.now),
    );
    if (failed.length > 0) {
      if (firstFailure.length === 0) firstFailure = failed;
      continue;
    }
    return ok({ state: dealState(candidate.to), intents: Object.freeze([]) });
  }
  return failure(
    rejection(RejectionCode.guardFailed, firstFailure, {
      status: state.status,
      event: event.type,
    }),
  );
}
