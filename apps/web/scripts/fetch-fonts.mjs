#!/usr/bin/env node
/**
 * Гарнитуры — самохостингом: `node scripts/fetch-fonts.mjs`.
 *
 * ## Зачем скрипт, а не ссылка на CDN
 *
 * До этого захода в `apps/web` не было ни `@font-face`, ни `next/font`, ни
 * каталога `public/`, а токен `--font-sans` начинался с `'Manrope'`. Ни один
 * браузер, кроме разработческого, этих гарнитур не видел: интерфейс набирался
 * системным DejaVu, и **все** суждения о бюджетах длины, ритме и плотности
 * сняты не с того (`CABINETS-REDESIGN.md` §1.6).
 *
 * Ссылка на `fonts.googleapis.com` эту дыру не закрывает, а переносит: сеть в
 * проде не гарантирована, а шрифт, который не пришёл, — это тот же системный
 * фолбэк, только теперь ещё и с миганием. Поэтому файлы лежат в репозитории, а
 * скрипт нужен ровно один раз на обновление версии гарнитуры.
 *
 * ## Что делает
 *
 * 1. Спрашивает у Google Fonts CSS с UA современного Chrome — тогда отдаются
 *    `woff2` и **переменные** начертания там, где они есть (Manrope и Noto Sans
 *    Georgian — одним файлом на подмножество, вес 400…800).
 * 2. Берёт только нужные подмножества (`SUBSETS`): греческого, вьетнамского,
 *    математики и эмодзи в интерфейсе нет, и грузить их в репозиторий незачем.
 * 3. Складывает файлы в `public/fonts`, считает `sha256`, пишет
 *    `public/fonts/MANIFEST.json` — происхождение каждого файла: семейство,
 *    подмножество, диапазон, вес, исходный адрес, отпечаток.
 * 4. Генерирует `src/styles/fonts.css` из того же манифеста: диапазоны
 *    `unicode-range` в стилях обязаны совпадать с тем, что реально скачано, —
 *    переписанные руками, они разъезжаются молча и роняют фолбэк на грузинском.
 *
 * ## Проверка без сети
 *
 * `--check` не ходит в сеть: сверяет отпечатки файлов с манифестом и
 * актуальность `fonts.css`. Это то, что можно позвать из CI.
 *
 * ## Лицензии
 *
 * Все три семейства — SIL Open Font License 1.1. Текст лицензии кладётся рядом
 * с файлами (`public/fonts/OFL-*.txt`): шрифт без лицензии в репозитории — это
 * не «мелочь оформления», а несоблюдённое условие распространения.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const FONT_DIR = join(APP_ROOT, 'public', 'fonts');
const MANIFEST = join(FONT_DIR, 'MANIFEST.json');
const CSS_FILE = join(APP_ROOT, 'src', 'styles', 'fonts.css');

/** UA современного Chrome: без него Google Fonts отдаёт `ttf` вместо `woff2`. */
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Подмножества, которые действительно набираются на экранах.
 *
 * `latin-ext` держит знак лари `U+20BE` (диапазон `U+20AD-20C0`) — из-за него
 * подмножество нужно и грузинскому семейству тоже: знак валюты обязан прийти
 * из настоящей гарнитуры, а не из фолбэка со своей метрикой.
 */
const SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'georgian'];

const FAMILIES = [
  {
    slug: 'manrope',
    family: 'Manrope',
    query: 'Manrope:wght@400..800',
    ofl: 'manrope',
    keep: ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'],
  },
  {
    slug: 'plexmono',
    family: 'IBM Plex Mono',
    // Единственное невариативное семейство: веса берутся поимённо, и ровно те,
    // что стоят в `app.css` (400 подписи, 500 приглушённая сумма, 600 сумма,
    // 700 код). Лишний вес — это лишний файл в репозитории.
    query: 'IBM+Plex+Mono:wght@400;500;600;700',
    ofl: 'ibmplexmono',
    keep: ['latin', 'latin-ext', 'cyrillic'],
  },
  {
    slug: 'georgian',
    family: 'Noto Sans Georgian',
    query: 'Noto+Sans+Georgian:wght@400..800',
    ofl: 'notosansgeorgian',
    keep: ['georgian', 'latin-ext'],
  },
];

async function text(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`${url} ответил ${response.status}`);
  return response.text();
}

async function bytes(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`${url} ответил ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Разбор ответа Google Fonts: подмножество берётся из комментария **над**
 * блоком.
 *
 * Порядок здесь не косметика. Ответ идёт как `/* cyrillic *\/ @font-face {…}`,
 * а `split('@font-face')` разрезает его так, что комментарий следующего блока
 * попадает в конец предыдущего куска. Прочитанный «последним в куске», он
 * называет **соседнее** подмножество: файлы уезжают на одно имя, два начертания
 * встают в один файл, и обнаруживается это уже на экране — по пропавшему
 * кириллическому тексту. Поэтому подпись переносится из прошлого куска, а не
 * ищется в текущем.
 */
function parseFaces(css) {
  const faces = [];
  let subset = null;
  for (const chunk of css.split('@font-face')) {
    const src = chunk.match(/url\((https:[^)]+\.woff2)\)/u);
    if (src !== null) {
      const weight = chunk.match(/font-weight:\s*([^;]+);/u);
      const range = chunk.match(/unicode-range:\s*([^;]+);/u);
      faces.push({
        subset,
        url: src[1],
        weight: weight === null ? '400' : weight[1].trim(),
        unicodeRange: range === null ? null : range[1].trim(),
      });
    }
    const comment = [...chunk.matchAll(/\/\*\s*([a-z-]+)\s*\*\//gu)].at(-1);
    if (comment !== undefined) subset = comment[1];
  }
  return faces;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fileName(slug, subset, weight) {
  return `${slug}-${subset}-${weight.replace(/\s+/gu, '-')}.woff2`;
}

/**
 * Стили собираются из манифеста, а не пишутся руками: диапазон в `@font-face`
 * обязан быть тем же, по которому подмножество нарезано. Разошлись — браузер
 * либо тянет лишний файл, либо не находит глиф и уходит в системный шрифт,
 * причём молча.
 */
function renderCss(manifest) {
  const lines = [
    '/*',
    ' * Файл собран `scripts/fetch-fonts.mjs` из `public/fonts/MANIFEST.json`.',
    ' * Руками не правится: диапазоны обязаны совпадать с нарезкой подмножеств.',
    ' *',
    ' * `font-display: swap` — текст читается системным шрифтом, пока не пришёл',
    ' * свой, и не исчезает вовсе. На экране денег невидимый текст хуже текста в',
    ' * другой гарнитуре.',
    ' */',
    '',
  ];
  for (const item of manifest.files) {
    lines.push('@font-face {');
    lines.push(`  font-family: '${item.family}';`);
    lines.push('  font-style: normal;');
    lines.push(`  font-weight: ${item.weight};`);
    lines.push('  font-display: swap;');
    lines.push(`  src: url('/fonts/${item.file}') format('woff2');`);
    if (item.unicodeRange !== null) lines.push(`  unicode-range: ${item.unicodeRange};`);
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

async function download() {
  rmSync(FONT_DIR, { recursive: true, force: true });
  mkdirSync(FONT_DIR, { recursive: true });
  const files = [];
  for (const family of FAMILIES) {
    const css = await text(`https://fonts.googleapis.com/css2?family=${family.query}&display=swap`);
    const faces = parseFaces(css).filter(
      (face) => SUBSETS.includes(face.subset) && family.keep.includes(face.subset),
    );
    if (faces.length === 0) throw new Error(`${family.family}: не найдено ни одного подмножества`);
    for (const face of faces) {
      const buffer = await bytes(face.url);
      const file = fileName(family.slug, face.subset, face.weight);
      writeFileSync(join(FONT_DIR, file), buffer);
      files.push({
        family: family.family,
        subset: face.subset,
        weight: face.weight,
        file,
        bytes: buffer.length,
        sha256: sha256(buffer),
        source: face.url,
        unicodeRange: face.unicodeRange,
      });
      process.stdout.write(`  ✓ ${file} — ${buffer.length} байт\n`);
    }
    try {
      const licence = await text(
        `https://raw.githubusercontent.com/google/fonts/main/ofl/${family.ofl}/OFL.txt`,
      );
      writeFileSync(join(FONT_DIR, `OFL-${family.slug}.txt`), licence, 'utf8');
    } catch (error) {
      process.stdout.write(`  ⚠ лицензия ${family.family} не скачана: ${error.message}\n`);
    }
  }
  const manifest = {
    note: 'Собрано scripts/fetch-fonts.mjs. Лицензия всех трёх семейств — SIL OFL 1.1.',
    fetchedAt: new Date().toISOString().slice(0, 10),
    files,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(CSS_FILE, renderCss(manifest), 'utf8');
  process.stdout.write(`\nФайлов: ${files.length}, манифест и fonts.css обновлены.\n`);
}

function check() {
  if (!existsSync(MANIFEST)) {
    process.stdout.write('Манифест не найден: шрифты не скачаны.\n');
    return 1;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  let bad = 0;
  for (const item of manifest.files) {
    const path = join(FONT_DIR, item.file);
    if (!existsSync(path)) {
      process.stdout.write(`  ✗ нет файла ${item.file}\n`);
      bad += 1;
      continue;
    }
    if (sha256(readFileSync(path)) !== item.sha256) {
      process.stdout.write(`  ✗ отпечаток разошёлся: ${item.file}\n`);
      bad += 1;
    }
  }
  const known = new Set(manifest.files.map((item) => item.file));
  for (const entry of readdirSync(FONT_DIR)) {
    if (!entry.endsWith('.woff2') || known.has(entry)) continue;
    process.stdout.write(`  ✗ файл вне манифеста: ${entry}\n`);
    bad += 1;
  }
  if (readFileSync(CSS_FILE, 'utf8') !== renderCss(manifest)) {
    process.stdout.write('  ✗ src/styles/fonts.css разошёлся с манифестом\n');
    bad += 1;
  }
  if (bad === 0) process.stdout.write(`Шрифты на месте: ${manifest.files.length} файлов.\n`);
  return bad === 0 ? 0 : 1;
}

if (process.argv.includes('--check')) {
  process.exit(check());
} else {
  download().catch((error) => {
    process.stdout.write(`Не удалось скачать шрифты: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
