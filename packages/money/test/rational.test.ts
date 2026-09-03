import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  applyRational,
  compareRational,
  money,
  multiplyRational,
  rational,
  rationalEquals,
  rationalFromDecimalString,
  scaleBy,
  subtractRational,
} from '../src/index';

describe('rational: курс без плавающей точки', () => {
  it('normalises sign and reduces the fraction', () => {
    expect(rational(2n, -4n)).toEqual({ numerator: -1n, denominator: 2n });
    expect(rationalEquals(rational(4n, 8n), rational(1n, 2n))).toBe(true);
  });

  it('parses decimal rates exactly', () => {
    expect(rationalFromDecimalString('2.6686875')).toEqual({
      numerator: 42699n,
      denominator: 16000n,
    });
    expect(rationalFromDecimalString('0.007')).toEqual({ numerator: 7n, denominator: 1000n });
  });

  it('rejects a zero denominator and malformed rates', () => {
    expect(() => rational(1n, 0n)).toThrow(MoneyError);
    expect(() => rationalFromDecimalString('2,5')).toThrow(MoneyError);
    expect(() => rationalFromDecimalString('1e-3')).toThrow(MoneyError);
  });

  it('multiplies and subtracts exactly where floats drift', () => {
    const third = rational(1n, 3n);
    const product = multiplyRational(multiplyRational(third, rational(3n, 1n)), rational(1n, 1n));
    expect(rationalEquals(product, rational(1n, 1n))).toBe(true);
    expect(subtractRational(rational(1n, 10n), rational(1n, 10n)).numerator).toBe(0n);
    expect(compareRational(rational(1n, 3n), rational(1n, 2n))).toBe(-1);
  });

  it('rounds in the direction it is told, including for negatives', () => {
    const seventh = rational(1n, 7n);
    expect(applyRational(10n, seventh, 'trunc')).toBe(1n);
    expect(applyRational(10n, seventh, 'ceil')).toBe(2n);
    expect(applyRational(10n, seventh, 'floor')).toBe(1n);
    expect(applyRational(-10n, seventh, 'trunc')).toBe(-1n);
    expect(applyRational(-10n, seventh, 'floor')).toBe(-2n);
    expect(applyRational(-10n, seventh, 'ceil')).toBe(-1n);
  });

  it('scales money by a rate', () => {
    expect(scaleBy(money('USD', 8_000_000n), rationalFromDecimalString('2.6686875'), 'trunc').minor).toBe(
      21_349_500n,
    );
  });
});
