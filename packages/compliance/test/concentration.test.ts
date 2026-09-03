import { describe, expect, it } from 'vitest';
import { type MonthlyTurnover, evaluateConcentration } from '../src/index';
import { BY, DE, GE, IL, POLICY, RU } from './support/fixtures';

const policy = POLICY.concentration;

function turnover(
  byCountry: readonly { country: typeof GE; minor: bigint }[],
  totalMinor: bigint,
): MonthlyTurnover {
  return { year: 2026, month: 9, currency: 'GEL', totalMinor, byCountry };
}

describe('лимиты концентрации возвращают доли и превышение, а не булево', () => {
  it('в пределах лимитов', () => {
    const report = evaluateConcentration(
      turnover(
        [
          { country: DE, minor: 30_000_000n },
          { country: IL, minor: 30_000_000n },
          { country: RU, minor: 20_000_000n },
          { country: GE, minor: 20_000_000n },
        ],
        100_000_000n,
      ),
      policy,
    );
    expect(report.withinLimits).toBe(true);
    expect(report.breaches).toEqual(['compliance.concentration.within_limits']);
    expect(report.countries.find((item) => item.country === RU)?.shareBp).toBe(2_000);
  });

  it('высокорисковая юрисдикция сверх 25% — превышение с фактической долей', () => {
    const report = evaluateConcentration(
      turnover(
        [
          { country: RU, minor: 40_000_000n },
          { country: DE, minor: 60_000_000n },
        ],
        100_000_000n,
      ),
      policy,
    );
    expect(report.withinLimits).toBe(false);
    const ru = report.countries.find((item) => item.country === RU);
    expect(ru?.shareBp).toBe(4_000);
    expect(ru?.limitBp).toBe(2_500);
    expect(ru?.excessBp).toBe(1_500);
    expect(ru?.excessMinor).toBe(15_000_000n);
    expect(report.breaches).toContain('compliance.concentration.high_risk_country_exceeded');
  });

  it('обычная страна сверх 40% — превышение', () => {
    const report = evaluateConcentration(
      turnover(
        [
          { country: DE, minor: 50_000_000n },
          { country: IL, minor: 50_000_000n },
        ],
        100_000_000n,
      ),
      policy,
    );
    expect(report.countries.find((item) => item.country === DE)?.excessBp).toBe(1_000);
    expect(report.breaches).toContain('compliance.concentration.country_exceeded');
  });

  it('совокупная доля высокорисковых считается отдельно от долей по странам', () => {
    const report = evaluateConcentration(
      turnover(
        [
          { country: RU, minor: 20_000_000n },
          { country: BY, minor: 20_000_000n },
          { country: DE, minor: 40_000_000n },
          { country: IL, minor: 20_000_000n },
        ],
        100_000_000n,
      ),
      policy,
    );
    // Каждая по отдельности в лимите 25%, совокупно — 40%.
    expect(report.countries.every((item) => item.excessBp === 0)).toBe(true);
    expect(report.highRiskAggregate.shareBp).toBe(4_000);
    expect(report.highRiskAggregate.excessBp).toBe(1_500);
    expect(report.highRiskAggregate.excessMinor).toBe(15_000_000n);
    expect(report.breaches).toContain('compliance.concentration.high_risk_aggregate_exceeded');
    expect(report.withinLimits).toBe(false);
  });

  it('доля округляется вверх: на границе решение строгое', () => {
    const report = evaluateConcentration(
      turnover([{ country: RU, minor: 2_500_001n }], 10_000_000n),
      policy,
    );
    expect(report.countries[0]?.shareBp).toBe(2_501);
    expect(report.countries[0]?.excessBp).toBe(1);
  });

  it('нулевой оборот не даёт превышений и не делит на ноль', () => {
    const report = evaluateConcentration(turnover([], 0n), policy);
    expect(report.withinLimits).toBe(true);
    expect(report.highRiskAggregate.shareBp).toBe(0);
  });

  it('части больше целого — ошибка агрегата, а не молчаливый отчёт', () => {
    expect(() =>
      evaluateConcentration(turnover([{ country: DE, minor: 200n }], 100n), policy),
    ).toThrow('compliance.aggregate.parts_exceed_total');
  });

  it('отрицательные величины отвергаются', () => {
    expect(() => evaluateConcentration(turnover([], -1n), policy)).toThrow(
      'compliance.aggregate.negative',
    );
  });
});
