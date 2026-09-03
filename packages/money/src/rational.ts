import { type CurrencyCode } from './currency';
import { MoneyError, MoneyErrorCode } from './errors';
import { type Money, money } from './money';

/**
 * Курс и ставка — рациональное число из двух bigint, а не float.
 * Курс 2,6686875 GEL/USD в double уже не равен себе после трёх операций,
 * а из него считается сумма, которую увидит клиент.
 */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;
  while (right !== 0n) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left;
}

/** Нормализуем знак в числителе и сокращаем: равные величины равны структурно. */
export function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) {
    throw new MoneyError(MoneyErrorCode.rationalZeroDenominator);
  }
  const sign = denominator < 0n ? -1n : 1n;
  const signedNumerator = numerator * sign;
  const signedDenominator = denominator * sign;
  const divisor = greatestCommonDivisor(signedNumerator, signedDenominator);
  if (divisor === 0n) {
    return Object.freeze({ numerator: 0n, denominator: 1n });
  }
  return Object.freeze({
    numerator: signedNumerator / divisor,
    denominator: signedDenominator / divisor,
  });
}

export const RATIONAL_ONE: Rational = rational(1n, 1n);
export const RATIONAL_ZERO: Rational = rational(0n, 1n);

const DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d+)?$/u;

export function rationalFromDecimalString(text: string): Rational {
  if (!DECIMAL_PATTERN.test(text)) {
    throw new MoneyError(MoneyErrorCode.parseFormat, { text });
  }
  const negative = text.startsWith('-');
  const unsigned = text.startsWith('+') || text.startsWith('-') ? text.slice(1) : text;
  const dot = unsigned.indexOf('.');
  const integerPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fractionPart = dot === -1 ? '' : unsigned.slice(dot + 1);
  const denominator = 10n ** BigInt(fractionPart.length);
  const numerator = BigInt(integerPart) * denominator + (fractionPart === '' ? 0n : BigInt(fractionPart));
  return rational(negative ? -numerator : numerator, denominator);
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

export function subtractRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function compareRational(left: Rational, right: Rational): -1 | 0 | 1 {
  const leftSide = left.numerator * right.denominator;
  const rightSide = right.numerator * left.denominator;
  if (leftSide < rightSide) return -1;
  if (leftSide > rightSide) return 1;
  return 0;
}

export function rationalEquals(left: Rational, right: Rational): boolean {
  return compareRational(left, right) === 0;
}

/**
 * Направление округления задаётся явно на каждом вызове: правило «остаток
 * достаётся получателю» (FUNCTIONAL.md §4.3) — это выбор направления, и он
 * не должен решаться умолчанием библиотеки.
 */
export type Rounding = 'trunc' | 'floor' | 'ceil';

export function applyRational(value: bigint, factor: Rational, rounding: Rounding): bigint {
  const numerator = value * factor.numerator;
  const denominator = factor.denominator;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) {
    return quotient;
  }
  switch (rounding) {
    case 'trunc':
      return quotient;
    case 'floor':
      return numerator < 0n ? quotient - 1n : quotient;
    case 'ceil':
      return numerator > 0n ? quotient + 1n : quotient;
  }
}

export function scaleBy<C extends CurrencyCode>(
  value: Money<C>,
  factor: Rational,
  rounding: Rounding,
): Money<C> {
  return money(value.currency, applyRational(value.minor, factor, rounding));
}
