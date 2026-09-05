/**
 * Каталог мутаций приёма: перечисление целей и подмена одной из них.
 *
 * ## Зачем отдельный модуль
 *
 * Прогон состоит из двух половин в разных процессах: скрипт
 * (`intake-mutation.mjs`) перечисляет мутации и запускает наборы, конфигурация
 * vitest (`mutation.vitest.config.ts`) подменяет исходник внутри прогона. Обе
 * обязаны отвечать на вопрос «какие есть мутации и что делает вот эта»
 * **одинаково** — иначе скрипт отчитается о цели, которую прогон не тронул, и
 * это будет выглядеть как зелёный результат. Ответ здесь один и общий.
 *
 * ## Что мутируется и почему именно это
 *
 * Прошлый заход по этому пакету прогнал операторы сравнения и границы порогов.
 * Он не трогал три класса, каждый из которых ломает продукт молча:
 *
 *  1. **Константы политик и числа в расчётах** (`num`). Допуск, три курса и
 *     порог дрейфа, веса сопоставления, пороги показа и автосопоставления,
 *     срок котировки — это величины, которые видит клиент или которые двигают
 *     деньги. Тест, не заметивший смены `50` на `51` в доле допуска, не
 *     проверяет допуск: он проверяет, что функция что-то вернула.
 *  2. **Удаление вызова** (`call`, `throw`). Проверка, вызов которой снесён,
 *     остаётся в файле и читается как работающая. Это ровно тот дефект, ради
 *     которого в домене появился мутационный прогон guard'ов.
 *  3. **Подмена ключа причины на соседний** (`key`). Оператор принимает решение
 *     по названной причине: «раскрыто задним числом» и «раскрытие устарело» —
 *     разные действия. Тест, проверяющий только сумму, пропускает подмену
 *     причины целиком.
 *
 * Плюс два оператора, без которых первые три не полны: `bool` — переворот
 * значения в тотальных таблицах (`TOLERANCE_COVERS_SHORTFALL`,
 * `LEG_IS_OBSERVABLE`), и `str` — подмена значения закрытого перечня на соседа
 * по тому же перечню (маршрут приёма, вид разнесения, исход сопоставления,
 * участок трекинга, вид задачи оператору).
 *
 * ## Почему подмена — текст, а не подстановка модуля
 *
 * Здесь нет таблицы функций, которую можно подменить экспортом: мутируются
 * литералы внутри модулей. Правка текста в `transform` действует независимо от
 * того, кто и как читает значение. На диск не пишется ничего — ни на время
 * прогона, ни на секунду; скрипт сверяет отпечаток дерева до и после.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
export const SRC_DIR = resolve(PACKAGE_ROOT, 'src');

/** Имя переменной окружения с идентификатором мутации. */
export const MUTATION_ENV = 'SDELKA_MUTATE_INTAKE';

/** Метка в потоке ошибок: подмена дошла до исходника. См. `intake-mutation.mjs`. */
export const APPLIED_MARK = 'sdelka.mutation.applied:';

/* ------------------------------------------------------------------ */
/* Разбор исходника: где код, а где комментарий, строка или регулярное */
/* ------------------------------------------------------------------ */

const REGEX_ALLOWED_AFTER = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
  'n', // `return /…/`
]);

/**
 * Маска «эта позиция — код», список строковых литералов и список слов.
 *
 * Нужна ровно затем, чтобы мутация не залезла в комментарий (их в пакете
 * больше, чем кода) и в регулярное выражение: `\d{4}` в шаблоне версии
 * политики — не константа политики, а часть проверки формата.
 *
 * Шаблонная строка разбирается наивно, как одна строка целиком: вложенных
 * строковых литералов в шаблонах пакета нет, а числа и ключи внутри шаблона
 * мутировать незачем.
 */
function classify(code) {
  const mask = new Uint8Array(code.length);
  const strings = [];
  let index = 0;
  let previous = '';
  while (index < code.length) {
    const character = code[index];
    const following = code[index + 1];
    if (character === '/' && following === '/') {
      while (index < code.length && code[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && following === '*') {
      index += 2;
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      const start = index;
      index += 1;
      while (index < code.length) {
        if (code[index] === '\\') {
          index += 2;
          continue;
        }
        if (code[index] === character) {
          index += 1;
          break;
        }
        index += 1;
      }
      strings.push({ start, end: index, value: code.slice(start + 1, index - 1) });
      previous = character;
      continue;
    }
    if (character === '/' && REGEX_ALLOWED_AFTER.has(previous)) {
      index += 1;
      let inClass = false;
      while (index < code.length) {
        const inner = code[index];
        if (inner === '\\') {
          index += 2;
          continue;
        }
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) {
          index += 1;
          break;
        } else if (inner === '\n') break;
        index += 1;
      }
      while (index < code.length && /[a-z]/u.test(code[index])) index += 1;
      previous = '/';
      continue;
    }
    mask[index] = 1;
    if (!/\s/u.test(character)) previous = character;
    index += 1;
  }
  return { mask, strings };
}

function isIdentifierChar(character) {
  return character !== undefined && /[\w$]/u.test(character);
}

/* ------------------------------------------------------------------ */
/* Словари закрытых перечней                                          */
/* ------------------------------------------------------------------ */

/**
 * Перечни, объявленные в самом пакете (`export const X = [...] as const;`),
 * плюс те, что приходят из соседних пакетов и здесь только употребляются.
 *
 * Второй список задан явно, а не выведен: значения `DetectorOutcome` и
 * `ReviewTaskKind` живут в `@sdelka/compliance`, и читать чужой пакет ради
 * каталога мутаций значило бы завести зависимость там, где её нет.
 */
const EXTERNAL_VOCABULARIES = [
  // `DetectorOutcome` — лестница исходов комплаенса (`ROUTE_BY_OUTCOME`).
  ['clear', 'review', 'stop', 'hold', 'block'],
  // `ReviewTaskKind` — вид задачи в очередь разбора.
  ['payer_hold', 'payer_exception', 'intake_unmatched'],
  // Вид подтверждения участка (`LegEvidence.kind`).
  ['observed_by_us', 'declared_by_party', 'not_observable'],
  // Вид разрешения допуска (`ToleranceResolution.kind`).
  ['declared', 'undeclared'],
  // Вид требования второго утверждения (`ManualMatchSecondApproval.kind`).
  ['required', 'not_required'],
  // Степени совпадения имени (`NameMatch.degree`) — вторичный сигнал.
  ['identical_in_source_alphabet', 'identical_after_latinization', 'strong'],
];

function declaredVocabularies(sources) {
  const list = [];
  const declarationSpans = new Map();
  for (const [name, code] of sources) {
    const spans = [];
    const pattern = /export const [A-Z_0-9]+ = \[([\s\S]*?)\] as const;/gu;
    let match = pattern.exec(code);
    while (match !== null) {
      const body = match[1];
      const members = [...body.matchAll(/'([^']+)'/gu)].map((item) => item[1]);
      if (members.length > 1) list.push(members);
      spans.push([match.index, match.index + match[0].length]);
      match = pattern.exec(code);
    }
    declarationSpans.set(name, spans);
  }
  return { list, declarationSpans };
}

/* ------------------------------------------------------------------ */
/* Ключи причин                                                        */
/* ------------------------------------------------------------------ */

/**
 * Соседний ключ причины — следующий в **своей группе** реестра `keys.ts`.
 *
 * Группа, а не весь реестр: подмена «допуск раскрыт задним числом» на «трекинг
 * просрочен» отличима почти любым утверждением, а подмена на соседа по группе —
 * это ровно та ошибка, которую человек делает при правке, и ровно та, которая
 * даёт оператору неверное основание для действия. Группы заданы в реестре
 * комментариями-разделителями.
 */
function reasonNeighbours(keysSource) {
  const groups = [];
  let current = [];
  for (const line of keysSource.split('\n')) {
    if (/^\s*\/\* --- /u.test(line)) {
      if (current.length > 0) groups.push(current);
      current = [];
      continue;
    }
    const match = /^\s*([A-Za-z][\w]*):\s*'([^']+)',\s*$/u.exec(line);
    if (match !== null) current.push(match[1]);
  }
  if (current.length > 0) groups.push(current);

  const neighbour = new Map();
  for (const group of groups) {
    if (group.length < 2) continue;
    for (let index = 0; index < group.length; index += 1) {
      neighbour.set(group[index], group[(index + 1) % group.length]);
    }
  }
  return neighbour;
}

/* ------------------------------------------------------------------ */
/* Операторы мутации                                                   */
/* ------------------------------------------------------------------ */

function blank(code, start, end) {
  const removed = code.slice(start, end).replace(/[^\n]/gu, ' ');
  return code.slice(0, start) + removed + code.slice(end);
}

function lineOf(code, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (code[index] === '\n') line += 1;
  return line;
}

/** Конец инструкции: точка с запятой на верхнем уровне скобок от `start`. */
function statementEnd(code, start) {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    const character = code[index];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
    else if (character === ';' && depth === 0) return index + 1;
    if (depth < 0) return -1;
  }
  return -1;
}

/**
 * Участки, где литерал существует только в типе: объявления `type` и тела
 * `interface`.
 *
 * Мутация типа не меняет поведение ни при каких входных данных — типы стёрты до
 * прогона. Такой мутант выживает всегда, и место ему не в списке выживших (где
 * каждая строка требует ответа «какого теста не хватает»), а вне каталога. Иначе
 * отчёт наполняется мутантами, про которых заранее известно, что они
 * эквивалентны, и настоящие пропуски тонут среди них.
 */
function typeSpans(code) {
  const spans = [];
  const pattern = /^(?:export )?(type|interface) [A-Za-z]/gmu;
  let match = pattern.exec(code);
  while (match !== null) {
    const start = match.index;
    if (match[1] === 'type') {
      const end = statementEnd(code, start);
      if (end > start) spans.push([start, end]);
    } else {
      const brace = code.indexOf('{', start);
      if (brace >= 0) {
        let depth = 0;
        for (let index = brace; index < code.length; index += 1) {
          if (code[index] === '{') depth += 1;
          else if (code[index] === '}') {
            depth -= 1;
            if (depth === 0) {
              spans.push([start, index + 1]);
              break;
            }
          }
        }
      }
    }
    match = pattern.exec(code);
  }
  return spans;
}

function numberMutants(file, code, mask) {
  const mutants = [];
  let index = 0;
  while (index < code.length) {
    if (mask[index] !== 1 || !/[0-9]/u.test(code[index])) {
      index += 1;
      continue;
    }
    const previous = code[index - 1];
    if (isIdentifierChar(previous) || previous === '.') {
      index += 1;
      continue;
    }
    let end = index;
    while (end < code.length && /[0-9_]/u.test(code[end])) end += 1;
    const digits = code.slice(index, end);
    const big = code[end] === 'n';
    const literal = big ? `${digits}n` : digits;
    const literalEnd = big ? end + 1 : end;
    if (!isIdentifierChar(code[literalEnd]) && code[literalEnd] !== '.') {
      const value = BigInt(digits.replace(/_/gu, ''));
      const suffix = big ? 'n' : '';
      const bumped = `${value + 1n}${suffix}`;
      const zeroed = value === 0n ? `1${suffix}` : `0${suffix}`;
      for (const [tag, replacement] of [
        ['inc', bumped],
        ['zero', zeroed],
      ]) {
        mutants.push({
          operator: 'num',
          file,
          line: lineOf(code, index),
          description: `${literal} → ${replacement}`,
          tag: `${index}-${tag}`,
          apply: (source) => source.slice(0, index) + replacement + source.slice(literalEnd),
          expect: literal,
          at: index,
        });
      }
    }
    index = literalEnd;
  }
  return mutants;
}

function booleanMutants(file, code, mask) {
  const mutants = [];
  const pattern = /\b(true|false)\b/gu;
  let match = pattern.exec(code);
  while (match !== null) {
    const start = match.index;
    if (mask[start] === 1 && !isIdentifierChar(code[start - 1])) {
      const replacement = match[1] === 'true' ? 'false' : 'true';
      const end = start + match[1].length;
      mutants.push({
        operator: 'bool',
        file,
        line: lineOf(code, start),
        description: `${match[1]} → ${replacement}`,
        tag: `${start}`,
        apply: (source) => source.slice(0, start) + replacement + source.slice(end),
        expect: match[1],
        at: start,
      });
    }
    match = pattern.exec(code);
  }
  return mutants;
}

function stringMutants(file, code, strings, vocabularies, spans) {
  const mutants = [];
  for (const literal of strings) {
    if (code[literal.start] !== "'") continue;
    if (spans.some(([from, to]) => literal.start >= from && literal.start < to)) continue;
    const owning = vocabularies.filter((members) => members.includes(literal.value));
    if (owning.length !== 1) continue;
    const members = owning[0];
    const position = members.indexOf(literal.value);
    const replacement = members[(position + 1) % members.length];
    mutants.push({
      operator: 'str',
      file,
      line: lineOf(code, literal.start),
      description: `'${literal.value}' → '${replacement}'`,
      tag: `${literal.start}`,
      apply: (source) =>
        `${source.slice(0, literal.start)}'${replacement}'${source.slice(literal.end)}`,
      expect: `'${literal.value}'`,
      at: literal.start,
    });
  }
  return mutants;
}

function reasonKeyMutants(file, code, mask, neighbours) {
  const mutants = [];
  const pattern = /INTAKE_REASON_KEYS\.([A-Za-z][\w]*)/gu;
  let match = pattern.exec(code);
  while (match !== null) {
    const start = match.index;
    const neighbour = neighbours.get(match[1]);
    if (mask[start] === 1 && neighbour !== undefined) {
      const end = start + match[0].length;
      mutants.push({
        operator: 'key',
        file,
        line: lineOf(code, start),
        description: `${match[1]} → ${neighbour}`,
        tag: `${start}`,
        apply: (source) =>
          `${source.slice(0, start)}INTAKE_REASON_KEYS.${neighbour}${source.slice(end)}`,
        expect: match[0],
        at: start,
      });
    }
    match = pattern.exec(code);
  }
  return mutants;
}

/**
 * Удаление инструкции-вызова и инструкции-`throw`.
 *
 * Берутся только инструкции, а не любые вызовы: `const x = f()` удалить нельзя,
 * не сломав следующую строку, и мутант, который не собирается, ничего не
 * проверяет. Условный вызов (`if (…) reasons.push(…);`) удаляется вместе с
 * условием — поведение то же: вызова не происходит никогда.
 */
function deletionMutants(file, code) {
  const mutants = [];
  const lines = code.split('\n');
  let offset = 0;
  for (let number = 0; number < lines.length; number += 1) {
    const line = lines[number];
    const callMatch = /^(\s*)(?:if \(.+\) )?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/u.exec(line);
    const throwMatch = /^(\s*)throw new [A-Za-z_$][\w$]*\(/u.exec(line);
    const chosen = throwMatch ?? callMatch;
    if (chosen !== null) {
      const start = offset + chosen[1].length;
      const end = statementEnd(code, start);
      const next = lines[number + 1] ?? '';
      const followedByElse = /^\s*(\}\s*)?else\b/u.test(next);
      if (end > start && !followedByElse) {
        mutants.push({
          operator: throwMatch !== null ? 'throw' : 'call',
          file,
          line: number + 1,
          description: `удалено: ${code.slice(start, Math.min(end, start + 48)).split('\n')[0]}…`,
          tag: `${start}`,
          apply: (source) => blank(source, start, end),
          expect: code.slice(start, end),
          at: start,
        });
      }
    }
    offset += line.length + 1;
  }
  return mutants;
}

/* ------------------------------------------------------------------ */
/* Каталог                                                             */
/* ------------------------------------------------------------------ */

function readSources() {
  const names = readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort();
  return names.map((name) => [name, readFileSync(join(SRC_DIR, name), 'utf8')]);
}

/**
 * Полный каталог мутаций. Порядок детерминирован: имя файла, затем позиция.
 * Идентификатор — `<файл>::<оператор>::<метка>`; по нему конфигурация vitest
 * находит ту же самую мутацию, что и скрипт.
 */
export function buildCatalogue() {
  const sources = readSources();
  const { list: declaredList, declarationSpans } = declaredVocabularies(sources);
  const vocabularies = [...declaredList, ...EXTERNAL_VOCABULARIES];
  const keysSource = sources.find(([name]) => name === 'keys.ts');
  if (keysSource === undefined) throw new Error('sdelka.mutation.keys_registry_missing');
  const neighbours = reasonNeighbours(keysSource[1]);
  if (neighbours.size === 0) throw new Error('sdelka.mutation.reason_groups_missing');

  const mutants = [];
  for (const [name, code] of sources) {
    const { mask, strings } = classify(code);
    const spans = declarationSpans.get(name) ?? [];
    const types = typeSpans(code);
    const forFile = [
      ...numberMutants(name, code, mask),
      ...booleanMutants(name, code, mask),
      ...stringMutants(name, code, strings, vocabularies, spans),
      ...(name === 'keys.ts' ? [] : reasonKeyMutants(name, code, mask, neighbours)),
      ...deletionMutants(name, code),
    ];
    const runtime = forFile.filter(
      (mutant) => !types.some(([from, to]) => mutant.at >= from && mutant.at < to),
    );
    runtime.sort((left, right) => left.at - right.at);
    for (const mutant of runtime) {
      mutants.push({ ...mutant, id: `${name}::${mutant.operator}::${mutant.tag}` });
    }
  }
  return mutants;
}

/** Мутация по идентификатору. Неизвестный идентификатор — отказ, а не тишина. */
export function findMutant(id) {
  const mutant = buildCatalogue().find((item) => item.id === id);
  if (mutant === undefined) throw new Error(`sdelka.mutation.unknown_target:${id}`);
  return mutant;
}

/**
 * Подмена исходника. Отсутствие ожидаемого текста — отказ: мутация, которая
 * ничего не изменила, отчиталась бы об успехе прогона, то есть солгала бы.
 */
export function mutateSource(code, mutant) {
  const mutated = mutant.apply(code);
  if (mutated === code) throw new Error(`sdelka.mutation.no_change:${mutant.id}`);
  return mutated;
}

export function targetFile(mutant) {
  return join(SRC_DIR, mutant.file);
}
