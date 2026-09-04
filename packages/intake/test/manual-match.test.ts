import { describe, expect, it } from 'vitest';
import { type DualControl, type DualControlRequirement, distinctApprovers } from '@sdelka/compliance';
import {
  type IntakePolicy,
  type ManualMatchAssessment,
  type ManualMatchRequest,
  INTAKE_REASON_KEYS,
  assessManualMatch,
  requiresSecondApproval,
} from '../src/index';
import { POLICY, gel, jpy, usd } from './support/fixtures';

const SMALL = gel(500_000n);
const LARGE = gel(50_000_000n);

/**
 * Кворум там, где он есть. Обращение к нему через ветку — не церемония: у
 * сопоставления ниже порога кворума нет вовсе, и тест, который спрашивает о нём
 * без разбора ветки, спрашивает о несуществующем.
 */
function requiredControl(assessed: ManualMatchAssessment): DualControl {
  if (assessed.secondApproval.kind !== 'required') {
    throw new Error(`ожидался кворум, получено: ${assessed.secondApproval.kind}`);
  }
  return assessed.secondApproval.control;
}

function request(overrides: Partial<ManualMatchRequest> = {}): ManualMatchRequest {
  return {
    incomingPaymentId: 'in-1',
    dealId: 'deal-1',
    trancheId: 't1',
    amount: LARGE,
    preparedBy: 'operator-1',
    approvals: Object.freeze(['approver-2']),
    justificationRef: 'bank-letter-77',
    ...overrides,
  };
}

describe('порог второго утверждения', () => {
  it('сумма ниже порога — второй человек не нужен', () => {
    expect(requiresSecondApproval(SMALL, POLICY)).toBe(false);
  });

  it('сумма выше порога — нужен', () => {
    expect(requiresSecondApproval(LARGE, POLICY)).toBe(true);
  });

  it('валюта без объявленного порога требует второго утверждения всегда', () => {
    expect(requiresSecondApproval(jpy(1n), POLICY)).toBe(true);
  });

  it('порог по валютам, без пересчёта по курсу', () => {
    expect(requiresSecondApproval(usd(300_000n), POLICY)).toBe(false);
    expect(requiresSecondApproval(usd(500_000n), POLICY)).toBe(true);
  });
});

describe('оператор не утверждает то, что готовил сам', () => {
  it('единственное утверждение от готовившего не засчитывается', () => {
    const assessed = assessManualMatch(request({ approvals: ['operator-1'] }), POLICY);
    expect(assessed.allowed).toBe(false);
    expect(assessed.failures).toContain(INTAKE_REASON_KEYS.matchManualAwaitsSecondApproval);
  });

  it('одна и та же учётная запись дважды — одно утверждение', () => {
    const assessed = assessManualMatch(
      request({ approvals: ['approver-2', 'approver-2'] }),
      POLICY,
    );
    expect(distinctApprovers(requiredControl(assessed))).toEqual(['approver-2']);
    expect(assessed.allowed).toBe(true);
  });

  it('второй человек доводит сопоставление до применимого', () => {
    expect(assessManualMatch(request(), POLICY).allowed).toBe(true);
  });

  it('ниже порога утверждений не требуется вовсе', () => {
    const assessed = assessManualMatch(request({ amount: SMALL, approvals: [] }), POLICY);
    expect(assessed.secondApproval.kind).toBe('not_required');
    expect(assessed.allowed).toBe(true);
  });
});

describe('«проверка не нужна» и «проверка пройдена» — разные факты', () => {
  it('различаются веткой, а не числом: у «не нужна» кворума нет вовсе', () => {
    const below = assessManualMatch(request({ amount: SMALL, approvals: [] }), POLICY);
    const above = assessManualMatch(request({ amount: LARGE }), POLICY);
    expect(below.secondApproval.kind).toBe('not_required');
    expect(above.secondApproval.kind).toBe('required');
    // Оба применимы — и это ровно тот случай, где прежняя форма их путала:
    // порог ноль давал «правило выполнено» там, где правила не было.
    expect(below.allowed).toBe(true);
    expect(above.allowed).toBe(true);
    // Спросить о кворуме там, где его нет, нечем: свойства не существует.
    expect('control' in below.secondApproval).toBe(false);
    expect(distinctApprovers(requiredControl(above))).toEqual(['approver-2']);
  });

  it('кворум ветки «не требуется» невыразим', () => {
    const below = assessManualMatch(request({ amount: SMALL, approvals: [] }), POLICY);
    if (below.secondApproval.kind === 'not_required') {
      // @ts-expect-error у «второе утверждение не требуется» кворума нет
      expect(below.secondApproval.control).toBeUndefined();
    }
  });

  it('порог политики с нулём невыразим', () => {
    // @ts-expect-error ноль — не порог, а его отсутствие: решает сумма, а не настройка
    const zero: IntakePolicy['manualMatch'] = { ...POLICY.manualMatch, requiredApprovals: 0 };
    expect(zero.requiredApprovals).toBe(0);
  });

  it('ноль, пришедший в политике приведением, не применяет сопоставление молча', () => {
    // До правки: `allowed === true` без единого утверждения на сумме выше
    // порога — ровно та операция, ради запрета которой правило и написано.
    const corrupted: IntakePolicy = {
      ...POLICY,
      manualMatch: {
        ...POLICY.manualMatch,
        requiredApprovals: 0 as unknown as DualControlRequirement,
      },
    };
    const assessed = assessManualMatch(request({ amount: LARGE, approvals: [] }), corrupted);
    expect(assessed.secondApproval.kind).toBe('required');
    expect(assessed.allowed).toBe(false);
    expect(assessed.failures).toContain(INTAKE_REASON_KEYS.matchManualAwaitsSecondApproval);
  });
});

describe('запись с основанием', () => {
  it('сопоставление без ссылки на основание не применяется', () => {
    const assessed = assessManualMatch(request({ justificationRef: '  ' }), POLICY);
    expect(assessed.allowed).toBe(false);
    expect(assessed.failures).toContain(INTAKE_REASON_KEYS.matchManualJustificationMissing);
  });

  it('основание требуется и там, где второго утверждения не нужно', () => {
    const assessed = assessManualMatch(
      request({ amount: SMALL, approvals: [], justificationRef: '' }),
      POLICY,
    );
    expect(assessed.allowed).toBe(false);
  });
});

describe('правило второго утверждения — общее, а не четвёртая копия', () => {
  it('механика берётся из @sdelka/compliance и считает те же множества', () => {
    const assessed = assessManualMatch(
      request({ approvals: ['operator-1', 'approver-2', 'approver-3'] }),
      POLICY,
    );
    // Готовивший вычтен, порядок сохранён — как в `dual-control.ts`.
    expect(distinctApprovers(requiredControl(assessed))).toEqual(['approver-2', 'approver-3']);
  });
});
