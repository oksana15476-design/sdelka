import {
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
import { NOW } from './facts';

/** Состояние на заданном статусе. Дедлайн обязателен по типу — его нельзя опустить. */
export function stateAt(status: NonTerminalTrancheStatus): TrancheState {
  return nonTerminalTrancheState(status, deadline(plus(NOW, DEFAULT_DEADLINE_POLICY[status])));
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
