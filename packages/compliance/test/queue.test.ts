import { money } from '@sdelka/money';
import { type Instant, instant } from '@sdelka/domain';
import { describe, expect, it } from 'vitest';
import {
  type ReviewTask,
  escalatedTasks,
  escalationLevel,
  oldestTaskAgeMs,
  prioritize,
  taskAgeMs,
} from '../src/index';
import { NOW, POLICY } from './support/fixtures';

const HOUR_MS = 60 * 60 * 1000;
const policy = POLICY.queue;

function task(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    taskId: 'task-1',
    kind: 'payer_hold',
    dealId: 'deal-1',
    trancheId: 'tranche-1',
    partyId: null,
    rankAmount: money('GEL', 10_000_000n),
    enteredAt: instant(NOW - HOUR_MS) as Instant,
    deadlineAt: instant(NOW + HOUR_MS) as Instant,
    severity: 'hold',
    assigneeId: null,
    policyVersionId: POLICY.version,
    ...overrides,
  };
}

describe('возраст считается от постановки, а не от дедлайна', () => {
  it('сдвиг дедлайна возраст не меняет', () => {
    const fresh = task({ deadlineAt: instant(NOW + 1000 * HOUR_MS) as Instant });
    expect(taskAgeMs(fresh, NOW)).toBe(HOUR_MS);
  });

  it('возраст не отрицателен при часах вперёд', () => {
    expect(taskAgeMs(task({ enteredAt: instant(NOW + HOUR_MS) as Instant }), NOW)).toBe(0);
  });

  it('эскалация растёт по порогам возраста', () => {
    expect(escalationLevel(task(), NOW, policy)).toBe(0);
    expect(escalationLevel(task({ enteredAt: instant(NOW - 5 * HOUR_MS) as Instant }), NOW, policy)).toBe(1);
    expect(escalationLevel(task({ enteredAt: instant(NOW - 25 * HOUR_MS) as Instant }), NOW, policy)).toBe(2);
    expect(escalationLevel(task({ enteredAt: instant(NOW - 80 * HOUR_MS) as Instant }), NOW, policy)).toBe(3);
  });
});

describe('порядок разбора', () => {
  it('эскалация впереди суммы: мелкая старая задача не голодает', () => {
    const big = task({ taskId: 'big', rankAmount: money('GEL', 90_000_000n) });
    const smallOld = task({
      taskId: 'small-old',
      rankAmount: money('GEL', 100_000n),
      enteredAt: instant(NOW - 80 * HOUR_MS) as Instant,
    });
    const order = prioritize([big, smallOld], policy, NOW).map((item) => item.task.taskId);
    expect(order).toEqual(['small-old', 'big']);
  });

  it('при равной эскалации выше тяжесть, затем сумма', () => {
    const heavy = task({ taskId: 'heavy', severity: 'block', rankAmount: money('GEL', 1n) });
    const light = task({ taskId: 'light', severity: 'review', rankAmount: money('GEL', 90_000_000n) });
    expect(prioritize([light, heavy], policy, NOW).map((item) => item.task.taskId)).toEqual([
      'heavy',
      'light',
    ]);
  });

  it('при равных тяжести и эскалации выше сумма', () => {
    const big = task({ taskId: 'b', rankAmount: money('GEL', 90_000_000n) });
    const small = task({ taskId: 'a', rankAmount: money('GEL', 1_000n) });
    expect(prioritize([small, big], policy, NOW).map((item) => item.task.taskId)).toEqual(['b', 'a']);
  });

  it('сумма в чужой валюте не ранжируется, но задача не теряется', () => {
    const foreign = task({ taskId: 'foreign', rankAmount: money('USD', 90_000_000n) });
    const ranked = prioritize([foreign], policy, NOW);
    expect(ranked[0]?.rankMinor).toBeNull();
    expect(ranked).toHaveLength(1);
  });

  it('порядок устойчив: полностью равные задачи упорядочены по идентификатору', () => {
    const first = task({ taskId: 'aaa' });
    const second = task({ taskId: 'bbb' });
    expect(prioritize([second, first], policy, NOW).map((item) => item.task.taskId)).toEqual([
      'aaa',
      'bbb',
    ]);
  });
});

describe('метрики дежурного', () => {
  it('возраст самой старой задачи', () => {
    const tasks = [task({ taskId: 'a' }), task({ taskId: 'b', enteredAt: instant(NOW - 9 * HOUR_MS) as Instant })];
    expect(oldestTaskAgeMs(tasks, NOW)).toBe(9 * HOUR_MS);
    expect(oldestTaskAgeMs([], NOW)).toBeNull();
  });

  it('перешагнувшие норматив выделяются отдельно', () => {
    const tasks = [task({ taskId: 'a' }), task({ taskId: 'b', enteredAt: instant(NOW - 9 * HOUR_MS) as Instant })];
    expect(escalatedTasks(tasks, policy, NOW).map((item) => item.taskId)).toEqual(['b']);
  });
});
