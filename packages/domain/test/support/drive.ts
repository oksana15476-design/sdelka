import {
  type Instant,
  type NonTerminalTrancheStatus,
  type Rejection,
  type TrancheContext,
  type TrancheEvent,
  type TrancheState,
  type TrancheTransitionResult,
  DEFAULT_DEADLINE_POLICY,
  deadline,
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
  status: NonTerminalTrancheStatus,
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
