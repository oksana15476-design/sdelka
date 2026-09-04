import { describe, expect, it } from 'vitest';
import { money } from '@sdelka/money';
import {
  type IntakePolicy,
  INTAKE_REASON_KEYS,
  PROPOSED_INTAKE_POLICY,
  intakePolicyVersionId,
  toleranceAmount,
  toleranceFor,
} from '../src/index';
import { gel, jpy, usd } from './support/fixtures';

function withTolerance(overrides: Partial<IntakePolicy['tolerance']>): IntakePolicy {
  return Object.freeze({
    ...PROPOSED_INTAKE_POLICY,
    tolerance: Object.freeze({ ...PROPOSED_INTAKE_POLICY.tolerance, ...overrides }),
  });
}

describe('допуск: берётся меньшее из абсолюта и доли', () => {
  it('доминирует абсолют — берётся абсолют', () => {
    // Требование огромное: половина процента от него больше абсолютных 50 лари.
    const policy = withTolerance({ absolute: [money('GEL', 5_000n)], shareBp: 50 });
    const resolution = toleranceFor(gel(100_000_000n), policy);
    expect(resolution.kind).toBe('declared');
    expect(toleranceAmount(resolution, 'GEL').minor).toBe(5_000n);
  });

  it('доминирует доля — берётся доля', () => {
    // Требование маленькое: половина процента от него меньше абсолютных 50 лари.
    const policy = withTolerance({ absolute: [money('GEL', 5_000n)], shareBp: 50 });
    const resolution = toleranceFor(gel(100_000n), policy);
    expect(toleranceAmount(resolution, 'GEL').minor).toBe(500n);
  });

  it('доля усекается, а не округляется вверх: послабление не округляют в свою пользу', () => {
    const policy = withTolerance({ absolute: [money('GEL', 1_000_000n)], shareBp: 50 });
    // 33 333 × 0,5% = 166,665 минорных единиц → 166.
    expect(toleranceAmount(toleranceFor(gel(33_333n), policy), 'GEL').minor).toBe(166n);
  });
});

describe('допуск: крайние значения', () => {
  it('нулевая доля законна и означает строгое равенство', () => {
    const policy = withTolerance({ absolute: [money('GEL', 5_000n)], shareBp: 0 });
    const resolution = toleranceFor(gel(100_000n), policy);
    expect(resolution.kind).toBe('declared');
    expect(toleranceAmount(resolution, 'GEL').minor).toBe(0n);
    expect(resolution.reasons).toContain(INTAKE_REASON_KEYS.toleranceZero);
  });

  it('нулевой абсолют законен и побеждает любую долю', () => {
    const policy = withTolerance({ absolute: [money('GEL', 0n)], shareBp: 500 });
    expect(toleranceAmount(toleranceFor(gel(100_000_000n), policy), 'GEL').minor).toBe(0n);
  });

  it('нулевое требование даёт нулевой допуск', () => {
    expect(toleranceAmount(toleranceFor(gel(0n), PROPOSED_INTAKE_POLICY), 'GEL').minor).toBe(0n);
  });
});

describe('допуск в чужой валюте — отказ закрытый, а не пересчёт', () => {
  it('валюта, для которой политика ничего не объявила, даёт «не объявлено»', () => {
    const resolution = toleranceFor(jpy(1_000n), PROPOSED_INTAKE_POLICY);
    expect(resolution.kind).toBe('undeclared');
    expect(resolution.reasons).toContain(INTAKE_REASON_KEYS.toleranceCurrencyNotDeclared);
  });

  it('«не объявлено» читается как ноль, а не как «допуска нет ограничения»', () => {
    const resolution = toleranceFor(jpy(1_000n), PROPOSED_INTAKE_POLICY);
    expect(toleranceAmount(resolution, 'JPY').minor).toBe(0n);
  });

  it('абсолют другой валюты не подставляется вместо отсутствующего', () => {
    const policy = withTolerance({ absolute: [money('GEL', 5_000n)], shareBp: 50 });
    expect(toleranceFor(usd(100_000n), policy).kind).toBe('undeclared');
  });
});

describe('политика', () => {
  it('версия имеет разбираемый формат и отвергает произвольную строку', () => {
    expect(() => intakePolicyVersionId('intake/2026-09-04.1')).not.toThrow();
    expect(() => intakePolicyVersionId('2026-09-04')).toThrow();
  });

  it('политика заморожена: величины не правятся в рантайме', () => {
    expect(Object.isFrozen(PROPOSED_INTAKE_POLICY)).toBe(true);
    expect(Object.isFrozen(PROPOSED_INTAKE_POLICY.tolerance)).toBe(true);
    expect(Object.isFrozen(PROPOSED_INTAKE_POLICY.quote)).toBe(true);
  });

  it('у каждого порога есть письменное обоснование', () => {
    const thresholds = [
      PROPOSED_INTAKE_POLICY.matching.candidateThreshold,
      PROPOSED_INTAKE_POLICY.matching.autoMatchThreshold,
      PROPOSED_INTAKE_POLICY.matching.damagedReferenceThreshold,
      PROPOSED_INTAKE_POLICY.quote.driftThreshold,
    ];
    for (const threshold of thresholds) {
      expect(threshold.rationaleDocRef).toMatch(/^docs\//u);
    }
    expect(PROPOSED_INTAKE_POLICY.tolerance.rationaleDocRef).toMatch(/^docs\//u);
  });
});
