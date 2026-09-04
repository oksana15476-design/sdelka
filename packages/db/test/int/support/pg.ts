import { describe } from 'vitest';
import { DATABASE_URL_ENV, databaseUrl } from '../../../src/env.ts';
import { DbError } from '../../../src/errors.ts';
import { migrate } from '../../../src/migrate.ts';
import {
  type Pool,
  type PoolClient,
  createPool,
  isDatabaseUnreachable,
  probeConnection,
} from '../../../src/pool.ts';

/**
 * Каркас интеграционных тестов.
 *
 * **Пропуск обязан быть громким и узким.** Молчаливый пропуск читается как
 * «прошло»: набор зелёный, база не проверена, и узнаётся об этом на проде.
 *
 * Прежняя редакция ловила `catch (error)` вокруг соединения **и** миграций
 * разом и на любую ошибку объявляла базу недоступной. Проба заведомо неверной
 * строкой подключения дала «79 пропущено, код выхода 0»: упавшая миграция и
 * отсутствующая база были неразличимы, и обе зелёные. То есть каркас, стоящий
 * ради проверки инвариантов базы, умел молча не проверить ни одного.
 *
 * Граница проведена **по стадии**, а не по тексту ошибки:
 *
 * - до базы не добрались: **пропуск с причиной**. Это законное состояние машины
 *   без поднятого кластера;
 * - база есть, миграция упала — **падение**. Это дефект схемы, и он обязан
 *   быть виден там же, где случился.
 *
 * Разбирать сообщение драйвера вместо стадии было бы гаданием: тексты ошибок
 * не наш контракт и меняются с версией `pg`.
 *
 * Стадии соединения при этом мало: «соединиться не удалось» — не то же самое,
 * что «базы нет». Неверный пароль, отсутствующая база и запрещающий `pg_hba`
 * падают на той же стадии, но сервер при этом **ответил** — это настройка, а не
 * недоступность, и пропуск здесь снова превратил бы непроверенную схему в
 * зелёный прогон. Кто именно недоступен, решает `isDatabaseUnreachable`
 * (`src/pool.ts`) по роду ошибки, а сроки ожидания задают таймауты пула: без
 * них недоступный адрес не пропускал набор, а вешал прогон на минуты.
 */
export interface Environment {
  readonly available: boolean;
  readonly reason: string;
  readonly pool: Pool | null;
}

/**
 * Зависимости каркаса — параметром, чтобы обе ветки проверялись **без базы**.
 * Каркас, который сам себя не проверяет, ровно один раз и превращает всё в
 * «пропущено».
 */
export interface EnvironmentDeps {
  readonly connect: (url: string) => Pool;
  readonly probe: (pool: Pool) => Promise<void>;
  readonly migrate: (pool: Pool) => Promise<unknown>;
}

export const DEFAULT_ENVIRONMENT_DEPS: EnvironmentDeps = Object.freeze({
  connect: createPool,
  probe: probeConnection,
  migrate,
});

/**
 * Причина пропуска в читаемом виде. Строка подключения в неё не попадает
 * никогда: в ней пароль (красная линия №12). У `DbError` сообщение — это
 * технический ключ, поэтому подробности («сколько ждали») дописываем отдельно,
 * иначе `db.connect.timeout` не отличить от мгновенного отказа.
 */
function reasonOf(error: unknown): string {
  if (error instanceof DbError) {
    const details = Object.entries(error.details)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    return details.length === 0 ? error.code : `${error.code} ${details}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Пропуск: базы нет. Причина печатается при загрузке модуля, а не копится молча. */
function unavailable(reason: string): Environment {
  console.warn(`[@sdelka/db] интеграционные тесты пропущены: ${reason}`);
  return { available: false, reason, pool: null };
}

/**
 * Разрешение окружения. Бросает, если база доступна, а миграции не применились:
 * возвращать «недоступно» в этом случае — и есть та самая ложь.
 */
export async function resolveEnvironment(
  url: string | null,
  deps: EnvironmentDeps = DEFAULT_ENVIRONMENT_DEPS,
): Promise<Environment> {
  if (url === null) {
    return unavailable(`${DATABASE_URL_ENV} not set`);
  }
  const pool = deps.connect(url);
  try {
    await deps.probe(pool);
  } catch (error) {
    // Пул закрываем в обоих случаях: брошенный сокет держал бы прогон живым
    // после того, как всё уже решено.
    await pool.end().catch(() => undefined);
    if (!isDatabaseUnreachable(error)) {
      // Сервер ответил (или ошибка неизвестного рода) — это не «базы нет».
      // Молчать нельзя: пропуск требует доказательства недоступности.
      throw error;
    }
    return unavailable(reasonOf(error));
  }
  try {
    await deps.migrate(pool);
  } catch (error) {
    // Соединение есть. Дальше любая ошибка — дефект схемы, и молчать о нём
    // нельзя: пул закрываем, чтобы прогон не завис на открытом сокете, а
    // ошибку отдаём наверх как есть.
    await pool.end().catch(() => undefined);
    throw error;
  }
  return { available: true, reason: '', pool };
}

const url = databaseUrl();

let cached: Environment | null = null;

export async function environment(): Promise<Environment> {
  if (cached !== null) return cached;
  cached = await resolveEnvironment(url);
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
