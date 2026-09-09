import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbError, DbErrorCode } from './errors.ts';

/** Каталог с миграциями. Файлы — обычный SQL, читаемый `psql` без обвязки. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Имя файла контрольных сумм внутри каталога миграций. */
export const CHECKSUMS_NAME = 'CHECKSUMS';

/** Файл контрольных сумм: применённая миграция не правится, заводится новая. */
export const CHECKSUMS_FILE = join(MIGRATIONS_DIR, CHECKSUMS_NAME);

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

/**
 * Род расхождения каталога со слепком. Чинятся они по-разному, поэтому
 * различаются: см. `DbErrorCode.migrationChecksumDrift`.
 */
export type ChecksumDriftKind = 'changed' | 'unlisted' | 'orphaned';

export interface ChecksumDrift {
  readonly fileName: string;
  readonly kind: ChecksumDriftKind;
}

/**
 * Сверка каталога миграций со слепком `CHECKSUMS` — **чистая функция**, без
 * файловой системы и без базы.
 *
 * Проверка идёт в обе стороны намеренно. Односторонняя («каждый файл найден в
 * слепке») пропустила бы удалённую миграцию: файла нет, сверять нечего, накат
 * молча применяет на один шаг меньше. Расхождения возвращаются **списком**, а
 * не первым найденным: разворачивающий узнаёт обо всех сразу, а не перебором.
 */
export function checksumDrift(
  migrations: readonly Migration[],
  recorded: ReadonlyMap<string, string>,
): readonly ChecksumDrift[] {
  const drift: ChecksumDrift[] = [];
  const present = new Set<string>();
  for (const migration of migrations) {
    present.add(migration.fileName);
    const stored = recorded.get(migration.fileName);
    if (stored === undefined) {
      drift.push({ fileName: migration.fileName, kind: 'unlisted' });
    } else if (stored !== migration.checksum) {
      drift.push({ fileName: migration.fileName, kind: 'changed' });
    }
  }
  for (const fileName of recorded.keys()) {
    if (!present.has(fileName)) {
      drift.push({ fileName, kind: 'orphaned' });
    }
  }
  return Object.freeze(drift.sort((left, right) => left.fileName.localeCompare(right.fileName)));
}

/**
 * Миграции каталога, сверенные со слепком `CHECKSUMS`.
 *
 * Это первое, что делает накат, и делает он это **до** подключения к базе:
 * каталог, разошедшийся со слепком, нельзя применять ни к какой базе, и узнать
 * об этом дешевле всего без сети.
 *
 * Слепок обязан существовать: его отсутствие — не «нечего сверять», а
 * `orphaned`-наоборот, то есть накат вслепую. Пустой файл дал бы `unlisted` на
 * каждую миграцию, отсутствующий — исключение чтения; оба громкие, и это
 * правильно.
 */
export function loadVerifiedMigrations(dir: string = MIGRATIONS_DIR): readonly Migration[] {
  const migrations = loadMigrations(dir);
  const recorded = parseChecksums(readFileSync(join(dir, CHECKSUMS_NAME), 'utf8'));
  const drift = checksumDrift(migrations, recorded);
  if (drift.length > 0) {
    const first = drift[0];
    throw new DbError(DbErrorCode.migrationChecksumDrift, {
      // Первое расхождение названо поимённо — с него и чинят; остальные
      // перечислены рядом, чтобы починка не шла по одному за перезапуск.
      fileName: first?.fileName ?? '',
      kind: first?.kind ?? '',
      files: drift.map((item) => `${item.fileName}:${item.kind}`).join(','),
    });
  }
  return migrations;
}
