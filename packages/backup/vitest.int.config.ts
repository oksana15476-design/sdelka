import { defineConfig } from 'vitest/config';

/**
 * Учения: нужен живой Postgres и `pg_dump`/`pg_restore` в `PATH`.
 *
 * Запускается только явно — `pnpm --filter @sdelka/backup test:int`. Набор
 * заводит **свои** базы (снимаемую и восстанавливаемую) и сносит их за собой;
 * ни `SDELKA_DATABASE_URL`, ни чужие базы кластера он не трогает.
 */
export default defineConfig({
  test: {
    include: ['test/int/**/*.int.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
