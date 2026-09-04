import { describe, expect, it } from 'vitest';
import { distinctApprovers } from '@sdelka/compliance';
import {
  type ManualMatchRequest,
  INTAKE_REASON_KEYS,
  assessManualMatch,
  requiresSecondApproval,
} from '../src/index';
import { POLICY, gel, jpy, usd } from './support/fixtures';

const SMALL = gel(500_000n);
const LARGE = gel(50_000_000n);

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
    expect(distinctApprovers(assessed.control)).toEqual(['approver-2']);
    expect(assessed.allowed).toBe(true);
  });

  it('второй человек доводит сопоставление до применимого', () => {
    expect(assessManualMatch(request(), POLICY).allowed).toBe(true);
  });

  it('ниже порога утверждений не требуется вовсе', () => {
    const assessed = assessManualMatch(request({ amount: SMALL, approvals: [] }), POLICY);
    expect(assessed.requiresSecondApproval).toBe(false);
    expect(assessed.allowed).toBe(true);
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
    expect(distinctApprovers(assessed.control)).toEqual(['approver-2', 'approver-3']);
  });
});
