#!/usr/bin/env node
/**
 * Проверка интерфейса одной командой: `pnpm --filter @sdelka/web verify:ui`.
 *
 * ## Зачем
 *
 * Три требования проекта невозможно удержать вычиткой, потому что нарушаются
 * они тихо и по одному:
 *
 * 1. **Кабинет один.** Слов «кабинет покупателя» и «кабинет продавца» не должно
 *    быть нигде — ни в заголовке, ни в ключе локализации, ни в имени файла.
 *    Одно такое слово, попавшее в ключ, переживёт десяток ревью.
 * 2. **Ни одной строки текста в компонентах.** Литерал в JSX не ломает сборку и
 *    не виден на скриншоте: он просто не переводится, и это обнаруживается на
 *    грузинском у клиента.
 * 3. **Макет проверяется на самом длинном языке.** Грузинский шире русского и
 *    вдвое шире английского на коротких строках; ломается вёрстка именно там,
 *    поэтому обход идёт по трём языкам, а не по одному.
 *
 * Скрипт поднимает приложение, обходит экраны, складывает скриншоты и
 * заканчивается ненулевым кодом на первом же нарушении. Образец подхода —
 * `packages/e2e/scripts/guard-mutation.mjs`: проверка, которую можно запустить,
 * а не та, которую нужно вспомнить провести.
 *
 * ## Что проверяется
 *
 * Статически, до браузера: запрещённые слова, литералы в компонентах,
 * совпадение наборов ключей у трёх словарей.
 * В браузере: непереведённый ключ на экране, горизонтальное переполнение на
 * 360 px, обрезанный текст в кнопках и чипах, размер сенсорных целей, контраст,
 * единственный `h1`, достижимость с клавиатуры.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const SRC = join(APP_ROOT, 'src');
const SHOTS = join(APP_ROOT, 'screenshots');
const MESSAGES = join(SRC, 'i18n', 'messages');
const PORT = Number(process.env.VERIFY_PORT ?? 3210);
const BASE = `http://127.0.0.1:${PORT}`;
const BROWSER_PATH = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

const failures = [];
function fail(area, message) {
  failures.push(`${area}: ${message}`);
  process.stdout.write(`  ✗ ${area}: ${message}\n`);
}
function pass(message) {
  process.stdout.write(`  ✓ ${message}\n`);
}

/* ------------------------------------------------------------------ обход */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const SOURCE_FILES = walk(SRC);

/* ------------------------------------------- 1. запрещённые слова о кабинетах */

/**
 * Ролевые названия кабинета. Кабинет один: клиент платит по одной сделке и
 * получает по другой, и слово «кабинет покупателя» описывает продукт, которого
 * нет (`CABINETS.md` §4).
 */
const FORBIDDEN_PHRASES = [
  /кабинет[а-яё]*\s+(покупател|продавц|получател|плательщик)/iu,
  /(buyer|seller|payee|payer|client)[\s_-]?cabinet/iu,
  /личный\s+кабинет\s+(покупател|продавц)/iu,
  /эскроу|escrow|ესქრო/iu,
];

/**
 * Слова `buyer` и `seller` в слое интерфейса запрещены целиком: роль — свойство
 * сделки. Исключение ровно одно и названо поимённо — имена полей `TrancheFacts`
 * из `@sdelka/domain`, которые мы не переименовываем, потому что не владеем ими.
 */
const DOMAIN_FIELD_TOKENS = ['buyerPayerKey', 'registryOwnerIsBuyer', 'buyer:', 'buyer,'];

function checkVocabulary() {
  process.stdout.write('Запрещённые слова про кабинеты\n');
  for (const file of SOURCE_FILES) {
    const rel = relative(APP_ROOT, file);
    if (/buyer|seller|cabinet/iu.test(rel)) {
      fail('имя файла', `${rel} — ролевое название кабинета в пути`);
    }
    const text = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_PHRASES) {
      const found = text.match(pattern);
      if (found !== null) fail('словарь', `${rel}: «${found[0]}»`);
    }
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (!/\b(buyer|seller)\b/iu.test(line)) return;
      if (DOMAIN_FIELD_TOKENS.some((token) => line.includes(token))) return;
      fail('роль как состояние', `${rel}:${index + 1} — ${line.trim().slice(0, 80)}`);
    });
  }
  if (failures.length === 0) pass('ролевых названий кабинета нет ни в коде, ни в путях');
}

/* --------------------------------------- 2. литералы текста в компонентах */

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

/**
 * Сообщения `throw` вырезаются перед проверкой намеренно: это текст для
 * разработчика, а не для клиента. На экран он попасть не может — фикстура с
 * недостижимым состоянием роняет сборку, а не показывает страницу. Всё, что
 * действительно доходит до экрана, идёт через `t()` из словаря либо приходит
 * данными из `fixtures/data.json`, где имена собственные и лежат.
 */
function stripThrowMessages(text) {
  return text.replace(/throw\s+new\s+\w+\([\s\S]*?\);/gu, 'throw 0;');
}

const LETTERS_NON_ASCII = /[Ѐ-ӿႠ-ჿ]/u;

/**
 * Текстовый узел JSX: между тегами стоит слово. Узел обязан состоять только из
 * букв, пробелов и простой пунктуации — иначе это не текст, а выражение или
 * обрывок типа, попавший между угловыми скобками.
 */
const JSX_TEXT_NODE = />\s*([A-Za-zЀ-ӿႠ-ჿ][A-Za-zЀ-ӿႠ-ჿ \u00a0,.!?\u2014\u2013-]{1,})\s*</gu;

function checkLiterals() {
  process.stdout.write('Литералы текста в компонентах\n');
  const before = failures.length;
  for (const file of SOURCE_FILES) {
    const rel = relative(APP_ROOT, file);
    if (file.endsWith('.json')) continue;
    if (!/\.(ts|tsx)$/u.test(file)) continue;
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
    const raw = readFileSync(file, 'utf8');
    const code = stripThrowMessages(stripComments(raw));
    const nonAscii = code.match(LETTERS_NON_ASCII);
    if (nonAscii !== null) {
      const line = code.slice(0, code.indexOf(nonAscii[0])).split('\n').length;
      fail('литерал', `${rel}:${line} — текст в коде вместо ключа локализации`);
    }
    if (!file.endsWith('.tsx')) continue;
    for (const match of code.matchAll(JSX_TEXT_NODE)) {
      const value = match[1].trim();
      if (value.length === 0) continue;
      const line = code.slice(0, match.index).split('\n').length;
      fail('литерал', `${rel}:${line} — текстовый узел «${value.slice(0, 40)}»`);
    }
  }
  if (failures.length === before) pass('ни одной строки текста в компонентах: только ключи');
}

/* ------------------------------------------------- 3. словари трёх языков */

function checkDictionaries() {
  process.stdout.write('Словари трёх языков\n');
  const before = failures.length;
  const dicts = {};
  for (const locale of ['ru', 'en', 'ka']) {
    dicts[locale] = JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), 'utf8'));
  }
  const reference = Object.keys(dicts.ru).sort();
  for (const locale of ['en', 'ka']) {
    const keys = Object.keys(dicts[locale]).sort();
    const missing = reference.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !reference.includes(key));
    if (missing.length > 0) fail('словарь', `${locale}: не хватает ключей — ${missing.slice(0, 5).join(', ')}`);
    if (extra.length > 0) fail('словарь', `${locale}: лишние ключи — ${extra.slice(0, 5).join(', ')}`);
  }
  for (const key of reference) {
    if (/buyer|seller|cabinet|кабинет/iu.test(key)) {
      fail('ключ локализации', `${key} — роль или кабинет в имени ключа`);
    }
    for (const locale of ['ru', 'en', 'ka']) {
      const value = dicts[locale][key];
      if (typeof value !== 'string' || value.trim().length === 0) {
        fail('словарь', `${locale}: пустое значение у ${key}`);
        continue;
      }
      // Значение в один знак — не перевод, а обрезок: ровно так выглядела
      // строка состояния, от которой в словарь попала первая буква. «Вы» в две
      // буквы законно, одна буква — нет.
      if (value.trim().length < 2) {
        fail('словарь', `${locale}: подозрительно короткое значение у ${key} — «${value}»`);
      }
      const slots = (dicts.ru[key].match(/\{(\w+)\}/gu) ?? []).sort().join(',');
      const own = (value.match(/\{(\w+)\}/gu) ?? []).sort().join(',');
      if (slots !== own) {
        fail('словарь', `${locale}: подстановки у ${key} расходятся с русским (${own} против ${slots})`);
      }
    }
  }
  if (failures.length === before) {
    pass(`три словаря совпадают по составу: ${reference.length} ключей в каждом`);
  }
  return reference.length;
}

/* --------------------------------------------------------- 4. что обходим */

const MONEY_STATES = [
  ['m01', 'notFunded'], ['m02', 'transferDeclared'], ['m03', 'unidentified'],
  ['m04', 'heldThirdParty'], ['m05', 'onAccountFx'], ['m06', 'onAccount'],
  ['m07', 'partiallyFunded'], ['m08', 'overfunded'], ['m09', 'reserved'],
  ['m10', 'submitted'], ['m11', 'releasePending'], ['m12', 'released'],
  ['m13', 'payoutUnknown'], ['m14', 'rollbackInProgress'], ['m15', 'releasedToAccount'],
  ['m16', 'refundInProgress'], ['m17', 'refunded'], ['m18', 'frozen'],
];

const RECEIVING = [
  ['r01', 'notFunded'], ['r02', 'onAccount'], ['r03', 'reserved'],
  ['r04', 'released'], ['r05', 'payoutUnknown'], ['r06', 'releasedToAccount'],
  ['r07', 'reserved-cooling'],
];

const PERIMETER = ['P-01', 'P-03', 'P-04', 'P-06', 'P-07', 'P-09', 'P-10'];

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 360, height: 780 };

function routes() {
  const list = [];
  const add = (name, path, viewports, locales = ['ru', 'en', 'ka']) => {
    for (const locale of locales) {
      for (const [kind, viewport] of Object.entries(viewports)) {
        list.push({ name, path, locale, kind, viewport });
      }
    }
  };
  add('deals-list', '', { desktop: DESKTOP, mobile: MOBILE });
  add('deals-list-empty', '?state=empty', { desktop: DESKTOP }, ['ka']);
  add('deals-list-loading', '?state=loading', { desktop: DESKTOP }, ['ka']);
  add('deals-list-error', '?state=error', { desktop: DESKTOP }, ['ka']);
  for (const [id, state] of MONEY_STATES) {
    add(`deal-paying-${id}-${state}`, `/deals/${id}`, { desktop: DESKTOP }, ['ru']);
    add(`deal-paying-${id}-${state}`, `/deals/${id}`, { mobile: MOBILE }, ['ka']);
  }
  for (const [id, state] of RECEIVING) {
    add(`deal-receiving-${id}-${state}`, `/deals/${id}`, { desktop: DESKTOP }, ['ru']);
    add(`deal-receiving-${id}-${state}`, `/deals/${id}`, { mobile: MOBILE }, ['ka']);
  }
  add('deal-partial', '/deals/m09?state=partial', { desktop: DESKTOP }, ['ka']);
  add('deal-denied', '/deals/m09?state=denied', { desktop: DESKTOP }, ['ka']);
  add('deal-error', '/deals/m09?state=error', { desktop: DESKTOP }, ['ka']);
  add('account', '/account', { desktop: DESKTOP, mobile: MOBILE });
  for (const state of PERIMETER) {
    add(`requisites-${state}`, `/requisites?state=${state}`, { desktop: DESKTOP }, ['ru']);
    add(`requisites-${state}`, `/requisites?state=${state}`, { mobile: MOBILE }, ['ka']);
  }
  add('ops-queue', '/ops', { desktop: { width: 1440, height: 1000 } });
  add('ops-queue', '/ops', { mobile: MOBILE }, ['ru']);
  add('ops-queue-empty', '/ops?type=verifyClient', { desktop: { width: 1440, height: 1000 } }, ['ka']);
  add('security', '/security', { desktop: DESKTOP }, ['ka']);
  return list;
}

/* ------------------------------------------------- 5. проверки в браузере */

const PAGE_CHECKS = `(() => {
  const problems = [];
  const text = document.body.innerText;

  const untranslated = text.match(/\\[[a-z][\\w.$-]*\\.[\\w.$-]+\\]/g);
  if (untranslated) problems.push('непереведённый ключ на экране: ' + untranslated.slice(0, 3).join(', '));

  const headings = document.querySelectorAll('h1');
  if (headings.length !== 1) problems.push('заголовков h1 на экране: ' + headings.length);

  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    problems.push('горизонтальное переполнение: ' + doc.scrollWidth + ' против ' + doc.clientWidth);
  }

  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (value) => (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
  const backgroundOf = (node) => {
    let current = node;
    while (current) {
      const bg = getComputedStyle(current).backgroundColor;
      const parts = (bg.match(/[\\d.]+/g) || []).map(Number);
      if (parts.length >= 3 && (parts.length < 4 || parts[3] > 0.5)) return parts.slice(0, 3);
      current = current.parentElement;
    }
    return [255, 255, 255];
  };

  for (const node of document.querySelectorAll('p, span, a, h1, h2, h3, li, td, th, summary')) {
    if (node.children.length > 0) continue;
    const value = (node.textContent || '').trim();
    if (value.length === 0) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const fg = parse(style.color);
    const bg = backgroundOf(node);
    const lighter = Math.max(luminance(fg), luminance(bg));
    const darker = Math.min(luminance(fg), luminance(bg));
    const ratio = (lighter + 0.05) / (darker + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const required = large ? 3 : 4.5;
    if (ratio < required - 0.01) {
      problems.push('контраст ' + ratio.toFixed(2) + ' при требуемом ' + required + ': «' + value.slice(0, 30) + '»');
    }
  }

  for (const node of document.querySelectorAll('a, button, summary, [role="button"]')) {
    const box = node.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    // Ссылка внутри предложения — исключение WCAG 2.5.5: увеличивать её цель
    // значит рвать строку. Признак — родитель содержит заметно больше текста,
    // чем сама ссылка.
    const own = (node.textContent || '').trim().length;
    const around = (node.parentElement?.textContent || '').trim().length;
    if (around > own * 1.3) continue;
    if (box.height < 44 || box.width < 24) {
      problems.push('малая цель ' + Math.round(box.width) + 'x' + Math.round(box.height) + ': «' + (node.textContent || '').trim().slice(0, 24) + '»');
    }
  }

  for (const node of document.querySelectorAll('.btn, .chip, .badge, .nav__link, .langs__item')) {
    if (node.scrollWidth > node.clientWidth + 1) {
      problems.push('обрезанный текст в элементе управления: «' + (node.textContent || '').trim().slice(0, 30) + '»');
    }
  }

  return problems;
})()`;

async function checkKeyboard(page) {
  const focusable = await page.evaluate(
    () => document.querySelectorAll('a[href], button, summary, input, select, textarea').length,
  );
  if (focusable === 0) return [];
  const problems = [];
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement?.tagName ?? null);
  if (first === null || first === 'BODY') problems.push('первый Tab не попал ни на один элемент');
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('Tab');
  }
  const reached = await page.evaluate(() => {
    const node = document.activeElement;
    if (!node || node === document.body) return null;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  if (reached === false) problems.push('фокус ушёл на невидимый элемент');
  return problems;
}

/* -------------------------------------------------------------- 6. запуск */

async function waitForServer(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/ru`);
      if (response.ok) return true;
    } catch {
      // сервер ещё поднимается
    }
    await new Promise((done) => setTimeout(done, 400));
  }
  return false;
}

async function main() {
  process.stdout.write('Проверка интерфейса «Сделка»\n\n');
  checkVocabulary();
  checkLiterals();
  const keyCount = checkDictionaries();
  process.stdout.write('\n');

  if (failures.length > 0) {
    process.stdout.write(`Статические проверки не пройдены: ${failures.length}. Браузер не запускаем.\n`);
    process.exit(1);
  }

  if (!existsSync(join(APP_ROOT, '.next'))) {
    process.stdout.write('Сборки нет — собираем.\n');
    const build = spawn('npx', ['next', 'build'], { cwd: APP_ROOT, stdio: 'inherit' });
    const code = await new Promise((done) => build.on('exit', done));
    if (code !== 0) {
      process.stdout.write('Сборка не удалась.\n');
      process.exit(1);
    }
  }

  const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: APP_ROOT,
    stdio: 'ignore',
    detached: true,
  });
  const stop = () => {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // уже остановлен
    }
  };
  process.on('exit', stop);

  if (!(await waitForServer(40_000))) {
    fail('сервер', 'не поднялся за 40 секунд');
    stop();
    process.exit(1);
  }
  process.stdout.write(`Приложение поднято на ${BASE}\n\n`);

  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({ executablePath: BROWSER_PATH });
  const list = routes();
  process.stdout.write(`Обход: ${list.length} экранов (три языка, десктоп и телефон)\n`);
  let shot = 0;

  for (const route of list) {
    const context = await browser.newContext({
      viewport: route.viewport,
      deviceScaleFactor: 1,
      locale: route.locale,
    });
    const page = await context.newPage();
    const url = `${BASE}/${route.locale}${route.path}`;
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    if (response === null || !response.ok()) {
      fail('маршрут', `${url} ответил ${response === null ? 'ничем' : response.status()}`);
      await context.close();
      continue;
    }
    const problems = await page.evaluate(PAGE_CHECKS);
    for (const problem of problems) {
      fail(`${route.name}.${route.locale}.${route.kind}`, problem);
    }
    const file = join(SHOTS, `${route.name}.${route.locale}.${route.kind}.png`);
    await page.screenshot({ path: file, fullPage: true });
    shot += 1;
    for (const problem of await checkKeyboard(page)) {
      fail(`${route.name}.${route.locale}.${route.kind}`, problem);
    }
    await context.close();
  }

  await browser.close();
  stop();

  process.stdout.write(`\nСкриншотов: ${shot}, в ${relative(APP_ROOT, SHOTS)}\n`);
  process.stdout.write(`Ключей локализации: ${keyCount} на каждый из трёх языков\n`);
  if (failures.length > 0) {
    process.stdout.write(`\nНарушений: ${failures.length}\n`);
    process.exit(1);
  }
  process.stdout.write('\nНарушений нет.\n');
  process.exit(0);
}

main().catch((error) => {
  process.stdout.write(`Проверка упала: ${error?.stack ?? error}\n`);
  process.exit(1);
});
