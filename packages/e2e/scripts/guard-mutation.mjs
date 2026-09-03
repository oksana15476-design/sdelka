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
 * ## Почему скрипт ничего не пишет
 *
 * Подмена живёт в резолвере vitest (`vitest.config.ts`, плагин
 * `sdelka:guard-mutation`) и существует только в памяти процесса. Ни один файл
 * не меняется — ни на время прогона, ни на секунду. Поэтому:
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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const GUARDS_SOURCE = resolve(REPO_ROOT, 'packages/domain/src/guards.ts');
const ENV_NAME = 'SDELKA_MUTATE_GUARD';

/**
 * Перечень guard'ов читается из самого домена, а не дублируется здесь.
 *
 * Список guard'ов растёт (`g_beneficiary_verified` в E13-2, `g_funds_collected`
 * в этом батче), и вторая копия перечня отстала бы молча — ровно тем же
 * способом, каким отставал перечень счетов в учёте. Разбор текстовый: скрипту
 * нельзя зависеть от сборки пакета, который он проверяет.
 */
function guardIds() {
  const source = readFileSync(GUARDS_SOURCE, 'utf8');
  const start = source.indexOf('export const GUARD_IDS = [');
  if (start < 0) {
    throw new Error(`mutation.guard_ids_not_found:${GUARDS_SOURCE}`);
  }
  const end = source.indexOf('] as const;', start);
  if (end < 0) {
    throw new Error(`mutation.guard_ids_unterminated:${GUARDS_SOURCE}`);
  }
  const ids = [...source.slice(start, end).matchAll(/'(g_[a-z0-9_]+)'/g)].map((match) => match[1]);
  if (ids.length === 0) {
    throw new Error(`mutation.guard_ids_empty:${GUARDS_SOURCE}`);
  }
  return ids;
}

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

function runSuite(mutatedGuard) {
  const env = { ...process.env };
  if (mutatedGuard === null) {
    delete env[ENV_NAME];
  } else {
    env[ENV_NAME] = mutatedGuard;
  }
  // `--bail=1`: для мутации важен сам факт падения, а не полный список
  // упавших тестов. Прогон обрывается на первом же — это экономит минуты.
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--bail=1', '--reporter=dot', '--silent'],
    { cwd: PACKAGE_ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function main() {
  const guards = guardIds();
  const before = treeFingerprint();
  process.stdout.write(
    `Мутационный прогон guard'ов: ${guards.length} шт., отпечаток дерева ${before.digest.slice(0, 16)}… (${before.files} файлов)\n\n`,
  );

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
  for (const guard of guards) {
    const started = Date.now();
    const run = runSuite(guard);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const killed = run.status !== 0;
    if (!killed) survived.push(guard);
    process.stdout.write(
      `${killed ? '  убит  ' : 'НЕ ПОКРЫТ'}  ${guard.padEnd(32)} ${seconds}s\n`,
    );
  }

  const after = treeFingerprint();
  const intact = after.digest === before.digest;
  process.stdout.write(
    `\nОтпечаток дерева после прогона: ${after.digest.slice(0, 16)}… — ${intact ? 'совпал' : 'РАЗОШЁЛСЯ'}\n`,
  );

  if (survived.length > 0) {
    process.stdout.write(
      `\nНе покрыты сквозным контуром (${survived.length}): ${survived.join(', ')}\n` +
        'Guard, чьё удаление не роняет ни одного сквозного теста, не проверяется — ' +
        'его можно снести незаметно.\n',
    );
  } else {
    process.stdout.write('\nКаждый guard роняет хотя бы один сквозной тест.\n');
  }

  process.exit(survived.length === 0 && intact ? 0 : 1);
}

main();
