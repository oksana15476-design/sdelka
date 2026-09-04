import { DbError, DbErrorCode } from './errors.ts';

/**
 * Строка подключения — **только из окружения** (красная линия №12). Значения по
 * умолчанию здесь нет и быть не может: умолчание с хостом и паролем — это
 * секрет в репозитории, просто написанный мелко.
 *
 * Имя переменной одно на всё: миграции, интеграционные тесты и приложение
 * читают её же. Разделение «одна строка для владельца, другая для приложения»
 * не заводится намеренно — разделение прав держат **роли** (`roles.ts`), а не
 * две строки подключения, которые рано или поздно разъедутся.
 */
export const DATABASE_URL_ENV = 'SDELKA_DATABASE_URL';

/** `null`, если переменная не задана. Без исключения: пропуск тестов — не ошибка. */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[DATABASE_URL_ENV];
  return value === undefined || value.length === 0 ? null : value;
}

/** То же, но для тех, кому без базы делать нечего: миграции, CLI. */
export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = databaseUrl(env);
  if (value === null) {
    throw new DbError(DbErrorCode.databaseUrlMissing, { variable: DATABASE_URL_ENV });
  }
  return value;
}
