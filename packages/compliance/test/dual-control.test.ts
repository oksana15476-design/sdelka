import { describe, expect, it } from 'vitest';
import {
  type DualControl,
  GENERIC_DUAL_CONTROL_REASONS,
  REASON_KEYS,
  distinctApprovers,
  dualControlFailures,
  dualControlSatisfied,
  isDistinctApprover,
} from '../src/index';

function control(overrides: Partial<DualControl> = {}): DualControl {
  return {
    preparedBy: 'operator-1',
    approvals: Object.freeze(['approver-2']),
    requiredApprovals: 1,
    ...overrides,
  };
}

describe('готовивший не утверждает', () => {
  it('утверждение готовившего не засчитывается', () => {
    expect(distinctApprovers(control({ approvals: ['operator-1'] }))).toEqual([]);
    expect(dualControlSatisfied(control({ approvals: ['operator-1'] }))).toBe(false);
  });

  it('готовивший не может быть годным утверждающим', () => {
    expect(isDistinctApprover(control(), 'operator-1')).toBe(false);
  });

  it('уже утвердивший второй раз не годится', () => {
    expect(isDistinctApprover(control(), 'approver-2')).toBe(false);
  });

  it('новый человек годится', () => {
    expect(isDistinctApprover(control(), 'approver-3')).toBe(true);
  });
});

describe('утверждающие считаются множеством, а не счётчиком', () => {
  it('одна учётная запись дважды — одно утверждение', () => {
    const state = control({ approvals: ['approver-2', 'approver-2'], requiredApprovals: 2 });
    expect(distinctApprovers(state)).toEqual(['approver-2']);
    expect(dualControlSatisfied(state)).toBe(false);
  });

  it('порядок сохраняется: видно, кто утвердил первым', () => {
    const state = control({ approvals: ['approver-3', 'approver-2'] });
    expect(distinctApprovers(state)).toEqual(['approver-3', 'approver-2']);
  });

  it('готовивший вычитается из середины перечня', () => {
    const state = control({ approvals: ['approver-2', 'operator-1', 'approver-3'] });
    expect(distinctApprovers(state)).toEqual(['approver-2', 'approver-3']);
  });
});

describe('крайние значения', () => {
  it('ноль требуемых утверждений — законное значение', () => {
    expect(dualControlSatisfied(control({ approvals: [], requiredApprovals: 0 }))).toBe(true);
  });

  it('готовившего нет — утверждения считаются все', () => {
    const state = control({ preparedBy: null, approvals: ['a', 'b'], requiredApprovals: 2 });
    expect(dualControlSatisfied(state)).toBe(true);
  });
});

describe('причины отказа', () => {
  it('правило выполнено — причин нет', () => {
    expect(dualControlFailures(control(), GENERIC_DUAL_CONTROL_REASONS)).toEqual([]);
  });

  it('утверждений не хватает', () => {
    expect(
      dualControlFailures(control({ approvals: [] }), GENERIC_DUAL_CONTROL_REASONS),
    ).toEqual([REASON_KEYS.dualControlAwaitsSecondApproval]);
  });

  it('обе причины возвращаются вместе: это два разных факта', () => {
    const failures = dualControlFailures(
      control({ approvals: [] }),
      GENERIC_DUAL_CONTROL_REASONS,
      'operator-1',
    );
    expect(failures).toEqual([
      REASON_KEYS.dualControlApproverNotDistinct,
      REASON_KEYS.dualControlAwaitsSecondApproval,
    ]);
  });

  it('ключи причин задаёт периметр, а не примитив', () => {
    const custom = { awaits: 'x.awaits', notDistinct: 'x.not_distinct' } as const;
    expect(dualControlFailures<'x.awaits' | 'x.not_distinct'>(control({ approvals: [] }), custom)).toEqual([
      'x.awaits',
    ]);
  });
});
