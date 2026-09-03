import {
  type DurationMs,
  type FreezeReason,
  type Instant,
  type Rejection,
  type ThawedTrancheStatus,
  type TrancheContext,
  type TrancheEvent,
  type TrancheState,
  type TrancheTransitionResult,
  DEFAULT_DEADLINE_POLICY,
  deadline,
  frozenTrancheState,
  nonTerminalTrancheState,
  plus,
  reduceTranche,
} from '../../src/index';
import { CONDITION_ACT, NOW } from './facts';

/**
 * Состояние на заданном статусе. Дедлайн и время входа обязательны по типу —
 * их нельзя опустить (STATE-MACHINES.md §5).
 */
export function stateAt(
  status: ThawedTrancheStatus,
  enteredAt: Instant = NOW,
): TrancheState {
  return nonTerminalTrancheState(
    status,
    deadline(plus(NOW, DEFAULT_DEADLINE_POLICY[status])),
    enteredAt,
    // Акт есть у всего, что вышло из `pending`: до него деньги не принимаются.
    status === 'pending' ? null : CONDITION_ACT,
  );
}

/**
 * Замороженное состояние собирается **другим** помощником, и это правильно: у
 * него нет дедлайна, зато есть остаток, основание и автор заморозки. Общий
 * `stateAt` его собрать не может по типу.
 */
export function frozenStateAt(
  suspendedFrom: ThawedTrancheStatus,
  remaining: DurationMs,
  options: {
    readonly enteredAt?: Instant;
    readonly reason?: FreezeReason;
    readonly frozenBy?: string;
  } = {},
): TrancheState {
  return frozenTrancheState(
    suspendedFrom,
    remaining,
    options.enteredAt ?? NOW,
    CONDITION_ACT,
    options.reason ?? 'sanctions',
    options.frozenBy ?? 'compliance-1',
  );
}

export function accept(
  state: TrancheState,
  event: TrancheEvent,
  context: TrancheContext,
): TrancheTransitionResult {
  const result = reduceTranche(state, event, context);
  if (!result.ok) {
    throw new Error(`unexpected rejection: ${result.error.code} ${result.error.failedGuards.join(',')}`);
  }
  return result.value;
}

export function reject(
  state: TrancheState,
  event: TrancheEvent,
  context: TrancheContext,
): Rejection {
  const result = reduceTranche(state, event, context);
  if (result.ok) {
    throw new Error(`unexpected transition to ${result.value.state.status}`);
  }
  return result.error;
}

/** Проводит транш по последовательности событий, ожидая, что каждое принято. */
export function walk(
  state: TrancheState,
  events: readonly TrancheEvent[],
  context: TrancheContext,
): TrancheState {
  return events.reduce((current, event) => accept(current, event, context).state, state);
}
