import { DbError, DbErrorCode } from './errors.ts';
import { type Migration, loadMigrations } from './migrations.ts';
import type { Pool, PoolClient } from './pool.ts';
import { MIGRATION_LOCK_KEY, MIGRATION_TABLE, OWNER_ROLE, SCHEMA_NAME } from './roles.ts';

/**
 * Раннер миграций.
 *
 * Три вещи, ради которых он вообще существует:
 *
 * 1. **Консультативная блокировка.** Две параллельные миграции обязаны
 *    выстроиться в очередь. Без неё две реплики приложения, стартовавшие
 *    одновременно, применяют одну миграцию дважды.
 * 2. **Контрольная сумма.** Уже применённая миграция не правится: правка
 *    молча расходится с тем, что стоит на проде. Расхождение — отказ, а не
 *    предупреждение (`db.migration.checksum_mismatch`).
 * 3. **`SET LOCAL ROLE`.** Каждый файл выполняется от имени владельца схемы,
 *    поэтому объекты принадлежат `sdelka_owner`, а не тому, кто случайно
 *    подключился. На этом стоит инвариант 21: гранты роли приложения имеют
 *    смысл только тогда, когда она не владелец (`roles.ts`).
 *
 * Первая миграция роли заводит, поэтому она одна выполняется без `SET ROLE` —
 * `SET ROLE sdelka_owner` стоит внутри неё самой, после `CREATE ROLE`.
 */
const BOOTSTRAP_MIGRATION = '0001';

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

interface AppliedRow {
  readonly version: string;
  readonly checksum: string;
}

async function ensureBookkeeping(client: PoolClient): Promise<void> {
  // Схема и таблица учёта миграций создаются до первой миграции — иначе
  // записать факт применения первой было бы некуда. Владельца им назначает
  // `0001`, когда роль уже существует.
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA_NAME}`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
       version text PRIMARY KEY,
       file_name text NOT NULL,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function appliedMigrations(client: PoolClient): Promise<ReadonlyMap<string, string>> {
  const result = await client.query<AppliedRow>(
    `SELECT version, checksum FROM ${MIGRATION_TABLE}`,
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

async function applyOne(client: PoolClient, migration: Migration): Promise<void> {
  await client.query('BEGIN');
  try {
    if (migration.version !== BOOTSTRAP_MIGRATION) {
      await client.query(`SET LOCAL ROLE ${OWNER_ROLE}`);
    }
    await client.query(migration.sql);
    await client.query('RESET ROLE');
    await client.query(
      `INSERT INTO ${MIGRATION_TABLE} (version, file_name, checksum) VALUES ($1, $2, $3)`,
      [migration.version, migration.fileName, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function migrate(pool: Pool, dir?: string): Promise<MigrateResult> {
  const migrations = dir === undefined ? loadMigrations() : loadMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    await ensureBookkeeping(client);
    const known = await appliedMigrations(client);
    for (const migration of migrations) {
      const previous = known.get(migration.version);
      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          // Правка применённой миграции — расхождение с тем, что стоит на
          // проде, и починить его правкой файла нельзя: нужна новая миграция.
          throw new DbError(DbErrorCode.migrationChecksumMismatch, {
            version: migration.version,
            fileName: migration.fileName,
          });
        }
        skipped.push(migration.version);
        continue;
      }
      await applyOne(client, migration);
      applied.push(migration.version);
    }
    const files = new Set(migrations.map((item) => item.version));
    for (const version of known.keys()) {
      if (!files.has(version)) {
        throw new DbError(DbErrorCode.migrationMissing, { version });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    client.release();
  }
  return Object.freeze({ applied: Object.freeze(applied), skipped: Object.freeze(skipped) });
}
