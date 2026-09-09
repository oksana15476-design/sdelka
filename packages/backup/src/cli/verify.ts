import { redactConnectionString } from '../connection.ts';
import { RESTORE_ADMIN_URL_ENV, RESTORE_URL_ENV, optionalEnv, requireEnv } from '../env.ts';
import { BackupError, BackupErrorCode } from '../errors.ts';
import { backupPool } from '../pool.ts';
import { openBackupSet, restoreForDrill } from '../restore.ts';
import { verifyRestored } from '../verify.ts';
import { findingLine, reportFailure } from './report.ts';

/**
 * `pnpm --filter @sdelka/backup verify -- <путь-к-копии>` — учение: копия
 * поднимается в чистую базу и **проверяется**.
 *
 * Это главная команда пакета. Копия, которую ни разу не восстанавливали, — не
 * копия, а файл: узнать, что она нечитаема, можно ровно в тот день, когда она
 * понадобилась, и в этот день узнавать уже поздно.
 *
 * Что проверяется — `verify.ts`: версия схемы, перепись (таблицы, строки, суммы
 * проводок, покрытие), целостность цепочек вечного журнала, нулевая сумма
 * проводок и покрытие не ниже единицы.
 *
 * Коды выхода: `0` — восстановленное сошлось со слепком по всем предметам
 * проверки; `1` — не сошлось, и в `stderr` перечислено **каждое** расхождение
 * техническим ключом.
 *
 * `--allow-empty` — единственная поблажка: разрешает признать целой копию базы,
 * в которой нет ни одной записи обоих журналов. Без флага это отказ
 * (`backup.verify.nothing_checked`), потому что «ноль записей» иначе неотличимо
 * от «копия снята не с той базы».
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const allowEmpty = args.includes('--allow-empty');
  const path = args.find((item) => !item.startsWith('--'));
  if (path === undefined) {
    throw new BackupError(BackupErrorCode.setIncomplete, { reason: 'path_argument_missing' });
  }
  const targetUrl = requireEnv(RESTORE_URL_ENV);
  const adminUrl = optionalEnv(RESTORE_ADMIN_URL_ENV);

  const set = await openBackupSet(path);
  await restoreForDrill({
    set,
    targetUrl,
    ...(adminUrl === null ? {} : { adminUrl }),
  });

  const pool = backupPool(targetUrl);
  try {
    const report = await verifyRestored(pool, { manifest: set.manifest, allowEmpty });
    if (!report.ok) {
      for (const item of report.findings) {
        process.stderr.write(`${findingLine(item)}\n`);
      }
      process.stderr.write(`backup.verify.failed findings=${report.findings.length}\n`);
      return 1;
    }
    process.stdout.write(
      `backup.verify.ok base=${set.base}` +
        ` target=${redactConnectionString(targetUrl)}` +
        ` schema=${report.schemaVersion}` +
        ` chains=${report.chainsVerified}` +
        ` audit=${report.auditRecords}` +
        ` entries=${report.journalEntries}\n`,
    );
    return 0;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exitCode = await main().catch((error: unknown) =>
  reportFailure(error, (line) => process.stderr.write(line)),
);
