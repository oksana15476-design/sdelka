import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/i18n/locales';
import { preloadedFonts } from './fonts';

/**
 * Предзагрузка ссылается на файлы, которых может не быть.
 *
 * `<link rel="preload">` на несуществующий адрес не роняет ни сборку, ни
 * страницу: браузер получает 404, печатает предупреждение в консоль и рисует
 * системным шрифтом. То есть промах в имени файла выглядит ровно так же, как
 * положение до этого захода, — и обнаружить его можно только сверкой с тем, что
 * лежит в `public/fonts`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(HERE, '..', '..', 'public', 'fonts', 'MANIFEST.json');

interface Manifest {
  readonly files: readonly {
    readonly file: string;
    readonly family: string;
    readonly subset: string;
  }[];
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;

describe('гарнитуры лежат в репозитории, а не приходят из сети', () => {
  it('каждый предзагружаемый файл есть в манифесте', () => {
    const known = new Set(manifest.files.map((item) => `/fonts/${item.file}`));
    for (const locale of LOCALES) {
      for (const href of preloadedFonts(locale)) {
        expect(known.has(href), `${locale}: файла ${href} нет в манифесте`).toBe(true);
      }
    }
  });

  it('у каждого языка предзагружено своё письмо', () => {
    expect(preloadedFonts('ka').some((href) => href.includes('georgian-georgian'))).toBe(true);
    expect(preloadedFonts('ru').some((href) => href.includes('cyrillic'))).toBe(true);
    // Английскому хватает латиницы: своего письма у него нет, и третий файл был
    // бы каналом, потраченным впустую.
    expect(preloadedFonts('en')).toHaveLength(2);
  });

  it('грузинское начертание скачано настоящим, а не подставлено фолбэком', () => {
    const georgian = manifest.files.filter(
      (item) => item.family === 'Noto Sans Georgian' && item.subset === 'georgian',
    );
    expect(georgian.length).toBeGreaterThan(0);
  });

  /**
   * Знак лари живёт в подмножестве `latin-ext` (диапазон `U+20AD-20C0`), и
   * взять его неоткуда, кроме грузинской гарнитуры: в Manrope и IBM Plex Mono
   * этого глифа нет. Подмножество, потерянное при обновлении шрифтов, вернуло
   * бы знак валюты в системный фолбэк — то есть в чужую метрику посреди
   * колонки сумм.
   */
  it('подмножество со знаком лари скачано у грузинской гарнитуры', () => {
    const lari = manifest.files.find(
      (item) => item.family === 'Noto Sans Georgian' && item.subset === 'latin-ext',
    );
    expect(lari).toBeDefined();
  });
});
