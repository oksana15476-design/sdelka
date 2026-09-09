import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DATABASE_URL_ENV,
  createPool,
  databaseUrl,
  isDatabaseUnreachable,
  migrate,
  probeConnection,
} from '@sdelka/db';
import { describe } from 'vitest';
import { failureLine } from '../../../src/cli/report.ts';
import { withDatabaseName } from '../../../src/connection.ts';
import type { Pool } from '../../../src/pool.ts';

/**
 * Каркас учений по восстановлению.
 *
 * **Пропуск обязан быть громким и узким** — правило то же, что у каркаса
 * `@sdelka/db` (`test/int/support/pg.ts`), и по той же причине: молчаливый
 * пропуск читается как «прошло», а здесь «прошло» означает «копия проверена».
 * Копия, которую ни разу не восстанавливали, — не копия, а файл, и узнать об
 * этом можно ровно в тот день, когда она понадобилась.
 *
 * Граница проведена по стадии: до кластера не добрались — пропуск с причиной;
 * кластер ответил, а дальше что-то упало — падение.
 *
 * Набор заводит **свои** базы (снимаемую и восстанавливаемую) и сносит их за
 * собой. Базу из строки подключения он не трогает ничем, кроме соединения:
 * из-под неё выполняются `CREATE DATABASE` и `DROP DATABASE`.
 */
export interface DrillSuite {
  readonly run: (name: string, body: () => void) => void;
  readonly title: string;
  readonly cluster: string | null;
}

function unavailable(reason: string): null {
  console.warn(`[@sdelka/backup] учения пропущены: ${reason}`);
  return null;
}

async function resolveCluster(): Promise<string | null> {
  const url = databaseUrl();
  if (url === null) return unavailable(`${DATABASE_URL_ENV} not set`);
  const pool = createPool(url);
  try {
    await probeConnection(pool);
    return url;
  } catch (error) {
    // Сервер ответил — это не «кластера нет»: неверный пароль и запрещающий
    // `pg_hba` падают на той же стадии, и пропуск здесь превратил бы
    // непроверенную копию в зелёный прогон.
    if (!isDatabaseUnreachable(error)) throw error;
    return unavailable(error instanceof Error ? error.message : String(error));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function drillSuite(name: string): Promise<DrillSuite> {
  const cluster = await resolveCluster();
  return cluster === null
    ? { run: describe.skip, title: `${name} [пропущено: нет кластера]`, cluster: null }
    : { run: describe, title: name, cluster };
}

/* ------------------------------------------------------------------------- */
/* Одноразовые базы                                                          */
/* ------------------------------------------------------------------------- */

let counter = 0;

/**
 * Имя базы уникально в пределах кластера: брошенная база от убитого прогона —
 * законный остаток, и наступать на неё именем нельзя. Алфавит — тот же, что
 * требует `restoreForDrill` от цели (`^[a-z_][a-z0-9_]*$`).
 */
export function scratchName(role: 'src' | 'dst'): string {
  counter += 1;
  return `sdelka_drill_${role}_${process.pid}_${Date.now().toString(36)}_${counter}`.toLowerCase();
}

export function pooled(url: string): Pool {
  const pool = createPool(url);
  // `DROP DATABASE ... WITH (FORCE)` рвёт соединения, которые пул не успел
  // закрыть. Без слушателя разрыв прилетает необработанным исключением и роняет
  // прогон уже после зелёных проверок — а vitest печатает в такой отчёт
  // состояние клиента целиком, включая пароль (красная линия №12).
  pool.on('error', () => undefined);
  return pool;
}

export async function createDatabase(admin: Pool, name: string): Promise<void> {
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
}

export async function dropDatabase(admin: Pool, name: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
}

/** Строка подключения к другой базе того же кластера — разбором, а не склейкой. */
export { withDatabaseName };

/** Накат миграций в заведённую базу. Отдельным шагом, как и в бою. */
export async function migrateDatabase(url: string): Promise<string> {
  const pool = pooled(url);
  try {
    return (await migrate(pool)).version;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------- */
/* Каталог копии                                                             */
/* ------------------------------------------------------------------------- */

export async function scratchDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'sdelka-drill-'));
}

export async function removeDirectory(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Отказ учения — с ключом и подробностями, а не одним ключом.
 *
 * `BackupError` несёт сообщением технический ключ, и в отчёте прогона видно
 * ровно его: «backup.command.failed» без хвоста `stderr` не отличает
 * «`pg_restore` не нашёл роль» от «диск кончился». Подробности собирает
 * `failureLine` — тот же вывод, что печатает команда, то есть уже без пароля
 * (красная линия №12).
 */
export async function loudly<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error: unknown) {
    throw new Error(failureLine(error), { cause: error });
  }
}

/* ------------------------------------------------------------------------- */
/* Порча восстановленной копии                                               */
/* ------------------------------------------------------------------------- */

/**
 * Таблицы, у которых на время порчи снимаются пользовательские триггеры.
 *
 * ⚠ **Это не обход красной линии №11, а условие честности учения.** Журнал
 * аудита и журнал учёта в продукте не редактируются, и триггеры
 * `forbid_audit_mutation`/`forbid_ledger_mutation` держат это на всех, включая
 * владельца. Но порча копии приходит **не через продукт**: обрезанная передача,
 * сбойный сектор, восстановление, доехавшее наполовину, — ни одно из этого о
 * триггерах не знает. Проверка, испытанная только тем повреждением, которое
 * умеет нанести приложение, не испытана вовсе.
 *
 * Портится **одноразовая база учения**, которая сносится в конце файла.
 * Источник и боевая база не трогаются ничем.
 */
const TAMPERED_TABLES = ['audit_record', 'ledger_entry', 'ledger_posting'] as const;

export async function tamper(url: string, statements: readonly string[]): Promise<void> {
  const pool = pooled(url);
  try {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE sdelka_owner');
      for (const table of TAMPERED_TABLES) {
        await client.query(`ALTER TABLE sdelka.${table} DISABLE TRIGGER USER`);
      }
      for (const sql of statements) await client.query(sql);
      for (const table of TAMPERED_TABLES) {
        await client.query(`ALTER TABLE sdelka.${table} ENABLE TRIGGER USER`);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}
