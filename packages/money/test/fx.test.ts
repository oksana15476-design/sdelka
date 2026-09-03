import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  accountingFxDifference,
  convert,
  convertAtRate,
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
    const converted = convert(source, 'GEL', rates, asOf, 'trunc');
    expect(converted.source).toEqual(source);
    expect(converted.target.currency).toBe('GEL');
    expect(converted.target.minor).toBe(21_349_500n);
    expect(converted.rates).toBe(rates);
    expect(converted.asOf).toBe(asOf);
  });

  it('reproduces the documented spread of 1 505 GEL', () => {
    const converted = convert(source, 'GEL', rates, asOf, 'trunc');
    const spread = platformSpread(converted, 'trunc');
    expect(spread.kind).toBe('platform_spread');
    expect(spread.amount.minor).toBe(150_500n);
  });

  it('keeps the accounting fx difference separate from the spread', () => {
    const converted = convert(source, 'GEL', rates, asOf, 'trunc');
    const breakdown = fxBreakdown(converted, 'trunc');
    expect(breakdown.accounting.amount.minor).toBe(250_500n);
    expect(breakdown.spread.amount.minor).toBe(150_500n);
    // CORE.md Ф5: это разные показатели. Они не равны и не складываются.
    expect(breakdown.accounting.amount.minor).not.toBe(breakdown.spread.amount.minor);
  });

  it('reports a zero accounting difference when the official rate equals the client rate', () => {
    const converted = convert(source, 'GEL', { ...rates, official: rates.client }, asOf, 'trunc');
    expect(accountingFxDifference(converted, 'trunc').amount.minor).toBe(0n);
    expect(platformSpread(converted, 'trunc').amount.minor).toBe(150_500n);
  });

  it('refuses to convert a currency into itself and to accept a malformed date', () => {
    expect(() => convert(source, 'USD', rates, asOf, 'trunc')).toThrow(MoneyError);
    expect(() => convertAtRate(source, 'USD', rates.official, 'trunc')).toThrow(MoneyError);
    expect(() => isoDate('03.09.2026')).toThrow(MoneyError);
  });
});

describe('направление округления при конвертации', () => {
  /**
   * FUNCTIONAL.md §4.3: «Направление задаётся явным параметром на каждом вызове,
   * значения по умолчанию у операции нет». Отсутствие умолчания проверяется
   * арностью: параметр со значением по умолчанию в `length` не считается, и
   * возврат умолчания уронит этот тест, а не пройдёт незамеченным. Типовую
   * сторону («вызов без параметра не компилируется») держит `pnpm typecheck`.
   */
  it('has no overload without the rounding argument', () => {
    expect(convert.length).toBe(5);
    expect(convertAtRate.length).toBe(4);
    expect(platformSpread.length).toBe(2);
    expect(accountingFxDifference.length).toBe(2);
    expect(fxBreakdown.length).toBe(2);
  });

  it('truncates rather than rounds to nearest, in whichever direction is asked', () => {
    // 1 005 USD по курсу 2,6686875 — это 2 682,0309... лари: усечение отбрасывает
    // 0,09 тетри, ceil добавляет тетри. Разница копеечная и в этом весь смысл:
    // молчаливое умолчание теряет её тысячу раз (FUNCTIONAL.md §4.3).
    const odd = money('USD', 100_500n);
    expect(convertAtRate(odd, 'GEL', rates.client, 'trunc').minor).toBe(268_203n);
    expect(convertAtRate(odd, 'GEL', rates.client, 'ceil').minor).toBe(268_204n);
    expect(convertAtRate(odd, 'GEL', rates.client, 'floor').minor).toBe(268_203n);
  });

  it('accounts for currencies with a different number of minor digits', () => {
    // JPY — 0 знаков. Пересчёт «минорные на курс» без поправки на порядок дал бы
    // сумму в сто раз больше: 100,00 USD по 150 — это 15 000 иен, а не 1 500 000.
    const hundredDollars = money('USD', 10_000n);
    const rate = rationalFromDecimalString('150');
    expect(convertAtRate(hundredDollars, 'JPY', rate, 'trunc').minor).toBe(15_000n);
    const fifteenThousandYen = money('JPY', 15_000n);
    expect(
      convertAtRate(fifteenThousandYen, 'USD', rationalFromDecimalString('0.0066666'), 'trunc').minor,
    ).toBe(9_999n);
  });
});
