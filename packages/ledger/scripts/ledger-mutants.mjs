/**
 * Каталог мутаций учёта: перечисление целей и подмена одной из них.
 *
 * ## Зачем отдельный модуль
 *
 * Прогон состоит из двух половин в разных процессах: скрипт
 * (`ledger-mutation.mjs`) перечисляет мутации и запускает наборы, конфигурация
 * vitest (`mutation.vitest.config.ts`) подменяет исходник внутри прогона. Обе
 * обязаны отвечать на вопрос «какие есть мутации и что делает вот эта»
 * **одинаково** — иначе скрипт отчитается о цели, которую прогон не тронул, и
 * это будет выглядеть как зелёный результат. Ответ здесь один.
 *
 * Форма взята со стенда комплаенса
 * (`packages/compliance/scripts/compliance-mutants.mjs`) — самой полной из трёх
 * существующих, — и перенесена целиком вместе с тем, чем она отличается от
 * более раннего варианта приёма: рекурсивным обходом `src`, операторами
 * `cmp`/`eq`/`logic`, вырезанием списков параметров типа, реестром равносильных
 * мутаций с проверкой в обе стороны и сверкой отпечатка пакета. Меняются только
 * словари перечней: у учёта они свои.
 *
 * ## Что мутируется и почему именно это
 *
 * Учёт — пакет, где живут красные линии №1–№4, и все четыре высказаны не
 * словами, а **знаком, границей и стороной проводки**:
 *
 *  1. **Числа** (`num`). Суммы в учёте — целые минорные единицы (красная линия
 *     №4), поэтому каждый литерал `0n`, `1n`, `2n` — либо граница знака, либо
 *     доля потолка, либо смещение разбора ключа. Набор, не заметивший смены
 *     `0n` на `1n` в `if (total !== 0n)`, не проверяет равенство суммы проводок
 *     нулю — он проверяет, что функция что-то вернула.
 *  2. **Границы сравнения** (`cmp`). `custodyTotal >= obligationsTotal` — это
 *     покрытие (красная линия №3), `withheld > cap.minor` — потолок удержания,
 *     `gain > funded` — запрет финансировать чужой файл. Значение **ровно на
 *     границе** меняет класс, и порог, у которого не проверена его собственная
 *     граница, задан с точностью до единицы.
 *  3. **Равенство и логика** (`eq`, `logic`). `===` ↔ `!==`, `&&` ↔ `||`:
 *     конъюнкт, который никто не проверяет, — это условие, которое можно снести
 *     (сверка отнесения с файлом счёта, сверка подтверждения сторон).
 *  4. **Значение закрытого перечня на соседа** (`str`). Сторона проводки
 *     (`'debit'` ↔ `'credit'`), тип счёта, принадлежность средств, направление
 *     пула, вид счёта, вид записи. Сторона проводки — это и есть та самая
 *     «сторона», которую тест обязан утверждать: запись, где дебет и кредит
 *     поменялись местами, сходится повалютно ровно так же.
 *  5. **Код ошибки и код инварианта на соседний по группе** (`key`). Дежурный
 *     действует по коду: «покрытие ниже единицы» и «профицит средств» —
 *     разные действия, а `journalCorrectionNotMirror` вместо
 *     `journalCorrectionUnwindsSpentFunds` называет не ту причину. Тест,
 *     проверяющий только факт отказа, подмену кода пропускает целиком. Сосед
 *     берётся из **своей** группы реестра (по пространству имён значения:
 *     `ledger.entry.*`, `ledger.journal.*`, `ledger.posting.*`, …): подмена на
 *     код из другой группы отличима почти любым утверждением, а подмена на
 *     соседа — ровно та ошибка, которую делает человек при правке.
 *  6. **Переворот флага** (`bool`) и **удаление вызова и `throw`**
 *     (`call`, `throw`). Проверка, вызов которой снесён, остаётся в файле и
 *     читается как работающая: `createJournalEntry` зовёт одиннадцать
 *     `assert…` подряд, и каждый из них обязан быть кем-то замечен.
 *
 * ## Почему подмена — текст, а не подстановка модуля
 *
 * Здесь нет таблицы функций, которую можно подменить экспортом: мутируются
 * литералы и операторы внутри модулей. Правка текста в `transform` действует
 * независимо от того, кто и как читает значение. На диск не пишется ничего —
 * ни на время прогона, ни на секунду; скрипт сверяет отпечаток пакета до и
 * после.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
export const SRC_DIR = resolve(PACKAGE_ROOT, 'src');

/** Имя переменной окружения с идентификатором мутации. */
export const MUTATION_ENV = 'SDELKA_MUTATE_LEDGER';

/** Метка в потоке ошибок: подмена дошла до исходника. См. `ledger-mutation.mjs`. */
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
 * больше, чем кода) и в регулярное выражение: `[A-Za-z0-9._-]{1,128}` в
 * `CLIENT_KEY_PATTERN` — длина ключа личности, а не порог политики, и мутация
 * там ломает разбор, ничего не проверяя.
 *
 * Шаблонная строка разбирается наивно, как одна строка целиком: подстановки
 * внутри шаблонов пакета — идентификаторы и вызовы, мутировать там нечего.
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
 * Перечни, приходящие из соседних пакетов: здесь они только употребляются, а
 * объявлены не тут. Задано явно, а не выведено чтением чужого `src`: каталог
 * мутаций одного пакета не должен зависеть от расположения файлов другого.
 */
const EXTERNAL_VOCABULARIES = [
  // `CurrencyCode` (`@sdelka/money`). Валюта входит в ключ файла и в ключ
  // остатка; в самом учёте она сегодня приезжает значением, а не литералом, но
  // перечень объявлен здесь, чтобы литерал, появившийся завтра, попал под
  // мутацию сразу, а не после правки этого файла.
  ['GEL', 'USD', 'EUR', 'JPY'],
  // `Rounding` (`@sdelka/money`, `rational.ts`) — направление округления.
  // Красная линия №4 и §4.3: усечение в пользу клиента — это решение, а не
  // умолчание, и подмена его на округление вверх обязана быть замечена.
  //
  // Порядок не алфавитный, и это важно: сосед `'trunc'` — `'ceil'`, потому что
  // на неотрицательных величинах (а других в учёте нет: `feeCeilingCap`
  // отвергает отрицательное брутто) `'trunc'` и `'floor'` — одно и то же, и
  // такая подмена была бы равносильной по построению, то есть строкой в отчёте,
  // которая ничего не проверяет.
  ['trunc', 'ceil', 'floor'],
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

/**
 * Виды счетов — перечень, объявленный **типом**, а не массивом.
 *
 * План счетов (`Account`) — размеченное объединение, и вида счёта в рантайме
 * нет: есть литералы `'client_locked'`, `'fee_receivable'`, `'suspense_unidentified'`
 * в сравнениях, в конструкторах и в `accountCode`. Это самый ценный словарь
 * пакета: подмена вида счёта в сравнении — ровно тот дефект, который уже
 * случался дважды (отмывка прошла сначала через `suspense:unidentified`, потом
 * через `unclaimed:liability` мимо перечня имён), поэтому читается он из
 * объявления типа, а не переписывается сюда руками — переписанный список
 * разошёлся бы с планом счетов молча.
 */
function accountKinds(accountsSource) {
  const declaration = /export type Account =([\s\S]*?)\n\n/u.exec(accountsSource);
  if (declaration === null) return [];
  return [...declaration[1].matchAll(/readonly kind: '([a-z_]+)'/gu)].map((item) => item[1]);
}

/* ------------------------------------------------------------------ */
/* Коды ошибок и коды инвариантов                                      */
/* ------------------------------------------------------------------ */

/**
 * Соседний код — следующий в **своей группе** реестра.
 *
 * Группа — пространство имён значения (`ledger.entry.*`, `ledger.journal.*`,
 * `ledger.posting.*`, `ledger.settlement.*`, `ledger.invariant.*`), а не
 * комментарий-разделитель, как в комплаенсе: здесь пространство имён и есть
 * объявленная группировка, оно переписано в код каждого значения и не зависит
 * от того, как расставлены комментарии.
 *
 * Код, оказавшийся в своей группе единственным (`ledger.account.*`,
 * `ledger.fee_ceiling.*`), берёт соседа из полного порядка объявления реестра:
 * иначе он не мутировался бы вовсе, то есть выпал бы из прогона тихо — а
 * «тихо выпало из прогона» в этом проекте уже дважды оказывалось дороже, чем
 * менее точная мутация.
 */
function codeNeighbours(sources) {
  const neighbour = new Map();
  for (const [, code] of sources) {
    const declaration = /export const ([A-Za-z][\w]*) = \{([\s\S]*?)\n\} as const;/gu;
    let match = declaration.exec(code);
    while (match !== null) {
      const registry = match[1];
      const members = [...match[2].matchAll(/^ {2}([A-Za-z][\w]*): '([^']+)',$/gmu)].map((item) => [
        item[1],
        item[2],
      ]);
      const groups = new Map();
      for (const [member, value] of members) {
        const namespace = value.split('.')[1] ?? '';
        groups.set(namespace, [...(groups.get(namespace) ?? []), member]);
      }
      const order = members.map(([member]) => member);
      for (const group of groups.values()) {
        const ring = group.length > 1 ? group : order;
        for (const member of group) {
          const position = ring.indexOf(member);
          const next = ring[(position + 1) % ring.length];
          if (next !== member) neighbour.set(`${registry}.${member}`, `${registry}.${next}`);
        }
      }
      match = declaration.exec(code);
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

/**
 * Конец инструкции: точка с запятой на верхнем уровне скобок от `start`.
 *
 * Скобки и точка с запятой считаются **только в коде** — маска `classify`
 * обязательна, а не удобна. Комплаенс обходился без неё случайно: там ни в
 * одном объявлении типа не оказалось комментария с точкой с запятой. В плане
 * счетов учёта такой комментарий есть («…внутри нашего журнала; без этого
 * счёта…»), и разбор без маски обрывал объявление `Account` на середине —
 * половина видов счёта уезжала в каталог как обычные литералы, хотя это чистый
 * тип, стёртый до прогона. Отчёт получил бы полтора десятка мутантов,
 * выживающих по построению.
 */
function statementEnd(code, start, mask) {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    if (mask[index] !== 1) continue;
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
 * каждая строка требует ответа «какого теста не хватает»), а вне каталога.
 *
 * В учёте это не мелочь: план счетов `Account` — размеченное объединение из
 * восемнадцати видов, и без этого исключения отчёт состоял бы из литералов его
 * объявления.
 */
function typeSpans(code, mask) {
  const spans = [];
  const pattern = /^(?:export )?(?:declare )?(type|interface) [A-Za-z]/gmu;
  let match = pattern.exec(code);
  while (match !== null) {
    const start = match.index;
    if (mask[start] !== 1) {
      match = pattern.exec(code);
      continue;
    }
    if (match[1] === 'type') {
      const end = statementEnd(code, start, mask);
      if (end > start) spans.push([start, end]);
    } else {
      let brace = code.indexOf('{', start);
      while (brace >= 0 && mask[brace] !== 1) brace = code.indexOf('{', brace + 1);
      if (brace >= 0) {
        let depth = 0;
        for (let index = brace; index < code.length; index += 1) {
          if (mask[index] !== 1) continue;
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

/**
 * Списки параметров типа: `Map<CurrencyCode, bigint>`, `Money<C>`,
 * `Readonly<Record<AccountKind, AccountNature>>`.
 *
 * Внутри угловых скобок живут **только типы**, а типы стёрты до прогона. Мутация
 * там не меняет поведения ни при каких входных данных — такой мутант выживает
 * всегда. Место таким мутантам не в списке выживших, где каждая строка требует
 * ответа «какого теста не хватает», а вне каталога.
 *
 * Объявления `type` и `interface` вырезаются отдельно (`typeSpans`); здесь —
 * параметры типа в **значимых** позициях: сигнатурах функций, вызовах и
 * объявлениях переменных.
 *
 * Открывающая скобка распознаётся по отсутствию пробела перед ней: в этом пакете
 * параметр типа пишется вплотную к имени (`new Map<string, bigint>()`), а
 * сравнение — всегда с пробелами (`custodyTotal >= obligationsTotal`). Разбор
 * обрывается на `;`, `(`, `{`, `}` и `=`: если до них закрывающая скобка не
 * встретилась, это было не начало списка параметров, и участок не вырезается.
 */
function typeArgumentSpans(code, mask) {
  const spans = [];
  for (let index = 0; index < code.length; index += 1) {
    if (mask[index] !== 1 || code[index] !== '<') continue;
    if (!isIdentifierChar(code[index - 1])) continue;
    let depth = 0;
    for (let scan = index; scan < code.length; scan += 1) {
      const character = code[scan];
      if (character === '<') depth += 1;
      else if (character === '>') {
        depth -= 1;
        if (depth === 0) {
          spans.push([index, scan + 1]);
          index = scan;
          break;
        }
      } else if (
        character === ';' ||
        character === '(' ||
        character === '{' ||
        character === '}' ||
        character === '='
      ) {
        break;
      }
    }
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
      // У нуля «на единицу больше» и «обнулить» — одна и та же подмена. Второй
      // экземпляр не добавил бы ни одного различения, а стоил бы полного
      // прогона набора: на сотнях числовых мутаций это минуты впустую.
      const variants =
        bumped === zeroed
          ? [['inc', bumped]]
          : [
              ['inc', bumped],
              ['zero', zeroed],
            ];
      for (const [tag, replacement] of variants) {
        mutants.push({
          operator: 'num',
          file,
          line: lineOf(code, index),
          description: `${literal} → ${replacement}`,
          tag: `${index}-${tag}`,
          apply: (source) => source.slice(0, index) + replacement + source.slice(literalEnd),
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
      at: literal.start,
    });
  }
  return mutants;
}

function codeKeyMutants(file, code, mask, neighbours) {
  const mutants = [];
  const pattern = /\b(LedgerErrorCode|InvariantCode)\.([A-Za-z][\w]*)/gu;
  let match = pattern.exec(code);
  while (match !== null) {
    const start = match.index;
    const neighbour = neighbours.get(`${match[1]}.${match[2]}`);
    if (mask[start] === 1 && neighbour !== undefined && !isIdentifierChar(code[start - 1])) {
      const end = start + match[0].length;
      mutants.push({
        operator: 'key',
        file,
        line: lineOf(code, start),
        description: `${match[1]}.${match[2]} → ${neighbour}`,
        tag: `${start}`,
        apply: (source) => `${source.slice(0, start)}${neighbour}${source.slice(end)}`,
        at: start,
      });
    }
    match = pattern.exec(code);
  }
  return mutants;
}

/**
 * Граница сравнения: `>=` ↔ `>`, `<=` ↔ `<`.
 *
 * Ровно один мутант на место сравнения: значение **на пороге** переходит в
 * другой класс. Это и есть проверка порога как порога, а не как числа: тест,
 * который бьёт по «сильно выше» и «сильно ниже», переживает сдвиг границы на
 * единицу и потому о границе ничего не говорит. В учёте порог почти всегда
 * ноль — покрытие, знак остатка, потолок удержания, — а ноль это и есть та
 * самая граница, на которой стоит вся арифметика пакета.
 *
 * Односимвольные `<` и `>` берутся **только окружённые пробелами**. В этом
 * пакете параметр типа (`Map<CurrencyCode, bigint>`, `Money<C>`) пишется без
 * пробела перед скобкой, а сравнение — всегда с пробелами. Ошибиться здесь
 * дорого: мутация в параметре типа не собирается, а несобравшийся мутант — это
 * не «правило не проверено», это сломанная проверка. Поэтому же несобравшийся
 * мутант получает отдельный исход `broken`, а не тихо считается убитым.
 */
function comparisonMutants(file, code, mask) {
  const mutants = [];
  for (let index = 0; index + 1 < code.length; index += 1) {
    if (mask[index] !== 1) continue;
    const two = code.slice(index, index + 2);
    let from = null;
    let to = null;
    if (two === '>=' || two === '<=') {
      // `=>`, `>>=`, `<<=` сюда не попадают: перед `>=`/`<=` не должно быть
      // символа оператора, а после — знака равенства (`>==` не существует).
      const before = code[index - 1];
      if (before === '=' || before === '<' || before === '>' || before === '!') continue;
      if (code[index + 2] === '=') continue;
      from = two;
      to = two[0];
    } else if (
      (code[index] === '<' || code[index] === '>') &&
      code[index - 1] === ' ' &&
      code[index + 1] === ' '
    ) {
      from = code[index];
      to = `${code[index]}=`;
    }
    if (from === null) continue;
    const start = index;
    const end = index + from.length;
    mutants.push({
      operator: 'cmp',
      file,
      line: lineOf(code, start),
      description: `${from} → ${to}`,
      tag: `${start}`,
      apply: (source) => source.slice(0, start) + to + source.slice(end),
      at: start,
    });
    index = end - 1;
  }
  return mutants;
}

/** Равенство: `===` ↔ `!==`. Виды счетов, коды счетов, владельцы, валюты. */
function equalityMutants(file, code, mask) {
  const mutants = [];
  const pattern = /(?<![=!<>])(===|!==)(?!=)/gu;
  let match = pattern.exec(code);
  while (match !== null) {
    const start = match.index;
    if (mask[start] === 1) {
      const replacement = match[1] === '===' ? '!==' : '===';
      const end = start + 3;
      mutants.push({
        operator: 'eq',
        file,
        line: lineOf(code, start),
        description: `${match[1]} → ${replacement}`,
        tag: `${start}`,
        apply: (source) => source.slice(0, start) + replacement + source.slice(end),
        at: start,
      });
    }
    match = pattern.exec(code);
  }
  return mutants;
}

/**
 * Логика: `&&` ↔ `||`.
 *
 * Условие из нескольких конъюнктов — обычное место, где лишний конъюнкт никто
 * не проверяет: сверка подтверждения сторон (`trancheSettlement`) сравнивает
 * пять полей подряд, и набор, бьющий по одному, ничего не говорит про
 * остальные четыре.
 */
function logicMutants(file, code, mask) {
  const mutants = [];
  const pattern = /(&&|\|\|)/gu;
  let match = pattern.exec(code);
  while (match !== null) {
    const start = match.index;
    if (mask[start] === 1) {
      const replacement = match[1] === '&&' ? '||' : '&&';
      const end = start + 2;
      mutants.push({
        operator: 'logic',
        file,
        line: lineOf(code, start),
        description: `${match[1]} → ${replacement}`,
        tag: `${start}`,
        apply: (source) => source.slice(0, start) + replacement + source.slice(end),
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
 * проверяет. Условный вызов (`if (…) violations.push(…);`) удаляется вместе с
 * условием — поведение то же: вызова не происходит никогда.
 *
 * Главная цель оператора в этом пакете — одиннадцать `assert…` подряд в
 * `createJournalEntry` и восемь в `appendEntry`: снесённая проверка остаётся в
 * файле и читается как работающая.
 */
function deletionMutants(file, code, mask) {
  const mutants = [];
  const lines = code.split('\n');
  let offset = 0;
  for (let number = 0; number < lines.length; number += 1) {
    const line = lines[number];
    const callMatch = /^(\s*)(?:if \(.+\) )?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/u.exec(line);
    const throwMatch = /^(\s*)throw new [A-Za-z_$][\w$]*\(/u.exec(line);
    const chosen = throwMatch ?? callMatch;
    if (chosen !== null && mask[offset + chosen[1].length] === 1) {
      const start = offset + chosen[1].length;
      const end = statementEnd(code, start, mask);
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
          at: start,
        });
      }
    }
    offset += line.length + 1;
  }
  return mutants;
}

/* ------------------------------------------------------------------ */
/* Объявленные эквивалентные мутации                                   */
/* ------------------------------------------------------------------ */

/**
 * Мутации, которые **не могут** быть убиты, потому что не меняют поведения ни
 * при каких входных данных.
 *
 * ## Зачем это список, а не абзац в отчёте
 *
 * Мутант, выживший потому, что тестов не хватает, и мутант, выживший потому,
 * что менять там нечего, — разные факты, и смешивать их нельзя. Пока они в
 * одном списке, прогон заканчивается ненулевым кодом всегда, а список выживших
 * приходится каждый раз перечитывать заново, вспоминая, какие двадцать строк
 * уже разбирали. Проверку, которая всегда красная, перестают запускать.
 *
 * Поэтому вывод разбора записан здесь и **проверяется**:
 *
 *  · объявление, которому не соответствует ни одна мутация каталога, — отказ:
 *    код изменился, а разбор остался от прежнего;
 *  · объявленная эквивалентной мутация, которую **убил** набор, — тоже отказ:
 *    значит, поведение всё-таки меняется, и рассуждение ниже неверно.
 *
 * ## Ключ
 *
 * Файл, **функция**, оператор, **текст строки**, позиция подмены внутри строки и
 * описание подмены (`equivalenceKey`). Не смещение в файле: смещение сдвигает
 * любая правка выше по файлу, и список протухал бы от добавленного комментария.
 * Почему в ключе стоит имя функции — там же: без него одно объявление накрыло
 * две одинаковые строки в разных функциях `journal.ts`, из которых равносильна
 * только одна.
 */
export const EQUIVALENT_MUTANTS = Object.freeze([
  {
    file: 'balance.ts',
    scope: 'accountBalances',
    operator: 'cmp',
    sourceLine: '.sort((left, right) => (left.accountCode < right.accountCode ? -1 : 1));',
    column: 41,
    description: '< → <=',
    reason:
      'Компаратор сортировки читает ключи `Map`, а они уникальны по построению: пары равных ' +
      'ключей у него не бывает, и `<` от `<=` отличается только на ней. Порядок выдачи от ' +
      'подмены не меняется ни на одном журнале.',
  },
  {
    file: 'balance.ts',
    scope: 'coverageByTranche',
    operator: 'cmp',
    sourceLine: 'const sortedRefs = [...refs.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1));',
    column: 70,
    description: '< → <=',
    reason:
      'Компаратор сортировки читает ключи `Map`, а они уникальны по построению: пары равных ' +
      'ключей у него не бывает, и `<` от `<=` отличается только на ней. Порядок выдачи от ' +
      'подмены не меняется ни на одном журнале.',
  },
  {
    file: 'balance.ts',
    scope: 'coverageByFundsSource',
    operator: 'cmp',
    sourceLine: 'left[0] < right[0] ? -1 : 1,',
    column: 8,
    description: '< → <=',
    reason:
      'Компаратор сортировки читает ключи `Map`, а они уникальны по построению: пары равных ' +
      'ключей у него не бывает, и `<` от `<=` отличается только на ней. Порядок выдачи от ' +
      'подмены не меняется ни на одном журнале.',
  },
  {
    file: 'balance.ts',
    scope: 'byCurrencyList',
    operator: 'cmp',
    sourceLine: '.sort((left, right) => (left[0] < right[0] ? -1 : 1))',
    column: 32,
    description: '< → <=',
    reason:
      'Компаратор сортировки читает ключи `Map`, а они уникальны по построению: пары равных ' +
      'ключей у него не бывает, и `<` от `<=` отличается только на ней. Порядок выдачи от ' +
      'подмены не меняется ни на одном журнале.',
  },
  {
    file: 'balance.ts',
    scope: 'clientStatement',
    operator: 'cmp',
    sourceLine: 'left[0] < right[0] ? -1 : 1,',
    column: 8,
    description: '< → <=',
    reason:
      'Компаратор сортировки читает ключи `Map`, а они уникальны по построению: пары равных ' +
      'ключей у него не бывает, и `<` от `<=` отличается только на ней. Порядок выдачи от ' +
      'подмены не меняется ни на одном журнале.',
  },
  {
    file: 'balance.ts',
    scope: 'feePositions',
    operator: 'cmp',
    sourceLine: '.sort((left, right) => (left[0] < right[0] ? -1 : 1))',
    column: 32,
    description: '< → <=',
    reason:
      'Компаратор сортировки читает ключи `Map`, а они уникальны по построению: пары равных ' +
      'ключей у него не бывает, и `<` от `<=` отличается только на ней. Порядок выдачи от ' +
      'подмены не меняется ни на одном журнале.',
  },
  {
    file: 'balance.ts',
    scope: 'openFxPositions',
    operator: 'cmp',
    sourceLine: '.sort((left, right) => (left[0] < right[0] ? -1 : 1))',
    column: 32,
    description: '< → <=',
    reason:
      'Компаратор сортировки читает ключи `Map`, а они уникальны по построению: пары равных ' +
      'ключей у него не бывает, и `<` от `<=` отличается только на ней. Порядок выдачи от ' +
      'подмены не меняется ни на одном журнале.',
  },
  {
    file: 'balance.ts',
    scope: 'openFeeReceivables',
    operator: 'cmp',
    sourceLine: '.sort((left, right) => (left[0] < right[0] ? -1 : 1))',
    column: 32,
    description: '< → <=',
    reason:
      'Компаратор сортировки читает ключи `Map`, а они уникальны по построению: пары равных ' +
      'ключей у него не бывает, и `<` от `<=` отличается только на ней. Порядок выдачи от ' +
      'подмены не меняется ни на одном журнале.',
  },
  {
    file: 'balance.ts',
    scope: 'openTransitPositions',
    operator: 'cmp',
    sourceLine: '.sort((left, right) => (left[0] < right[0] ? -1 : 1))',
    column: 32,
    description: '< → <=',
    reason:
      'Компаратор сортировки читает ключи `Map`, а они уникальны по построению: пары равных ' +
      'ключей у него не бывает, и `<` от `<=` отличается только на ней. Порядок выдачи от ' +
      'подмены не меняется ни на одном журнале.',
  },
  {
    file: 'entries.ts',
    scope: 'withToken',
    operator: 'bool',
    sourceLine: 'descriptors[key] = { value, enumerable: false, writable: false, configurable: false };',
    column: 57,
    description: 'false → true',
    reason:
      '`Object.freeze` строкой ниже делает каждое собственное свойство неизменяемым и ' +
      'ненастраиваемым независимо от описателя, поэтому `writable` в нём уже ничего не ' +
      'решает. Различима только `enumerable` — заморозка её не трогает, и её мутант убит ' +
      '(`test/entries-dictionary.test.ts`).',
  },
  {
    file: 'entries.ts',
    scope: 'withToken',
    operator: 'bool',
    sourceLine: 'descriptors[key] = { value, enumerable: false, writable: false, configurable: false };',
    column: 78,
    description: 'false → true',
    reason:
      'То же самое про `configurable`: заморозка перекрывает описатель.',
  },
  {
    file: 'entries.ts',
    scope: 'settleTrancheToClientAccount',
    operator: 'call',
    sourceLine: 'assertSameCurrency(gross, withheld.accruedFee);',
    column: 0,
    description: 'удалено: assertSameCurrency(gross, withheld.accruedFee);…',
    reason:
      'Следом считается `subtract(gross, fee)`, а `subtract` сам зовёт `assertSameCurrency` с ' +
      'теми же аргументами в том же порядке: без этой строки отказ тот же самый — ' +
      '`money.currency_mismatch` с теми же деталями. Строка стоит ради того, чтобы условие ' +
      'читалось в словаре записей, а не выпадало из библиотеки сумм.',
  },
  {
    file: 'entries.ts',
    scope: 'absorbShortfall',
    operator: 'call',
    sourceLine: 'assertSameCurrency(received, shortfall);',
    column: 0,
    description: 'удалено: assertSameCurrency(received, shortfall);…',
    reason:
      'То же самое: ниже стоит `add(received, shortfall)`, и сверку валют делает он.',
  },
  {
    file: 'entries.ts',
    scope: 'feeAccrualFor',
    operator: 'logic',
    sourceLine: 'if (entry.kind === \'correction\' && entry.correctsEntryId !== null) {',
    column: 32,
    description: '&& → ||',
    reason:
      'Вид записи и наличие ссылки связаны конструктором жёстко: исправление без ссылки ' +
      'отвергает `entryCorrectionWithoutReference`, расчёт со ссылкой — ' +
      '`entrySettlementWithReference`. Значит два конъюнкта — одно и то же утверждение, и «и» ' +
      'с «или» на нём совпадают.',
  },
  {
    file: 'entry.ts',
    scope: 'clientAccountFile',
    operator: 'logic',
    sourceLine: 'return \'dealId\' in account && \'trancheId\' in account',
    column: 27,
    description: '&& → ||',
    reason:
      'Ни один вид счёта в плане не несёт `dealId` без `trancheId`: их несёт только ' +
      '`client_locked`, и оба сразу. Условие различает случаи, которых в плане счетов нет.',
  },
  {
    file: 'entry.ts',
    scope: 'postingFile',
    operator: 'str',
    sourceLine: 'if (scope === \'pooled\') return null;',
    column: 14,
    description: '\'pooled\' → \'owner_in_code\'',
    reason:
      'Строкой выше файл для `owner_in_code` уже возвращён, поэтому подмена делает ветку ' +
      'недостижимой, а пуловая проводка уходит на `return posting.attribution`. Отнесение на ' +
      'пуловой проводке запрещено (`assertAttribution`, `postingClientAttributionMismatch`), ' +
      'то есть там всегда `null` — ровно то, что возвращала ветка.',
  },
  {
    file: 'entry.ts',
    scope: 'assertSettlementCeiling',
    operator: 'cmp',
    sourceLine: 'if (withheld <= 0n) continue;',
    column: 13,
    description: '<= → <',
    reason:
      'Различие только при `withheld === 0n`. Тогда `cap` считается от положительного брутто ' +
      'при неотрицательной доле, то есть `cap.minor >= 0n`, и проверка `0n > cap.minor` ложна ' +
      'при любом потолке. Ни одна запись не меняет судьбу.',
  },
  {
    file: 'entry.ts',
    scope: 'clientFileGains',
    operator: 'eq',
    sourceLine: 'if (accountType(account) === \'asset\') {',
    column: 25,
    description: '=== → !==',
    reason:
      'Обе корзины входят в результат с одним знаком: в `custody` кладётся `signed`, в ' +
      '`obligations` — `−signed`, а прирост считается как `custody − obligations`, то есть ' +
      'сумма `signed` по всем проводкам файла. От того, в какую корзину попала проводка, ' +
      'результат не зависит ни при каких данных. Это не пробел в тестах, а инертная развилка ' +
      'в коде — разбор в отчёте по прогону.',
  },
  {
    file: 'entry.ts',
    scope: 'clientFileGains',
    operator: 'str',
    sourceLine: 'if (accountType(account) === \'asset\') {',
    column: 29,
    description: '\'asset\' → \'liability\'',
    reason:
      'То же самое: перестановка проводок между двумя корзинами не меняет их разность.',
  },
  {
    file: 'fee-ceiling.ts',
    scope: 'strictestFeeCeiling',
    operator: 'cmp',
    sourceLine: 'return compareRational(left.maxShare, right.maxShare) <= 0 ? left : right;',
    column: 54,
    description: '<= → <',
    reason:
      'Различие только при равных долях, и тогда возвращаются два структурно равных значения: ' +
      '`rational` сокращает дробь и нормализует знак, поэтому 1/50 и 2/100 — одно значение. ' +
      'Различить стороны можно лишь тождеством объекта, а тождество в величину потолка не ' +
      'входит.',
  },
  {
    file: 'invariants.ts',
    scope: 'latestOccurredAt',
    operator: 'cmp',
    sourceLine: 'if (latest === null || parsed > Date.parse(latest)) latest = entry.occurredAt;',
    column: 30,
    description: '> → >=',
    reason:
      'При равных метках присваивается то же самое значение: `latest` — максимум по времени, ' +
      'и повторное присваивание равного его не меняет.',
  },
  {
    file: 'invariants.ts',
    scope: 'checkLedgerInvariants',
    operator: 'cmp',
    sourceLine: 'if (position.outstanding.minor <= 0n) continue;',
    column: 31,
    description: '<= → <',
    reason:
      'Различие только при нулевом остатке требования, а такой позиции в выдаче ' +
      '`openFeeReceivables` не бывает: ключ, чей итог обнулился, удаляется в конце записи, ' +
      'которая его тронула. Отрицательный остаток обе границы отсекают одинаково.',
  },
  {
    file: 'invariants.ts',
    scope: 'overfundedShortfalls',
    operator: 'cmp',
    sourceLine: 'left[0] < right[0] ? -1 : 1,',
    column: 8,
    description: '< → <=',
    reason:
      'Компаратор сортировки читает ключи `Map`, а они уникальны по построению: пары равных ' +
      'ключей у него не бывает, и `<` от `<=` отличается только на ней. Порядок выдачи от ' +
      'подмены не меняется ни на одном журнале.',
  },
  {
    file: 'journal.ts',
    scope: 'feeRestorableBy',
    operator: 'logic',
    sourceLine: 'if (entry.kind !== \'correction\' || entry.correctsEntryId === null) return new Map();',
    column: 32,
    description: '|| → &&',
    reason:
      'Тот же довод, что и в `entries.ts`: вид записи и наличие ссылки связаны конструктором, ' +
      'поэтому оба условия истинны и ложны одновременно.',
  },
  {
    file: 'journal.ts',
    scope: 'feeRestorableBy',
    operator: 'cmp',
    sourceLine: 'if (net < 0n) restorable.set(key, -net);',
    column: 8,
    description: '< → <=',
    reason:
      'Предел читается ниже как `restorable.get(key) ?? 0n`, поэтому ключ со значением `0n` и ' +
      'отсутствующий ключ дают одно и то же. При `net === 0n` цель требование не двигала, и ' +
      'возвращать по ней нечего в обоих вариантах.',
  },
  {
    file: 'journal.ts',
    scope: 'feeRestorableBy',
    operator: 'logic',
    sourceLine: 'if (existing.kind !== \'correction\' || existing.correctsEntryId !== target.id) continue;',
    column: 35,
    description: '|| → &&',
    reason:
      'Чтобы различить, нужна лежащая в журнале запись-исправление **другой** цели с ' +
      'положительным чистым дебетом требования по тому же траншу. Положительный дебет ' +
      'требования бывает у начисления (второе по траншу запрещает `journalFeeAccruedTwice`) и ' +
      'у реверса расчёта, а реверс по одному расчёту возможен один и его цель — тот самый ' +
      'расчёт. В журнале, собранном `appendEntry`, такой записи нет.',
  },
  {
    file: 'journal.ts',
    scope: 'feeRestorableBy',
    operator: 'cmp',
    sourceLine: 'if (net <= 0n) continue;',
    column: 8,
    description: '<= → <',
    reason:
      'При `net === 0n` из предела вычитается ноль: значение не меняется, меняется лишь ' +
      'наличие ключа, которое читается тем же `?? 0n`.',
  },
  {
    file: 'journal.ts',
    scope: 'feeAccrualTranches',
    operator: 'cmp',
    sourceLine: 'if (total > (allowed > 0n ? allowed : 0n)) accrued.add(key);',
    column: 21,
    description: '> → >=',
    reason:
      'При `allowed === 0n` обе ветки тернарного оператора дают `0n`, и порог сравнения ' +
      '`total` не меняется.',
  },
  {
    file: 'journal.ts',
    scope: 'assertConversionKeyNotReused',
    operator: 'eq',
    sourceLine: '(posting.direction === \'debit\' ? posting.amount.minor : -posting.amount.minor),',
    column: 19,
    description: '=== → !==',
    reason:
      'Эти остатки читаются ровно одним способом — `every(total => total === 0n)`, проверкой ' +
      'плоскости позиции. Обращение знака у всех слагаемых сразу оставляет ноль нулём, ' +
      'поэтому вывод не меняется ни на одном журнале. В сообщение об ошибке эти величины не ' +
      'попадают (в отличие от `netMovements`, где такая же подмена убита).',
  },
  {
    file: 'journal.ts',
    scope: 'assertConversionKeyNotReused',
    operator: 'str',
    sourceLine: '(posting.direction === \'debit\' ? posting.amount.minor : -posting.amount.minor),',
    column: 23,
    description: '\'debit\' → \'credit\'',
    reason:
      'То же самое: подмена стороны обращает знак всех слагаемых сразу, а читается только ' +
      'равенство нулю.',
  },
  {
    file: 'journal.ts',
    scope: 'recognisedShortfallOf',
    operator: 'logic',
    sourceLine: 'if (attribution === null || !isClientRef(attribution)) continue;',
    column: 25,
    description: '|| → &&',
    reason:
      'Единственный вызов `recognisedShortfallOf` получает уже отфильтрованные проводки: ' +
      '`assertShortfallFundingResolves` оставляет только те, у которых отнесение не `null` и ' +
      'указывает на клиента. Проводка с `null` до второй половины условия не доходит.',
  },
  {
    file: 'journal.ts',
    scope: 'assertCorrectionMirrorsTarget',
    operator: 'cmp',
    sourceLine: 'if (moved > 0n === movement.minor > 0n) fail(\'same_direction\');',
    column: 10,
    description: '> → >=',
    reason:
      '`moved === 0n` к этой строке уже отсеяно ветвью `account_not_in_target`, поэтому ' +
      '`moved > 0n` и `moved >= 0n` совпадают.',
  },
  {
    file: 'journal.ts',
    scope: 'assertCorrectionMirrorsTarget',
    operator: 'cmp',
    sourceLine: 'if (moved > 0n === movement.minor > 0n) fail(\'same_direction\');',
    column: 34,
    description: '> → >=',
    reason:
      'То же самое со второй стороны: `movement.minor === 0n` отсеяно в начале цикла — «ноль ' +
      'не движение».',
  },
  {
    file: 'journal.ts',
    scope: 'assertCorrectionMirrorsTarget',
    operator: 'cmp',
    sourceLine: 'if (moved > 0n ? total < -moved : total > -moved) fail(\'exceeds_target\');',
    column: 10,
    description: '> → >=',
    reason:
      'Сторону выбирает знак `moved`, а нулевой `moved` к этой строке не доходит: его ' +
      'отсекает `account_not_in_target`.',
  },
]);

/**
 * Ключ объявления и мутанта: файл, **функция**, оператор, текст строки, позиция
 * подмены внутри строки и описание подмены.
 *
 * Позиция внутри строки нужна там, где на одной строке несколько одинаковых
 * подмен: без неё одно объявление накрывало бы все, то есть объявляло бы
 * эквивалентной в том числе убиваемую мутацию.
 *
 * **Имя функции — правка против стенда комплаенса, и она оплачена ошибкой.**
 * В учёте одно и то же выражение встречается в разных функциях одного файла
 * буквально знак в знак: строка
 * `(posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor)`
 * стоит и в `feeReceivableNet`, и в `assertConversionKeyNotReused`
 * (`journal.ts`), с одинаковым отступом и одинаковой позицией подмены. В первой
 * знак читается величиной требования и подмена убита набором; во второй он
 * читается только равенством нулю и подмена равносильна. Ключ без имени функции
 * накрыл бы обе одним объявлением — то есть объявил бы равносильной убиваемую
 * мутацию. Проверка «объявлено эквивалентным, но набор его убил» это и поймала,
 * ради чего она и написана.
 *
 * Имя функции, а не смещение: смещение сдвигает любая правка выше по файлу, и
 * список протухал бы от добавленного комментария.
 *
 * Позиция считается от начала **обрезанной** строки, поэтому переносы и
 * изменение отступа её не двигают. Одинаковые строки с одинаковой позицией
 * внутри одной функции намеренно делят одно объявление: причина
 * равносильности у них одна.
 */
export function equivalenceKey(item) {
  return `${item.file}::${item.scope}::${item.operator}::${item.sourceLine}::${item.column}::${item.description}`;
}

/**
 * Имя ближайшего объявления `function` выше по файлу — грубая, но
 * детерминированная область видимости. Вложенные стрелочные функции своего
 * имени не получают: их довольно различать по функции, в которой они объявлены.
 */
function enclosingScope(code, offset) {
  const pattern = /^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/gmu;
  let name = '';
  let match = pattern.exec(code);
  while (match !== null && match.index < offset) {
    name = match[1];
    match = pattern.exec(code);
  }
  return name;
}

/* ------------------------------------------------------------------ */
/* Каталог                                                             */
/* ------------------------------------------------------------------ */

/**
 * Исходники пакета, включая подкаталоги.
 *
 * Обход рекурсивный, а не по одному каталогу. Сегодня `src` учёта плоский, и
 * соблазн упростить велик — но ровно этот дефект уже случался дважды: первая
 * версия прогона guard'ов в `packages/e2e` искала перечень по одному
 * захардкоженному месту, треть словаря оставалась непроверенной, а отчёт был
 * зелёный; в комплаенсе плоское чтение оставило бы вне прогона семь детекторов
 * из восьми. Каталог, который перестаёт видеть файл в день его переезда в
 * подкаталог, — это зелёный отчёт о непроверенном коде.
 */
function readSources(directory = SRC_DIR, prefix = '') {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const sources = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      sources.push(...readSources(join(directory, entry.name), relative));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    sources.push([relative, readFileSync(join(directory, entry.name), 'utf8')]);
  }
  return sources;
}

/**
 * Полный каталог мутаций. Порядок детерминирован: путь файла, затем позиция.
 * Идентификатор — `<файл>::<оператор>::<метка>`; по нему конфигурация vitest
 * находит ту же самую мутацию, что и скрипт.
 */
export function buildCatalogue() {
  const sources = readSources();
  const { list: declaredList, declarationSpans } = declaredVocabularies(sources);
  const accountsSource = sources.find(([name]) => name === 'accounts.ts');
  if (accountsSource === undefined) throw new Error('sdelka.mutation.accounts_missing');
  const kinds = accountKinds(accountsSource[1]);
  if (kinds.length < 2) throw new Error('sdelka.mutation.account_kinds_missing');
  const vocabularies = [...declaredList, kinds, ...EXTERNAL_VOCABULARIES];
  const neighbours = codeNeighbours(sources);
  if (neighbours.size === 0) throw new Error('sdelka.mutation.code_registries_missing');

  const mutants = [];
  for (const [name, code] of sources) {
    const { mask, strings } = classify(code);
    const spans = declarationSpans.get(name) ?? [];
    const types = [...typeSpans(code, mask), ...typeArgumentSpans(code, mask)];
    const forFile = [
      ...numberMutants(name, code, mask),
      ...booleanMutants(name, code, mask),
      ...stringMutants(name, code, strings, vocabularies, spans),
      ...codeKeyMutants(name, code, mask, neighbours),
      ...comparisonMutants(name, code, mask),
      ...equalityMutants(name, code, mask),
      ...logicMutants(name, code, mask),
      ...deletionMutants(name, code, mask),
    ];
    const runtime = forFile.filter(
      (mutant) => !types.some(([from, to]) => mutant.at >= from && mutant.at < to),
    );
    runtime.sort((left, right) => left.at - right.at);
    for (const mutant of runtime) {
      // Текст строки нужен для сверки с объявлениями эквивалентных мутаций:
      // ключ по смещению протухал бы от любой правки выше по файлу.
      const lineStart = code.lastIndexOf('\n', mutant.at - 1) + 1;
      const lineEnd = code.indexOf('\n', mutant.at);
      const rawLine = code.slice(lineStart, lineEnd < 0 ? code.length : lineEnd);
      const sourceLine = rawLine.trim();
      const column = mutant.at - lineStart - (rawLine.length - rawLine.trimStart().length);
      mutants.push({
        ...mutant,
        sourceLine,
        column,
        scope: enclosingScope(code, mutant.at),
        id: `${name}::${mutant.operator}::${mutant.tag}`,
      });
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
 * Подмена исходника. Отсутствие изменения — отказ: мутация, которая ничего не
 * изменила, отчиталась бы об успехе прогона, то есть солгала бы.
 */
export function mutateSource(code, mutant) {
  const mutated = mutant.apply(code);
  if (mutated === code) throw new Error(`sdelka.mutation.no_change:${mutant.id}`);
  return mutated;
}

export function targetFile(mutant) {
  return join(SRC_DIR, mutant.file);
}
