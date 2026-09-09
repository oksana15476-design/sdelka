import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Census } from './census.ts';
import { CENSUS_FORMAT_VERSION } from './census.ts';
import { BackupError, BackupErrorCode } from './errors.ts';

/**
 * Набор файлов копии — три штуки, и все три обязательны.
 *
 * - `<имя>.dump` — сама копия, формат `custom` (`pg_dump -Fc`);
 * - `<имя>.manifest.json` — слепок: перепись источника плюс то, чем и когда
 *   копия снята;
 * - `<имя>.sha256` — контрольные суммы первых двух **в формате `sha256sum`**.
 *
 * Формат `sha256sum` выбран не для красоты: дежурный обязан уметь проверить
 * целостность копии без нашего кода вообще — `sha256sum -c имя.sha256`. Если
 * единственный способ убедиться в целости копии живёт внутри того же
 * приложения, что и база, то в день, когда не поднимается ни то ни другое,
 * убедиться нечем.
 */
export const MANIFEST_FORMAT_VERSION = 1;

export const DUMP_SUFFIX = '.dump';
export const MANIFEST_SUFFIX = '.manifest.json';
export const CHECKSUMS_SUFFIX = '.sha256';

export interface BackupManifest {
  readonly formatVersion: number;
  /** Момент **начала** снимка в UTC: снимок согласован именно на него. */
  readonly takenAt: string;
  /**
   * Имя базы. **Не строка подключения**: в ней пароль, а слепок лежит рядом с
   * копией и уезжает в хранилище вместе с ней (красная линия №12).
   */
  readonly database: string;
  readonly serverVersion: string;
  readonly toolVersion: string;
  readonly dumpFile: string;
  readonly dumpBytes: string;
  readonly dumpSha256: string;
  readonly census: Census;
}

export function baseNameOf(path: string): string {
  for (const suffix of [DUMP_SUFFIX, MANIFEST_SUFFIX, CHECKSUMS_SUFFIX]) {
    if (path.endsWith(suffix)) return path.slice(0, -suffix.length);
  }
  return path;
}

export function serializeManifest(manifest: BackupManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function fail(reason: string): never {
  throw new BackupError(BackupErrorCode.manifestInvalid, { reason });
}

/**
 * Разбор слепка. Проверяется ровно то, без чего сверка врёт: версия формата и
 * присутствие полей, по которым потом сравнивают.
 *
 * Молчаливое «поле отсутствует — считаем нулём» здесь запрещено: слепок с
 * потерянным полем `census.auditRecords` дал бы «ожидали ноль записей,
 * получили ноль» и объявил бы порванную копию целой.
 */
export function parseManifest(text: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('unparseable');
  }
  if (typeof value !== 'object' || value === null) fail('not_object');
  const manifest = value as Partial<BackupManifest>;
  if (manifest.formatVersion !== MANIFEST_FORMAT_VERSION) {
    fail(`format_version:${String(manifest.formatVersion)}`);
  }
  for (const key of [
    'takenAt',
    'database',
    'serverVersion',
    'toolVersion',
    'dumpFile',
    'dumpBytes',
    'dumpSha256',
  ] as const) {
    if (typeof manifest[key] !== 'string' || manifest[key].length === 0) fail(`field:${key}`);
  }
  const census = manifest.census as Partial<Census> | undefined;
  if (census === undefined || typeof census !== 'object') fail('field:census');
  if (census.formatVersion !== CENSUS_FORMAT_VERSION) {
    fail(`census_version:${String(census.formatVersion)}`);
  }
  for (const key of ['schemaVersion', 'auditRecords', 'journalEntries'] as const) {
    if (typeof census[key] !== 'string') fail(`census_field:${key}`);
  }
  for (const key of ['migrations', 'tables', 'chains', 'postingSums', 'coverage'] as const) {
    if (!Array.isArray(census[key])) fail(`census_field:${key}`);
  }
  return manifest as BackupManifest;
}

/* ------------------------------------------------------------------------- */
/* Контрольные суммы                                                         */
/* ------------------------------------------------------------------------- */

export interface Checksum {
  readonly digest: string;
  readonly file: string;
}

/** Формат `sha256sum`: «хеш, два пробела, имя файла». Имя — без каталога. */
export function renderChecksums(items: readonly Checksum[]): string {
  return items.map((item) => `${item.digest}  ${item.file}`).join('\n').concat('\n');
}

const CHECKSUM_LINE = /^([0-9a-f]{64})\s\s?(.+)$/u;

export function parseChecksums(text: string): readonly Checksum[] {
  const items: Checksum[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const match = CHECKSUM_LINE.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      fail('checksum_line');
    }
    items.push(Object.freeze({ digest: match[1], file: match[2] }));
  }
  if (items.length === 0) fail('checksum_empty');
  return Object.freeze(items);
}

export function digestOf(items: readonly Checksum[], file: string): string {
  const found = items.find((item) => item.file === file);
  if (found === undefined) {
    throw new BackupError(BackupErrorCode.setIncomplete, { file });
  }
  return found.digest;
}

/**
 * Хеш файла потоком, а не через чтение целиком: копия боевой базы не обязана
 * помещаться в память процесса, который её проверяет.
 */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export async function readManifestFile(path: string): Promise<BackupManifest> {
  return parseManifest(await readFile(path, 'utf8'));
}
