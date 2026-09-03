import { describe, expect, it } from 'vitest';
import {
  type Instant,
  type TrancheState,
  DAY,
  DEFAULT_ESCALATION_POLICY,
  HOUR,
  instant,
  isEscalated,
  isTerminalTrancheStatus,
  trancheStateAge,
} from '../src/index';
import { NOW, context } from './support/facts';
import { accept, stateAt } from './support/drive';

const at = (offset: number): Instant => instant(NOW + offset);

function deadlineOf(state: TrancheState): number {
  if (!('deadline' in state)) {
    throw new Error('terminal state has no deadline');
  }
  return state.deadline.at;
}

describe('возраст состояния считается отдельно от дедлайна (STATE-MACHINES.md §5)', () => {
  it('keeps enteredAt across repeated payout_result(unknown) while the deadline moves', () => {
    // Каждый неответ банка отодвигает часы: дедлайн пересчитывается от «сейчас».
    // Возраст при этом продолжает идти от первого входа в `paying_out` — иначе
    // застрявшая выплата выглядела бы вечно свежей и не попадала в эскалацию.
    let state: TrancheState = stateAt('paying_out', NOW);
    const deadlines: number[] = [deadlineOf(state)];

    for (const offset of [HOUR, 2 * HOUR, 3 * HOUR]) {
      const now = at(offset);
      state = accept(state, { type: 'payout_result', outcome: 'unknown' }, context({}, now)).state;
      expect(state.status).toBe('paying_out');
      expect(trancheStateAge(state, now)).toBe(offset);
      deadlines.push(deadlineOf(state));
    }

    // Дедлайн растёт с каждым повтором...
    expect(deadlines).toEqual([
      NOW + DAY,
      NOW + HOUR + DAY,
      NOW + 2 * HOUR + DAY,
      NOW + 3 * HOUR + DAY,
    ]);
    // ...а время входа не сдвигается ни разу.
    expect('enteredAt' in state && state.enteredAt).toBe(NOW);
    expect(trancheStateAge(state, at(5 * DAY))).toBe(5 * DAY);
  });

  it('escalates by age, not by the deadline that the repeats keep pushing away', () => {
    let state: TrancheState = stateAt('paying_out', NOW);
    for (const offset of [DAY, 2 * DAY, 3 * DAY]) {
      state = accept(
        state,
        { type: 'payout_result', outcome: 'unknown' },
        context({}, at(offset)),
      ).state;
    }
    // Дедлайн в будущем, автоматический переход не наступил, но транш висит
    // четвёртые сутки — это случай дежурного.
    expect(deadlineOf(state)).toBeGreaterThan(at(3 * DAY));
    expect(isEscalated(state, at(3 * DAY), DEFAULT_ESCALATION_POLICY)).toBe(true);
    expect(isEscalated(state, at(HOUR), DEFAULT_ESCALATION_POLICY)).toBe(false);
  });

  it('resets enteredAt when the status actually changes', () => {
    const now = at(6 * HOUR);
    const state = accept(
      stateAt('collected', NOW),
      { type: 'reserve_requested' },
      context({}, now),
    ).state;
    expect(state.status).toBe('reserved');
    expect(trancheStateAge(state, now)).toBe(0);
  });

  it('has no age for a terminal state', () => {
    const state = accept(
      stateAt('paying_out', NOW),
      { type: 'payout_result', outcome: 'settled' },
      context({}, at(HOUR)),
    ).state;
    expect(isTerminalTrancheStatus(state.status)).toBe(true);
    expect(trancheStateAge(state, at(DAY))).toBeNull();
    expect(isEscalated(state, at(DAY), DEFAULT_ESCALATION_POLICY)).toBe(false);
  });

  it('covers every non-terminal status with an escalation threshold', () => {
    // Состояние без порога эскалации — это состояние, из которого транш можно
    // не заметить. Полнота держится типом `Record`, тест фиксирует её значением.
    for (const threshold of Object.values(DEFAULT_ESCALATION_POLICY)) {
      expect(threshold).toBeGreaterThan(0);
    }
  });
});
