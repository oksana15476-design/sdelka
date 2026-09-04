#!/usr/bin/env node
/**
 * Мутационный прогон guard'ов домена по сквозному контуру.
 *
 * ## Зачем
 *
 * Дефект, ради которого написан этот скрипт, находили дважды и оба раза
 * глазами: guard домена удаляли — и сквозной контур этого не замечал. Проверка
 * «каждое правило проверяется по имени» (`STATE-MACHINES.md` §7) до сих пор
 * держалась на том, что кто-то догадается её провести. Здесь она становится
 * командой, которую можно запустить и которая заканчивается ненулевым кодом.
 *
 * Мутация ровно та же, которой пользовался верификатор: реализация guard'а
 * заменяется на `() => true`. Если после этого весь сквозной прогон остаётся
 * зелёным — guard не проверяется сквозным контуром ни в одном сценарии. Это и
 * есть дыра: правило можно снести, и никто не узнает.
 *
 * ## Что было сломано в самом скрипте
 *
 * Первая версия отчиталась: «восемнадцать guard'ов, все убиты». Читалось это
 * как «все guard'ы домена проверяются», а означало другое: скрипт текстово
 * вычитывал **один** блок по захардкоженному имени `GUARD_IDS`. Вне прогона
 * оставались шесть guard'ов сделки (`DEAL_GUARD_IDS`) и пять guard'ов вывода
 * (`WITHDRAWAL_GUARD_IDS`) — одиннадцать из тридцати, треть словаря, и никто
 * этого не видел, потому что отчёт был зелёный.
 *
 * Теперь перечни ищутся по признаку, а не по имени (`guard-registry.mjs`):
 * перечень, заведённый через полгода под любым именем, попадёт в прогон без
 * правки скрипта. Это условие задачи, а не удобство: сюда пришли второй раз
 * именно потому, что имя было одно и захардкоженное.
 *
 * ## Почему скрипт ничего не пишет
 *
 * Подмена живёт в `transform` конфигурации vitest
 * (`scripts/mutation.vitest.config.ts`) и существует только в памяти процесса.
 * Ни один файл не меняется — ни на время прогона, ни на секунду. Поэтому:
 *
 * - в `packages/domain` можно работать параллельно: скрипт туда не пишет;
 * - прерывание прогона (Ctrl-C, падение, kill) не оставляет репозиторий с
 *   намеренно испорченным guard'ом — восстанавливать нечего.
 *
 * Утверждение проверяется, а не декларируется: дерево хешируется до и после,
 * расхождение — отказ.
 *
 * ## Как запускать
 *
 *     pnpm --filter @sdelka/e2e mutation
 *
 * Код выхода 0 — каждый guard роняет хотя бы один сквозной тест. Иначе 1 и
 * поимённый список непокрытых.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MUTATION_ENV,
  PACKAGE_ROOT,
  REPO_ROOT,
  discoverRegistries,
  formatTarget,
  validateRegistries,
} from './guard-registry.mjs';

const CONFIG = 'scripts/mutation.vitest.config.ts';

/**
 * Отпечаток рабочего дерева: путь, размер и содержимое каждого файла, который
 * git считает частью проекта (отслеживаемые плюс неигнорируемые новые).
 *
 * Через git, а не обходом каталогов: так в отпечаток не попадают `node_modules`
 * и прочее игнорируемое, а попадает всё, что попадёт в коммит.
 */
function treeFingerprint() {
  const listed = (args) =>
    spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tracked = listed(['ls-files', '-z']);
  const untracked = listed(['ls-files', '--others', '--exclude-standard', '-z']);
  if (tracked.status !== 0 || untracked.status !== 0) {
    throw new Error('mutation.git_ls_files_failed');
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
      // Файл исчез между перечислением и чтением — это уже изменение дерева.
      content = Buffer.from('<<missing>>');
    }
    digest.update(path);
    digest.update('\0');
    digest.update(createHash('sha256').update(content).digest());
    digest.update('\0');
  }
  return { digest: digest.digest('hex'), files: paths.length };
}

function runSuite(target) {
  const env = { ...process.env };
  if (target === null) {
    delete env[MUTATION_ENV];
  } else {
    env[MUTATION_ENV] = target;
  }
  // `--bail=1`: для мутации важен сам факт падения, а не полный список
  // упавших тестов. Прогон обрывается на первом же — это экономит минуты.
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--config', CONFIG, '--bail=1', '--reporter=dot', '--silent'],
    { cwd: PACKAGE_ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * Чем закончился прогон с подменённым guard'ом.
 *
 * Различение здесь не формальность. Сломанная подмена — опечатка в разборе,
 * незакрытая скобка, не найденная реализация — роняет **сборку модуля**, и
 * прогон падает. Прежний скрипт записал бы это в «убит»: правило считалось бы
 * проверенным ровно потому, что проверка сломалась. Поэтому «убит» — это
 * упавший **тест**, а не упавший прогон: в выводе обязана быть строка
 * `Tests … failed`, и не должно быть следа отказа подмены (`sdelka.mutation.…`).
 */
function classify(run) {
  if (run.output.includes('sdelka.mutation.')) return 'broken';
  const failed = /Tests\s+(\d+)\s+failed/u.exec(run.output);
  if (failed !== null && Number(failed[1]) > 0) return 'killed';
  if (run.status === 0) return 'survived';
  return 'broken';
}

function main() {
  const registries = discoverRegistries();
  if (registries.length === 0) {
    process.stdout.write('Перечней guard\'ов не найдено — это отказ, а не «нечего проверять».\n');
    process.exit(1);
  }

  // Подмена проверяется на всех целях **до** первого прогона: сломанная
  // выглядит как убитый guard, и узнать об этом за миллисекунды дешевле, чем за
  // тридцать прогонов.
  const problems = validateRegistries(registries);
  if (problems.length > 0) {
    process.stdout.write(`Подмена невозможна для ${problems.length} цели(ей):\n`);
    for (const problem of problems) process.stdout.write(`  ${problem}\n`);
    process.exit(1);
  }

  const targets = registries.flatMap((registry) =>
    registry.guards.map((guard) => ({ registry, guard, target: formatTarget(registry, guard) })),
  );
  const before = treeFingerprint();

  process.stdout.write(
    `Мутационный прогон guard'ов: ${targets.length} шт. в ${registries.length} перечнях, ` +
      `отпечаток дерева ${before.digest.slice(0, 16)}… (${before.files} файлов)\n`,
  );
  for (const registry of registries) {
    process.stdout.write(
      `  ${registry.list.padEnd(22)} ${String(registry.guards.length).padStart(2)}  ${registry.relative}\n`,
    );
  }
  process.stdout.write('\n');

  // Базовый прогон: без зелёного контура мутация ничего не значит — «упало»
  // означало бы «оно и так падало».
  const baseline = runSuite(null);
  if (baseline.status !== 0) {
    process.stdout.write('Базовый прогон КРАСНЫЙ — мутация не имеет смысла.\n');
    process.stdout.write(baseline.output);
    process.exit(1);
  }
  process.stdout.write('Базовый прогон зелёный.\n\n');

  const survived = [];
  const broken = [];
  let currentList = null;
  for (const item of targets) {
    if (currentList !== item.registry.list) {
      currentList = item.registry.list;
      process.stdout.write(`${item.registry.relative} — ${currentList}\n`);
    }
    const started = Date.now();
    const run = runSuite(item.target);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const verdict = classify(run);
    if (verdict === 'survived') survived.push(item.target);
    if (verdict === 'broken') {
      broken.push({ target: item.target, output: run.output });
    }
    const label = { killed: '  убит  ', survived: 'НЕ ПОКРЫТ', broken: ' СЛОМАНО ' }[verdict];
    process.stdout.write(`  ${label}  ${item.guard.padEnd(32)} ${seconds}s\n`);
  }

  const after = treeFingerprint();
  const intact = after.digest === before.digest;
  process.stdout.write(
    `\nОтпечаток дерева после прогона: ${after.digest.slice(0, 16)}… — ${intact ? 'совпал' : 'РАЗОШЁЛСЯ'}\n`,
  );

  if (broken.length > 0) {
    process.stdout.write(
      `\nПодмена сломалась на ${broken.length} цели(ях) — это не «guard убит», а нерабочая проверка:\n`,
    );
    for (const item of broken) {
      process.stdout.write(`\n--- ${item.target} ---\n${item.output.slice(-2000)}\n`);
    }
  }

  if (survived.length > 0) {
    process.stdout.write(
      `\nНе покрыты сквозным контуром (${survived.length}):\n` +
        survived.map((item) => `  ${item}\n`).join('') +
        'Guard, чьё удаление не роняет ни одного сквозного теста, не проверяется — ' +
        'его можно снести незаметно.\n',
    );
  } else if (broken.length === 0) {
    process.stdout.write('\nКаждый guard роняет хотя бы один сквозной тест.\n');
  }

  process.exit(survived.length === 0 && broken.length === 0 && intact ? 0 : 1);
}

main();
