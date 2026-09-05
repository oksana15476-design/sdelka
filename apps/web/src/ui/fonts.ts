import type { Locale } from '@/i18n/locales';

/**
 * Что грузим заранее, а что подождёт.
 *
 * `font-display: swap` держит текст читаемым, пока гарнитура едет, но платит за
 * это перерисовкой: сумма, набранная сначала системным шрифтом, а через кадр
 * своим, на экране денег заметна. Предзагрузка снимает перерисовку у того, что
 * читают первым, — и **только** у него: preload всех восемнадцати файлов
 * отобрал бы канал у самой страницы.
 *
 * Отбор — по языку страницы, а не «на всякий случай»: русскому не нужен
 * мхедрули, грузинскому — кириллица. Латиница нужна всем: на любом языке в
 * интерфейсе есть коды валют, IBAN и номера.
 *
 * Моноширинный берётся весом 600 — это вес `.amount` (`app.css`), то есть тех
 * самых цифр, ради которых экран открывают.
 */
const SANS_LATIN = 'manrope-latin-400-800.woff2';
const MONO_AMOUNT = 'plexmono-latin-600.woff2';
const SANS_CYRILLIC = 'manrope-cyrillic-400-800.woff2';
const GEORGIAN = 'georgian-georgian-400-800.woff2';

/**
 * Имена файлов перечислены здесь, а не читаются из манифеста, по одной причине:
 * манифест лежит в `public/` и в сборку страницы не входит. Чтобы список не
 * разъехался с тем, что реально скачано, его держит тест `fonts.test.ts` —
 * он сверяет каждое имя с `public/fonts/MANIFEST.json`.
 */
export function preloadedFonts(locale: Locale): readonly string[] {
  const own = locale === 'ka' ? GEORGIAN : locale === 'ru' ? SANS_CYRILLIC : null;
  const files = [SANS_LATIN, MONO_AMOUNT];
  if (own !== null) files.push(own);
  return files.map((file) => `/fonts/${file}`);
}
