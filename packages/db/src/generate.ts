import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR, loadMigrations, renderChecksums } from './migrations.ts';

/**
 * `generate` — склейка миграций в снимок схемы и пересчёт контрольных сумм.
 *
 * ORM здесь нет, и генерировать клиента не из чего. Но корневой `package.json`
 * держит команду `db:generate`, и мёртвая команда хуже отсутствующей: её
 * запускают и делают вывод, что всё в порядке. Поэтому команда делает
 * единственное осмысленное, что здесь есть:
 *
 * - `migrations/schema.sql` — все миграции подряд, одним файлом. Он читается
 *   человеком и скармливается `psql` на чистой базе, когда нужен слепок, а не
 *   история;
 * - `migrations/CHECKSUMS` — по строке на файл в формате `sha256sum`. По нему
 *   тест дрейфа ловит правку **уже применённой** миграции: править её нельзя,
 *   можно только завести следующую.
 */
export const SCHEMA_SNAPSHOT = join(MIGRATIONS_DIR, 'schema.sql');

export function renderSnapshot(dir: string = MIGRATIONS_DIR): string {
  const migrations = loadMigrations(dir);
  const header = [
    '-- Снимок схемы: склейка миграций в порядке применения.',
    '-- Файл собирается командой `pnpm db:generate`; править его руками бесполезно.',
    '-- Источник истины — сами миграции.',
    '',
  ].join('\n');
  const body = migrations
    .map((item) => `-- ===== ${item.fileName} =====\n${item.sql.trimEnd()}\n`)
    .join('\n');
  return `${header}${body}`;
}

export function generate(dir: string = MIGRATIONS_DIR): { snapshot: string; checksums: string } {
  const migrations = loadMigrations(dir);
  const snapshot = renderSnapshot(dir);
  const checksums = renderChecksums(migrations);
  writeFileSync(join(dir, 'schema.sql'), snapshot, 'utf8');
  writeFileSync(join(dir, 'CHECKSUMS'), checksums, 'utf8');
  return { snapshot, checksums };
}
