/**
 * Перечни guard'ов домена: поиск и подмена одной реализации.
 *
 * ## Зачем отдельный модуль
 *
 * Мутационный прогон состоит из двух половин, живущих в разных процессах:
 * скрипт (`guard-mutation.mjs`) перечисляет цели, конфиг vitest
 * (`mutation.vitest.config.ts`) подменяет реализацию внутри прогона. Обе
 * половины обязаны отвечать на один и тот же вопрос «где guard'ы и как
 * зовётся вот этот» **одинаково**, иначе скрипт отчитается о цели, которую
 * прогон не тронул, — и это будет выглядеть как зелёный результат.
 *
 * Поэтому ответ здесь один и общий.
 *
 * ## Что было сломано
 *
 * Предыдущая версия вычитывала **один** блок по захардкоженному имени
 * `GUARD_IDS`. Перечень транша попадал в прогон, а перечни сделки
 * (`DEAL_GUARD_IDS`, `deal.ts`) и вывода (`WITHDRAWAL_GUARD_IDS`,
 * `client-account.ts`) — нет, и отчёт «восемнадцать guard'ов, все убиты»
 * читался как «все guard'ы домена проверяются». Одиннадцать не проверялись
 * вовсе.
 *
 * Здесь перечень не назван по имени ни разу. Регистром считается **любое**
 * `export const … = [ 'g_…', … ] as const;` в исходниках домена: перечень,
 * заведённый через полгода, попадёт в прогон без правки скрипта — а если он
 * заведён так, что не находится, скрипт об этом скажет (см.
 * `validateRegistries`), вместо того чтобы молча его пропустить.
 *
 * ## Почему подмена — правка исходника, а не подмена модуля
 *
 * Раньше подмена жила в резолвере: импорт `guards.ts` уводился на
 * сгенерированный модуль, который переэкспортировал таблицу с одной заменённой
 * реализацией. Для guard'ов транша это работает, потому что таблицу читает
 * **другой** модуль (`tranche.ts` импортирует `evaluateGuard`).
 *
 * Для сделки и вывода тот же приём не сработал бы вовсе, и это не мелочь
 * настройки, а свойство кода: `DEAL_GUARDS` вообще не экспортируется, а
 * `reduceWithdrawal` зовёт `evaluateWithdrawalGuard` из **своего же** модуля —
 * замена экспорта на поведение внутри модуля не влияет. Подменённый экспорт
 * дал бы зелёный прогон при «сломанном» guard'е: мутация, которая ничего не
 * мутирует, — худший из возможных результатов, потому что она успокаивает.
 *
 * Поэтому подмена делается над **текстом модуля** в `transform`: реализация
 * guard'а заменяется на `() => true` там, где она объявлена. Кто её читает —
 * снаружи, изнутри, через замыкание — перестаёт иметь значение. На диск при
 * этом по-прежнему не пишется ничего: `transform` работает с копией в памяти,
 * а отпечаток дерева до и после прогона скрипт сверяет.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
export const DOMAIN_SRC = resolve(REPO_ROOT, 'packages/domain/src');

/** Имя переменной окружения с целью мутации: `<путь от корня>::<guard>`. */
export const MUTATION_ENV = 'SDELKA_MUTATE_GUARD_TARGET';

/** Идентификатор guard'а: тот же словарь, что в `STATE-MACHINES.md` §1.3. */
const GUARD_ID = /^g_[a-z0-9_]+$/u;

/* ------------------------------------------------------------------------- */
/* Лексер: где в исходнике комментарии, строки и регулярные выражения         */
/* ------------------------------------------------------------------------- */

/** Символы, после которых `/` начинает регулярное выражение, а не деление. */
const REGEX_ALLOWED_BEFORE = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<',
  '>', '\n',
]);
const REGEX_ALLOWED_KEYWORDS = [
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await',
];

function regexAllowedHere(code, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/u.test(code[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  const previous = code[cursor];
  if (REGEX_ALLOWED_BEFORE.has(previous)) return true;
  if (!/[A-Za-z0-9_$]/u.test(previous)) return false;
  let start = cursor;
  while (start >= 0 && /[A-Za-z0-9_$]/u.test(code[start])) start -= 1;
  return REGEX_ALLOWED_KEYWORDS.includes(code.slice(start + 1, cursor + 1));
}

/**
 * Разбор исходника на «структуру» и «содержимое».
 *
 * Возвращает `masked` — строку той же длины, где всё содержимое комментариев,
 * строковых литералов и регулярных выражений заменено пробелами. По ней можно
 * считать скобки и искать разделители, не боясь скобки внутри комментария:
 * в `guards.ts` их полно (`client:{клиент}:tranche:{сделка}`), и наивный
 * счётчик на них разъезжается.
 *
 * И `strings` — спаны строковых литералов с уже разобранным значением: имена
 * guard'ов берутся оттуда, а не регулярным выражением по тексту, где они
 * встречаются и в прозе комментариев.
 */
export function lex(code) {
  const masked = code.split('');
  const strings = [];
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (masked[i] !== '\n') masked[i] = ' ';
    }
  };
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === '//') {
      let end = code.indexOf('\n', i);
      if (end < 0) end = code.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (two === '/*') {
      let end = code.indexOf('*/', i + 2);
      end = end < 0 ? code.length : end + 2;
      blank(i, end);
      i = end;
      continue;
    }
    const char = code[i];
    if (char === "'" || char === '"' || char === '`') {
      const start = i;
      i += 1;
      let value = '';
      while (i < code.length) {
        if (code[i] === '\\') {
          value += code[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (code[i] === char) break;
        value += code[i];
        i += 1;
      }
      i = Math.min(i + 1, code.length);
      blank(start, i);
      strings.push({ start, end: i, value, quote: char });
      continue;
    }
    if (char === '/' && regexAllowedHere(code, i)) {
      const start = i;
      i += 1;
      let inClass = false;
      while (i < code.length) {
        const current = code[i];
        if (current === '\\') {
          i += 2;
          continue;
        }
        if (current === '\n') break;
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) break;
        i += 1;
      }
      while (i < code.length && /[a-z]/u.test(code[i] ?? '')) i += 1;
      i = Math.min(i + 1, code.length);
      blank(start, i);
      continue;
    }
    i += 1;
  }
  return { masked: masked.join(''), strings };
}

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);

/** Позиция закрывающей скобки к открывающей на `start`. Считает по `masked`. */
function matchBracket(masked, start) {
  const stack = [OPEN[masked[start]]];
  for (let i = start + 1; i < masked.length; i += 1) {
    const char = masked[i];
    if (char in OPEN) {
      stack.push(OPEN[char]);
      continue;
    }
    if (!CLOSE.has(char)) continue;
    if (stack[stack.length - 1] !== char) return -1;
    stack.pop();
    if (stack.length === 0) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------------- */
/* Поиск перечней                                                            */
/* ------------------------------------------------------------------------- */

function listFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

const DECLARATION = /\bexport\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=;]*)?=\s*\[/gu;

/**
 * Перечни guard'ов в исходниках домена.
 *
 * Признак перечня — **содержимое, а не имя**: экспортированный `as const`
 * массив, все элементы которого суть строковые литералы вида `g_…`. Имя
 * `GUARD_IDS` здесь не упоминается, и в этом весь смысл: перечень, заведённый
 * под любым другим именем, находится сам.
 *
 * Вспомогательные наборы вроде `EVIDENCE_GUARDS` в `tranche.ts` (подмножество
 * уже объявленных guard'ов, приписанное ребру) под признак не подходят: они не
 * экспортированы и не `as const`. Если однажды подойдут — они окажутся в
 * прогоне как отдельный «перечень», и `validateRegistries` тут же скажет, что
 * реализаций для них в файле нет. Ложное срабатывание будет громким, а не
 * тихим, и это единственно верная сторона для ошибки.
 */
export function discoverRegistries(dir = DOMAIN_SRC) {
  const registries = [];
  for (const file of listFiles(dir)) {
    const code = readFileSync(file, 'utf8');
    const { masked, strings } = lex(code);
    DECLARATION.lastIndex = 0;
    let match;
    while ((match = DECLARATION.exec(masked)) !== null) {
      const open = match.index + match[0].length - 1;
      const close = matchBracket(masked, open);
      if (close < 0) continue;
      const tail = masked.slice(close + 1, close + 32).trimStart();
      if (!tail.startsWith('as const')) continue;
      const inside = strings.filter((item) => item.start > open && item.end <= close);
      if (inside.length === 0) continue;
      if (!inside.every((item) => GUARD_ID.test(item.value))) continue;
      const body = masked.slice(open + 1, close);
      // В массиве нет ничего, кроме строк и запятых: перечень, а не выражение.
      if (/[^\s,]/u.test(body)) continue;
      registries.push({
        file,
        relative: relative(REPO_ROOT, file),
        list: match[1],
        guards: inside.map((item) => item.value),
      });
    }
  }
  return registries;
}

/* ------------------------------------------------------------------------- */
/* Подмена одной реализации                                                  */
/* ------------------------------------------------------------------------- */

export class MutationError extends Error {
  constructor(code, detail) {
    super(`sdelka.mutation.${code}:${detail}`);
    this.name = 'MutationError';
  }
}

/**
 * Заменить реализацию guard'а на `() => true` в тексте модуля.
 *
 * Ищется **объявление свойства** `g_…:` — ключ таблицы реализаций. Имя guard'а
 * встречается в файле и в перечне, и в списках guard'ов на рёбрах, но там оно
 * строковый литерал (`'g_…'`), а не ключ, и по маске лексера строки не видно
 * вовсе. Ключ в кавычках тоже допустим: он ищется среди разобранных строк по
 * следующему за ними двоеточию.
 *
 * Совпадений обязано быть ровно одно. Ноль означает, что перечень есть, а
 * таблицы реализаций нет (или она устроена иначе, чем объектным литералом), —
 * и тогда мутация ничего не изменила бы, а прогон остался зелёным и был бы
 * прочитан как «guard проверяется». Больше одного — что имя guard'а
 * неоднозначно внутри файла. Оба случая заканчиваются отказом, а не догадкой.
 */
export function mutateSource(code, guard, where = '<memory>') {
  if (!GUARD_ID.test(guard)) throw new MutationError('bad_guard_id', guard);
  const { masked, strings } = lex(code);
  const positions = [];

  const bare = new RegExp(`(^|[\\s{,;])(${guard})\\s*:`, 'gu');
  let match;
  while ((match = bare.exec(masked)) !== null) {
    positions.push({ key: match.index + match[1].length, colon: match.index + match[0].length - 1 });
  }
  for (const item of strings) {
    if (item.value !== guard) continue;
    const rest = masked.slice(item.end);
    const offset = rest.length - rest.trimStart().length;
    if (rest[offset] !== ':') continue;
    positions.push({ key: item.start, colon: item.end + offset });
  }

  if (positions.length === 0) throw new MutationError('implementation_not_found', `${where}:${guard}`);
  if (positions.length > 1) throw new MutationError('implementation_ambiguous', `${where}:${guard}`);

  const start = positions[0].colon + 1;
  let end = start;
  const stack = [];
  while (end < masked.length) {
    const char = masked[end];
    if (char in OPEN) stack.push(OPEN[char]);
    else if (CLOSE.has(char)) {
      if (stack.length === 0) break; // `}` таблицы: значение было последним
      if (stack[stack.length - 1] !== char) {
        throw new MutationError('unbalanced_value', `${where}:${guard}`);
      }
      stack.pop();
    } else if (char === ',' && stack.length === 0) break;
    end += 1;
  }
  if (end >= masked.length) throw new MutationError('value_unterminated', `${where}:${guard}`);
  return `${code.slice(0, start)} () => true${code.slice(end)}`;
}

/**
 * Проверка, что каждый найденный guard действительно подменяем — **до** того,
 * как запускать прогоны.
 *
 * Без неё сломанная подмена выглядит как убитый guard: прогон падает не
 * потому, что правило перестало работать, а потому, что модуль не собрался.
 * Здесь это ловится за миллисекунды и по имени.
 */
export function validateRegistries(registries) {
  const problems = [];
  for (const registry of registries) {
    const code = readFileSync(registry.file, 'utf8');
    for (const guard of registry.guards) {
      try {
        const mutated = mutateSource(code, guard, registry.relative);
        if (mutated === code) problems.push(`${registry.relative}::${guard}: подмена ничего не изменила`);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------------- */
/* Цель мутации как строка                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Цель — **файл и guard**, а не один guard.
 *
 * Имена перечней пересекаются намеренно (`STATE-MACHINES.md` §9, единый
 * словарь): `g_source_account_known` и `g_approvals_sufficient` есть и у
 * транша, и у вывода; `g_condition_agreed` и `g_unfreeze_approvers_distinct` —
 * и у транша, и у сделки. Мутация по одному имени ломала бы то один, то другой
 * и отчитывалась бы за оба.
 */
export function formatTarget(registry, guard) {
  return `${registry.relative}::${guard}`;
}

export function parseTarget(spec) {
  const separator = spec.lastIndexOf('::');
  if (separator < 0) throw new MutationError('bad_target', spec);
  return {
    file: resolve(REPO_ROOT, spec.slice(0, separator)),
    guard: spec.slice(separator + 2),
  };
}
