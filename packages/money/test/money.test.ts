import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  MoneyErrorCode,
  add,
  compare,
  fromDecimalString,
  minorUnitScale,
  money,
  multiplyByInteger,
  negate,
  subtract,
  sum,
  toDecimalString,
} from '../src/index';

describe('money: construction and parsing', () => {
  it('builds from minor units', () => {
    expect(money('GEL', 213_495_00n).minor).toBe(21349500n);
  });

  it('parses decimal strings without floating point', () => {
    expect(fromDecimalString('GEL', '2134.95').minor).toBe(213495n);
    expect(fromDecimalString('GEL', '0.01').minor).toBe(1n);
    expect(fromDecimalString('GEL', '-0.01').minor).toBe(-1n);
    expect(fromDecimalString('GEL', '7').minor).toBe(700n);
    expect(fromDecimalString('GEL', '+7.5').minor).toBe(750n);
  });

  it('keeps precision that double would lose', () => {
    const a = fromDecimalString('USD', '0.1');
    const b = fromDecimalString('USD', '0.2');
    expect(add(a, b).minor).toBe(30n);
    expect(toDecimalString(add(a, b))).toBe('0.30');
  });

  it('parses amounts far beyond the safe integer range', () => {
    const huge = fromDecimalString('USD', '99999999999999999999.99');
    expect(huge.minor).toBe(9999999999999999999999n);
    expect(toDecimalString(huge)).toBe('99999999999999999999.99');
  });

  it('rejects malformed input instead of guessing', () => {
    for (const text of ['1e3', '1 000.00', '1,00', '', '.5', 'abc', '1.2.3', 'NaN', 'Infinity']) {
      expect(() => fromDecimalString('GEL', text)).toThrow(MoneyError);
    }
  });

  it('rejects extra fraction digits rather than rounding silently', () => {
    try {
      fromDecimalString('GEL', '1.005');
      expect.unreachable();
    } catch (error) {
      expect((error as MoneyError).code).toBe(MoneyErrorCode.parseTooManyFractionDigits);
    }
  });
});

describe('money: minor unit exponent is a property of the currency', () => {
  it('does not hardcode 100', () => {
    expect(minorUnitScale('GEL')).toBe(100n);
    expect(minorUnitScale('JPY')).toBe(1n);
  });

  it('parses and prints a zero-decimal currency', () => {
    const value = fromDecimalString('JPY', '1500');
    expect(value.minor).toBe(1500n);
    expect(toDecimalString(value)).toBe('1500');
    expect(() => fromDecimalString('JPY', '1500.5')).toThrow(MoneyError);
  });

  it('round-trips every currency', () => {
    expect(toDecimalString(fromDecimalString('EUR', '-12.34'))).toBe('-12.34');
    expect(toDecimalString(fromDecimalString('USD', '0.00'))).toBe('0.00');
    expect(toDecimalString(money('JPY', -7n))).toBe('-7');
  });
});

describe('money: arithmetic', () => {
  const gel = (text: string) => fromDecimalString('GEL', text);

  it('adds, subtracts, negates and multiplies by integers', () => {
    expect(add(gel('10.00'), gel('0.05')).minor).toBe(1005n);
    expect(subtract(gel('10.00'), gel('0.05')).minor).toBe(995n);
    expect(negate(gel('10.00')).minor).toBe(-1000n);
    expect(multiplyByInteger(gel('10.00'), 3n).minor).toBe(3000n);
  });

  it('compares and sums', () => {
    expect(compare(gel('1.00'), gel('2.00'))).toBe(-1);
    expect(compare(gel('2.00'), gel('2.00'))).toBe(0);
    expect(compare(gel('3.00'), gel('2.00'))).toBe(1);
    expect(sum('GEL', [gel('1.00'), gel('2.50')]).minor).toBe(350n);
  });

  it('throws on currency mismatch at runtime as well as at compile time', () => {
    const usd = fromDecimalString('USD', '1.00');
    // @ts-expect-error красная линия: сложение разных валют — ошибка типа
    expect(() => add(gel('1.00'), usd)).toThrow(MoneyError);
  });
});
