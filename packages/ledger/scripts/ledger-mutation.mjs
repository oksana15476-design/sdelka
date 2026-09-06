#!/usr/bin/env node
/**
 * Мутационный прогон пакета учёта.
 *
 * ## Зачем
 *
 * В журнале проводок живут красные линии №1–№4, и ни одна из них не высказана
 * словами: они высказаны **знаком, границей и стороной проводки**. Сумма
 * проводок равна нулю — это `total !== 0n`; комиссия не задерживается на
 * номинальном счёте — это `moved < recognised`; покрытие — это
 * `custody >= obligations`; целые минорные единицы — это `0n` вместо `0`.
 * Подмена в любом из этих мест не ломает ни один сценарий: запись по-прежнему
 * собирается, отчёт по-прежнему возвращает число. Меняется только то, какое
 * именно число он возвращает и какую запись пропускает.
 *
 * Двести тестов пакета — это утверждение о том, что такие подмены кто-то
 * заметит. Проверить утверждение можно единственным способом: по очереди
 * испортить каждую величину, каждую границу сравнения, каждую сторону проводки
 * и каждый код ошибки и посмотреть, заметит ли набор. Здесь это команда,
 * которая заканчивается ненулевым кодом, а не намерение провести проверку
 * однажды.
 *
 * Классы мутаций и их обоснование — в `ledger-mutants.mjs`.
 *
 * ## Три исхода, а не два
 *
 *  · **убит** — набор упал: величина или причина кем-то проверяется;
 *  · **выжил** — набор зелёный: величину можно менять, и никто не заметит;
 *  · **сломан** — подмена не дошла до исходника (модуль не импортирован ни одним
 *    набором, каталог рассинхронизирован с текстом, подмена не собирается).
 *    Отдельный исход обязателен: без него сломанная подмена читается как
 *    «выжил», то есть как отсутствие тестов, и уводит работу не туда.
 *
 * ## Дерево не меняется
 *
 * Скрипт ничего не пишет в `src`: подмена живёт в `transform` конфигурации
 * vitest и существует в памяти процесса. Утверждение проверяется, а не
 * декларируется — отпечаток файлов пакета снимается до и после прогона,
 * расхождение означает отказ с ненулевым кодом (см. `treeFingerprint`).
 *
 * ## Как запускать
 *
 *     pnpm --filter @sdelka/ledger mutation
 *     pnpm --filter @sdelka/ledger mutation -- --operator=cmp --file=balance.ts
 *     pnpm --filter @sdelka/ledger mutation -- --file=entry.ts
 *     pnpm --filter @sdelka/ledger mutation -- --list
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EQUIVALENT_MUTANTS,
  PACKAGE_ROOT,
  REPO_ROOT,
  buildCatalogue,
  equivalenceKey,
} from './ledger-mutants.mjs';

/**
 * Потолок на одну мутацию по умолчанию (`--timeout=<секунды>` его меняет).
 *
 * Обычная мутация укладывается в секунды, вечный цикл — никогда. Потолок высок
 * намеренно: на занятой машине прогон замедляется в разы, а срабатывание
 * потолка засчитывает мутанта убитым — то есть низкий потолок покупает скорость
 * ценой ложного «убит», и цена эта — неверный отчёт.
 */
const RUN_TIMEOUT_MS = 180_000;

function parseArguments(argv) {
  const options = {
    operator: null,
    file: null,
    list: false,
    concurrency: 2,
    only: null,
    ids: null,
    timeout: RUN_TIMEOUT_MS,
  };
  for (const argument of argv) {
    // Голый `--` приходит от pnpm: документированный вызов
    // `pnpm --filter @sdelka/ledger mutation -- --list` передаёт разделитель
    // скрипту как обычный аргумент. Отказ на нём означал бы, что команда из
    // собственной документации не работает.
    if (argument === '--') continue;
    const match = /^--([a-z]+)(?:=(.*))?$/u.exec(argument);
    if (match === null) throw new Error(`ledger.mutation.bad_argument:${argument}`);
    const [, name, value] = match;
    if (name === 'list') options.list = true;
    else if (name === 'operator') options.operator = value;
    else if (name === 'file') options.file = value;
    else if (name === 'only') options.only = value;
    else if (name === 'concurrency') options.concurrency = Number(value);
    else if (name === 'ids') options.ids = value;
    else if (name === 'timeout') options.timeout = Number(value) * 1_000;
    else throw new Error(`ledger.mutation.bad_argument:${argument}`);
  }
  return options;
}

/**
 * Отпечаток пакета: путь и содержимое каждого файла `packages/ledger`,
 * который git считает частью проекта. Через git, а не обходом каталогов: так в
 * отпечаток не попадают `node_modules`, а попадает всё, что попадёт в коммит.
 *
 * Отпечаток снимается по **пакету**, а не по всему дереву, и это не послабление.
 * Проверяется утверждение «прогон ничего не пишет в мутируемые исходники»;
 * мутируется только `packages/ledger/src`. Отпечаток всего дерева отвечал бы
 * на другой вопрос — «менял ли кто-нибудь что-нибудь в репозитории за эти
 * минуты», — и в дереве, где параллельно работают другие руки, отвечал бы «да»
 * всегда. Проверка, которая падает по чужой причине, перестаёт что-либо значить
 * уже на второй раз.
 */
function treeFingerprint() {
  const listed = (args) =>
    spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tracked = listed(['ls-files', '-z', '--', 'packages/ledger']);
  const untracked = listed([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    'packages/ledger',
  ]);
  if (tracked.status !== 0 || untracked.status !== 0) {
    throw new Error('ledger.mutation.git_failed');
  }
  const paths = [...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')]
    .filter((item) => item.length > 0)
    .sort();
  const digest = createHash('sha256');
  for (const path of paths) {
    let content;
    try {
      content = readFileSync(resolve(REPO_ROOT, path));
    } catch {
      // Файл исчез между перечислением и чтением — это уже изменение пакета.
      content = Buffer.from('<<missing>>');
    }
    digest.update(path);
    digest.update('\0');
    digest.update(createHash('sha256').update(content).digest());
    digest.update('\0');
  }
  return { digest: digest.digest('hex'), files: paths.length };
}

/**
 * Рабочий процесс с живым vitest. Пул тянущий: следующая мутация уходит тому,
 * кто освободился.
 *
 * Зависание — отдельный случай, а не разновидность падения. Синхронный вечный
 * цикл (мутация `index += 1` → `index += 0` в разборе графем) не прерывается
 * изнутри процесса: событийный цикл занят, таймаут теста не сработает. Поэтому
 * надзиратель ждёт ответа не дольше `RUN_TIMEOUT_MS`, убивает процесс и
 * поднимает новый, а мутацию засчитывает убитой — поведение изменилось так, что
 * прогон не завершился вовсе.
 */
const LIVE_WORKERS = new Set();

/**
 * Убить рабочий процесс **вместе с его потомством**.
 *
 * vitest поднимает собственные процессы-исполнители. Убитый по одному только
 * своему идентификатору рабочий процесс оставляет их сиротами, они продолжают
 * занимать процессор — и следующий прогон замедляется из-за предыдущего,
 * срабатывает потолок, убивается ещё один процесс, и так по кругу. Поэтому
 * процесс запускается отдельной группой и убивается группой.
 */
function killWorker(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

process.on('exit', () => {
  for (const child of LIVE_WORKERS) killWorker(child);
});

function startWorker(onLine, onExit) {
  const child = spawn('node', ['scripts/ledger-mutation-worker.mjs'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  LIVE_WORKERS.add(child);
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  child.on('close', (status) => {
    LIVE_WORKERS.delete(child);
    onExit(status, errors);
  });
  return child;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const fullCatalogue = buildCatalogue();

  // Объявления эквивалентности сверяются с **полным** каталогом, а не с
  // отфильтрованным прогоном: объявление, потерявшее свою мутацию, — это
  // разбор, оставшийся от прежнего кода, и знать о нём надо независимо от того,
  // какой срез запускали сейчас.
  const declaredKeys = new Set(fullCatalogue.map((mutant) => equivalenceKey(mutant)));
  const staleDeclarations = EQUIVALENT_MUTANTS.filter(
    (declaration) => !declaredKeys.has(equivalenceKey(declaration)),
  );
  const equivalent = new Map(
    EQUIVALENT_MUTANTS.map((declaration) => [equivalenceKey(declaration), declaration]),
  );

  let catalogue = fullCatalogue;
  if (options.operator !== null) {
    catalogue = catalogue.filter((item) => item.operator === options.operator);
  }
  if (options.file !== null) catalogue = catalogue.filter((item) => item.file === options.file);
  if (options.only !== null) catalogue = catalogue.filter((item) => item.id === options.only);
  if (options.ids !== null) {
    // Догон: список идентификаторов, оставшихся с прерванного прогона. Прогон в
    // дереве, где параллельно работают ещё девять пар рук, прерывается не по
    // своей вине, и начинать его каждый раз сначала — верный способ не
    // закончить никогда.
    const wanted = new Set(
      readFileSync(resolve(PACKAGE_ROOT, options.ids), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
    catalogue = catalogue.filter((item) => wanted.has(item.id));
  }

  if (options.list) {
    for (const mutant of catalogue) {
      console.log(`${mutant.id}\t${mutant.file}:${mutant.line}\t${mutant.description}`);
    }
    console.log(`всего: ${catalogue.length}`);
    return 0;
  }

  const before = treeFingerprint();
  console.log(`пакет до прогона: ${before.digest.slice(0, 16)} (${before.files} файлов)`);
  console.log(
    `мутаций: ${catalogue.length}, из них объявлено эквивалентными: ` +
      `${catalogue.filter((item) => equivalent.has(equivalenceKey(item))).length}`,
  );

  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const queue = [...catalogue];
  const survived = [];
  const equivalentSurvivors = [];
  const refuted = [];
  const broken = [];
  let killed = 0;
  let done = 0;
  let baselineFailed = false;

  function record(mutant, verdict, note) {
    done += 1;
    const declaration = equivalent.get(equivalenceKey(mutant));
    if (verdict === 'survived') {
      if (declaration === undefined) survived.push(mutant);
      else equivalentSurvivors.push(mutant);
    } else if (verdict === 'broken') broken.push({ mutant, note });
    else {
      killed += 1;
      // Объявленную эквивалентной мутацию убил набор — значит, поведение всё-таки
      // меняется, и разбор в `EQUIVALENT_MUTANTS` неверен. Это находка, а не шум.
      if (declaration !== undefined) refuted.push({ mutant, declaration });
    }
    const mark =
      verdict === 'killed'
        ? declaration === undefined
          ? '·'
          : 'ОПРОВЕРГНУТО'
        : verdict === 'survived'
          ? declaration === undefined
            ? 'ВЫЖИЛ'
            : '≡'
          : 'СЛОМАН';
    console.log(
      `[${done}/${catalogue.length}] ${mark} ${mutant.id} — ${mutant.file}:${mutant.line} ${mutant.description}${note === '' ? '' : ` (${note})`}`,
    );
  }

  /** Одна дорожка пула: живой рабочий процесс, переживающий свою же смерть. */
  function lane() {
    return new Promise((finished) => {
      let child = null;
      let inFlight = null;
      let watchdog = null;

      const clearWatchdog = () => {
        if (watchdog !== null) clearTimeout(watchdog);
        watchdog = null;
      };

      const next = () => {
        clearWatchdog();
        const mutant = queue.shift();
        if (mutant === undefined) {
          inFlight = null;
          child?.stdin.write('QUIT\n');
          return;
        }
        inFlight = mutant;
        watchdog = setTimeout(() => {
          // Ответа нет дольше потолка: процесс зациклился и изнутри не
          // остановится. Убиваем снаружи вместе с потомством и засчитываем
          // мутанта убитым.
          if (child !== null) killWorker(child);
        }, options.timeout);
        child?.stdin.write(`${mutant.id}\n`);
      };

      const spawnLane = () => {
        child = startWorker(
          (line) => {
            if (line === 'READY') {
              next();
              return;
            }
            if (line.startsWith('BASELINE fail')) {
              baselineFailed = true;
              console.error(`базовый прогон без мутации красный: ${line}`);
              return;
            }
            if (line.startsWith('RESULT ')) {
              const [, id, verdict, ...rest] = line.split(' ');
              const mutant = byId.get(id) ?? inFlight;
              clearWatchdog();
              if (mutant !== null && mutant !== undefined) {
                record(mutant, verdict, rest.join(' ').trim());
              }
              inFlight = null;
              return;
            }
          },
          (status, errors) => {
            clearWatchdog();
            if (inFlight !== null) {
              // Процесс умер, не ответив: либо зациклился и был убит, либо упал.
              // И то и другое — изменение поведения, замеченное прогоном.
              record(
                inFlight,
                'killed',
                status === null ? 'зациклился, процесс убит' : `процесс умер (${status})`,
              );
              inFlight = null;
            }
            if (queue.length > 0 && !baselineFailed) {
              if (errors.length > 0) console.error(errors.slice(-800));
              spawnLane();
              return;
            }
            finished();
          },
        );
      };
      spawnLane();
    });
  }

  const lanes = Math.max(1, Math.min(options.concurrency, catalogue.length));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  if (baselineFailed) {
    console.error('мутационный прогон бессмыслен на красном наборе');
    return 1;
  }

  const after = treeFingerprint();
  console.log(`пакет после прогона: ${after.digest.slice(0, 16)} (${after.files} файлов)`);
  if (after.digest !== before.digest) {
    console.error('ИСХОДНИКИ ПАКЕТА ИЗМЕНИЛИСЬ ЗА ПРОГОН — результат недостоверен');
    return 1;
  }

  console.log('');
  console.log(
    `убито: ${killed}, выжило: ${survived.length}, ` +
      `эквивалентно (объявлено): ${equivalentSurvivors.length}, сломано: ${broken.length}`,
  );
  for (const item of broken) {
    console.log(`СЛОМАН ${item.mutant.id} — ${item.note}`);
  }
  for (const mutant of survived) {
    console.log(
      `ВЫЖИЛ ${mutant.id} — ${mutant.file}:${mutant.line} [${mutant.operator}] ${mutant.description}`,
    );
  }
  if (survived.length > 0) {
    console.log(
      'Выживший мутант — ветка, которую ни один тест не различает. Либо тест, ' +
        'проверяющий именно это различие, либо разбор в `EQUIVALENT_MUTANTS`.',
    );
  }
  for (const item of refuted) {
    console.log(
      `ОПРОВЕРГНУТО ${item.mutant.id} — ${item.mutant.file}:${item.mutant.line} ` +
        `${item.mutant.description}: объявлено эквивалентным, но набор его убил. ` +
        `Разбор неверен: ${item.declaration.reason}`,
    );
  }
  for (const declaration of staleDeclarations) {
    console.log(
      `УСТАРЕЛО объявление эквивалентности ${declaration.file} [${declaration.operator}] ` +
        `${declaration.description} — такой мутации в каталоге больше нет: ` +
        `«${declaration.sourceLine}»`,
    );
  }

  return survived.length === 0 &&
    broken.length === 0 &&
    refuted.length === 0 &&
    staleDeclarations.length === 0
    ? 0
    : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
