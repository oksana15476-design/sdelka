import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATABASE_URL_ENV } from '@sdelka/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BACKUP_DIR_ENV, RESTORE_URL_ENV } from '../../src/env.ts';
import { BackupErrorCode } from '../../src/errors.ts';
import { DUMP_SUFFIX } from '../../src/manifest.ts';
import type { Pool } from '../../src/pool.ts';
import {
  createDatabase,
  drillSuite,
  dropDatabase,
  loudly,
  migrateDatabase,
  pooled,
  removeDirectory,
  scratchDirectory,
  scratchName,
  withDatabaseName,
} from './support/drill.ts';
import { seedSource } from './support/seed.ts';

/**
 * Учение по **шипованному пути**: не по функциям пакета, а по тем самым
 * командам, которые запускает задание по расписанию и дежурный руками.
 *
 * Это не дубль `drill.int.test.ts`. Тот проверяет, что копия снимается и
 * сходится; этот — что до этого кода вообще доходит запуск: аргументы, коды
 * выхода, чтение окружения и вывод, в котором не должно быть пароля.
 *
 * Повод завести набор был предметный: команды не запускались вовсе. Node
 * отказывался разрешать импорты `@sdelka/audit` и `@sdelka/ledger` (они
 * написаны без расширений), и обе команды падали с `ERR_MODULE_NOT_FOUND` до
 * первой своей строки. Проверялись при этом функции пакета — они работали.
 */
const { run, title, cluster } = await drillSuite('учение: команды пакета');

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Наследуемое от прогона — поимённо и **перебором**, как в `exec.ts`. Чтение
 * по имени-константе здесь не стиль: перечень переменных (`packages/config`)
 * ищет прямые обращения к окружению грепом и требует записи в перечень на
 * каждое найденное имя. Перечень описывает переменные продукта, а не окружение
 * операционной системы, — а `PATH` и `HOME` нужны дочернему процессу, чтобы
 * найти `pg_dump` и прочитать `.pgpass`.
 */
const PASSTHROUGH = ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const;

function inherited(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Запуск команды пакета ровно так, как её запускает `pnpm --filter … <имя>`. */
async function runCli(
  script: 'dump' | 'verify',
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<Ran> {
  return await new Promise<Ran>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        './src/cli/register-ts.mjs',
        '--experimental-strip-types',
        `src/cli/${script}.ts`,
        ...args,
      ],
      {
        cwd: PACKAGE_ROOT,
        // Окружение собирается явно: чужие `PG*` прогона иначе переопределили
        // бы адрес, и команда снимала бы копию не с той базы.
        env: { ...inherited(), ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

let admin: Pool | null = null;
let sourceName = '';
let targetName = '';
let directory = '';
let sourceUrl = '';
let restoreUrl = '';
let secret = '';

beforeAll(async () => {
  if (cluster === null) return;
  admin = pooled(cluster);
  sourceName = scratchName('src');
  targetName = scratchName('dst');
  directory = await scratchDirectory();
  sourceUrl = withDatabaseName(cluster, sourceName);
  restoreUrl = withDatabaseName(cluster, targetName);
  secret = new URL(cluster).password;
  await loudly(async () => {
    await createDatabase(admin as Pool, sourceName);
    await migrateDatabase(sourceUrl);
    await seedSource(sourceUrl);
  });
}, 240_000);

afterAll(async () => {
  if (admin === null) return;
  await dropDatabase(admin, sourceName);
  await dropDatabase(admin, targetName);
  await removeDirectory(directory);
  await admin.end().catch(() => undefined);
}, 60_000);

/** Пароль не имеет права появиться в выводе команды ни при каком исходе. */
function expectNoSecret(ran: Ran): void {
  if (secret.length === 0) {
    console.warn('[@sdelka/backup] в строке подключения нет пароля — утечку проверить нечем');
    return;
  }
  expect(ran.stdout).not.toContain(secret);
  expect(ran.stderr).not.toContain(secret);
}

run(title, () => {
  it('dump: снимает копию, печатает слепок одной строкой и выходит нулём', async () => {
    if (cluster === null) return;
    const ran = await runCli('dump', [], {
      [DATABASE_URL_ENV]: sourceUrl,
      [BACKUP_DIR_ENV]: directory,
    });
    expect(`${ran.stdout}${ran.stderr}`).toContain('backup.dump.ok');
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain(`source=postgresql://`);
    expectNoSecret(ran);
    expect((await readdir(directory)).filter((name) => name.endsWith(DUMP_SUFFIX))).toHaveLength(1);
  }, 240_000);

  it('verify: поднимает копию в чистую базу, сверяет и выходит нулём', async () => {
    if (cluster === null) return;
    const dump = (await readdir(directory)).find((name) => name.endsWith(DUMP_SUFFIX)) ?? '';
    const ran = await runCli('verify', [join(directory, dump)], {
      [RESTORE_URL_ENV]: restoreUrl,
    });
    expect(`${ran.stdout}${ran.stderr}`).toContain('backup.verify.ok');
    expect(ran.code).toBe(0);
    // Строка подключения к цели печатается без пароля и без параметров.
    expect(ran.stdout).toContain(`target=postgresql://`);
    expectNoSecret(ran);
  }, 240_000);

  it('verify без переменной окружения: отказ ключом, а не значением по умолчанию', async () => {
    if (cluster === null) return;
    const ran = await runCli('verify', ['/nonexistent/set.dump'], {});
    expect(ran.stderr.trim()).toBe(`${BackupErrorCode.envMissing} variable=${RESTORE_URL_ENV}`);
    expect(ran.code).toBe(1);
  }, 60_000);

  it('verify без пути к набору: отказ ключом', async () => {
    if (cluster === null) return;
    const ran = await runCli('verify', [], { [RESTORE_URL_ENV]: restoreUrl });
    expect(ran.stderr.trim()).toBe(
      `${BackupErrorCode.setIncomplete} reason=path_argument_missing`,
    );
    expect(ran.code).toBe(1);
  }, 60_000);
});
