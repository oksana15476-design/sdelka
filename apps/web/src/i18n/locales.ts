/**
 * Языки продукта — русский, английский, грузинский с первого дня
 * (`CLAUDE.md`, «Три языка»).
 *
 * Тег локали отделён от кода языка намеренно: `Intl` форматирует по тегу с
 * регионом, а в маршруте живёт короткий код. Своих форматтеров чисел, дат и
 * валют в проекте нет ни одного — только `Intl` по этому тегу.
 */
export const LOCALES = ['ru', 'en', 'ka'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ru';

export const LOCALE_TAG: Readonly<Record<Locale, string>> = Object.freeze({
  ru: 'ru-RU',
  en: 'en-US',
  ka: 'ka-GE',
});

/**
 * Направление письма. Все три языка слева направо; поле существует, чтобы
 * задел под правостороннее письмо был выражен значением, а не обещанием: в
 * стилях нет ни одного физического свойства, и добавление языка с `rtl` не
 * потребует переписывать вёрстку.
 */
export const LOCALE_DIRECTION: Readonly<Record<Locale, 'ltr' | 'rtl'>> = Object.freeze({
  ru: 'ltr',
  en: 'ltr',
  ka: 'ltr',
});

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Тот же экран на другом языке.
 *
 * Переключатель обязан менять **язык**, а не место: клиент, стоящий на разборе
 * расхождения по своей сделке, после смены языка обязан остаться на нём.
 * Прежняя ссылка вела на `/{язык}` и выбрасывала на список сделок — то есть
 * переключатель работал ещё и кнопкой «домой», о чём нигде не сказано.
 *
 * Язык живёт первым сегментом маршрута (`middleware.ts`), поэтому подмена —
 * это подмена одного сегмента. Если первого сегмента нет или он не язык, вести
 * некуда, кроме корня: путь без языка до каркаса не доходит вовсе.
 */
export function localePath(path: string, locale: Locale): string {
  const first = path.split('/')[1] ?? '';
  if (!isLocale(first)) return `/${locale}`;
  return `/${locale}${path.slice(first.length + 1)}`;
}
