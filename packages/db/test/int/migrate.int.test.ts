import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DbError, DbErrorCode } from '../../src/errors.ts';
import { migrate } from '../../src/migrate.ts';
import { CHECKSUMS_NAME, loadMigrations, renderChecksums } from '../../src/migrations.ts';
import type { Pool } from '../../src/pool.ts';
import { APP_ROLE, MIGRATION_TABLE, OWNER_ROLE, SCHEMA_NAME } from '../../src/roles.ts';
import { assertSchemaCurrent, schemaState } from '../../src/schema-version.ts';
import { dbSuite } from './support/pg.ts';
import { partialMigrationsDir, removeDir, withScratchDatabase } from './support/scratch.ts';

/**
 * Накат как **отдельный шаг развёртывания**, а не как побочный эффект тестов.
 *
 * До этого набора миграции применялись двумя способами: каркасом
 * интеграционных тестов и локальным скриптом. Оба применяют их **один раз, к
 * тому, что есть**, и потому не проверяют ровно того, ради чего накат
 * существует: повтора, продолжения с середины и отказа при расхождении. Общая
 * база набора к началу файла уже накачена — на ней все три утверждения
 * проверяются вхолостую и всегда зелены.
 *
 * Поэтому каждый случай идёт на **своей одноразовой базе** (`support/scratch.ts`).
 *
 * Проверяется здесь то, чего не проверить без кластера:
 *
 * 1. чистая база накатывается целиком и по порядку;
 * 2. повтор ничего не применяет и не падает;
 * 3. подменённая контрольная сумма — отказ, а не тихое применение заново;
 * 4. частично накаченная продолжает с нужного места;
 * 5. упавшая миграция останавливает накат и не оставляет половины себя;
 * 6. накат не даёт роли приложения прав на журналы (инвариант 21) — на
 *    свежей базе, а не на давно живущей;
 * 7. ворота старта отказываются работать на несовпадении версии.
 */
const { run, title, pool } = await dbSuite('накат миграций');

const ALL = loadMigrations();
const ALL_VERSIONS = ALL.map((item) => item.version);
const LAST = ALL_VERSIONS.at(-1) ?? '';

/** Номера, применённые к базе, по порядку записи. */
async function appliedVersions(scratch: Pool): Promise<string[]> {
  const rows = await scratch.query<{ version: string }>(
    `SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`,
  );
  return rows.rows.map((row) => row.version);
}

run(title, () => {
  it('чистая база накатывается целиком и по порядку', async () => {
    if (pool === null) return;
    await withScratchDatabase(pool, async ({ pool: scratch }) => {
      const result = await migrate(scratch);
      expect(result.applied).toEqual(ALL_VERSIONS);
      expect(result.skipped).toEqual([]);
      expect(result.version).toBe(LAST);
      expect(await appliedVersions(scratch)).toEqual(ALL_VERSIONS);
      // Не «команда отработала», а «схема той версии, которую ждёт код».
      expect(await assertSchemaCurrent(scratch)).toBe(LAST);
    });
  });

  it('повторный накат ничего не применяет и не падает', async () => {
    if (pool === null) return;
    await withScratchDatabase(pool, async ({ pool: scratch }) => {
      await migrate(scratch);
      const before = await scratch.query<{ stamp: string }>(
        `SELECT max(applied_at)::text AS stamp FROM ${MIGRATION_TABLE}`,
      );
      const again = await migrate(scratch);
      expect(again.applied).toEqual([]);
      expect(again.skipped).toEqual(ALL_VERSIONS);
      expect(again.version).toBe(LAST);
      // Отметки времени не сдвинулись: ни одна миграция не выполнилась заново.
      // Без этой проверки «применилось молча заново» и «не применилось» дают
      // одинаково пустой `applied`.
      const after = await scratch.query<{ stamp: string }>(
        `SELECT max(applied_at)::text AS stamp FROM ${MIGRATION_TABLE}`,
      );
      expect(after.rows[0]?.stamp).toBe(before.rows[0]?.stamp);
    });
  });

  it('подменённая контрольная сумма — отказ, а не применение заново', async () => {
    if (pool === null) return;
    await withScratchDatabase(pool, async ({ pool: scratch }) => {
      await migrate(scratch);
      const victim = ALL_VERSIONS[4] ?? '';
      await scratch.query(
        `UPDATE ${MIGRATION_TABLE} SET checksum = 'подменено' WHERE version = '${victim}'`,
      );
      const error = await migrate(scratch).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe(DbErrorCode.migrationChecksumMismatch);
      expect((error as DbError).details.version).toBe(victim);
      // Ничего не применилось повторно и ничего не откатилось: расхождение
      // останавливает накат, а не чинит его.
      expect(await appliedVersions(scratch)).toEqual(ALL_VERSIONS);
      // И ворота старта видят то же расхождение своим ключом.
      await expect(assertSchemaCurrent(scratch)).rejects.toThrow(
        DbErrorCode.schemaChecksumMismatch,
      );
    });
  });

  it('частично накаченная база продолжает с нужного места', async () => {
    if (pool === null) return;
    const half = Math.floor(ALL.length / 2);
    const { dir, last } = partialMigrationsDir(half);
    try {
      await withScratchDatabase(pool, async ({ pool: scratch }) => {
        const first = await migrate(scratch, dir);
        expect(first.applied).toEqual(ALL_VERSIONS.slice(0, half));
        expect(first.version).toBe(last);
        // Половина схемы настоящая, а не подделанная строка в таблице учёта.
        await expect(assertSchemaCurrent(scratch)).rejects.toThrow(DbErrorCode.schemaBehind);

        const rest = await migrate(scratch);
        expect(rest.skipped).toEqual(ALL_VERSIONS.slice(0, half));
        expect(rest.applied).toEqual(ALL_VERSIONS.slice(half));
        expect(await appliedVersions(scratch)).toEqual(ALL_VERSIONS);
        expect(await assertSchemaCurrent(scratch)).toBe(LAST);
      });
    } finally {
      removeDir(dir);
    }
  });

  it('упавшая миграция останавливает накат и не оставляет половины себя', async () => {
    if (pool === null) return;
    const { dir } = partialMigrationsDir(1);
    try {
      // Файл, который заводит таблицу и следом падает. Транзакционность DDL в
      // Postgres обязана снять и таблицу: «применилась наполовину» — это
      // состояние, из которого накат уже не выходит.
      writeFileSync(
        join(dir, '0002_broken.sql'),
        `SET LOCAL ROLE ${OWNER_ROLE};\nCREATE TABLE ${SCHEMA_NAME}.half_applied (id int);\nSELECT 1 / 0;\n`,
        'utf8',
      );
      writeFileSync(join(dir, CHECKSUMS_NAME), renderChecksums(loadMigrations(dir)), 'utf8');
      await withScratchDatabase(pool, async ({ pool: scratch }) => {
        await expect(migrate(scratch, dir)).rejects.toThrow();
        expect(await appliedVersions(scratch)).toEqual(['0001']);
        const left = await scratch.query<{ oid: string | null }>(
          `SELECT to_regclass('${SCHEMA_NAME}.half_applied')::text AS oid`,
        );
        expect(left.rows[0]?.oid).toBeNull();
      });
    } finally {
      removeDir(dir);
    }
  });

  it('каталог, разошедшийся со слепком, не доезжает до базы', async () => {
    if (pool === null) return;
    const { dir } = partialMigrationsDir(2);
    try {
      // Слепок оставлен от двух миграций, а файлов стало три: так выглядит
      // миграция, добавленная без `pnpm db:generate`. На чистой базе сверка с
      // таблицей учёта этого не поймает — ловит только слепок.
      writeFileSync(join(dir, '0003_extra.sql'), 'SELECT 1;\n', 'utf8');
      await withScratchDatabase(pool, async ({ pool: scratch }) => {
        const error = await migrate(scratch, dir).catch((thrown: unknown) => thrown);
        expect((error as DbError).code).toBe(DbErrorCode.migrationChecksumDrift);
        // До базы не дошло вовсе: таблицы учёта нет, схема не тронута.
        expect(await schemaState(scratch)).toEqual({ kind: 'uninitialized' });
      });
    } finally {
      removeDir(dir);
    }
  });

  it('накат не даёт роли приложения прав на журналы', async () => {
    if (pool === null) return;
    // Инвариант 21 проверяется грантами. Проверять его только на давно живущей
    // базе недостаточно: там права могли сложиться руками. Здесь — ровно то,
    // что оставил после себя накат, и ничего сверх.
    await withScratchDatabase(pool, async ({ pool: scratch }) => {
      await migrate(scratch);
      const forbidden = await scratch.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.table_privileges
          WHERE grantee = '${APP_ROLE}'
            AND table_name IN ('audit_record', 'ledger_entry', 'ledger_posting')
            AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')`,
      );
      expect(forbidden.rows).toEqual([]);
      // И журнал роль приложения всё-таки дописывает — иначе пустой ответ выше
      // означал бы «прав нет вообще», а это другой дефект.
      const allowed = await scratch.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.table_privileges
          WHERE grantee = '${APP_ROLE}' AND table_name = 'audit_record'
          ORDER BY privilege_type`,
      );
      expect(allowed.rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT']);
    });
  });

  it('ворота старта: база без наката — отказ с именем, а не догадка', async () => {
    if (pool === null) return;
    await withScratchDatabase(pool, async ({ pool: scratch }) => {
      // Таблицы учёта нет вовсе — сюда попадает тот, кто поднял приложение,
      // забыв про накат.
      await expect(assertSchemaCurrent(scratch)).rejects.toThrow(
        DbErrorCode.schemaNotInitialized,
      );
    });
  });

  it('ворота старта: база впереди кода — отказ', async () => {
    if (pool === null) return;
    await withScratchDatabase(pool, async ({ pool: scratch }) => {
      await migrate(scratch);
      // Так выглядит откат приложения на предыдущую сборку после наката.
      await scratch.query(
        `INSERT INTO ${MIGRATION_TABLE} (version, file_name, checksum)
         VALUES ('9999', '9999_future.sql', 'z')`,
      );
      await expect(assertSchemaCurrent(scratch)).rejects.toThrow(DbErrorCode.schemaAhead);
      // Накат в таком состоянии тоже отказывается: файла под запись нет.
      await expect(migrate(scratch)).rejects.toThrow(DbErrorCode.migrationMissing);
    });
  });

  it('ворота старта проходят под ролью приложения, без прав владельца', async () => {
    if (pool === null) return;
    // Ворота обязаны проверяться теми правами, с какими потом работает процесс.
    // Проверка, требующая прав владельца, проверяет не то соединение.
    await withScratchDatabase(pool, async ({ pool: scratch }) => {
      await migrate(scratch);
      const client = await scratch.connect();
      try {
        await client.query(`SET ROLE ${APP_ROLE}`);
        expect(await schemaState(client)).toEqual({ kind: 'current', version: LAST });
      } finally {
        client.release();
      }
    });
  });
});
