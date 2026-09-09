import { DATABASE_URL_ENV, databaseUrl } from '@sdelka/db';
import { BackupError, BackupErrorCode } from './errors.ts';

/**
 * Переменные окружения снятия и восстановления. Значений по умолчанию нет ни у
 * одной (красная линия №12): умолчание с хостом и паролем — это секрет в
 * репозитории, просто написанный мелко.
 *
 * Строка подключения к боевой базе — **та же самая** переменная, что у
 * миграций и приложения (`SDELKA_DATABASE_URL`). Отдельная «строка для
 * резервного копирования» разошлась бы с основной ровно в тот день, когда база
 * переедет, и копия продолжила бы сниматься со старого адреса, отчитываясь об
 * успехе.
 */
export { DATABASE_URL_ENV, databaseUrl };

/** Каталог, куда кладётся набор файлов копии. */
export const BACKUP_DIR_ENV = 'SDELKA_BACKUP_DIR';

/**
 * База, в которую восстанавливается копия при проверке. **Она пересоздаётся**,
 * поэтому переменная отдельная и обязательная: подставить сюда боевой адрес по
 * умолчанию значит однажды его и снести.
 */
export const RESTORE_URL_ENV = 'SDELKA_RESTORE_DATABASE_URL';

/**
 * Служебная база того же кластера, из-под которой цель создаётся и сносится:
 * `DROP DATABASE` нельзя выполнить, подключившись к сносимой базе.
 *
 * Если не задана, берётся `postgres` того же кластера — это не секрет и не
 * догадка об адресе, а имя служебной базы, которое у Postgres одно.
 */
export const RESTORE_ADMIN_URL_ENV = 'SDELKA_RESTORE_ADMIN_URL';

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new BackupError(BackupErrorCode.envMissing, { variable: name });
  }
  return value;
}

export function optionalEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[name];
  return value === undefined || value.length === 0 ? null : value;
}
