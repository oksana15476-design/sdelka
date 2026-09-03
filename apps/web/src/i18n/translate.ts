import ru from './messages/ru.json';
import en from './messages/en.json';
import ka from './messages/ka.json';
import { type Locale, LOCALE_TAG } from './locales';

/**
 * Словарь — плоская карта «ключ → строка». Плоская, а не вложенная, ровно по
 * одной причине: отсутствующий ключ обязан быть видимой ошибкой, а у вложенной
 * структуры промах даёт `undefined` на середине пути и молчаливую пустоту.
 */
export type Dictionary = Readonly<Record<string, string>>;

const DICTIONARIES: Readonly<Record<Locale, Dictionary>> = Object.freeze({
  ru: ru as Dictionary,
  en: en as Dictionary,
  ka: ka as Dictionary,
});

export function dictionaryOf(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Подстановка значений в строку словаря.
 *
 * Пропущенный ключ возвращается видимой меткой, а не пустотой: пустая строка на
 * экране денег читается как «данных нет», и такой промах обязан бросаться в
 * глаза при первом же прогоне, а не жить в проде.
 */
export function t(dict: Dictionary, key: string, params?: MessageParams): string {
  const template = dict[key];
  if (template === undefined) {
    return `[${key}]`;
  }
  if (params === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Плюрализация через `Intl.PluralRules`: у ключа существуют варианты
 * `<ключ>.one`, `.few`, `.many`, `.other` — сколько форм у языка, столько и
 * ключей. Конкатенации «число + слово» нет ни одной: число подставляется внутрь
 * выбранной формы.
 */
export function plural(
  dict: Dictionary,
  locale: Locale,
  key: string,
  count: number,
  params?: MessageParams,
): string {
  const category = new Intl.PluralRules(LOCALE_TAG[locale]).select(count);
  const exact = `${key}.${category}`;
  const chosen = dict[exact] === undefined ? `${key}.other` : exact;
  return t(dict, chosen, { ...params, count });
}
