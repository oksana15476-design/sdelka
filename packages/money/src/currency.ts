import { MoneyError, MoneyErrorCode } from './errors';

/**
 * Число знаков после запятой — свойство валюты, а не константа 100.
 * JPY (0 знаков) присутствует намеренно: он ловит захардкоженную степень десяти.
 */
export const CURRENCY_EXPONENT = {
  GEL: 2,
  USD: 2,
  EUR: 2,
  JPY: 0,
} as const;

export type CurrencyCode = keyof typeof CURRENCY_EXPONENT;

export const CURRENCY_CODES = Object.keys(CURRENCY_EXPONENT) as readonly CurrencyCode[];

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, value);
}

export function assertCurrencyCode(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new MoneyError(MoneyErrorCode.unknownCurrency, { currency: value });
  }
  return value;
}

export function minorUnitExponent(currency: CurrencyCode): number {
  return CURRENCY_EXPONENT[currency];
}

/** Множитель мажорной единицы в минорных. Только bigint: плавающая точка запрещена. */
export function minorUnitScale(currency: CurrencyCode): bigint {
  return 10n ** BigInt(CURRENCY_EXPONENT[currency]);
}
