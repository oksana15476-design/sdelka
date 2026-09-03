import { type CurrencyCode } from './currency';
import { MoneyError, MoneyErrorCode } from './errors';
import { type Money, money, subtract } from './money';
import { type Rational, type Rounding, scaleBy } from './rational';

/** Дата операции в форме YYYY-MM-DD. Курс без даты не является курсом. */
export type IsoDate = string & { readonly __isoDate: unique symbol };

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function isoDate(value: string): IsoDate {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new MoneyError(MoneyErrorCode.parseFormat, { text: value });
  }
  return value as IsoDate;
}

/**
 * Три курса, которые обязаны храниться вместе (FUNCTIONAL.md §4.5, CORE.md Ф5):
 * клиентский (по нему зачисляем клиенту), эталонный (рыночный, от него считается
 * наценка) и официальный на дату операции (по нему считается учётная курсовая
 * разница). Без эталонного нельзя показать наценку и разделить выручку для налога.
 */
export interface FxRates {
  readonly client: Rational;
  readonly reference: Rational;
  readonly official: Rational;
}

export interface ConvertedAmount<F extends CurrencyCode, T extends CurrencyCode> {
  readonly source: Money<F>;
  /** Сумма, зачисленная клиенту: исходная сумма по клиентскому курсу. */
  readonly target: Money<T>;
  readonly rates: FxRates;
  readonly asOf: IsoDate;
}

export interface ConvertOptions {
  readonly rounding?: Rounding;
}

export function convert<F extends CurrencyCode, T extends CurrencyCode>(
  source: Money<F>,
  targetCurrency: T,
  rates: FxRates,
  asOf: IsoDate,
  options: ConvertOptions = {},
): ConvertedAmount<F, T> {
  if ((source.currency as CurrencyCode) === (targetCurrency as CurrencyCode)) {
    throw new MoneyError(MoneyErrorCode.fxCurrencyMismatch, {
      source: source.currency,
      target: targetCurrency,
    });
  }
  const rounding = options.rounding ?? 'trunc';
  const target = money(targetCurrency, scaleBy(source, rates.client, rounding).minor);
  return Object.freeze({ source, target, rates, asOf });
}

/**
 * Наш доход на конвертации: разница между эталонным и клиентским курсом.
 * Признаётся как `fx:income`.
 */
export interface PlatformSpread<C extends CurrencyCode> {
  readonly kind: 'platform_spread';
  readonly amount: Money<C>;
}

/**
 * Учётная курсовая разница по официальному курсу на дату операции.
 * Это **другой показатель**, не равный спреду (CORE.md Ф5, FUNCTIONAL.md §4.5):
 * смешивать их нельзя, поэтому они не Money, а два разных типа — сложить их
 * функцией `add` нельзя, распаковывать приходится осознанно.
 */
export interface AccountingFxDifference<C extends CurrencyCode> {
  readonly kind: 'accounting_fx_difference';
  readonly amount: Money<C>;
}

export function platformSpread<F extends CurrencyCode, T extends CurrencyCode>(
  converted: ConvertedAmount<F, T>,
  rounding: Rounding = 'trunc',
): PlatformSpread<T> {
  const atReference = money(
    converted.target.currency,
    scaleBy(converted.source, converted.rates.reference, rounding).minor,
  );
  return Object.freeze({
    kind: 'platform_spread',
    amount: subtract(atReference, converted.target),
  });
}

export function accountingFxDifference<F extends CurrencyCode, T extends CurrencyCode>(
  converted: ConvertedAmount<F, T>,
  rounding: Rounding = 'trunc',
): AccountingFxDifference<T> {
  const atOfficial = money(
    converted.target.currency,
    scaleBy(converted.source, converted.rates.official, rounding).minor,
  );
  return Object.freeze({
    kind: 'accounting_fx_difference',
    amount: subtract(atOfficial, converted.target),
  });
}

/** Оба показателя рядом, но по-прежнему раздельно: суммы здесь не складываются. */
export interface FxBreakdown<C extends CurrencyCode> {
  readonly spread: PlatformSpread<C>;
  readonly accounting: AccountingFxDifference<C>;
}

export function fxBreakdown<F extends CurrencyCode, T extends CurrencyCode>(
  converted: ConvertedAmount<F, T>,
): FxBreakdown<T> {
  return Object.freeze({
    spread: platformSpread(converted),
    accounting: accountingFxDifference(converted),
  });
}
