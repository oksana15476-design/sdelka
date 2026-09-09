import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BackupManifest } from '../../src/manifest.ts';
import {
  CHECKSUMS_SUFFIX,
  DUMP_SUFFIX,
  MANIFEST_SUFFIX,
  renderChecksums,
  serializeManifest,
} from '../../src/manifest.ts';
import { manifest as manifestFixture } from './fixtures.ts';

/**
 * Набор файлов копии, собранный **на диске и без базы**.
 *
 * Дамп здесь — произвольные байты: сверка контрольных сумм идёт до
 * `pg_restore` и о содержимом файла ничего не знает. Именно это свойство и
 * проверяется: обрезанный или подменённый файл обязан быть отвергнут **до**
 * того, как его начнут читать, — `pg_restore` читает обрезанный дамп молча до
 * места обрыва и завершается успехом на том, что успел прочитать.
 */
export interface WrittenSet {
  readonly base: string;
  readonly dumpPath: string;
  readonly manifestPath: string;
  readonly checksumsPath: string;
  readonly manifest: BackupManifest;
}

function sha256(payload: Buffer | string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export async function writeBackupSet(
  directory: string,
  name: string,
  options: { readonly dump?: Buffer; readonly manifest?: BackupManifest } = {},
): Promise<WrittenSet> {
  const base = join(directory, name);
  const dumpPath = `${base}${DUMP_SUFFIX}`;
  const manifestPath = `${base}${MANIFEST_SUFFIX}`;
  const checksumsPath = `${base}${CHECKSUMS_SUFFIX}`;
  const dump = options.dump ?? Buffer.from('PGDMP-не-настоящий-дамп');
  await writeFile(dumpPath, dump);

  const source = options.manifest ?? manifestFixture();
  const manifest: BackupManifest = Object.freeze({
    ...source,
    dumpFile: basename(dumpPath),
    dumpBytes: dump.byteLength.toString(),
    dumpSha256: sha256(dump),
  });
  const text = serializeManifest(manifest);
  await writeFile(manifestPath, text, 'utf8');
  await writeFile(
    checksumsPath,
    renderChecksums([
      { digest: manifest.dumpSha256, file: basename(dumpPath) },
      { digest: sha256(text), file: basename(manifestPath) },
    ]),
    'utf8',
  );
  return Object.freeze({ base, dumpPath, manifestPath, checksumsPath, manifest });
}
