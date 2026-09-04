import { describe } from 'vitest';
import { DATABASE_URL_ENV, databaseUrl } from '../../../src/env.ts';
import { migrate } from '../../../src/migrate.ts';
import { type Pool, type PoolClient, createPool } from '../../../src/pool.ts';

/**
 * Каркас интеграционных тестов.
 *
 * **Пропуск обязан быть громким.** Молчаливый пропуск читается как «прошло»:
 * набор зелёный, база не проверена, и узнаётся об этом на проде. Поэтому
 * причина печатается при загрузке модуля и повторяется в имени пропущенного
 * набора.
 */
export interface Environment {
  readonly available: boolean;
  readonly reason: string;
  readonly pool: Pool | null;
}

const url = databaseUrl();

let cached: Environment | null = null;

export async function environment(): Promise<Environment> {
  if (cached !== null) return cached;
  if (url === null) {
    const reason = `${DATABASE_URL_ENV} not set`;
    console.warn(`[@sdelka/db] интеграционные тесты пропущены: ${reason}`);
    cached = { available: false, reason, pool: null };
    return cached;
  }
  const pool = createPool(url);
  try {
    await pool.query('SELECT 1');
    await migrate(pool);
    cached = { available: true, reason: '', pool };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[@sdelka/db] интеграционные тесты пропущены: ${reason}`);
    await pool.end().catch(() => undefined);
    cached = { available: false, reason, pool: null };
  }
  return cached;
}

export async function closeEnvironment(): Promise<void> {
  if (cached?.pool != null) {
    await cached.pool.end();
    cached = null;
  }
}

/**
 * Клиент внутри транзакции, которая **всегда откатывается**.
 *
 * Тесты не чистят за собой руками: журнал только дополняется, и `DELETE` из
 * него запрещён и грантами, и триггером. Единственный способ вернуть базу в
 * исходное состояние — откат.
 */
export async function withRollback<T>(
  pool: Pool,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await body(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Код `SQLSTATE` ошибки, поднятой базой. `null` — ошибка не от базы. */
export function sqlState(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** Сообщение ошибки базы: у нас это всегда технический ключ. */
export function errorKey(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Набор, который сам себя пропускает с причиной в имени.
 *
 * `describe.skip` без причины оставляет в отчёте строку «пропущено» без
 * объяснения — а пропущенный по недоразумению набор внешне неотличим от
 * пропущенного намеренно.
 */
export type SuiteRunner = (name: string, body: () => void) => void;

export async function dbSuite(name: string): Promise<{
  readonly run: SuiteRunner;
  readonly title: string;
  readonly pool: Pool | null;
}> {
  const env = await environment();
  return env.available
    ? { run: describe, title: name, pool: env.pool }
    : { run: describe.skip, title: `${name} [пропущено: ${env.reason}]`, pool: null };
}
