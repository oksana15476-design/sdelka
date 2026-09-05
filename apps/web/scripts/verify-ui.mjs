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
 * достижимость с клавиатуры, **видимость фокус-кольца**, бюджеты длины на
 * грузинском и **бюджет длины самой суммы — на всех трёх языках**.
 *
 * ## Чего охват не видел до этого захода
 *
 * Число «150 экранов» описывало снимки, а не покрытие, и молчало о том, чего не
 * смотрит. Вне обхода были целиком:
 *
 * - **кабинет владельца** — четыре страницы, ни одной проверки ни разу;
 * - **карточка задачи консоли** (семнадцать видов разбора) и **дежурный
 *   дашборд** — то есть то, ради чего очередь существует;
 * - **грузинский на десктопе** у сделки и реквизитов: семейства заведены как
 *   ru.desktop + ka.mobile, и правило «макеты проверяются на самом длинном
 *   языке» выполнялось на них только для телефона;
 * - **длинная сумма** — не было ни на одном снимке, а бюджет мерил подпись к
 *   сумме, а не число;
 * - **заморозка у получателя** — состояние останавливает его выплату, а
 *   снималось только со стороны плательщика;
 * - **пусто, загрузка, ошибка** — были ровно у одного экрана из пяти;
 * - **кадр с видимым фокусом** — снимок делался до нажатия Tab.
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

import {
  LEXICON,
  formatFinding,
  scanDictionaries,
  validateAllowances,
} from './forbidden-lexicon.mjs';

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
  // Красная линия №10 действует и в исходниках: имя переменной, комментарий,
  // путь файла. Написания не дублируются здесь, а берутся из перечня —
  // иначе список в двух местах разъедется на первой же транслитерации.
  ...LEXICON.find((rule) => rule.id === 'escrow').patterns,
];

/**
 * Запрещённая лексика клиентских текстов живёт в `forbidden-lexicon.mjs`:
 * перечень собран из документов, каждое правило со ссылкой, исключения — явным
 * списком с причиной. Отдельный модуль, потому что перечень обязан проверяться
 * тестом (`forbidden-lexicon.test.mjs`) без сервера и браузера.
 *
 * Здесь остаётся только вызов и печать: `banned` роняет прогон, `open` —
 * печатается как «ждёт решения» и прогон не роняет (почему именно так —
 * в шапке модуля).
 */

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
  checkForbiddenLexicon(dicts);
  return reference.length;
}

/**
 * Запрещённая лексика по трём словарям: перечень и исключения — в
 * `forbidden-lexicon.mjs`, здесь прогон и печать.
 *
 * Порядок печати выбран так, чтобы «ждёт решения» нельзя было пролистать: оно
 * идёт после падений и с точным адресом — язык, ключ, слово, вопрос.
 */
function checkForbiddenLexicon(dicts) {
  process.stdout.write('Запрещённая лексика в текстах для клиента\n');
  const before = failures.length;

  for (const problem of validateAllowances()) {
    fail('исключение', problem);
  }

  const { findings, unusedAllowances, gaps } = scanDictionaries(dicts);

  for (const finding of findings.filter((item) => item.tier === 'banned')) {
    fail('слово в тексте клиента', `${formatFinding(finding)} · ${finding.source}`);
  }

  // Разрешение, пережившее свой текст, ничего не ломает сегодня и молча
  // разрешает завтра: снятое исключение — такая же правка, как снятая строка.
  for (const allowance of unusedAllowances) {
    fail(
      'исключение',
      `${allowance.rule}/${allowance.key} — исключение ничего не разрешает, слова в тексте больше нет`,
    );
  }

  if (failures.length === before) {
    pass(`запрещённых слов нет: ${LEXICON.filter((r) => r.tier === 'banned').length} правил по трём языкам`);
  }

  const open = findings.filter((item) => item.tier === 'open');
  if (open.length > 0) {
    process.stdout.write(`  ? ждут решения человека: ${open.length}\n`);
    const byRule = new Map();
    for (const finding of open) {
      if (!byRule.has(finding.ruleId)) byRule.set(finding.ruleId, []);
      byRule.get(finding.ruleId).push(finding);
    }
    for (const [ruleId, items] of byRule) {
      const rule = LEXICON.find((item) => item.id === ruleId);
      process.stdout.write(`    · ${rule.rule} (${items.length}) — ${rule.question}\n`);
      process.stdout.write(`      ${rule.source}\n`);
      for (const finding of items) process.stdout.write(`      ${formatFinding(finding)}\n`);
    }
  }

  // Дыра, о которой знают, лучше дыры, о которой забыли: документы называют
  // написание не на всех трёх языках, и правило без написания на языке ничего
  // на нём не ловит. Печатаем на каждом прогоне, чтобы это не выглядело
  // проверкой, которой нет.
  const unknownSpelling = gaps.filter((gap) => gap.status === 'открыто');
  if (unknownSpelling.length > 0) {
    const list = unknownSpelling.map((gap) => `${gap.ruleId}/${gap.locale}`).join(', ');
    process.stdout.write(
      `  ? написание не установлено у ${unknownSpelling.length} правил: ${list}\n`,
    );
  }
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
  // Заморозка снималась только со стороны плательщика (`m18`), хотя
  // останавливает она выплату **получателю**: у плательщика замороженные деньги
  // лежат там же, где лежали, а получатель перестаёт получать. Тексты,
  // последствия и доступные действия у двух ролей разные — проверялась одна.
  ['r08', 'frozen'],
];

/**
 * Сделка с самой длинной суммой — отдельным маршрутом, а не положением денег.
 *
 * Положение у неё то же `M-09`, что у `m09`; отличается только длина числа:
 * 1 234 567 890 минорных единиц против 21 700 000 у всех прочих. Длинного числа
 * не было ни на одном снимке набора, и колонка сумм ни разу не проверялась на
 * переполнение (`fixtures/scenarios.ts`, `m20`).
 */
const LONG_AMOUNT_DEAL = 'm20';

const PERIMETER = ['P-01', 'P-03', 'P-04', 'P-06', 'P-07', 'P-09', 'P-10'];

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 360, height: 780 };
/**
 * Широкая оболочка: консоль оператора и кабинет владельца рисуются в ней, а не
 * в клиентской (`ui/chrome.tsx`, `wide = console || owner`). Ширина 1280 у них
 * — не проектная раскладка, а промежуточная.
 */
const WIDE = { width: 1440, height: 1000 };

/**
 * ## Как выбираются сочетания языка и ширины
 *
 * Полный перебор — три языка на две ширины, шесть снимков на каждый маршрут.
 * Маршрутов около семидесяти, то есть четыреста с лишним прогонов и вчетверо
 * больше времени. Берём три сочетания из шести, и всегда одни и те же — по
 * риску, а не по симметрии:
 *
 * 1. **ka × узкая (360)** — самый длинный язык в самой тесной коробке. Здесь и
 *    только здесь живут горизонтальное переполнение, обрезка текста в кнопках и
 *    чипах, малые сенсорные цели.
 * 2. **ka × проектная ширина (1280 клиенту, 1440 консоли и владельцу)** —
 *    правило проекта «макеты проверяются на самом длинном языке» выполняется
 *    только здесь. На телефоне десктопных блоков (`wide-only`, две колонки,
 *    таблица проводок, метрики) на экране **нет вовсе**, то есть по-грузински
 *    их не видел никто. Это была дыра у `deal-*` и `requisites-*`: заведены как
 *    ru.desktop + ka.mobile, и грузинский десктоп не снимался ни разу.
 * 3. **ru × проектная ширина** — только там, где показаны деньги. `Intl` в
 *    русской локали печатает лари **трёхбуквенным кодом** `GEL`, а не знаком
 *    `₾` (`i18n/format.ts`), и потому самая широкая запись суммы существует
 *    только в русском: `12 345 678,90 GEL` против `12 345 678,90 ₾`. На
 *    грузинском её не увидеть ни на одной ширине.
 *
 * `en` к новым экранам не добавляется намеренно: он короче обоих на каждой
 * строке, а стоит столько же. Экран, выдержавший ka и ru, выдержит и его.
 * Там, где `en` уже был (клиентские экраны первой очереди), он и остаётся —
 * снимать его перестать значило бы потерять покрытие, а не сэкономить.
 */
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
    add(`deal-paying-${id}-${state}`, `/deals/${id}`, { desktop: DESKTOP, mobile: MOBILE }, ['ka']);
  }
  for (const [id, state] of RECEIVING) {
    add(`deal-receiving-${id}-${state}`, `/deals/${id}`, { desktop: DESKTOP }, ['ru']);
    add(`deal-receiving-${id}-${state}`, `/deals/${id}`, { desktop: DESKTOP, mobile: MOBILE }, ['ka']);
  }
  /**
   * Длинная сумма: грузинская подпись рядом с десятизначным числом — на
   * телефоне и на десктопе, — и русская запись с кодом `GEL`, самая широкая из
   * трёх. Экран «Мой счёт» ловит ту же сумму в запертой части, а очередь
   * оператора — в строке задачи; оба маршрута в обходе уже есть.
   */
  add(`deal-long-amount`, `/deals/${LONG_AMOUNT_DEAL}`, { desktop: DESKTOP, mobile: MOBILE }, ['ka']);
  add(`deal-long-amount`, `/deals/${LONG_AMOUNT_DEAL}`, { desktop: DESKTOP }, ['ru']);
  add('deal-partial', '/deals/m09?state=partial', { desktop: DESKTOP }, ['ka']);
  add('deal-denied', '/deals/m09?state=denied', { desktop: DESKTOP }, ['ka']);
  add('deal-error', '/deals/m09?state=error', { desktop: DESKTOP }, ['ka']);
  add('account', '/account', { desktop: DESKTOP, mobile: MOBILE });
  for (const state of PERIMETER) {
    add(`requisites-${state}`, `/requisites?state=${state}`, { desktop: DESKTOP }, ['ru']);
    add(`requisites-${state}`, `/requisites?state=${state}`, { desktop: DESKTOP, mobile: MOBILE }, ['ka']);
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
  /**
   * Пусто, загрузка и ошибка были ровно у одного экрана — списка сделок.
   * Пустое состояние есть ещё у четырёх, и ни одно не снималось: пустой экран
   * не ломает сборку и не виден в обычном обходе, а клиент в первый день видит
   * именно его. Берём узкую ширину: пустой блок — одна карточка, и рискует он
   * только переполнением на телефоне.
   */
  add('account-empty', '/account?state=empty', { mobile: MOBILE }, ['ka']);
  add('documents-empty', '/documents?state=empty', { mobile: MOBILE }, ['ka']);
  add('notifications-empty', '/notifications?state=empty', { mobile: MOBILE }, ['ka']);
  add('archive-empty', '/archive?state=empty', { mobile: MOBILE }, ['ka']);
  add('ops-queue', '/ops', { wide: WIDE });
  add('ops-queue', '/ops', { mobile: MOBILE }, ['ru']);
  add('ops-queue-empty', '/ops?type=verifyClient', { wide: WIDE }, ['ka']);
  /* Нарушение покрытия клиентских средств — красная линия №3 на экране. Баннер
     существует, и не снимался ни разу. */
  add('ops-queue-breach', '/ops?state=breach', { wide: WIDE }, ['ka']);
  add('ops-decision', '/ops/decision', { wide: WIDE, mobile: MOBILE });
  add('ops-reconciliation', '/ops/reconciliation', { wide: WIDE, mobile: MOBILE });
  add('ops-unfreeze', '/ops/unfreeze', { wide: WIDE, mobile: MOBILE });
  /**
   * Дежурный дашборд — второе место консоли, куда ходят не за задачей, и вне
   * обхода он был целиком. На нём стоят пять утренних метрик и журнал проводок:
   * длинные грузинские подписи в узких колонках — ровно тот случай, ради
   * которого обход и существует.
   */
  add('ops-duty', '/ops/duty', { wide: WIDE, mobile: MOBILE }, ['ka']);
  add('ops-duty', '/ops/duty', { wide: WIDE }, ['ru']);
  /**
   * Кабинет владельца — четыре страницы, которых в обходе не было **вовсе**.
   * Они собираются, отдают 200 и ни разу не проверялись ни на непереведённый
   * ключ, ни на переполнение, ни на контраст, ни на бюджеты длины.
   *
   * Карточки сделок берутся не подряд, а по трём разным формам экономики:
   * `ow01` — расчёт с конвертацией (две валюты и три курса, самая плотная),
   * `ow05` — откат с отрицательной маржой (знак минус, тревожный тон),
   * `ow04` — сделка в работе (ожидаемая комиссия вместо фактической).
   * Остальные тридцать пять повторяют одну из трёх.
   */
  add('owner-summary', '/owner', { wide: WIDE, mobile: MOBILE }, ['ka']);
  add('owner-summary', '/owner', { wide: WIDE }, ['ru']);
  /* Предыдущий период пуст по построению фикстуры: пустая сводка — состояние
     экрана, а не отсутствие данных, и до сих пор его не видел никто. */
  add('owner-summary-empty', '/owner?period=previous', { wide: WIDE }, ['ka']);
  add('owner-deals', '/owner/deals', { wide: WIDE, mobile: MOBILE }, ['ka']);
  add('owner-deals', '/owner/deals', { wide: WIDE }, ['ru']);
  add('owner-deal-fx', '/owner/deals/ow01', { wide: WIDE, mobile: MOBILE }, ['ka']);
  add('owner-deal-fx', '/owner/deals/ow01', { wide: WIDE }, ['ru']);
  add('owner-deal-loss', '/owner/deals/ow05', { wide: WIDE }, ['ka']);
  add('owner-deal-live', '/owner/deals/ow04', { wide: WIDE }, ['ka']);
  add('owner-tariff', '/owner/tariff', { wide: WIDE, mobile: MOBILE }, ['ka']);
  add('owner-tariff', '/owner/tariff', { wide: WIDE }, ['ru']);
  add('security', '/security', { desktop: DESKTOP }, ['ka']);
  return list;
}

/* ------------------------------------- карточки задач консоли: обход по факту */

/**
 * Виды задач — из фикстуры, а не списком здесь.
 *
 * Перечень, переписанный в скрипт руками, разъезжается с кодом на первой же
 * правке и разъезжается **молча**: новый вид задачи просто не попадает в обход,
 * и его карточка не проверяется ничем. Ровно так девять видов разбора и прожили
 * до сих пор — объявлены в коде, невидимы на экране.
 */
function declaredTaskTypes() {
  const source = readFileSync(join(SRC, 'fixtures', 'store.ts'), 'utf8');
  const block = source.match(/export const TASK_TYPES = \[([\s\S]*?)\] as const;/u);
  if (block === null) {
    fail('очередь', 'перечень TASK_TYPES не найден в fixtures/store.ts — обход карточек не построен');
    return [];
  }
  return [...block[1].matchAll(/'(\w+)'/gu)].map((match) => match[1]);
}

/**
 * Рамка карточки у всех видов одна, а наполнение блока «разбор» — пяти форм
 * (`ui/ops-work.ts`, `DetailKind`). По одному представителю на форму снимается
 * вторым сочетанием; остальные двенадцать видов отличаются только текстом, и
 * непереведённый ключ у них ловится первым сочетанием.
 */
const TASK_DETAIL_SAMPLE = Object.freeze({
  approvePayout: 'decision',
  reviewBreak: 'break',
  reviewSanction: 'unfreeze',
  intakeUnderpayment: 'facts',
  matchPayment: 'none',
});

/**
 * Единственный вид задачи, который консоль показывает на телефоне: ночью будят
 * ради утверждения выплаты, остальное закрыто классом `task--desktop-only`
 * (`ui/ops.tsx`). Снимать на 360 карточки, до которых с телефона не дойти,
 * значило бы искать дефекты в раскладке, которой нет в продукте.
 */
const TASK_ON_PHONE = ['approvePayout'];

/**
 * Адреса карточек читаются из самой очереди, а не собираются из `dealId` и вида
 * задачи: правило склейки идентификатора живёт в фикстуре и может измениться, а
 * ссылка на экране — это то, по чему пойдёт оператор.
 */
async function taskRoutes() {
  const response = await fetch(`${BASE}/ka/ops`);
  if (!response.ok) {
    fail('очередь', `/ka/ops ответил ${response.status} — карточки задач в обход не попали`);
    return [];
  }
  const html = await response.text();
  const ids = [...new Set([...html.matchAll(/\/ka\/ops\/task\/([A-Za-z0-9_-]+)/gu)].map((m) => m[1]))];
  const firstOfType = new Map();
  for (const id of ids) {
    const type = id.slice(id.indexOf('-') + 1);
    if (!firstOfType.has(type)) firstOfType.set(type, id);
  }
  for (const type of declaredTaskTypes()) {
    if (firstOfType.has(type)) continue;
    fail('очередь', `вид задачи ${type} объявлен в TASK_TYPES, но в очереди его нет — карточку никто не откроет`);
  }
  for (const type of Object.keys(TASK_DETAIL_SAMPLE)) {
    if (firstOfType.has(type)) continue;
    fail('очередь', `представитель разбора «${TASK_DETAIL_SAMPLE[type]}» (${type}) пропал из очереди — форма разбора осталась без снимка`);
  }
  const list = [];
  for (const [type, id] of firstOfType) {
    const name = `ops-task-${type}`;
    const path = `/ops/task/${id}`;
    list.push({ name, path, locale: 'ka', kind: 'wide', viewport: WIDE });
    if (TASK_ON_PHONE.includes(type)) {
      list.push({ name, path, locale: 'ka', kind: 'mobile', viewport: MOBILE });
    }
    if (type in TASK_DETAIL_SAMPLE) {
      list.push({ name, path, locale: 'ru', kind: 'wide', viewport: WIDE });
    }
  }
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
    // Подпись у суммы, а не сама сумма: у числа свой бюджет, ниже.
    ['подпись суммы', '.amount-label', 24],
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

/**
 * Бюджет длины **самой суммы** — единственный, который считается на всех трёх
 * языках, а не только на грузинском.
 *
 * ## Чего не было
 *
 * Бюджет `.amount-label` мерил **подпись** к сумме («Сумма сделки», «Маржа»), а
 * у самого числа бюджета не было ни одного. Число при этом длиннее подписи
 * ровно там, где раскладка ломается: в колонке значений, где рядом стоит
 * грузинская подпись и код валюты.
 *
 * ## Почему на всех трёх языках, а не на `ka`
 *
 * Правило «самый длинный язык — грузинский» верно для текста и **неверно для
 * денег**. `Intl` в русской локали печатает лари трёхбуквенным кодом `GEL`
 * вместо знака `₾` (`i18n/format.ts`, и это правило локали, а не дефект), а
 * английская ставит код впереди: `12 345 678,90 GEL` и `GEL 12,345,678.90` —
 * по семнадцать знаков против пятнадцати у грузинского `12 345 678,90 ₾`.
 * Мерить сумму только на `ka` значит не мерить её вовсе в той локали, где она
 * шире всего.
 *
 * ## Откуда 20
 *
 * Это замер, а не круглое число: самая длинная сумма набора (`m20`,
 * 1 234 567 890 минорных единиц) даёт 17 знаков, со знаком «+» или «−» — 18,
 * запас 2. Сумма на разряд больше в бюджет не влезает — и это верно: раскладки
 * под неё не рисовали. Предел суммы сделки в продукте не назван — **[открыто]**,
 * решение владельца; до него бюджет описывает то, что раскладка держит сегодня.
 */
const AMOUNT_BUDGET = `(() => {
  const problems = [];
  for (const node of document.querySelectorAll('.amount')) {
    const value = (node.textContent || '').replace(/\\s+/g, ' ').trim();
    if (value.length === 0 || value.length <= 20) continue;
    problems.push('бюджет длины (сумма): ' + value.length + ' знаков при 20 — «' + value + '»');
  }
  return problems;
})()`;

/**
 * Состояние фокуса: куда он попал, видно ли элемент и **видно ли сам фокус**.
 *
 * Наличие кольца не угадывается по свойствам, а измеряется разностью: стиль
 * снимается у сфокусированного узла, затем узел теряет фокус и стиль снимается
 * снова. Совпали — значит на экране не изменилось ничего, и фокус невидим.
 * Проверка «есть ли `outline`» так не умеет: постоянная тень у кнопки прошла бы
 * за фокус-кольцо, а кольцо, нарисованное на `::after`, — не прошло бы вовсе.
 * Поэтому псевдоэлементы читаются тоже.
 */
const FOCUS_STATE = `(() => {
  const node = document.activeElement;
  if (!node || node === document.body) return null;
  const box = node.getBoundingClientRect();
  const read = () => {
    const out = [];
    for (const pseudo of [null, '::before', '::after']) {
      const style = getComputedStyle(node, pseudo);
      out.push([
        style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset,
        style.boxShadow, style.backgroundColor, style.color, style.borderColor,
        style.textDecorationLine, style.content, style.opacity, style.transform,
      ].join('~'));
    }
    return out.join('|');
  };
  const focused = read();
  node.blur();
  const blurred = read();
  node.focus();
  return {
    label: String(node.getAttribute('aria-label') || node.textContent || node.tagName).trim().slice(0, 30),
    visible: box.width > 0 && box.height > 0,
    ring: focused !== blurred,
  };
})()`;

/**
 * Кадры, на которых фокус-кольцо обязано быть видно **глазом**, а не только
 * проверкой. По одному на каждую оболочку: клиент широкий, клиент узкий,
 * консоль, кабинет владельца. Больше не нужно — оболочка одна на все свои
 * экраны, а снимок стоит времени.
 */
const FOCUS_SHOTS = new Set([
  'deals-list.ka.desktop',
  'deals-list.ka.mobile',
  'ops-queue.ka.wide',
  'owner-summary.ka.wide',
]);

/**
 * Клавиатура и видимый фокус.
 *
 * ## Что было сломано
 *
 * Проверка считала нажатия Tab и смотрела, попал ли фокус на видимый узел. Того,
 * что фокус **видно**, она не проверяла вовсе, а снимок делался до неё — то есть
 * кадра с фокус-кольцом не существовало ни одного за весь обход. Пропавшая
 * обводка не ломает ни сборку, ни тест, ни скриншот; она ломает работу
 * клавиатурой, и обнаруживается это у того, кто мышью не пользуется.
 */
async function checkKeyboard(page, shotPath) {
  const focusable = await page.evaluate(
    () => document.querySelectorAll('a[href], button, summary, input, select, textarea').length,
  );
  if (focusable === 0) return [];
  const problems = [];
  await page.keyboard.press('Tab');
  const first = await page.evaluate(FOCUS_STATE);
  if (first === null) {
    problems.push('первый Tab не попал ни на один элемент');
  } else {
    if (!first.visible) problems.push(`первый Tab попал на невидимый элемент: «${first.label}»`);
    // Кольцо меряется разностью стилей, поэтому «не видно» здесь значит «на
    // экране не изменилось ничего», а не «не нашли знакомого свойства».
    if (!first.ring) problems.push(`фокус не виден: стиль элемента «${first.label}» не меняется от фокуса`);
  }
  /* Кадр с фокусом — не полностраничный: кольцо стоит на первом элементе, и
     полная страница ради него весит впятеро больше, ничего не добавляя. */
  if (shotPath !== null) await page.screenshot({ path: shotPath, fullPage: false });
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
  /* Карточки задач добавляются после подъёма сервера: их адреса читаются из
     самой очереди, а не собираются здесь из идентификаторов фикстуры. */
  /**
   * `VERIFY_ONLY` — отбор маршрутов по имени регулярным выражением, для
   * отладки самой проверки. Полный обход идёт четыре минуты, и правка одного
   * правила не должна стоить четырёх минут: `VERIFY_ONLY=owner-` снимает
   * кабинет владельца за десять секунд. В обычном прогоне переменной нет, и
   * обход полный — сузить его молча нельзя, отбор печатается строкой.
   */
  const only = process.env.VERIFY_ONLY ?? null;
  const all = [...routes(), ...(await taskRoutes())];
  const list = only === null ? all : all.filter((route) => new RegExp(only, 'u').test(route.name));
  if (only !== null) {
    process.stdout.write(`⚠ отбор VERIFY_ONLY=${only}: обход неполный, зелёный результат ничего не доказывает\n`);
  }
  const byName = new Set(list.map((route) => route.name)).size;
  process.stdout.write(
    `Обход: ${list.length} снимков на ${byName} маршрутах (ka и ru, узкая и проектная ширина)\n`,
  );
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
    const at = `${route.name}.${route.locale}.${route.kind}`;
    const problems = await page.evaluate(PAGE_CHECKS);
    if (route.locale === 'ka') {
      problems.push(...(await page.evaluate(LENGTH_BUDGETS)));
    }
    // Бюджет суммы — на каждом языке: самая широкая запись денег живёт в
    // русской локали, а не в грузинской (см. шапку `AMOUNT_BUDGET`).
    problems.push(...(await page.evaluate(AMOUNT_BUDGET)));
    for (const problem of problems) {
      fail(at, problem);
    }
    const file = join(SHOTS, `${at}.png`);
    await page.screenshot({ path: file, fullPage: true });
    shot += 1;
    const focusShot = FOCUS_SHOTS.has(at) ? join(SHOTS, `${at}.focus.png`) : null;
    for (const problem of await checkKeyboard(page, focusShot)) {
      fail(at, problem);
    }
    if (focusShot !== null) shot += 1;
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
