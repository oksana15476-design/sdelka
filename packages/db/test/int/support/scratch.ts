import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseUrl } from '../../../src/env.ts';
import {
  CHECKSUMS_NAME,
  MIGRATIONS_DIR,
  loadMigrations,
  renderChecksums,
} from '../../../src/migrations.ts';
import { type Pool, createPool } from '../../../src/pool.ts';

/**
 * Одноразовая база под проверку наката.
 *
 * Накат нельзя проверить на общей базе набора. «Чистая база накатывается
 * целиком» и «частично накаченная продолжает с нужного места» требуют базы,
 * которую можно привести в нужное состояние и выбросить, а общая база к началу
 * файла уже накачена — на ней оба утверждения проверяются вхолостую.
 *
 * Изоляция схемой не годится: схема названа в миграциях поимённо (`sdelka.`), и
 * ни `search_path`, ни `SET LOCAL` этого не меняют. Поэтому — отдельная база.
 *
 * Логин-роль обязана иметь `CREATEDB`; его выдаёт `scripts/dev-db.sh`. Если
 * права нет, набор **падает с указанием, что запустить**, а не пропускается:
 * пропуск здесь означал бы зелёный прогон без единой проверки наката.
 */
const CREATE_DATABASE_HINT = 'db.test.scratch_denied: bash packages/db/scripts/dev-db.sh';

let counter = 0;

function scratchName(): string {
  counter += 1;
  // Имя уникально в пределах кластера: параллельных прогонов у набора нет
  // (`fileParallelism: false`), но брошенная база от убитого прогона —
  // законный остаток, и наступать на неё именем нельзя.
  return `sdelka_scratch_${process.pid}_${Date.now().toString(36)}_${counter}`;
}

/**
 * Строка подключения к другой базе того же кластера.
 *
 * Разбирается `URL`, а не склейкой строк: пароль, хост и параметры обязаны
 * доехать без изменений. Строка формата `host=… dbname=…` (keyword/value)
 * `URL`-ом не разбирается — такую отвергаем явно, потому что «догадаться» о ней
 * значит подставить не ту базу и накатить в неё.
 */
export function withDatabaseName(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface Scratch {
  readonly pool: Pool;
  readonly name: string;
}

/**
 * Заводит базу, отдаёт пул к ней и **всегда** её сносит.
 *
 * `WITH (FORCE)` — потому что упавший тест мог оставить соединение, а
 * `DROP DATABASE` без него ждёт вечно и превращает падение одного теста в
 * зависший прогон.
 */
export async function withScratchDatabase<T>(
  admin: Pool,
  body: (scratch: Scratch) => Promise<T>,
): Promise<T> {
  const url = databaseUrl();
  if (url === null) throw new Error('db.test.scratch_no_url');
  const name = scratchName();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === '42501') throw new Error(CREATE_DATABASE_HINT);
    throw error;
  }
  const pool = createPool(withDatabaseName(url, name));
  // `DROP DATABASE ... WITH (FORCE)` разрывает соединения, которые пул ещё не
  // успел закрыть; без слушателя такой разрыв прилетает как **необработанное**
  // исключение и роняет прогон уже после зелёных проверок. Хуже того, vitest
  // печатает в этот отчёт всё состояние клиента — включая пароль из строки
  // подключения (красная линия №12). Слушатель здесь именно для этого: база
  // сносится, разрыв ожидаем, и знать о нём никому не нужно.
  pool.on('error', () => undefined);
  try {
    return await body({ pool, name });
  } finally {
    await pool.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
  }
}

/**
 * Каталог из первых `count` миграций со своим слепком `CHECKSUMS`.
 *
 * Так получается база, накаченная **частично**: не выдуманная строка в таблице
 * учёта, а настоящая схема из настоящих файлов, оборванная на нужном шаге.
 * Подделанная строка проверяла бы арифметику над номерами, а не то, что
 * продолжение наката работает на реальной половине схемы.
 */
export function partialMigrationsDir(count: number): { readonly dir: string; readonly last: string } {
  const all = loadMigrations();
  const taken = all.slice(0, count);
  const last = taken.at(-1)?.version;
  if (last === undefined) throw new Error('db.test.partial_empty');
  const dir = mkdtempSync(join(tmpdir(), 'sdelka-partial-'));
  for (const migration of taken) {
    copyFileSync(join(MIGRATIONS_DIR, migration.fileName), join(dir, migration.fileName));
  }
  writeFileSync(join(dir, CHECKSUMS_NAME), renderChecksums(taken), 'utf8');
  return { dir, last };
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
