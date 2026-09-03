import { type CurrencyCode, minorUnitExponent, minorUnitScale } from './currency';
import { MoneyError, MoneyErrorCode } from './errors';

/**
 * Сумма — целые минорные единицы (bigint) плюс код валюты.
 * Красная линия №4: никаких сумм в плавающей точке, включая парсинг и вывод.
 *
 * Код валюты — параметр типа, и второй аргумент операций помечен `NoInfer`:
 * `add(usd, gel)` не компилируется, а не расширяет тип до объединения валют.
 * В рантайме несовпадение всё равно проверяется — типы не переживают границу
 * процесса (данные приходят из базы и из вебхуков).
 */
export interface Money<C extends CurrencyCode = CurrencyCode> {
  readonly currency: C;
  readonly minor: bigint;
}

export function money<C extends CurrencyCode>(currency: C, minor: bigint): Money<C> {
  return Object.freeze({ currency, minor });
}

export function zero<C extends CurrencyCode>(currency: C): Money<C> {
  return money(currency, 0n);
}

const DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d+)?$/u;

/**
 * Разбор десятичной строки — только целочисленный: строка режется на части и
 * складывается через BigInt. Number не участвует нигде, поэтому «0.1 + 0.2»
 * здесь не существует как проблема.
 *
 * Лишние знаки после запятой не округляются, а отвергаются: округление — это
 * решение бизнес-правила (см. split), а не побочный эффект парсинга.
 */
export function fromDecimalString<C extends CurrencyCode>(currency: C, text: string): Money<C> {
  if (!DECIMAL_PATTERN.test(text)) {
    throw new MoneyError(MoneyErrorCode.parseFormat, { currency, text });
  }
  const negative = text.startsWith('-');
  const unsigned = text.startsWith('+') || text.startsWith('-') ? text.slice(1) : text;
  const dot = unsigned.indexOf('.');
  const integerPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fractionPart = dot === -1 ? '' : unsigned.slice(dot + 1);
  const exponent = minorUnitExponent(currency);
  if (fractionPart.length > exponent) {
    throw new MoneyError(MoneyErrorCode.parseTooManyFractionDigits, {
      currency,
      text,
      exponent: String(exponent),
    });
  }
  const padded = fractionPart.padEnd(exponent, '0');
  const minor = BigInt(integerPart) * minorUnitScale(currency) + (padded === '' ? 0n : BigInt(padded));
  return money(currency, negative ? -minor : minor);
}

/** Обратная операция к разбору. Тоже без Number: только строковые операции над bigint. */
export function toDecimalString(value: Money): string {
  const exponent = minorUnitExponent(value.currency);
  const negative = value.minor < 0n;
  const absolute = negative ? -value.minor : value.minor;
  const scale = minorUnitScale(value.currency);
  const integerPart = (absolute / scale).toString();
  if (exponent === 0) {
    return `${negative ? '-' : ''}${integerPart}`;
  }
  const fractionPart = (absolute % scale).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${integerPart}.${fractionPart}`;
}

export function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new MoneyError(MoneyErrorCode.currencyMismatch, {
      left: left.currency,
      right: right.currency,
    });
  }
}

export function add<C extends CurrencyCode>(left: Money<C>, right: Money<NoInfer<C>>): Money<C> {
  assertSameCurrency(left, right);
  return money(left.currency, left.minor + right.minor);
}

export function subtract<C extends CurrencyCode>(left: Money<C>, right: Money<NoInfer<C>>): Money<C> {
  assertSameCurrency(left, right);
  return money(left.currency, left.minor - right.minor);
}

export function negate<C extends CurrencyCode>(value: Money<C>): Money<C> {
  return money(value.currency, -value.minor);
}

export function absolute<C extends CurrencyCode>(value: Money<C>): Money<C> {
  return money(value.currency, value.minor < 0n ? -value.minor : value.minor);
}

/** Умножение только на целое: доля выражается Rational и применяется через scaleBy. */
export function multiplyByInteger<C extends CurrencyCode>(value: Money<C>, factor: bigint): Money<C> {
  return money(value.currency, value.minor * factor);
}

export function compare<C extends CurrencyCode>(left: Money<C>, right: Money<NoInfer<C>>): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  if (left.minor < right.minor) return -1;
  if (left.minor > right.minor) return 1;
  return 0;
}

export function equals(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.minor === right.minor;
}

export function isZero(value: Money): boolean {
  return value.minor === 0n;
}

export function isNegative(value: Money): boolean {
  return value.minor < 0n;
}

export function isPositive(value: Money): boolean {
  return value.minor > 0n;
}

export function minimum<C extends CurrencyCode>(left: Money<C>, right: Money<NoInfer<C>>): Money<C> {
  return compare(left, right) <= 0 ? left : right;
}

export function maximum<C extends CurrencyCode>(left: Money<C>, right: Money<NoInfer<C>>): Money<C> {
  return compare(left, right) >= 0 ? left : right;
}

export function sum<C extends CurrencyCode>(currency: C, values: readonly Money<NoInfer<C>>[]): Money<C> {
  let total = 0n;
  for (const value of values) {
    assertSameCurrency({ currency, minor: 0n }, value);
    total += value.minor;
  }
  return money(currency, total);
}
