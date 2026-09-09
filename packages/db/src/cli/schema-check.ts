import { requireDatabaseUrl } from '../env.ts';
import { createPool } from '../pool.ts';
import { assertSchemaCurrent } from '../schema-version.ts';
import { reportFailure } from './report.ts';

/**
 * `pnpm --filter @sdelka/db schema:check` — третий шаг развёртывания: **схема
 * накачена ровно до той версии, которую знает эта сборка**.
 *
 * Команда ничего не мигрирует и ничего не чинит. Она отвечает на единственный
 * вопрос, на который иначе отвечают догадкой: та ли база под этим кодом.
 * Ставится в разворачивающий скрипт перед запуском процесса
 * (`pnpm env:check && pnpm --filter @sdelka/db schema:check && pnpm start`), а
 * когда у приложения появится точка входа — тем же вызовом `assertSchemaCurrent`
 * первой строкой после проверки окружения.
 *
 * Хватает прав роли приложения: команда только читает `sdelka.schema_migration`.
 * Это намеренно — ворота обязаны проверяться теми же правами, с какими потом
 * работает процесс, иначе они проверяют не то соединение.
 *
 * Коды выхода: `0` — версия совпала; `1` — любое расхождение, с техническим
 * ключом в `stderr` (`db.schema.not_initialized`, `db.schema.behind`,
 * `db.schema.ahead`, `db.schema.checksum_mismatch`).
 */
async function main(): Promise<number> {
  const pool = createPool(requireDatabaseUrl());
  try {
    process.stdout.write(`db.schema.ok version=${await assertSchemaCurrent(pool)}\n`);
    return 0;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exitCode = await main().catch((error: unknown) =>
  reportFailure(error, (line) => process.stderr.write(line)),
);
