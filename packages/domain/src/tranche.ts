import type { CurrencyCode, Money } from '@sdelka/money';
import { type GuardId, type GuardInput, type TrancheFacts, evaluateGuard } from './guards';
import { payoutIdempotencyKey } from './ids';
import {
  type Deadline,
  type DurationMs,
  type Instant,
  DAY,
  HOUR,
  deadline,
  plus,
} from './instant';
import type { Intent, LedgerTemplate } from './intents';
import { RELEASE_CONDITIONS } from './release-condition';
import { type Rejection, type Result, RejectionCode, failure, ok, rejection } from './result';
import type { PayoutOutcome, TrancheEvent, TrancheEventType } from './tranche-events';

/** Состояния транша — STATE-MACHINES.md §1.1. */
export const TRANCHE_STATUSES = [
  'pending',
  'collecting',
  'collected',
  'reserved',
  'release_pending',
  'release_blocked',
  'paying_out',
  'paid_out',
  'refund_pending',
  'refunding',
  'refunded',
  'written_off',
] as const;

export type TrancheStatus = (typeof TRANCHE_STATUSES)[number];

export const TERMINAL_TRANCHE_STATUSES = ['paid_out', 'refunded', 'written_off'] as const;

export type TerminalTrancheStatus = (typeof TERMINAL_TRANCHE_STATUSES)[number];
export type NonTerminalTrancheStatus = Exclude<TrancheStatus, TerminalTrancheStatus>;

export function isTerminalTrancheStatus(status: TrancheStatus): status is TerminalTrancheStatus {
  return (TERMINAL_TRANCHE_STATUSES as readonly string[]).includes(status);
}

/**
 * Состояние транша. Дедлайн лежит внутри нетерминального варианта, поэтому
 * «нетерминальное состояние без дедлайна» невозможно собрать — это структура,
 * а не проверка (FUNCTIONAL.md инвариант 7, STATE-MACHINES.md §4).
 */
export type TrancheState =
  | { readonly status: NonTerminalTrancheStatus; readonly deadline: Deadline }
  | { readonly status: TerminalTrancheStatus };

export function nonTerminalTrancheState(
  status: NonTerminalTrancheStatus,
  at: Deadline,
): TrancheState {
  return Object.freeze({ status, deadline: at });
}

export function terminalTrancheState(status: TerminalTrancheStatus): TrancheState {
  return Object.freeze({ status });
}

export type DeadlinePolicy = Readonly<Record<NonTerminalTrancheStatus, DurationMs>>;

/**
 * Сроки жизни нетерминальных состояний. Значения — рабочее умолчание, не норма:
 * продуктовые окна (отсечка рабочего дня, ежедневная сверка) задаются политикой,
 * а не зашиты в автомат.
 */
export const DEFAULT_DEADLINE_POLICY: DeadlinePolicy = Object.freeze({
  pending: DAY,
  collecting: (3 * DAY) as DurationMs,
  collected: DAY,
  reserved: DAY,
  release_pending: (4 * HOUR) as DurationMs,
  release_blocked: DAY,
  // paying_out и refunding выходят по ответу провайдера или по ежедневной
  // сверке — не позднее следующего дня (STATE-MACHINES.md §5).
  paying_out: DAY,
  refunding: DAY,
  refund_pending: DAY,
});

export interface TrancheContext {
  readonly now: Instant;
  readonly dealId: string;
  readonly trancheId: string;
  readonly facts: TrancheFacts;
  readonly deadlinePolicy: DeadlinePolicy;
}

export interface TrancheTransition {
  readonly from: TrancheStatus;
  readonly to: TrancheStatus;
  readonly event: TrancheEventType;
  readonly guards: readonly GuardId[];
  /** Guard'ы, которые обязаны НЕ выполниться: «¬g_payer_matches» из §1.4. */
  readonly negatedGuards: readonly GuardId[];
  /** Различитель исхода для `payout_result` и `reconciliation_resolved`. */
  readonly outcome: PayoutOutcome | null;
}

function transition(
  from: TrancheStatus,
  event: TrancheEventType,
  to: TrancheStatus,
  guards: readonly GuardId[] = [],
  negatedGuards: readonly GuardId[] = [],
  outcome: PayoutOutcome | null = null,
): TrancheTransition {
  return Object.freeze({ from, to, event, guards, negatedGuards, outcome });
}

const EVIDENCE_GUARDS: readonly GuardId[] = [
  'g_evidence_present',
  'g_fields_match',
  'g_owner_matches',
  'g_beneficiary_locked',
];

/**
 * Таблица переходов — STATE-MACHINES.md §1.4.
 *
 * Guard'ы доказательств продублированы на `release_pending → paying_out`
 * намеренно. Без этого существует путь `collecting → release_blocked →
 * release_pending → paying_out`: платёж третьего лица уходит в блокировку и
 * выходит оттуда по утверждению оператора мимо проверки пакета доказательств,
 * совпадения полей и сверки собственника. Guard, стоящий только на одном входе
 * в состояние, не защищает состояние (§1.4, §4).
 */
export const TRANCHE_TRANSITIONS: readonly TrancheTransition[] = Object.freeze([
  transition('pending', 'instructions_issued', 'collecting'),

  transition('collecting', 'funds_received', 'collected', ['g_amount_sufficient', 'g_payer_matches']),
  // Платёж третьего лица: деньги не зачисляются на сделку, разбор комплаенсом.
  transition('collecting', 'funds_received', 'release_blocked', [], ['g_payer_matches']),
  transition('collecting', 'deadline_reached', 'refund_pending'),
  // [решение] §1.4: отзыв принимается из collecting, collected, reserved.
  transition('collecting', 'revocation_requested', 'refund_pending'),

  transition('collected', 'reserve_requested', 'reserved'),
  transition('collected', 'refund_requested', 'refund_pending'),
  transition('collected', 'deadline_reached', 'refund_pending'),
  transition('collected', 'revocation_requested', 'refund_pending'),

  transition('reserved', 'condition_established', 'release_pending', EVIDENCE_GUARDS),
  transition('reserved', 'mismatch_detected', 'release_blocked'),
  transition('reserved', 'reserve_expired', 'collected'),
  transition('reserved', 'condition_failed', 'refund_pending'),
  transition('reserved', 'revocation_requested', 'refund_pending'),

  transition('release_pending', 'release_authorized', 'paying_out', [
    ...EVIDENCE_GUARDS,
    'g_approvals_sufficient',
    'g_no_active_payout',
    'g_coverage_ok',
  ]),
  transition('release_pending', 'operator_blocked', 'release_blocked'),

  transition('release_blocked', 'approval_added', 'release_pending', ['g_mismatch_resolved']),
  transition('release_blocked', 'refund_requested', 'refund_pending'),
  transition('release_blocked', 'reserve_expired', 'collected'),
  transition('release_blocked', 'write_off_approved', 'written_off', [
    'g_write_off_approvers_distinct',
  ]),

  transition('paying_out', 'payout_result', 'paid_out', [], [], 'settled'),
  transition('paying_out', 'payout_result', 'release_blocked', [], [], 'rejected'),
  // «Неизвестно» оставляет транш здесь: повтор запрещён без сверки (§2.2).
  transition('paying_out', 'payout_result', 'paying_out', [], [], 'unknown'),
  // Событие сверки есть в §1.2, но отсутствует в таблице §1.4. Без него
  // обещание §5 «выход гарантирован не позднее следующего дня» не выполняется.
  transition('paying_out', 'reconciliation_resolved', 'paid_out', [], [], 'settled'),
  transition('paying_out', 'reconciliation_resolved', 'release_blocked', [], [], 'rejected'),

  transition('refund_pending', 'refund_initiated', 'refunding', ['g_source_account_known']),
  transition('refund_pending', 'refund_initiated', 'release_blocked', [], ['g_source_account_known']),

  transition('refunding', 'payout_result', 'refunded', [], [], 'settled'),
  transition('refunding', 'payout_result', 'release_blocked', [], [], 'rejected'),
  transition('refunding', 'payout_result', 'refunding', [], [], 'unknown'),
  transition('refunding', 'reconciliation_resolved', 'refunded', [], [], 'settled'),
  transition('refunding', 'reconciliation_resolved', 'release_blocked', [], [], 'rejected'),
]);

export interface TrancheTransitionResult {
  readonly state: TrancheState;
  readonly intents: readonly Intent[];
}

function eventOutcome(event: TrancheEvent): PayoutOutcome | null {
  if (event.type === 'payout_result') return event.outcome;
  if (event.type === 'reconciliation_resolved') return event.outcome;
  return null;
}

/**
 * Сумма, которой распоряжается проводка. Для зачисления — сумма события, для
 * выплаты, возврата и списания — фактически собранные средства.
 *
 * `null` означает, что денег по траншу не поступало: транш из `collecting`
 * уходит в возврат по дедлайну и возвращать нечего. Проводки в этом случае нет
 * вовсе — «возврат нуля» это запись с нулевой суммой, а такие записи журнал
 * не принимает.
 */
function moneyForTemplate(event: TrancheEvent, facts: TrancheFacts): Money<CurrencyCode> | null {
  if (event.type === 'funds_received') return event.amount;
  return facts.collectedAmount;
}

function exitIntents(from: TrancheStatus, to: TrancheStatus): readonly Intent[] {
  // §1.5: блокировка реквизитов снимается, только если уходим не в выплату.
  const payoutPath: readonly TrancheStatus[] = ['release_pending', 'paying_out', 'paid_out'];
  if (from === 'reserved' && !payoutPath.includes(to)) {
    return [{ type: 'unlock_beneficiary' }];
  }
  return [];
}

function entryIntents(
  to: TrancheStatus,
  event: TrancheEvent,
  context: TrancheContext,
): readonly Intent[] {
  const amount = moneyForTemplate(event, context.facts);
  const ledger = (template: LedgerTemplate): readonly Intent[] =>
    amount === null
      ? []
      : [
          {
            type: 'post_journal_entry',
            template,
            dealId: context.dealId,
            trancheId: context.trancheId,
            amount,
          },
        ];
  switch (to) {
    case 'collected':
      return [
        ...ledger('funds_received'),
        { type: 'notify', audience: 'buyer', messageKey: 'tranche.collected.buyer' },
      ];
    case 'reserved':
      return [
        { type: 'lock_beneficiary' },
        { type: 'notify', audience: 'seller', messageKey: 'tranche.reserved.seller' },
      ];
    case 'release_pending':
      return [
        { type: 'build_payout_instruction', idempotencyKey: payoutIdempotencyKey(context.trancheId) },
      ];
    case 'paying_out': {
      const evidenceBundleId = context.facts.evidenceBundleId;
      // Ветка `null` недостижима, пока на переходе стоит `g_evidence_present`,
      // и написана так, чтобы удаление guard'а не превратилось в выплату без
      // ссылки на доказательства, а остановило её (красная линия №5).
      return evidenceBundleId === null
        ? []
        : [
            {
              type: 'enqueue_outbound_payout',
              idempotencyKey: payoutIdempotencyKey(context.trancheId),
              evidenceBundleId,
            },
          ];
    }
    case 'paid_out':
      return [
        // Выплата и комиссия — в одном журнале (красная линия №2, §1.5).
        ...ledger('payout_with_fee'),
        { type: 'notify', audience: 'both', messageKey: 'tranche.paid_out.both' },
        { type: 'close_tranche' },
      ];
    case 'refunded':
      return [
        ...ledger('refund'),
        { type: 'notify', audience: 'buyer', messageKey: 'tranche.refunded.buyer' },
        { type: 'close_tranche' },
      ];
    case 'written_off':
      return [...ledger('write_off'), { type: 'close_tranche' }];
    case 'release_blocked':
      return [
        // Приоритет задачи оператора — по сумме транша (§1.5).
        { type: 'enqueue_operator_task', priorityAmount: context.facts.requiredAmount },
        { type: 'notify', audience: 'both', messageKey: 'tranche.release_blocked.both' },
      ];
    default:
      return [];
  }
}

function matches(candidate: TrancheTransition, input: GuardInput): readonly GuardId[] {
  const failed: GuardId[] = [];
  for (const guard of candidate.guards) {
    if (!evaluateGuard(guard, input)) failed.push(guard);
  }
  for (const guard of candidate.negatedGuards) {
    if (evaluateGuard(guard, input)) failed.push(guard);
  }
  return failed;
}

/**
 * Редьюсер транша: чистая функция состояния, события и контекста.
 * Побочных эффектов внутри нет — действия возвращаются намерениями.
 */
export function reduceTranche(
  state: TrancheState,
  event: TrancheEvent,
  context: TrancheContext,
): Result<TrancheTransitionResult, Rejection> {
  if (isTerminalTrancheStatus(state.status)) {
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
      // [открыто] §8: значение не подтверждено и до подтверждения не используется.
      return failure(
        rejection(RejectionCode.releaseConditionRequiresConfirmation, [], {
          conditionType: event.conditionType,
        }),
      );
    }
  }

  const outcome = eventOutcome(event);
  const candidates = TRANCHE_TRANSITIONS.filter(
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

  const input: GuardInput = { facts: context.facts, event, now: context.now };
  let firstFailure: readonly GuardId[] = [];
  for (const candidate of candidates) {
    const failed = matches(candidate, input);
    if (failed.length > 0) {
      if (firstFailure.length === 0) firstFailure = failed;
      continue;
    }
    const nextStatus = candidate.to;
    const intents: Intent[] = [...exitIntents(state.status, nextStatus)];
    if (isTerminalTrancheStatus(nextStatus)) {
      intents.push(...entryIntents(nextStatus, event, context));
      return ok({ state: terminalTrancheState(nextStatus), intents: Object.freeze(intents) });
    }
    const at = plus(context.now, context.deadlinePolicy[nextStatus]);
    intents.push({ type: 'set_deadline', at });
    intents.push(...entryIntents(nextStatus, event, context));
    return ok({
      state: nonTerminalTrancheState(nextStatus, deadline(at)),
      intents: Object.freeze(intents),
    });
  }

  return failure(
    rejection(RejectionCode.guardFailed, firstFailure, {
      status: state.status,
      event: event.type,
    }),
  );
}

export function initialTrancheState(now: Instant, policy: DeadlinePolicy): TrancheState {
  return nonTerminalTrancheState('pending', deadline(plus(now, policy.pending)));
}
