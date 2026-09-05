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

/** Знак лари. В коде — кодовой точкой: литерал в исходнике не нужен. */
const LARI = '₾';

export interface MoneyPart {
  readonly text: string;
  /** Знак лари ставится в слот фиксированной ширины, остальное — как есть. */
  readonly lari: boolean;
}

/**
 * Сумма, разобранная на части, чтобы знак валюты можно было положить в слот
 * фиксированной ширины (`IMPLEMENTATION.md` §1, дизайн-система §2.4).
 *
 * Глифа `₾` нет ни в Manrope, ни в IBM Plex Mono: он приходит из шрифта-фолбэка
 * со своей метрикой, и в вертикальном списке сумм уводит правый край. Слот
 * `.62em` возвращает колонку на место. Все прочие валюты форматируются без
 * изменений: у их символов метрика гарнитуры, и слот им только вредит.
 */
export function formatMoneyParts(locale: Locale, value: Money<CurrencyCode>): readonly MoneyPart[] {
  const formatter = new Intl.NumberFormat(LOCALE_TAG[locale], {
    style: 'currency',
    currency: value.currency,
  });
  const parts = (formatter.formatToParts as (input: string) => Intl.NumberFormatPart[])(
    toDecimalString(value),
  );
  const out: MoneyPart[] = [];
  for (const part of parts) {
    const lari = part.type === 'currency' && part.value === LARI;
    const previous = out.at(-1);
    if (!lari && previous !== undefined && !previous.lari) {
      out[out.length - 1] = { text: previous.text + part.value, lari: false };
      continue;
    }
    out.push({ text: part.value, lari });
  }
  return out;
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

/**
 * Покрытие — отношение, а не процент: цель ровно единица, и четыре знака после
 * запятой здесь несут смысл (`FUNCTIONAL.md`, красная линия №3).
 */
export function formatRatio(locale: Locale, value: number): string {
  return new Intl.NumberFormat(LOCALE_TAG[locale], {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value);
}

export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(LOCALE_TAG[locale]).format(value);
}

/**
 * Доля, пришедшая базисными пунктами, — два знака после запятой.
 *
 * Ставка и наценка приходят целыми базисными пунктами именно потому, что доля с
 * плавающей точкой в денежном домене запрещена (красная линия №4). Деление на
 * десять тысяч здесь — **последний шаг перед экраном**: полученное число ни во
 * что не возвращается и ни на что не умножается. Округление до одного знака не
 * годится: 0,69 % и 0,74 % — разные решения владельца, а печатались бы одинаково.
 */
export function formatBasisPoints(locale: Locale, bp: number): string {
  return new Intl.NumberFormat(LOCALE_TAG[locale], {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(bp / 10_000);
}

/**
 * Площадь объекта из выписки реестра.
 *
 * Приходит десятичной **строкой** и строкой же уходит в `Intl`: числом её
 * форматировать нельзя по той же причине, по которой нельзя деньги, — выписка
 * различает `92.0` и `92`, а `Number` их склеивает. Печаталась она до этого без
 * `Intl` вовсе, и на карточке сходились два десятичных разделителя: площадь с
 * точкой рядом с суммой, у которой запятая.
 *
 * Единицы измерения `Intl` здесь не даёт: квадратного метра нет в перечне
 * допустимых единиц `Intl.NumberFormat` (`Intl.supportedValuesOf('unit')` знает
 * только `meter`, `centimeter`, `kilometer`, `millimeter`). Поэтому
 * форматируется одно число, а обозначение единицы — вопрос подписи поля и
 * решается словарём, а не подстановкой в код.
 *
 * Два знака — потолок, один — пол: выписка даёт площадь с одним знаком после
 * запятой, и `92,0` обязано остаться `92,0`, иначе расхождение `92.0` против
 * `89.6` печатается как «92» против «89,6» и читается опечаткой.
 */
export function formatArea(locale: Locale, area: string): string {
  return formatDecimalString(
    new Intl.NumberFormat(LOCALE_TAG[locale], {
      minimumFractionDigits: 1,
      maximumFractionDigits: 2,
    }),
    area,
  );
}

/** Месяц периода — названием, как его печатает локаль, а не номером. */
export function formatMonth(locale: Locale, at: number): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(at);
}
