import type { CurrencyCode } from '@sdelka/money';
import { ComplianceError, ComplianceErrorCode } from './errors';
import type { CountryCode } from './identity';
import { type ReasonKey, REASON_KEYS } from './keys';
import type { ConcentrationPolicy } from './policy';

/**
 * Лимиты концентрации (`PRODUCT.md` §10): не более 25% месячного оборота от
 * клиентов одной высокорисковой юрисдикции, не более 40% на одну страну.
 *
 * Функция возвращает **фактические доли и превышение**, а не булево: оператору
 * и владельцу нужно знать, на сколько именно вышли за лимит и сколько оборота
 * придётся не брать, а не только «нельзя».
 *
 * Доли считаются с округлением вверх: на границе решение принимается в строгую
 * сторону, как и везде в системе.
 */
export interface CountryTurnover {
  readonly country: CountryCode;
  readonly minor: bigint;
}

export interface MonthlyTurnover {
  readonly year: number;
  readonly month: number;
  readonly currency: CurrencyCode;
  readonly totalMinor: bigint;
  readonly byCountry: readonly CountryTurnover[];
}

export interface CountryConcentration {
  readonly country: CountryCode;
  readonly minor: bigint;
  readonly shareBp: number;
  readonly limitBp: number;
  readonly highRisk: boolean;
  /** Превышение доли над лимитом в базисных пунктах. Ноль — лимит соблюдён. */
  readonly excessBp: number;
  /** Сколько оборота сверх лимита, в минорных единицах. */
  readonly excessMinor: bigint;
}

export interface AggregateConcentration {
  readonly minor: bigint;
  readonly shareBp: number;
  readonly limitBp: number;
  readonly excessBp: number;
  readonly excessMinor: bigint;
}

export interface ConcentrationReport {
  readonly year: number;
  readonly month: number;
  readonly currency: CurrencyCode;
  readonly totalMinor: bigint;
  readonly countries: readonly CountryConcentration[];
  /**
   * Совокупная доля высокорисковых юрисдикций. `CCO-compliance.md` формулирует
   * лимит как совокупный, `PRODUCT.md` §10 — как лимит на одну юрисдикцию.
   * Считаем оба и берём строгий; расхождение документов вынесено в отчёт.
   */
  readonly highRiskAggregate: AggregateConcentration;
  readonly breaches: readonly ReasonKey[];
  readonly withinLimits: boolean;
}

function ceilShareBp(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 10_000n + total - 1n) / total);
}

function excessMinor(part: bigint, total: bigint, limitBp: number): bigint {
  const allowed = (total * BigInt(limitBp)) / 10_000n;
  const excess = part - allowed;
  return excess > 0n ? excess : 0n;
}

export function evaluateConcentration(
  turnover: MonthlyTurnover,
  policy: ConcentrationPolicy,
): ConcentrationReport {
  if (turnover.totalMinor < 0n) {
    throw new ComplianceError(ComplianceErrorCode.aggregateNegative, {
      total: String(turnover.totalMinor),
    });
  }
  let sum = 0n;
  for (const item of turnover.byCountry) {
    if (item.minor < 0n) {
      throw new ComplianceError(ComplianceErrorCode.aggregateNegative, {
        country: item.country,
        minor: String(item.minor),
      });
    }
    sum += item.minor;
  }
  if (sum > turnover.totalMinor) {
    throw new ComplianceError(ComplianceErrorCode.aggregatePartsExceedTotal, {
      parts: String(sum),
      total: String(turnover.totalMinor),
    });
  }

  const breaches: ReasonKey[] = [];
  const countries: CountryConcentration[] = turnover.byCountry.map((item) => {
    const highRisk = policy.highRiskJurisdictions.includes(item.country);
    // Лимит на одну страну применяется ко всем; высокорисковая получает более
    // строгий из двух, а не вместо.
    const limitBp = highRisk
      ? Math.min(policy.singleCountryShareBp, policy.highRiskCountryShareBp)
      : policy.singleCountryShareBp;
    const shareBp = ceilShareBp(item.minor, turnover.totalMinor);
    const over = Math.max(0, shareBp - limitBp);
    if (over > 0) {
      breaches.push(
        highRisk
          ? REASON_KEYS.concentrationHighRiskCountryExceeded
          : REASON_KEYS.concentrationCountryExceeded,
      );
    }
    return Object.freeze({
      country: item.country,
      minor: item.minor,
      shareBp,
      limitBp,
      highRisk,
      excessBp: over,
      excessMinor: excessMinor(item.minor, turnover.totalMinor, limitBp),
    });
  });

  const highRiskMinor = countries
    .filter((item) => item.highRisk)
    .reduce((total, item) => total + item.minor, 0n);
  const aggregateShareBp = ceilShareBp(highRiskMinor, turnover.totalMinor);
  const aggregateOver = Math.max(0, aggregateShareBp - policy.highRiskAggregateShareBp);
  if (aggregateOver > 0) breaches.push(REASON_KEYS.concentrationHighRiskAggregateExceeded);

  const unique = breaches.filter((reason, index) => breaches.indexOf(reason) === index);
  return Object.freeze({
    year: turnover.year,
    month: turnover.month,
    currency: turnover.currency,
    totalMinor: turnover.totalMinor,
    countries: Object.freeze(countries),
    highRiskAggregate: Object.freeze({
      minor: highRiskMinor,
      shareBp: aggregateShareBp,
      limitBp: policy.highRiskAggregateShareBp,
      excessBp: aggregateOver,
      excessMinor: excessMinor(highRiskMinor, turnover.totalMinor, policy.highRiskAggregateShareBp),
    }),
    breaches: Object.freeze(unique.length > 0 ? unique : [REASON_KEYS.concentrationWithinLimits]),
    withinLimits: unique.length === 0,
  });
}
