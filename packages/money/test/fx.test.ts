import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  accountingFxDifference,
  convert,
  fxBreakdown,
  isoDate,
  money,
  platformSpread,
  rationalFromDecimalString,
} from '../src/index';

// Данные из FUNCTIONAL.md §3.3: 80 000 USD, рыночный курс 2,6875, спред 0,7%.
const source = money('USD', 8_000_000n);
const rates = {
  client: rationalFromDecimalString('2.6686875'),
  reference: rationalFromDecimalString('2.6875'),
  official: rationalFromDecimalString('2.7000'),
};
const asOf = isoDate('2026-09-03');

describe('три валютных измерения', () => {
  it('stores client, reference and official rate together with both amounts', () => {
    const converted = convert(source, 'GEL', rates, asOf);
    expect(converted.source).toEqual(source);
    expect(converted.target.currency).toBe('GEL');
    expect(converted.target.minor).toBe(21_349_500n);
    expect(converted.rates).toBe(rates);
    expect(converted.asOf).toBe(asOf);
  });

  it('reproduces the documented spread of 1 505 GEL', () => {
    const converted = convert(source, 'GEL', rates, asOf);
    const spread = platformSpread(converted);
    expect(spread.kind).toBe('platform_spread');
    expect(spread.amount.minor).toBe(150_500n);
  });

  it('keeps the accounting fx difference separate from the spread', () => {
    const converted = convert(source, 'GEL', rates, asOf);
    const breakdown = fxBreakdown(converted);
    expect(breakdown.accounting.amount.minor).toBe(250_500n);
    expect(breakdown.spread.amount.minor).toBe(150_500n);
    // CORE.md Ф5: это разные показатели. Они не равны и не складываются.
    expect(breakdown.accounting.amount.minor).not.toBe(breakdown.spread.amount.minor);
  });

  it('reports a zero accounting difference when the official rate equals the client rate', () => {
    const converted = convert(source, 'GEL', { ...rates, official: rates.client }, asOf);
    expect(accountingFxDifference(converted).amount.minor).toBe(0n);
    expect(platformSpread(converted).amount.minor).toBe(150_500n);
  });

  it('refuses to convert a currency into itself and to accept a malformed date', () => {
    expect(() => convert(source, 'USD', rates, asOf)).toThrow(MoneyError);
    expect(() => isoDate('03.09.2026')).toThrow(MoneyError);
  });
});
