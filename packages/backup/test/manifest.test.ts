import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CENSUS_FORMAT_VERSION } from '../src/census.ts';
import { BackupError, BackupErrorCode } from '../src/errors.ts';
import {
  CHECKSUMS_SUFFIX,
  DUMP_SUFFIX,
  MANIFEST_FORMAT_VERSION,
  MANIFEST_SUFFIX,
  baseNameOf,
  digestOf,
  fileSha256,
  parseChecksums,
  parseManifest,
  renderChecksums,
  serializeManifest,
} from '../src/manifest.ts';
import { census, manifest } from './support/fixtures.ts';

/**
 * Слепок и контрольные суммы.
 *
 * Главное свойство разбора — **он отказывается**. Слепок с потерянным полем не
 * имеет права разобраться в «ноль записей»: сверка тогда сравнила бы ноль с
 * нулём и объявила порванную копию целой. Поэтому здесь у каждого пропущенного
 * поля свой отказ, и проверяется он по ключу, а не по факту исключения.
 */
function refusal(call: () => unknown): BackupError {
  try {
    call();
  } catch (error: unknown) {
    if (error instanceof BackupError) return error;
    throw error;
  }
  throw new Error('backup.test.expected_refusal');
}

describe('имена файлов набора', () => {
  it.each([
    ['по дампу', `/var/backups/sdelka-prod-20260301T031500Z${DUMP_SUFFIX}`],
    ['по слепку', `/var/backups/sdelka-prod-20260301T031500Z${MANIFEST_SUFFIX}`],
    ['по суммам', `/var/backups/sdelka-prod-20260301T031500Z${CHECKSUMS_SUFFIX}`],
    ['по основе', '/var/backups/sdelka-prod-20260301T031500Z'],
  ])('основа набора берётся %s', (_name, path) => {
    expect(baseNameOf(path)).toBe('/var/backups/sdelka-prod-20260301T031500Z');
  });
});

describe('слепок', () => {
  it('круг «записали — прочитали» возвращает то же самое', () => {
    const source = manifest();
    expect(parseManifest(serializeManifest(source))).toEqual(source);
  });

  it('записывается с переводом строки в конце: файл читают и построчными средствами', () => {
    expect(serializeManifest(manifest()).endsWith('}\n')).toBe(true);
  });

  it('количества хранятся строками, а не числами (красная линия №4)', () => {
    const huge = '9223372036854775808';
    const parsed = parseManifest(
      serializeManifest(manifest({ census: census({ journalEntries: huge }) })),
    );
    expect(parsed.census.journalEntries).toBe(huge);
    // Через число это значение не проходит: проверка ловит именно потерю.
    expect(String(Number(huge))).not.toBe(huge);
  });

  it('строки подключения в слепке нет ни в каком виде: он уезжает в хранилище', () => {
    const text = serializeManifest(manifest());
    expect(text).not.toContain('postgresql://');
    expect(text).not.toContain('@');
  });

  it.each([
    ['не JSON', 'не-json', 'unparseable'],
    ['не объект', '"строка"', 'not_object'],
  ])('%s — backup.manifest.invalid с причиной', (_name, text, reason) => {
    const error = refusal(() => parseManifest(text));
    expect(error.code).toBe(BackupErrorCode.manifestInvalid);
    expect(error.details).toEqual({ reason });
  });

  it('чужая версия формата отвергается с номером: разбирать её нечем', () => {
    const text = JSON.stringify({ ...manifest(), formatVersion: MANIFEST_FORMAT_VERSION + 1 });
    const error = refusal(() => parseManifest(text));
    expect(error.code).toBe(BackupErrorCode.manifestInvalid);
    expect(error.details).toEqual({ reason: `format_version:${String(MANIFEST_FORMAT_VERSION + 1)}` });
  });

  it.each(['takenAt', 'database', 'serverVersion', 'toolVersion', 'dumpFile', 'dumpBytes', 'dumpSha256'])(
    'потерянное поле %s — отказ с именем поля, а не молчаливое умолчание',
    (field) => {
      const broken: Record<string, unknown> = { ...manifest() };
      delete broken[field];
      const error = refusal(() => parseManifest(JSON.stringify(broken)));
      expect(error.code).toBe(BackupErrorCode.manifestInvalid);
      expect(error.details).toEqual({ reason: `field:${field}` });
    },
  );

  it('потерянная перепись — отказ: сверять было бы не с чем', () => {
    const broken: Record<string, unknown> = { ...manifest() };
    delete broken.census;
    expect(refusal(() => parseManifest(JSON.stringify(broken))).details).toEqual({
      reason: 'field:census',
    });
  });

  it('чужая версия переписи отвергается отдельно от версии слепка', () => {
    const text = JSON.stringify(
      manifest({ census: { ...census(), formatVersion: CENSUS_FORMAT_VERSION + 1 } }),
    );
    expect(refusal(() => parseManifest(text)).details).toEqual({
      reason: `census_version:${String(CENSUS_FORMAT_VERSION + 1)}`,
    });
  });

  it.each(['schemaVersion', 'auditRecords', 'journalEntries'])(
    'потерянное количество %s — отказ, а не ноль',
    (field) => {
      const broken: Record<string, unknown> = { ...census() };
      delete broken[field];
      const text = JSON.stringify(manifest({ census: broken as never }));
      expect(refusal(() => parseManifest(text)).details).toEqual({
        reason: `census_field:${field}`,
      });
    },
  );

  it.each(['migrations', 'tables', 'chains', 'postingSums', 'coverage'])(
    'потерянный перечень %s — отказ, а не пустой список',
    (field) => {
      const broken: Record<string, unknown> = { ...census() };
      delete broken[field];
      const text = JSON.stringify(manifest({ census: broken as never }));
      expect(refusal(() => parseManifest(text)).details).toEqual({
        reason: `census_field:${field}`,
      });
    },
  );
});

describe('контрольные суммы', () => {
  const items = [
    { digest: 'a'.repeat(64), file: 'sdelka-prod.dump' },
    { digest: 'b'.repeat(64), file: 'sdelka-prod.manifest.json' },
  ];

  it('пишутся в формате sha256sum: хеш, два пробела, имя без каталога', () => {
    expect(renderChecksums(items)).toBe(
      `${'a'.repeat(64)}  sdelka-prod.dump\n${'b'.repeat(64)}  sdelka-prod.manifest.json\n`,
    );
  });

  it('круг «записали — прочитали» возвращает то же самое', () => {
    expect(parseChecksums(renderChecksums(items))).toEqual(items);
  });

  it('строка с одним пробелом (двоичный режим sha256sum) тоже читается', () => {
    expect(parseChecksums(`${'a'.repeat(64)} *sdelka-prod.dump\n`)).toEqual([
      { digest: 'a'.repeat(64), file: '*sdelka-prod.dump' },
    ]);
  });

  it('мусорная строка — отказ, а не пропуск', () => {
    const error = refusal(() => parseChecksums(`${'a'.repeat(64)}  ok.dump\nмусор\n`));
    expect(error.code).toBe(BackupErrorCode.manifestInvalid);
    expect(error.details).toEqual({ reason: 'checksum_line' });
  });

  it('пустой файл сумм — отказ: иначе «сверили ноль файлов» читалось бы как успех', () => {
    expect(refusal(() => parseChecksums('\n \n')).details).toEqual({ reason: 'checksum_empty' });
  });

  it('файла нет в перечне сумм — набор неполон', () => {
    const error = refusal(() => digestOf(items, 'sdelka-prod.sha256'));
    expect(error.code).toBe(BackupErrorCode.setIncomplete);
    expect(error.details).toEqual({ file: 'sdelka-prod.sha256' });
  });
});

describe('хеш файла', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sdelka-backup-digest-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('совпадает с посчитанным целиком: чтение потоком ничего не теряет', async () => {
    const path = join(dir, 'sample.bin');
    // Заведомо больше одного куска чтения: хеш потоком иначе проверяется на
    // одном `update` и на разбиении не проверяется вовсе.
    const payload = Buffer.alloc(1_000_000, 7);
    await writeFile(path, payload);
    expect(await fileSha256(path)).toBe(createHash('sha256').update(payload).digest('hex'));
  });

  it('меняется от одного байта', async () => {
    const path = join(dir, 'flip.bin');
    await writeFile(path, Buffer.from([1, 2, 3]));
    const before = await fileSha256(path);
    await writeFile(path, Buffer.from([1, 2, 4]));
    expect(await fileSha256(path)).not.toBe(before);
  });
});
