/**
 * Каталог мутаций комплаенса: перечисление целей и подмена одной из них.
 *
 * ## Зачем отдельный модуль
 *
 * Прогон состоит из двух половин в разных процессах: скрипт
 * (`compliance-mutation.mjs`) перечисляет мутации и запускает наборы,
 * конфигурация vitest (`mutation.vitest.config.ts`) подменяет исходник внутри
 * прогона. Обе обязаны отвечать на вопрос «какие есть мутации и что делает вот
 * эта» **одинаково** — иначе скрипт отчитается о цели, которую прогон не
 * тронул, и это будет выглядеть как зелёный результат. Ответ здесь один.
 *
 * Форма взята с приёма (`packages/intake/scripts/intake-mutants.mjs`), но
 * набор целей другой: комплаенс — это пакет **политических констант**, а не
 * расчётов. Что мутируется и почему:
 *
 *  1. **Числа политики и порогов** (`num`). Пороги скрининга и сверки
 *     собственника, порог отсева кандидата, срок белого списка, доли
 *     концентрации, окна и пороги дробления и перепродажи, ступени эскалации
 *     очереди, веса ансамбля сопоставления имён, порог владения 50%, срок
 *     работы от имени клиента. Каждое из этих чисел — решение о риске: набор,
 *     не заметивший смены `8_000` на `8_001`, не проверяет порог, он проверяет,
 *     что функция что-то вернула.
 *  2. **Ключ причины на соседний по группе** (`key`). Оператор действует по
 *     названной причине: «совпадение подтверждено» и «кандидат ниже порога» —
 *     разные действия. Тест, проверяющий только исход, подмену причины
 *     пропускает целиком. Сосед берётся из **своей** группы реестра `keys.ts`:
 *     подмена на причину из другой группы отличима почти любым утверждением, а
 *     подмена на соседа — ровно та ошибка, которую делает человек при правке.
 *  3. **Границы сравнения** (`cmp`). `>=` → `>` и `<=` → `<` (и обратно для
 *     строгих): значение **ровно на пороге** меняет класс. Порог, у которого не
 *     проверена его собственная граница, задан с точностью до единицы.
 *  4. **Равенство и логика** (`eq`, `logic`). `===` ↔ `!==`, `&&` ↔ `||`:
 *     конъюнкт, который никто не проверяет, — это условие, которое можно снести
 *     (например, сверка версии записи перечня в `whitelistCovers`).
 *  5. **Удаление вызова и `throw`** (`call`, `throw`). Проверка, вызов которой
 *     снесён, остаётся в файле и читается как работающая.
 *  6. **Значение закрытого перечня на соседа** (`str`) и **переворот флага**
 *     (`bool`): исход в тотальных таблицах (`BASE_OUTCOME`, `SEVERITY`), статус
 *     реквизитов, перечень санкционных источников, валюта ранжирования.
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
export const MUTATION_ENV = 'SDELKA_MUTATE_COMPLIANCE';

/** Метка в потоке ошибок: подмена дошла до исходника. См. `compliance-mutation.mjs`. */
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
 * политики — не константа политики, а часть проверки формата, а `[0-9a-f]{64}`
 * в `pii.ts` — длина хеша, не порог.
 *
 * Шаблонная строка разбирается наивно, как одна строка целиком: подстановки
 * внутри шаблонов пакета — идентификаторы, мутировать там нечего.
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
  // `BeneficiaryStatus` (`@sdelka/domain`) — статус реквизитов выплаты. Здесь он
  // решается (`verifyBeneficiaryHolder`), а хранится и охраняется в домене.
  ['draft', 'name_consistent', 'verified', 'blocked'],
  // `CurrencyCode` (`@sdelka/money`) — валюта порога дробления и ранжирования очереди.
  ['GEL', 'USD', 'EUR', 'JPY'],
  // Коды стран, встречающиеся в политике и в скрининге: высокорисковые
  // юрисдикции и грузинская оговорка. Не перечисление в коде — но закрытый
  // список тех, что политика называет по имени.
  ['GE', 'RU', 'BY'],
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
 * Группы заданы в реестре комментариями-разделителями `/* --- … --- *\/`.
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
 * каждая строка требует ответа «какого теста не хватает»), а вне каталога.
 *
 * В комплаенсе это не мелочь: разметённые объединения (`PayerRelationship`,
 * `PayerOrigin`, `CounterpartyRelation`, `BeneficiaryEffect`) держат десятки
 * строковых литералов, и без этого исключения отчёт состоял бы из них.
 */
function typeSpans(code) {
  const spans = [];
  const pattern = /^(?:export )?(?:declare )?(type|interface) [A-Za-z]/gmu;
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

/**
 * Списки параметров типа: `Authority<'read_beneficiary'>`, `decision<'clear'>(`,
 * `Readonly<Record<DetectorOutcome, ReasonKey>>`.
 *
 * Внутри угловых скобок живут **только типы**, а типы стёрты до прогона. Мутация
 * там не меняет поведения ни при каких входных данных — такой мутант выживает
 * всегда. Первый прогон это и показал: `readBeneficiary(state, _authority:
 * Authority<'read_beneficiary'>)` выдал «выжил», хотя проверять там нечего;
 * полномочие в этой позиции проверяет компилятор, а не тест. Место таким
 * мутантам не в списке выживших, где каждая строка требует ответа «какого теста
 * не хватает», а вне каталога.
 *
 * Объявления `type` и `interface` вырезаются отдельно (`typeSpans`); здесь —
 * параметры типа в **значимых** позициях: сигнатурах функций и вызовах.
 *
 * Открывающая скобка распознаётся по отсутствию пробела перед ней: в этом пакете
 * параметр типа пишется вплотную к имени (`decision<DetectorOutcome>(`), а
 * сравнение — всегда с пробелами (`age >= threshold`). Разбор обрывается на
 * `;`, `(`, `{`, `}` и `=`: если до них закрывающая скобка не встретилась, это
 * было не начало списка параметров, и участок не вырезается.
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
      // прогона набора: на четырёх сотнях числовых мутаций это минуты впустую.
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

function reasonKeyMutants(file, code, mask, neighbours) {
  const mutants = [];
  const pattern = /REASON_KEYS\.([A-Za-z][\w]*)/gu;
  let match = pattern.exec(code);
  while (match !== null) {
    const start = match.index;
    const neighbour = neighbours.get(match[1]);
    if (mask[start] === 1 && neighbour !== undefined && !isIdentifierChar(code[start - 1])) {
      const end = start + match[0].length;
      mutants.push({
        operator: 'key',
        file,
        line: lineOf(code, start),
        description: `${match[1]} → ${neighbour}`,
        tag: `${start}`,
        apply: (source) =>
          `${source.slice(0, start)}REASON_KEYS.${neighbour}${source.slice(end)}`,
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
 * единицу и потому о границе ничего не говорит.
 *
 * Односимвольные `<` и `>` берутся **только окружённые пробелами**. В этом
 * пакете параметр типа (`Record<DetectorOutcome, number>`, `decision<…>(`,
 * `Result<A, B>`) пишется без пробела перед скобкой, а сравнение — всегда с
 * пробелами. Ошибиться здесь дорого: мутация в параметре типа не собирается, а
 * несобравшийся мутант — это не «правило не проверено», это сломанная проверка.
 * Поэтому же несобравшийся мутант получает отдельный исход `broken`, а не
 * тихо считается убитым.
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

/** Равенство: `===` ↔ `!==`. Ключи личности, версии записей перечня, валюты. */
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
 * не проверяет: `whitelistCovers` сверяет четыре поля и срок, и набор, бьющий
 * по одному, ничего не говорит про остальные четыре.
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
 * Файл, оператор, **текст строки** и описание подмены. Не смещение в файле:
 * смещение сдвигает любая правка выше по файлу, и список протухал бы от
 * добавленного комментария. Одно объявление покрывает все совпадающие места —
 * в `names.ts` два одинаковых заголовка цикла эквивалентны по одной причине.
 */
export const EQUIVALENT_MUTANTS = Object.freeze([
  {
    file: 'concentration.ts',
    operator: 'cmp',
    sourceLine: 'return excess > 0n ? excess : 0n;',
    column: 14,
    description: '> → >=',
    reason:
      'Обе ветки при равенстве дают один и тот же ноль: `excess >= 0n ? excess : 0n` при ' +
      '`excess === 0n` возвращает тот же `0n`. Граница здесь не решает ничего.',
  },
  {
    file: 'decision.ts',
    operator: 'cmp',
    sourceLine: 'if (SEVERITY[outcome] > SEVERITY[worst]) worst = outcome;',
    column: 22,
    description: '> → >=',
    reason:
      'Тяжесть — взаимно однозначное соответствие исходу: равная тяжесть означает тот же ' +
      'самый исход, и присваивание становится тождественным. Сводный исход не меняется.',
  },
  {
    file: 'detectors/linkage.ts',
    operator: 'cmp',
    sourceLine: 'return left < right ? `${left}|${right}` : `${right}|${left}`;',
    column: 12,
    description: '< → <=',
    reason:
      'Ключ пары нужен симметричным. При совпадении идентификаторов обе ветки собирают ' +
      'одну и ту же строку, поэтому сторона сравнения на результате не сказывается.',
  },
  {
    file: 'detectors/linkage.ts',
    operator: 'cmp',
    sourceLine: 'for (let i = 0; i < facts.parties.length; i += 1) {',
    column: 18,
    description: '< → <=',
    reason:
      'Лишний шаг цикла не даёт ни одной пары: внутренний цикл начинается с `i + 1` и при ' +
      '`i === length` не выполняется ни разу, а `left` на этом шаге не определён и ' +
      'отсекается проверкой ниже.',
  },
  {
    file: 'detectors/linkage.ts',
    operator: 'cmp',
    sourceLine: 'for (let j = i + 1; j < facts.parties.length; j += 1) {',
    column: 22,
    description: '< → <=',
    reason:
      'Лишний шаг берёт `facts.parties[length]` — `undefined`, и пара отсекается проверкой ' +
      '`right === undefined` следующей же строкой.',
  },
  {
    file: 'detectors/linkage.ts',
    operator: 'logic',
    sourceLine: 'if (left === undefined || right === undefined) continue;',
    column: 23,
    description: '|| → &&',
    reason:
      'Проверка стоит ради `noUncheckedIndexedAccess`: при верных границах циклов ни один ' +
      'из двух элементов не бывает `undefined`, поэтому и `||`, и `&&` дают ложь всегда.',
  },
  {
    file: 'detectors/price.ts',
    operator: 'cmp',
    sourceLine: 'return value < 0n ? -value : value;',
    column: 13,
    description: '< → <=',
    reason: 'Модуль нуля: `-0n` и `0n` — одно и то же значение `BigInt`.',
  },
  {
    file: 'detectors/price.ts',
    operator: 'cmp',
    sourceLine:
      'deltaMinor < 0n ? REASON_KEYS.priceBelowContract : REASON_KEYS.priceAboveContract;',
    column: 11,
    description: '< → <=',
    reason:
      'До выбора направления расхождения нулевая разница уже возвращена как «совпадает» ' +
      '(`deltaMinor === 0n` в условии выше), поэтому здесь `deltaMinor` заведомо не ноль.',
  },
  {
    file: 'detectors/structuring.ts',
    operator: 'cmp',
    sourceLine: 'for (let end = 0; end < sorted.length; end += 1) {',
    column: 22,
    description: '< → <=',
    reason:
      'Лишний шаг берёт `sorted[end]` за концом массива и отсекается проверкой ' +
      '`if (last === undefined) continue;` первой же строкой тела.',
  },
  {
    file: 'detectors/structuring.ts',
    operator: 'cmp',
    sourceLine: 'while (start <= end) {',
    column: 13,
    description: '<= → <',
    reason:
      'Шаг `start === end` — это окно из одного платежа: разница его времени с самим собой ' +
      'равна нулю, ноль не больше окна, и цикл всё равно прерывается на первой же проверке. ' +
      'Ни `start`, ни границы окна не меняются.',
  },
  {
    file: 'names.ts',
    operator: 'logic',
    sourceLine: "if (left === '' || right === '') return 0;",
    column: 16,
    description: '|| → &&',
    reason:
      'Ранний ноль для одной пустой стороны дублирует то, что считается ниже: пустая ' +
      'сторона не даёт ни одного совпадения знаков, и `if (matches === 0) return 0;` ' +
      'возвращает тот же ноль. Строка — предохранитель, а не развилка; выбросить её ' +
      'значило бы положиться на другой предохранитель, поэтому она остаётся.',
  },
  {
    file: 'names.ts',
    operator: 'cmp',
    sourceLine: 'for (let i = 0; i < left.length; i += 1) {',
    column: 18,
    description: '< → <=',
    reason:
      'Оба цикла Джаро (набор совпадений и подсчёт перестановок) на лишнем шаге читают ' +
      '`left[length]` — `undefined`. Совпасть со знаком строки он не может, а в подсчёте ' +
      'перестановок отсекается проверкой `leftMatched[i] !== true`.',
  },
  {
    file: 'names.ts',
    operator: 'cmp',
    sourceLine:
      "while (prefix < 4 && prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {",
    column: 28,
    description: '< → <=',
    reason:
      'Граница длины левой формы выйти за предел не даёт: пройти дальше можно только когда ' +
      '**обе** стороны кончились одновременно (иначе один из знаков определён, а второй ' +
      'нет, и сравнение ложно), а это значит, что формы совпали целиком. Тогда Джаро равен ' +
      'десяти тысячам, и надбавка Винклера, сколько бы знаков префикса ни насчитали, равна ' +
      'нулю. Предел самого префикса (`prefix < 4`) — не эта мутация: он проверяется числом ' +
      'в `names.test.ts` и убивается.',
  },
  {
    file: 'names.ts',
    operator: 'cmp',
    sourceLine:
      "while (prefix < 4 && prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {",
    column: 52,
    description: '< → <=',
    reason: 'То же самое для границы длины правой формы.',
  },
  {
    file: 'names.ts',
    operator: 'bool',
    sourceLine: 'let bestExactInSourceAlphabet = false;',
    column: 32,
    description: 'false → true',
    reason:
      'Начальное значение переписывается на первой же паре: балл не бывает отрицательным, ' +
      'а `bestScore` начинается с −1, поэтому первая пара всегда «лучше» и присваивает ' +
      'признак заново. До второй пары исходное значение не доживает.',
  },
  {
    file: 'queue.ts',
    operator: 'cmp',
    sourceLine: 'if (leftRank !== rightRank) return rightRank > leftRank ? 1 : -1;',
    column: 45,
    description: '> → >=',
    reason:
      'Сравнение сумм выполняется только при `leftRank !== rightRank`: равенство до него ' +
      'не доходит, и сторона границы ни на что не влияет.',
  },
  {
    file: 'queue.ts',
    operator: 'cmp',
    sourceLine:
      'return left.task.taskId < right.task.taskId ? -1 : left.task.taskId > right.task.taskId ? 1 : 0;',
    column: 24,
    description: '< → <=',
    reason:
      'Различие возникает только у двух задач с **одинаковым** идентификатором. Такой пары ' +
      'в очереди не бывает: идентификатор задачи уникален, и порядок двух записей с одним ' +
      'идентификатором ничего не значит — различить их в выводе всё равно нечем.',
  },
  {
    file: 'queue.ts',
    operator: 'cmp',
    sourceLine:
      'return left.task.taskId < right.task.taskId ? -1 : left.task.taskId > right.task.taskId ? 1 : 0;',
    column: 68,
    description: '> → >=',
    reason:
      'То же самое со второй стороны: ветка достижима лишь при равных идентификаторах, ' +
      'которых в очереди не бывает.',
  },
  {
    file: 'queue.ts',
    operator: 'cmp',
    sourceLine: 'if (oldest === null || age > oldest) oldest = age;',
    column: 27,
    description: '> → >=',
    reason:
      'При равенстве присваивается то же самое число: метрика — максимум возраста, и ' +
      'повторное присваивание равного значения его не меняет.',
  },
]);

/**
 * Ключ объявления и мутанта: файл, оператор, текст строки, позиция подмены
 * внутри строки и описание подмены.
 *
 * Позиция внутри строки нужна там, где на одной строке несколько одинаковых
 * подмен: в условии Винклера три сравнения `<` подряд, и одно из них — предел
 * длины префикса, который набор как раз проверяет числом. Без позиции одно
 * объявление накрывало бы все три, то есть объявляло бы эквивалентной в том
 * числе убиваемую мутацию. Первая версия списка так и сделала, и прогон это
 * поймал сам — ради этого проверка «объявлено эквивалентным, но убито» и
 * написана.
 *
 * Позиция считается от начала **обрезанной** строки, поэтому переносы и
 * изменение отступа её не двигают. Одинаковые строки с одинаковой позицией
 * (два одинаковых заголовка цикла в `names.ts`) намеренно делят одно
 * объявление: причина эквивалентности у них одна.
 */
export function equivalenceKey(item) {
  return `${item.file}::${item.operator}::${item.sourceLine}::${item.column}::${item.description}`;
}

/* ------------------------------------------------------------------ */
/* Каталог                                                             */
/* ------------------------------------------------------------------ */

/**
 * Исходники пакета, включая подкаталоги.
 *
 * Обход рекурсивный, а не по одному каталогу: семь из восьми детекторов лежат в
 * `src/detectors`, и плоское чтение оставило бы вне прогона именно то, ради
 * чего он написан. Это тот же дефект, что был у первой версии прогона guard'ов
 * в `packages/e2e`: перечень искался по одному захардкоженному месту, треть
 * словаря оставалась непроверенной, а отчёт был зелёный.
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
  const vocabularies = [...declaredList, ...EXTERNAL_VOCABULARIES];
  const keysSource = sources.find(([name]) => name === 'keys.ts');
  if (keysSource === undefined) throw new Error('sdelka.mutation.keys_registry_missing');
  const neighbours = reasonNeighbours(keysSource[1]);
  if (neighbours.size === 0) throw new Error('sdelka.mutation.reason_groups_missing');

  const mutants = [];
  for (const [name, code] of sources) {
    const { mask, strings } = classify(code);
    const spans = declarationSpans.get(name) ?? [];
    const types = [...typeSpans(code), ...typeArgumentSpans(code, mask)];
    const forFile = [
      ...numberMutants(name, code, mask),
      ...booleanMutants(name, code, mask),
      ...stringMutants(name, code, strings, vocabularies, spans),
      ...(name === 'keys.ts' ? [] : reasonKeyMutants(name, code, mask, neighbours)),
      ...comparisonMutants(name, code, mask),
      ...equalityMutants(name, code, mask),
      ...logicMutants(name, code, mask),
      ...deletionMutants(name, code),
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
