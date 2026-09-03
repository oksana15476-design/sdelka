import type { Dictionary } from '@/i18n/translate';
import type { Locale } from '@/i18n/locales';

/**
 * Пара «словарь + локаль», которую получает каждый компонент.
 *
 * Передаётся значением, а не функцией: функция-компонент или замыкание,
 * уехавшее пропом через границу сервер → клиент, падает в рантайме и не ловится
 * сборкой. Здесь через границу едут только данные.
 */
export interface L10n {
  readonly dict: Dictionary;
  readonly locale: Locale;
}
