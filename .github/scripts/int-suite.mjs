#!/usr/bin/env node
/**
 * Интеграционный набор с доказательством того, что он **выполнился**.
 *
 * ## Зачем нужен посредник, а не строка `run:` в YAML
 *
 * Оба интеграционных набора (`packages/db`, `packages/e2e`) пропускают себя
 * сами, когда базы нет: `dbSuite` подставляет `describe.skip` с причиной в
 * имени. Это правильное поведение на машине разработчика и ловушка в
 * непрерывной проверке, потому что пропуск выглядит так:
 *
 *     Test Files  2 skipped (2)
 *          Tests  11 skipped (11)
 *     код выхода 0
 *
 * Работа, запускающая набор строкой `run:`, при этом зелёная. То есть проверка,
 * заведённая ради инвариантов базы, отчитывается об успехе, не проверив ни
 * одного. Ровно этот случай воспроизведён руками: без `SDELKA_DATABASE_URL`
 * набор `@sdelka/e2e` даёт «11 skipped» и ноль.
 *
 * Поэтому набор запускается **вторым репортёром в файл** и разбирается по
 * числам: пропущенных быть не должно ни одного, выполненных — не меньше
 * нижней границы (`.github/ci-expectations.json`).
 *
 * ## Почему команда не переписана здесь руками
 *
 * Соблазн написать в работе `pnpm --filter @sdelka/db exec vitest run --config
 * vitest.int.config.ts` велик, но тогда в репозитории появляются два описания
 * одного прогона, и они разъедутся молча: `test:int` в пакете поменяют, а
 * непрерывная проверка продолжит гонять прежнее. Здесь команда **читается** из
 * `scripts.test:int` пакета, и если она перестала быть запуском vitest —
 * скрипт останавливается и говорит, что его надо обновить, вместо того чтобы
 * запустить не то.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const EXPECTATIONS = join(REPO_ROOT, '.github', 'ci-expectations.json');

/** Ненулевой код и внятная причина. «Не смог проверить» — это отказ, не пропуск. */
function refuse(message) {
  process.stderr.write(`\n✗ ${message}\n`);
  process.exit(1);
}

/** Каталог пакета по имени. Перебор рабочих областей, а не таблица имён в скрипте. */
function packageDirectory(name) {
  for (const area of ['packages', 'apps']) {
    const root = join(REPO_ROOT, area);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const manifest = join(root, entry, 'package.json');
      if (!existsSync(manifest)) continue;
      if (JSON.parse(readFileSync(manifest, 'utf8')).name === name) return join(root, entry);
    }
  }
  return null;
}

const name = process.argv[2];
if (name === undefined) {
  refuse('не назван пакет: node .github/scripts/int-suite.mjs @sdelka/db');
}

const dir = packageDirectory(name);
if (dir === null) {
  refuse(`пакет ${name} не найден среди рабочих областей`);
}

const script = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts?.['test:int'];
if (typeof script !== 'string') {
  refuse(`у ${name} нет скрипта test:int — непрерывная проверка гоняла бы пустоту`);
}
if (!/^vitest\s+run(\s|$)/u.test(script)) {
  refuse(
    `скрипт test:int у ${name} — «${script}» — больше не запуск vitest. ` +
      'Разбор отчёта в этом скрипте рассчитан на vitest: обновите его, а не обходите.',
  );
}
if (/["'`]/u.test(script)) {
  refuse(`в скрипте test:int у ${name} есть кавычки — разбор аргументов здесь их не понимает`);
}

const expectations = JSON.parse(readFileSync(EXPECTATIONS, 'utf8'));
const floor = expectations.integration?.[name];
if (floor === undefined) {
  refuse(`для ${name} не задана нижняя граница в .github/ci-expectations.json`);
}

const report = join(process.env.RUNNER_TEMP ?? tmpdir(), `sdelka-int-${process.pid}.json`);
rmSync(report, { force: true });

/*
 * `--reporter=default` оставлен намеренно: без него в журнале работы вместо
 * прогона будет один JSON, и разбираться в упавшем тесте придётся по файлу
 * артефакта. Второй репортёр пишет отчёт в файл, а не в поток.
 */
const args = [
  '--filter',
  name,
  'exec',
  ...script.split(/\s+/u),
  '--reporter=default',
  '--reporter=json',
  `--outputFile.json=${report}`,
];

process.stdout.write(`Интеграционный набор ${name}: pnpm ${args.join(' ')}\n\n`);
const run = spawnSync('pnpm', args, { cwd: REPO_ROOT, stdio: 'inherit' });

if (run.error !== undefined) {
  refuse(`не удалось запустить pnpm: ${run.error.message}`);
}
if (run.status !== 0) {
  refuse(`набор ${name} завершился кодом ${run.status}`);
}
if (!existsSync(report)) {
  refuse(
    `набор ${name} закончился нулём, но отчёта ${report} нет. ` +
      'Пока отчёта нет, «прошло» и «не запускалось» неразличимы — считаем отказом.',
  );
}

const json = JSON.parse(readFileSync(report, 'utf8'));
rmSync(report, { force: true });

const passed = json.numPassedTests ?? 0;
const failed = json.numFailedTests ?? 0;
const pending = json.numPendingTests ?? 0;
const todo = json.numTodoTests ?? 0;
const files = Array.isArray(json.testResults) ? json.testResults.length : 0;

process.stdout.write(
  `\nОтчёт ${name}: выполнено ${passed}, файлов ${files}, ` +
    `упало ${failed}, пропущено ${pending}, отложено ${todo}\n`,
);

const complaints = [];
if (failed !== 0) {
  complaints.push(`упало тестов: ${failed}`);
}
if (pending !== 0) {
  /*
   * Главное, ради чего скрипт написан. Набор пропускает себя, когда базы нет,
   * и делает это с кодом выхода 0 — «N skipped» читается как зелёное.
   */
  complaints.push(
    `пропущено тестов: ${pending}. Набор обязан идти на живой базе; ` +
      'пропуск значит, что SDELKA_DATABASE_URL не довела до Postgres',
  );
}
if (todo !== 0) {
  complaints.push(`отложено тестов: ${todo} — в непрерывной проверке их быть не должно`);
}
if (passed < floor.minTests) {
  complaints.push(
    `выполнено ${passed} тестов при нижней границе ${floor.minTests}. ` +
      'Либо перечень файлов в конфигурации сузился, либо тесты удалили: ' +
      'границу опускают осознанно, правкой .github/ci-expectations.json',
  );
}
if (files < floor.minFiles) {
  complaints.push(`файлов с тестами ${files} при нижней границе ${floor.minFiles}`);
}

if (complaints.length > 0) {
  refuse(`набор ${name} зачтён не будет:\n  - ${complaints.join('\n  - ')}`);
}

process.stdout.write(`✓ набор ${name} действительно выполнился на живой базе\n`);
