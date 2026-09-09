import { requireDatabaseUrl } from '../env.ts';
import { migrate } from '../migrate.ts';
import { createPool } from '../pool.ts';
import { reportFailure } from './report.ts';

/**
 * `pnpm db:migrate` — **отдельный шаг развёртывания**, не часть старта
 * приложения.
 *
 * Порядок один: база готова → эта команда → приложение (ворота старта проверят
 * версию, `pnpm --filter @sdelka/db schema:check`). Команда идёт от роли,
 * состоящей в `sdelka_owner`; приложение работает от `sdelka_app` и прав на
 * изменение схемы не имеет вовсе.
 *
 * Коды выхода — контракт для разворачивающего скрипта:
 *
 * - `0` — схема на ожидаемой версии. Сюда же попадает повтор на уже накаченной
 *   базе: `applied=-`, и это успех, а не ошибка. Команда, падающая на повторе,
 *   приучает разворачивающего игнорировать её код выхода — и настоящий отказ
 *   он тоже проигнорирует;
 * - `1` — накат остановлен. Упавшая миграция откачена целиком, расхождение
 *   контрольных сумм остановило накат до первой записи.
 *
 * Отказ печатается **техническим ключом**, а не стеком: в свойствах ошибки
 * драйвера лежит адрес базы и пользователь (красная линия №12).
 */
async function main(): Promise<number> {
  const pool = createPool(requireDatabaseUrl());
  try {
    const result = await migrate(pool);
    process.stdout.write(
      `db.migrate.ok version=${result.version}` +
        ` applied=${result.applied.join(',') || '-'}` +
        ` skipped=${result.skipped.join(',') || '-'}\n`,
    );
    return 0;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exitCode = await main().catch((error: unknown) =>
  reportFailure(error, (line) => process.stderr.write(line)),
);
