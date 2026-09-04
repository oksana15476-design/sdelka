import { requireDatabaseUrl } from '../env.ts';
import { migrate } from '../migrate.ts';
import { createPool } from '../pool.ts';

/**
 * `pnpm db:migrate`. Строка подключения только из окружения (красная линия №12);
 * без неё команда падает с техническим ключом, а не подставляет умолчание.
 */
const pool = createPool(requireDatabaseUrl());
try {
  const result = await migrate(pool);
  process.stdout.write(
    `applied=${result.applied.join(',') || '-'} skipped=${result.skipped.join(',') || '-'}\n`,
  );
} finally {
  await pool.end();
}
