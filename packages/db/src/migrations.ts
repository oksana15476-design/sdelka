import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Каталог с миграциями. Файлы — обычный SQL, читаемый `psql` без обвязки. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Файл контрольных сумм: применённая миграция не правится, заводится новая. */
export const CHECKSUMS_FILE = join(MIGRATIONS_DIR, 'CHECKSUMS');

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/u;

export interface Migration {
  /** Четырёхзначный номер: он же порядок применения. */
  readonly version: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): readonly Migration[] {
  const files = readdirSync(dir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
  return Object.freeze(
    files.map((fileName) => {
      const match = MIGRATION_FILE.exec(fileName);
      // Regexp уже отобрал имена, но `noUncheckedIndexedAccess` не верит на
      // слово, и правильно делает: группа может быть `undefined` по типу.
      const version = match?.[1];
      if (version === undefined) {
        throw new Error(`db.migration.bad_name:${fileName}`);
      }
      const sql = readFileSync(join(dir, fileName), 'utf8');
      return Object.freeze({ version, fileName, sql, checksum: checksumOf(sql) });
    }),
  );
}

/**
 * Содержимое файла `CHECKSUMS` — по строке на миграцию, `<sha256>  <имя файла>`,
 * тот же формат, что у `sha256sum`: его можно проверить сторонним инструментом,
 * не запуская наш код.
 */
export function renderChecksums(migrations: readonly Migration[]): string {
  return `${migrations.map((item) => `${item.checksum}  ${item.fileName}`).join('\n')}\n`;
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf('  ');
    if (separator === -1) throw new Error(`db.checksums.bad_line:${trimmed}`);
    result.set(trimmed.slice(separator + 2), trimmed.slice(0, separator));
  }
  return result;
}
