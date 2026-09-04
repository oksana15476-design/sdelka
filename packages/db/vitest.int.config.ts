import { defineConfig } from 'vitest/config';

/**
 * Интеграционный набор: нужен Postgres. Запускается только явно —
 * `pnpm --filter @sdelka/db test:int`.
 *
 * Без `SDELKA_DATABASE_URL` набор **пропускается с явной причиной**, а не
 * молча: молчаливый пропуск читается как «прошло».
 */
export default defineConfig({
  test: {
    include: ['test/int/**/*.int.test.ts'],
    // Миграции и данные общие на всю базу: параллельные файлы затирали бы друг
    // друга. Последовательный прогон здесь дешевле изоляции по схемам.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
