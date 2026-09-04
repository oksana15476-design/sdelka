import { describe, expect, it } from 'vitest';
import {
  type DualControl,
  type DualControlRequirement,
  ComplianceError,
  ComplianceErrorCode,
  GENERIC_DUAL_CONTROL_REASONS,
  REASON_KEYS,
  distinctApprovers,
  dualControlFailures,
  dualControlRequirement,
  dualControlSatisfied,
  isDistinctApprover,
} from '../src/index';

/**
 * Порог, пришедший из-за границы процесса испорченным. Приведение здесь —
 * единственный способ его изобразить, и это и есть смысл правки: в рабочем коде
 * ноль больше не набирается без `as`.
 */
function corruptedRequirement(value: number): DualControlRequirement {
  return value as DualControlRequirement;
}

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

  it('порог этой проверке не передаётся: вопрос о людях, а не о счёте', () => {
    // Достаточно участников — целый `DualControl` здесь не нужен.
    expect(isDistinctApprover({ preparedBy: 'operator-1', approvals: [] }, 'approver-2')).toBe(true);
    // @ts-expect-error порог в вопросе о различности не участвует
    isDistinctApprover({ preparedBy: 'operator-1', approvals: [], requiredApprovals: 1 }, 'x');
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

describe('ноль требуемых утверждений', () => {
  it('невыразим типом', () => {
    // Компиляционный тест: если запрет исчезнет, `@ts-expect-error` останется
    // без ошибки и не соберётся уже этот файл.
    // @ts-expect-error ноль — не порог, а его отсутствие
    control({ requiredApprovals: 0 });
    // Тройки тоже нет: третью подпись брать неоткуда — уровней утверждения два.
    // @ts-expect-error порогов выше двух не существует
    control({ requiredApprovals: 3 });
  });

  it('ноль, пришедший приведением, читается как «утверждений не хватает», а не как «не нужны»', () => {
    // До правки здесь было `true`: `length >= 0` истинно всегда.
    const state = control({ approvals: [], requiredApprovals: corruptedRequirement(0) });
    expect(dualControlSatisfied(state)).toBe(false);
    expect(dualControlFailures(state, GENERIC_DUAL_CONTROL_REASONS)).toEqual([
      REASON_KEYS.dualControlAwaitsSecondApproval,
    ]);
  });

  it('ноль не спасает и операцию, которую утвердил сам готовивший', () => {
    // До правки — тоже `true`: порог ноль перекрывал вычет готовившего.
    expect(
      dualControlSatisfied(
        control({ approvals: ['operator-1'], requiredApprovals: corruptedRequirement(0) }),
      ),
    ).toBe(false);
  });

  it('дробь и тройка отказывают так же', () => {
    for (const broken of [0.5, 1.5, 3, -1]) {
      expect(
        dualControlSatisfied(
          control({
            approvals: ['approver-2', 'approver-3'],
            requiredApprovals: corruptedRequirement(broken),
          }),
        ),
      ).toBe(false);
    }
  });

  it('разбор порога на границе процесса: ноль бросает, 1 и 2 проходят', () => {
    expect(dualControlRequirement(1)).toBe(1);
    expect(dualControlRequirement(2)).toBe(2);
    for (const broken of [0, 3, 1.5, Number.NaN]) {
      expect(() => dualControlRequirement(broken)).toThrow(ComplianceError);
    }
    try {
      dualControlRequirement(0);
      expect.unreachable();
    } catch (error) {
      expect((error as ComplianceError).code).toBe(
        ComplianceErrorCode.dualControlRequirementInvalid,
      );
    }
  });
});

describe('крайние значения', () => {
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
