import type { CurrencyCode, Money } from '@sdelka/money';
import { toDecimalString } from '@sdelka/money';
import { type Locale, LOCALE_TAG } from './locales';

/**
 * Форматирование — только `Intl`, ни одной своей функции (`CLAUDE.md`,
 * «Три языка»). Особенности локалей не обходятся, а принимаются как есть:
 *
 * - грузинская локаль не группирует разряды ниже пяти знаков: `2605,00 ₾`, но
 *   `217 000,00 ₾`. Поэтому суммы никогда не выравниваются «по пробелам» и
 *   всегда получают `font-variant-numeric: tabular-nums`;
 * - символ лари в русской локали не выводится вовсе — вместо `₾` печатается
 *   код `GEL`. Подменять его своей строкой запрещено: это не дефект, а правило
 *   русской локали, и на печатной форме оно обязано совпадать с системным;
 * - короткая дата в двух локалях из трёх даёт двузначный год (`03.09.26`),
 *   поэтому у дат, к которым привязаны деньги, короткого стиля нет ни одного —
 *   только `medium` и длиннее.
 *
 * Сумма приходит целыми минорными единицами и превращается в строку без
 * плавающей точки: `toDecimalString` из `@sdelka/money` даёт десятичную
 * строку, а `Intl.NumberFormat` принимает строку и не теряет разрядов
 * (красная линия №4).
 */
function formatDecimalString(formatter: Intl.NumberFormat, text: string): string {
  // `Intl.NumberFormat` третьей редакции принимает десятичную строку и не теряет
  // разрядов. Тип в стандартной библиотеке описывает строку шаблонным литералом,
  // под который обычная `string` не подходит, — отсюда приведение. Числом здесь
  // форматировать нельзя: на шестизначных суммах это потеря точности, то есть
  // нарушение красной линии №4.
  return (formatter.format as (value: string) => string)(text);
}

export function formatMoney(locale: Locale, value: Money<CurrencyCode>): string {
  return formatDecimalString(
    new Intl.NumberFormat(LOCALE_TAG[locale], { style: 'currency', currency: value.currency }),
    toDecimalString(value),
  );
}

/** Сумма со знаком: движение по счёту читается только со знаком. */
export function formatSignedMoney(locale: Locale, value: Money<CurrencyCode>): string {
  return formatDecimalString(
    new Intl.NumberFormat(LOCALE_TAG[locale], {
      style: 'currency',
      currency: value.currency,
      signDisplay: 'exceptZero',
    }),
    toDecimalString(value),
  );
}

/** Курс всегда с направлением: «1 USD = X ₾», а не «2,71». */
export function formatRate(locale: Locale, rate: string, currency: CurrencyCode): string {
  return formatDecimalString(
    new Intl.NumberFormat(LOCALE_TAG[locale], {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }),
    rate,
  );
}

export function formatDate(locale: Locale, at: number, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], { dateStyle: 'medium', timeZone }).format(at);
}

export function formatDateTime(locale: Locale, at: number, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(at);
}

/** Название зоны так, как его печатает сама локаль, а не наш словарь. */
export function formatZoneName(locale: Locale, at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(at);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
}

/**
 * Остаток времени. Составляется из единиц измерения `Intl`, а не из склеенных
 * слов: «4 ч 12 мин» в русском, «4 სთ 12 წთ» в грузинском — формы разные, и
 * выбирает их локаль.
 */
export function formatRemaining(locale: Locale, milliseconds: number): string {
  const tag = LOCALE_TAG[locale];
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const unit = (value: number, name: 'day' | 'hour' | 'minute'): string =>
    new Intl.NumberFormat(tag, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value);
  if (days > 0) {
    return [unit(days, 'day'), unit(hours, 'hour')].join(' ');
  }
  if (hours > 0) {
    return [unit(hours, 'hour'), unit(minutes, 'minute')].join(' ');
  }
  return unit(minutes, 'minute');
}

/** Доля в процентах — тоже `Intl`, потому что разделитель и знак у локалей разные. */
export function formatPercent(locale: Locale, value: number): string {
  return new Intl.NumberFormat(LOCALE_TAG[locale], {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(LOCALE_TAG[locale]).format(value);
}
