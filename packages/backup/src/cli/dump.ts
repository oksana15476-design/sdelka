import { BACKUP_DIR_ENV, requireEnv } from '../env.ts';
import { createBackup } from '../dump.ts';
import { redactConnectionString } from '../connection.ts';
import { DATABASE_URL_ENV } from '../env.ts';
import { reportFailure } from './report.ts';

/**
 * `pnpm --filter @sdelka/backup dump` — снятие копии. Команда рассчитана на
 * запуск **по расписанию**: ни одного вопроса в терминал, ни одного значения
 * по умолчанию, код выхода — контракт.
 *
 * Пример задания (`cron`, ежедневно в 03:15 UTC):
 *
 * ```
 * 15 3 * * * SDELKA_DATABASE_URL=... SDELKA_BACKUP_DIR=/var/backups/sdelka \
 *   pnpm --filter @sdelka/backup dump >> /var/log/sdelka-backup.log 2>&1
 * ```
 *
 * Запуск — через `pnpm`, а не голым `node`: команде нужен флаг `--import` с
 * хуком разрешения (`resolve-ts.mjs`, разбор — там же). Без него она падает с
 * `ERR_MODULE_NOT_FOUND` до первой своей строки, и падение это не про копию.
 *
 * Строка подключения приходит окружением и в вывод не попадает: печатается
 * только её обрезанный вид без пароля и без параметров.
 *
 * Коды выхода: `0` — копия снята и слепок записан; `1` — не снята. Третьего
 * исхода нет: частично записанный набор не считается копией, потому что
 * контрольная сумма на него не сойдётся.
 */
async function main(): Promise<number> {
  const connectionString = requireEnv(DATABASE_URL_ENV);
  const directory = requireEnv(BACKUP_DIR_ENV);
  const result = await createBackup({ connectionString, directory });
  process.stdout.write(
    `backup.dump.ok base=${result.base}` +
      ` source=${redactConnectionString(connectionString)}` +
      ` bytes=${result.manifest.dumpBytes}` +
      ` sha256=${result.manifest.dumpSha256.slice(0, 16)}` +
      ` schema=${result.manifest.census.schemaVersion}` +
      ` audit=${result.manifest.census.auditRecords}` +
      ` entries=${result.manifest.census.journalEntries}\n`,
  );
  return 0;
}

process.exitCode = await main().catch((error: unknown) =>
  reportFailure(error, (line) => process.stderr.write(line)),
);
