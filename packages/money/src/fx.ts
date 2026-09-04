import { type CurrencyCode, minorUnitScale } from './currency';
import { MoneyError, MoneyErrorCode } from './errors';
import { type Money, money, subtract } from './money';
import { type Rational, type Rounding, applyRational, multiplyRational, rational } from './rational';

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
 * Курс — величина **со своей парой валют**, а не голое число.
 *
 * **Исправленный дефект, самый дорогой в батче.** Прежде курс был `Rational`,
 * пара валют жила в аргументах вызова, и `convert` умножала на клиентский курс
 * в любом направлении. Проба: у клиента 200 000 ₾, курс 2,50 (лари за доллар),
 * конвертация GEL→USD зачисляла клиенту 500 000 долларов вместо 80 000 —
 * умножение вместо деления. Запись собиралась, номинальный счёт в валюте,
 * которой платформа не держала, вырастал из нуля, а покрытие рапортовало
 * единицу по обеим валютам: обязательство и покрытие под него создавала одна и
 * та же запись. Ни один инвариант не срабатывал.
 *
 * Проверять направление на входе `convert` было бы недостаточно: проверка
 * ловит вызов, а величина остаётся двусмысленной, и следующий вызов из другого
 * пакета соберёт ту же ошибку заново. Поэтому **направление — часть величины**:
 * курс несёт `base` (за одну мажорную единицу какой валюты он выражен) и
 * `quote` (в каких мажорных единицах). Применить курс не к своей паре нельзя ни
 * по типам (валюта выводится из суммы, а курс помечен `NoInfer` — иначе `F`
 * вывелся бы объединением обеих валют и несовпадение прошло бы молча), ни в
 * рантайме: типы не переживают границу процесса, курс приходит из базы и от
 * провайдера.
 *
 * **Обратного курса здесь нет намеренно.** Арифметически он был бы точен
 * (переворот дроби), но `1 / клиентский курс USD→GEL` — не клиентский курс
 * GEL→USD: спред обязан работать в нашу сторону в обоих направлениях, а
 * перевёрнутый курс отдаёт его клиенту. Обратное направление — это другая
 * котировка, которую выдаёт провайдер, а не вычисляет `money`. Дай мы здесь
 * `invert`, дверь, ради закрытия которой переписан этот модуль, открылась бы
 * снова.
 */
export interface FxRate<F extends CurrencyCode = CurrencyCode, T extends CurrencyCode = CurrencyCode> {
  /** Валюта, за одну **мажорную** единицу которой выражен курс. */
  readonly base: F;
  /** Валюта, в мажорных единицах которой выражен курс. */
  readonly quote: T;
  readonly value: Rational;
}

export function fxRate<F extends CurrencyCode, T extends CurrencyCode>(
  base: F,
  quote: T,
  value: Rational,
): FxRate<F, T> {
  if ((base as CurrencyCode) === (quote as CurrencyCode)) {
    throw new MoneyError(MoneyErrorCode.fxCurrencyMismatch, { source: base, target: quote });
  }
  // Ноль и отрицательный курс — не курс. Ноль обнуляет чужие деньги, знак
  // выворачивает направление, и обе величины проходят всю арифметику молча.
  if (value.numerator <= 0n) {
    throw new MoneyError(MoneyErrorCode.fxNonPositiveRate, {
      base,
      quote,
      value: `${value.numerator}/${value.denominator}`,
    });
  }
  return Object.freeze({ base, quote, value });
}

/**
 * Три курса, которые обязаны храниться вместе (FUNCTIONAL.md §4.5, CORE.md Ф5):
 * клиентский (по нему зачисляем клиенту), эталонный (рыночный, от него считается
 * наценка) и официальный на дату операции (по нему считается учётная курсовая
 * разница). Без эталонного нельзя показать наценку и разделить выручку для налога.
 *
 * Пара валют у всех трёх одна и та же и объявлена один раз: три курса разных
 * пар — это не котировка, а три разные котировки, и смешивать их в одном
 * значении нельзя. Собираются они только через `fxRates`, который эту пару и
 * проставляет.
 */
export interface FxRates<F extends CurrencyCode = CurrencyCode, T extends CurrencyCode = CurrencyCode> {
  readonly base: F;
  readonly quote: T;
  readonly client: FxRate<F, T>;
  readonly reference: FxRate<F, T>;
  readonly official: FxRate<F, T>;
}

export interface FxRateValues {
  readonly client: Rational;
  readonly reference: Rational;
  readonly official: Rational;
}

export function fxRates<F extends CurrencyCode, T extends CurrencyCode>(
  base: F,
  quote: T,
  values: FxRateValues,
): FxRates<F, T> {
  return Object.freeze({
    base,
    quote,
    client: fxRate(base, quote, values.client),
    reference: fxRate(base, quote, values.reference),
    official: fxRate(base, quote, values.official),
  });
}

export interface ConvertedAmount<F extends CurrencyCode, T extends CurrencyCode> {
  readonly source: Money<F>;
  /** Сумма, зачисленная клиенту: исходная сумма по клиентскому курсу. */
  readonly target: Money<T>;
  readonly rates: FxRates<F, T>;
  readonly asOf: IsoDate;
}

/**
 * Пересчёт суммы по курсу. Целевая валюта берётся **из курса**, а не из
 * аргумента: у величины уже есть направление, и второй его источник означал бы
 * возможность их рассогласовать.
 *
 * Курс — единиц целевой валюты за **мажорную** единицу исходной, как его
 * публикуют банк и Нацбанк. Разница в числе знаков (JPY — 0, GEL — 2) входит
 * множителем: пересчёт «минорные на курс» верен только пока у обеих валют
 * одинаковый порядок, и именно это молча ломается на первой же валюте с другим
 * числом знаков (см. `CURRENCY_EXPONENT`).
 *
 * Направление округления — обязательный параметр: FUNCTIONAL.md §4.3,
 * «значения по умолчанию у операции нет».
 */
export function convertAtRate<F extends CurrencyCode, T extends CurrencyCode>(
  source: Money<F>,
  rate: FxRate<NoInfer<F>, T>,
  rounding: Rounding,
): Money<T> {
  assertRateApplies(source, rate);
  const exponentFactor = rational(minorUnitScale(rate.quote), minorUnitScale(source.currency));
  return money(
    rate.quote,
    applyRational(source.minor, multiplyRational(rate.value, exponentFactor), rounding),
  );
}

/**
 * Курс применяется только к своей паре. Типы это уже говорят, но данные
 * приходят из базы и от провайдера — там типов нет.
 */
function assertRateApplies<F extends CurrencyCode, T extends CurrencyCode>(
  source: Money<F>,
  rate: FxRate<F, T>,
): void {
  if ((source.currency as CurrencyCode) !== (rate.base as CurrencyCode)) {
    throw new MoneyError(MoneyErrorCode.fxRatePairMismatch, {
      source: source.currency,
      base: rate.base,
      quote: rate.quote,
    });
  }
  if ((rate.base as CurrencyCode) === (rate.quote as CurrencyCode)) {
    throw new MoneyError(MoneyErrorCode.fxCurrencyMismatch, {
      source: rate.base,
      target: rate.quote,
    });
  }
}

export function convert<F extends CurrencyCode, T extends CurrencyCode>(
  source: Money<F>,
  rates: FxRates<NoInfer<F>, T>,
  asOf: IsoDate,
  rounding: Rounding,
): ConvertedAmount<F, T> {
  const target = convertAtRate(source, rates.client, rounding);
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
  rounding: Rounding,
): PlatformSpread<T> {
  const atReference = convertAtRate(converted.source, converted.rates.reference, rounding);
  return Object.freeze({
    kind: 'platform_spread',
    amount: subtract(atReference, converted.target),
  });
}

export function accountingFxDifference<F extends CurrencyCode, T extends CurrencyCode>(
  converted: ConvertedAmount<F, T>,
  rounding: Rounding,
): AccountingFxDifference<T> {
  const atOfficial = convertAtRate(converted.source, converted.rates.official, rounding);
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
  rounding: Rounding,
): FxBreakdown<T> {
  return Object.freeze({
    spread: platformSpread(converted, rounding),
    accounting: accountingFxDifference(converted, rounding),
  });
}
