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
 * В браузере: непереведённый ключ на экране, **неподставленный и пусто
 * подставленный слот**, горизонтальное переполнение на 360 px, обрезанный текст
 * в кнопках и чипах, размер сенсорных целей, контраст, единственный `h1`,
 * достижимость с клавиатуры и **бюджеты длины на грузинском**.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
 * Слова, запрещённые в **тексте для клиента**, — по трём словарям сразу.
 *
 * Прежде эта проверка шла только по исходникам (`FORBIDDEN_PHRASES` выше), то
 * есть ловила слово, вписанное в компонент, — а текста в компонентах у нас нет
 * по построению. Весь клиентский текст живёт в словарях, и там проверки не было
 * вовсе: юрист прочитал их глазами, но микрокопи сокращают и переписывают, а
 * ревью глазами защиты не даёт (`LEGAL-REVIEW.md` §9 п.7).
 *
 * Две разные строгости, потому что слова разные:
 *
 * - `banned` — употребления нет вовсе. «Эскроу» запрещено красной линией №10:
 *   эскроу-агентом по грузинскому праву может быть только банк или микробанк,
 *   и слово незаконно даже в отрицании — оно называет нашу услугу чужим именем.
 * - `onlyDenied` — слово законно **только в отрицании**. «Не гарантия платежа»
 *   сказать можно и нужно, «гарантируем» — нельзя. Отрицание ищется в той же
 *   строке ключами трёх языков; строка без отрицания — отказ.
 *
 * ⚠ Проверка синтаксическая, а не смысловая: она не отличит «мы не гарантируем»
 * от «мы гарантируем, что не». Её задача — не пропустить слово молча, а
 * заставить человека принять решение и записать его.
 */
const COPY_WORDS = {
  banned: [
    { rule: 'эскроу (красная линия №10)', pattern: /эскроу|escrow|ესქრო/iu },
    { rule: 'обещание безусловной безопасности', pattern: /\bабсолютно\s+безопасн|\b100%\s*(безопасн|safe)/iu },
  ],
  onlyDenied: [
    { rule: 'гарантия', pattern: /гаранти[а-яё]*|guarante|გარანტ/iu },
  ],
};

/**
 * Отрицание в трёх языках — целым словом.
 *
 * Границу слова здесь нельзя писать через `\b`: она считается по ASCII, поэтому
 * `\bне\b` не находит «не» ни в русском, ни в грузинском, и проверка отвечала
 * «гарантия без отрицания» на строке «Это не гарантия платежа». Граница —
 * отсутствие буквы слева и справа, по свойству Unicode.
 */
const DENIAL = /(^|[^\p{L}])(не|нет|not|no|never|არ|აღარ)([^\p{L}]|$)/iu;

/**
 * Слова `buyer` и `seller` в слое интерфейса запрещены целиком: роль — свойство
 * сделки. Исключение ровно одно — имена, объявленные в `@sdelka/domain`: их мы
 * не переименовываем, потому что не владеем ими.
 *
 * ## Почему список **читается**, а не перечислен здесь
 *
 * Прежняя редакция несла перечень из четырёх строк, и одна из них —
 * `registryOwnerIsBuyer` — пережила само поле: E3 заменил пять булевых полей
 * выписки одним наблюдением, поля не стало, а разрешение на него осталось.
 * Такое разрешение не ломает ничего сегодня и молча разрешает завтра: любая
 * строка интерфейса с этим словом прошла бы проверку.
 *
 * Теперь имена вычитываются из исходников домена: составное имя (`buyerPayerKey`,
 * `buyerNames`) разрешено само по себе, а голое `buyer`/`seller` — только в
 * позиции ключа или свойства. Поле, исчезнувшее из домена, исчезает из
 * разрешений в тот же день.
 */
const DOMAIN_SRC = resolve(APP_ROOT, '..', '..', 'packages', 'domain', 'src');

function domainRoleIdentifiers() {
  const names = new Set();
  if (!existsSync(DOMAIN_SRC)) return names;
  for (const file of walk(DOMAIN_SRC)) {
    if (!file.endsWith('.ts')) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)) {
      if (/buyer|seller/iu.test(match[1])) names.add(match[1]);
    }
  }
  return names;
}

const DOMAIN_ROLE_NAMES = domainRoleIdentifiers();

/** Составные имена домена: они однозначны и разрешены как есть. */
const DOMAIN_FIELD_TOKENS = [...DOMAIN_ROLE_NAMES].filter(
  (name) => !/^(buyer|seller)$/iu.test(name),
);

/**
 * Голые `buyer`/`seller` — только как ключ объекта или свойство. Слово в тексте,
 * в имени ключа локализации или в заголовке так не выглядит.
 */
const BARE_ROLE_POSITIONS = [/\bbuyer\s*[:,)]/u, /\.buyer\b/u, /\bbuyer\s*\}/u];

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
      if (BARE_ROLE_POSITIONS.some((pattern) => pattern.test(line))) return;
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
      for (const item of COPY_WORDS.banned) {
        const found = value.match(item.pattern);
        if (found !== null) {
          fail('слово в тексте клиента', `${locale}: ${key} — «${found[0]}» (${item.rule})`);
        }
      }
      for (const item of COPY_WORDS.onlyDenied) {
        const found = value.match(item.pattern);
        if (found !== null && !DENIAL.test(value)) {
          fail(
            'слово в тексте клиента',
            `${locale}: ${key} — «${found[0]}» без отрицания (${item.rule})`,
          );
        }
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
  // Откат резерва по сроку: положение денег то же самое (`M-06`), но приходят
  // в него сверху, а не снизу, и экран обязан объяснить, откуда деньги снова
  // свободны (`CABINETS.md` §3.2 блок 6).
  ['m19', 'onAccount-afterReserve'],
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
  /**
   * Маршруты, которых в обходе не было **вовсе**, хотя страницы существуют:
   * пополнение, вывод, документы, уведомления, профиль, архив, заявка на сделку
   * и три экрана консоли — решение о выплате, сверка, снятие приостановки.
   *
   * Экран, которого нет в обходе, не проверяется ничем: ни на непереведённый
   * ключ, ни на переполнение, ни на контраст, ни на бюджеты длины. Восемь из
   * шестнадцати страниц приложения были ровно в этом положении, и «обход на 90
   * экранах» это скрывал, потому что 90 — число снимков, а не покрытых
   * маршрутов.
   */
  add('topup', `/topup/${MONEY_STATES[0][0]}`, { desktop: DESKTOP, mobile: MOBILE });
  add('withdraw', '/withdraw', { desktop: DESKTOP, mobile: MOBILE });
  add('documents', '/documents', { desktop: DESKTOP, mobile: MOBILE });
  add('notifications', '/notifications', { desktop: DESKTOP, mobile: MOBILE });
  add('profile', '/profile', { desktop: DESKTOP, mobile: MOBILE });
  add('archive', '/archive', { desktop: DESKTOP, mobile: MOBILE });
  add('deal-new', '/deals/new', { desktop: DESKTOP, mobile: MOBILE });
  add('ops-queue', '/ops', { desktop: { width: 1440, height: 1000 } });
  add('ops-queue', '/ops', { mobile: MOBILE }, ['ru']);
  add('ops-queue-empty', '/ops?type=verifyClient', { desktop: { width: 1440, height: 1000 } }, ['ka']);
  add('ops-decision', '/ops/decision', { desktop: { width: 1440, height: 1000 }, mobile: MOBILE });
  add('ops-reconciliation', '/ops/reconciliation', { desktop: { width: 1440, height: 1000 }, mobile: MOBILE });
  add('ops-unfreeze', '/ops/unfreeze', { desktop: { width: 1440, height: 1000 }, mobile: MOBILE });
  add('security', '/security', { desktop: DESKTOP }, ['ka']);
  return list;
}

/* ------------------------------------------------- 5. проверки в браузере */

const PAGE_CHECKS = `(() => {
  const problems = [];
  const text = document.body.innerText;

  const untranslated = text.match(/\\[[a-z][\\w.$-]*\\.[\\w.$-]+\\]/g);
  if (untranslated) problems.push('непереведённый ключ на экране: ' + untranslated.slice(0, 3).join(', '));

  // Слот, оставшийся в отрендеренном тексте: подстановку забыли передать.
  const slots = text.match(/\\{[a-zA-Z][\\w]*\\}/g);
  if (slots) problems.push('неподставленный слот на экране: ' + slots.slice(0, 3).join(', '));

  // Слот, подставленный **пустотой**. Ключ на экране не остаётся, ошибка не
  // бросается, строка просто читается как «Резерв снят , деньги идут». Ловится
  // это только следом от подстановки: пробел перед знаком препинания, двойной
  // пробел, висящее тире, скобки ни о чём.
  // ВНИМАНИЕ: след ищем внутри строки, а не по всему тексту разом. innerText
  // склеивает блочные элементы переводом строки, и заголовок с абзацем под ним
  // дают два перевода подряд — то есть «двойной пробел» срабатывал на каждой
  // второй странице просто потому, что у неё есть заголовок. Правило при этом
  // никогда не проходило, и настоящий след пустой подстановки тонул в шуме.
  const lines = text.split('\\n').map((line) => line.trim()).filter((line) => line !== '');
  for (const [rule, pattern] of [
    ['пробел перед знаком препинания', /[\\wа-яёა-ჰ]\\s+[,.;:!?]/u],
    ['двойной пробел', /[\\wа-яёა-ჰ]\\s{2,}[\\wа-яёა-ჰ]/u],
    ['пустые скобки', /\\(\\s*\\)/u],
    ['висящее тире', /[\\wа-яёა-ჰ]\\s[—–-]\\s*$/u],
  ]) {
    const line = lines.find((item) => pattern.test(item));
    if (line === undefined) continue;
    const at = line.search(pattern);
    problems.push(
      'след пустой подстановки (' + rule + '): «' + line.slice(Math.max(0, at - 20), at + 30) + '»',
    );
  }

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

/**
 * Бюджеты длины на грузинском — самом длинном из трёх языков.
 *
 * ## Почему это правило, а не вычитка
 *
 * Бюджеты прогонялись руками, и ручной прогон нашёл восемь превышений. Ручной
 * прогон находит их **один раз**: следующая правка микрокопи вернёт их без
 * единого сигнала, потому что перелив на грузинском не ломает ни сборку, ни
 * тест, ни скриншот — он ломает вёрстку у клиента.
 *
 * Считаются **знаки**, а не пиксели: пиксельная ширина зависит от шрифта и
 * округлений и мигает от прогона к прогону, а бюджет в знаках — это договор с
 * копирайтером, который можно назвать в брифе.
 *
 * Проверяется только `ka`: русский и английский короче, и бюджет, выдержанный
 * на грузинском, выдержан и на них. Обратное неверно.
 */
const LENGTH_BUDGETS = `(() => {
  const budgets = [
    ['заголовок', 'h1, h2, .card__title, .state-card__title, .banner__title, .outcome__title, .security__title', 44],
    ['тело', '.state-card__body, .banner__body, .outcome__body, .deadline__consequence, .empty p', 240],
    ['метка суммы', '.amount-label', 24],
    ['чип', '.chip, .chipbtn, .badge, .langs__item', 32],
    ['шаг ленты', '.timeline__label', 34],
    ['⚖-слот', '.legal__body', 200],
  ];
  const problems = [];
  for (const [name, selector, limit] of budgets) {
    for (const node of document.querySelectorAll(selector)) {
      const value = (node.textContent || '').replace(/\\s+/g, ' ').trim();
      if (value.length === 0 || value.length <= limit) continue;
      problems.push(
        'бюджет длины (' + name + '): ' + value.length + ' знаков при ' + limit + ' — «' + value.slice(0, 40) + '…»',
      );
    }
  }
  // Тело блока — не более трёх предложений. Четвёртое предложение читатель
  // состояния денег не дочитывает, и его там быть не должно.
  for (const node of document.querySelectorAll('.state-card__body, .banner__body, .outcome__body')) {
    const value = (node.textContent || '').replace(/\\s+/g, ' ').trim();
    if (value.length === 0) continue;
    const sentences = value.split(/[.!?](?:\\s|$)/u).filter((part) => part.trim().length > 0).length;
    if (sentences > 3) {
      problems.push('бюджет длины (тело): ' + sentences + ' предложения при 3 — «' + value.slice(0, 40) + '…»');
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

/* ------------------------------------------------- 4. свежесть сборки */

/**
 * Из чего собрано приложение — **весь** вход, а не только `apps/web/src`.
 *
 * ## Что было сломано
 *
 * Первая версия сравнивала отметку `BUILD_ID` с `apps/web/src` и
 * `package.json`. Дыра осталась ровно того же рода, что и та, которую она
 * закрывала: изменение в `packages/domain`, `packages/ledger` или
 * `packages/money` пересборку **не вызывало**, и обход шёл по вчерашней
 * сборке — с сегодняшним доменом внутри. В батче, где это писалось, не
 * выстрелило только потому, что `apps/web/src` менялся одновременно с
 * доменом; в батче, где правят один домен, выстрелило бы молча и зелёным.
 *
 * Пакеты не перечислены здесь руками: список зависимостей читается из
 * `package.json` приложения и замыкается транзитивно по рабочему пространству.
 * Новая зависимость попадёт в проверку сама — иначе мы вернулись бы сюда
 * третий раз.
 *
 * ## Почему отпечаток, а не время правки
 *
 * Сравнение по `mtime` верит часам и порядку файловых операций: `git checkout`
 * ветки со **старым** кодом ставит свежий `mtime`, а `git stash pop` — наоборот.
 * Отпечаток содержимого не верит ничему: сборка считается свежей, только если
 * вход байт-в-байт тот же, что был при её сборке. Отметка лежит внутри `.next`,
 * то есть пропадает вместе со сборкой.
 */
const WORKSPACE_PACKAGES = join(APP_ROOT, '..', '..', 'packages');

function workspaceDirectories() {
  const byName = new Map();
  for (const entry of readdirSync(WORKSPACE_PACKAGES)) {
    const manifest = join(WORKSPACE_PACKAGES, entry, 'package.json');
    if (!existsSync(manifest)) continue;
    byName.set(JSON.parse(readFileSync(manifest, 'utf8')).name, join(WORKSPACE_PACKAGES, entry));
  }
  return byName;
}

/** Зависимости приложения по рабочему пространству, замкнутые транзитивно. */
function workspaceClosure() {
  const byName = workspaceDirectories();
  const seen = new Set();
  const queue = [APP_ROOT];
  const roots = [];
  while (queue.length > 0) {
    const dir = queue.shift();
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const name of Object.keys(parsed.dependencies ?? {})) {
      const target = byName.get(name);
      if (target === undefined || seen.has(target)) continue;
      seen.add(target);
      roots.push(target);
      queue.push(target);
    }
  }
  return roots;
}

/**
 * Файлы, из которых собрана страница: исходники приложения, его конфигурация,
 * исходники и манифесты пакетов, от которых оно зависит, и замок версий.
 */
function buildInputs() {
  const files = [...SOURCE_FILES];
  for (const entry of readdirSync(APP_ROOT)) {
    // `tsconfig.tsbuildinfo` — след прошлого `tsc`, а не вход сборки: он
    // меняется на каждом typecheck и заставлял бы пересобирать вхолостую.
    if (entry === 'tsconfig.tsbuildinfo') continue;
    const full = join(APP_ROOT, entry);
    // Конфигурация приложения: `next.config.mjs`, `tsconfig.json`,
    // `package.json` и всё, что появится рядом. Каталоги — уже перечислены
    // отдельно либо не входят в сборку.
    if (statSync(full).isDirectory()) continue;
    files.push(full);
  }
  for (const dir of workspaceClosure()) {
    files.push(join(dir, 'package.json'));
    const src = join(dir, 'src');
    if (existsSync(src)) walk(src, files);
  }
  for (const shared of ['pnpm-lock.yaml', 'tsconfig.base.json']) {
    files.push(join(APP_ROOT, '..', '..', shared));
  }
  return files.filter((file) => existsSync(file) && statSync(file).isFile()).sort();
}

const BUILD_MARKER = join(APP_ROOT, '.next', 'sdelka-verify-inputs');

function inputsDigest() {
  const digest = createHash('sha256');
  for (const file of buildInputs()) {
    digest.update(relative(APP_ROOT, file));
    digest.update('\0');
    digest.update(createHash('sha256').update(readFileSync(file)).digest());
    digest.update('\0');
  }
  return digest.digest('hex');
}

function staleBuild(digest) {
  if (!existsSync(join(APP_ROOT, '.next', 'BUILD_ID'))) return true;
  if (!existsSync(BUILD_MARKER)) return true;
  return readFileSync(BUILD_MARKER, 'utf8').trim() !== digest;
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

  const digest = inputsDigest();
  if (staleBuild(digest)) {
    process.stdout.write(
      `Сборка отсутствует или собрана из другого кода (вход ${digest.slice(0, 12)}…) — собираем.\n`,
    );
    const build = spawn('npx', ['next', 'build'], { cwd: APP_ROOT, stdio: 'inherit' });
    const code = await new Promise((done) => build.on('exit', done));
    if (code !== 0) {
      process.stdout.write('Сборка не удалась.\n');
      process.exit(1);
    }
    // Отметка пишется **после** успешной сборки и только тогда: упавшая сборка
    // не должна выглядеть свежей на следующем запуске.
    writeFileSync(BUILD_MARKER, `${digest}\n`, 'utf8');
  } else {
    process.stdout.write(`Сборка соответствует исходникам (вход ${digest.slice(0, 12)}…).\n`);
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
    if (route.locale === 'ka') {
      problems.push(...(await page.evaluate(LENGTH_BUDGETS)));
    }
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
