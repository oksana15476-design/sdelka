import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKUP_DIR_ENV, requireEnv } from '../src/env.ts';
import { BackupError, BackupErrorCode } from '../src/errors.ts';
import { libpqEnv } from '../src/connection.ts';
import { digestOf, parseManifest, renderChecksums } from '../src/manifest.ts';
import { openBackupSet, restoreForDrill } from '../src/restore.ts';
import { runOrThrow } from '../src/exec.ts';
import { compareCensus, healthFindings } from '../src/verify.ts';
import { census, manifest } from './support/fixtures.ts';
import { writeBackupSet } from './support/set.ts';

/**
 * **Перечень отказов проверен целиком.** Не «код где-то бросается», а: у
 * каждого ключа `BackupErrorCode`, до которого можно дотянуться без базы, есть
 * проверка, утверждающая **именно этот ключ**.
 *
 * Проверка вида `await expect(...).rejects.toThrow()` здесь запрещена
 * намеренно: она одинаково зелена на «набор неполон» и на «упал `pg_restore`»,
 * то есть ровно там, где дежурному нужно различать. Замыкает набор проверка
 * полноты — она падает, если в перечень добавили ключ и забыли о нём здесь.
 */
let dir = '';

function sha256(payload: Buffer | string): string {
  return createHash('sha256').update(payload).digest('hex');
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sdelka-backup-codes-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Ключ отказа, поднятого вызовом. Не факт исключения, а именно ключ. */
async function codeOfRefusal(call: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error: unknown) {
    if (error instanceof BackupError) return error.code;
    throw error;
  }
  throw new Error('backup.test.expected_refusal');
}

/** Ключи, поднятые исключением. */
const THROWN: ReadonlyArray<{
  readonly code: BackupErrorCode;
  readonly title: string;
  readonly call: () => unknown | Promise<unknown>;
}> = [
  {
    code: BackupErrorCode.urlInvalid,
    title: 'строка подключения не разбирается',
    call: () => libpqEnv('host=127.0.0.1 dbname=x'),
  },
  {
    code: BackupErrorCode.envMissing,
    title: 'переменная окружения не задана',
    call: () => requireEnv(BACKUP_DIR_ENV, {}),
  },
  {
    code: BackupErrorCode.commandFailed,
    title: 'внешняя команда вышла с ненулевым кодом',
    call: async () =>
      await runOrThrow(process.execPath, ['-e', 'process.exit(2)'], { env: {} }),
  },
  {
    code: BackupErrorCode.commandMissing,
    title: 'внешней команды нет в PATH',
    call: async () =>
      await runOrThrow('sdelka-pg-dump-которого-нет', [], { env: {} }),
  },
  {
    code: BackupErrorCode.setIncomplete,
    title: 'файла нет в перечне контрольных сумм',
    call: () => digestOf([{ digest: 'a'.repeat(64), file: 'other.dump' }], 'sdelka.dump'),
  },
  {
    code: BackupErrorCode.manifestInvalid,
    title: 'слепок не разбирается',
    call: () => parseManifest('{'),
  },
  {
    code: BackupErrorCode.digestMismatch,
    title: 'контрольная сумма дампа не сошлась',
    call: async () => {
      const set = await writeBackupSet(dir, 'digest-dump');
      // Один подменённый байт. Ровно так выглядит и порча носителя, и
      // дописывание в файл: `pg_restore` на этом не спотыкается.
      await writeFile(set.dumpPath, Buffer.from('PGDMP-не-настоящий-дамq'));
      return await openBackupSet(set.dumpPath);
    },
  },
  {
    code: BackupErrorCode.targetIsSource,
    title: 'цель восстановления совпала с источником',
    call: async () => {
      const set = await writeBackupSet(dir, 'target-is-source');
      return await restoreForDrill({
        set: await openBackupSet(set.dumpPath),
        // База пересоздаётся целиком, поэтому совпадение имён — отказ **до**
        // единой команды: цена ошибки здесь — снесённая боевая база.
        targetUrl: `postgresql://u@127.0.0.1:1/${set.manifest.database}`,
      });
    },
  },
];

/** Ключи, поднятые расхождением сверки: они не бросаются, а собираются. */
const FOUND: ReadonlyArray<{
  readonly code: BackupErrorCode;
  readonly title: string;
  readonly call: () => readonly { readonly code: string }[];
}> = [
  {
    code: BackupErrorCode.schemaVersionMismatch,
    title: 'версия схемы разошлась',
    call: () => compareCensus(census(), census({ schemaVersion: '0001' })),
  },
  {
    code: BackupErrorCode.tableSetMismatch,
    title: 'набор таблиц разошёлся',
    call: () => compareCensus(census(), census({ tables: [] })),
  },
  {
    code: BackupErrorCode.tableRowsMismatch,
    title: 'число строк таблицы разошлось',
    call: () =>
      compareCensus(
        census(),
        census({ tables: census().tables.map((item) => ({ ...item, rows: '0' })) }),
      ),
  },
  {
    code: BackupErrorCode.chainSetMismatch,
    title: 'набор цепочек разошёлся',
    call: () => compareCensus(census(), census({ chains: [] })),
  },
  {
    code: BackupErrorCode.chainLengthMismatch,
    title: 'длина цепочки разошлась',
    call: () =>
      compareCensus(
        census(),
        census({ chains: census().chains.map((item) => ({ ...item, records: '1' })) }),
      ),
  },
  {
    code: BackupErrorCode.chainHeadMismatch,
    title: 'голова цепочки разошлась',
    call: () =>
      compareCensus(
        census(),
        census({ chains: census().chains.map((item) => ({ ...item, head: '0'.repeat(64) })) }),
      ),
  },
  {
    code: BackupErrorCode.postingSumMismatch,
    title: 'сумма проводок разошлась',
    call: () =>
      compareCensus(census(), census({ postingSums: [{ currency: 'GEL', sumMinor: '7' }] })),
  },
  {
    code: BackupErrorCode.coverageMismatch,
    title: 'покрытие разошлось',
    call: () => compareCensus(census(), census({ coverage: [] })),
  },
  {
    code: BackupErrorCode.nothingChecked,
    title: 'проверять было нечего',
    call: () =>
      healthFindings(census({ auditRecords: '0', journalEntries: '0' }), { allowEmpty: false }),
  },
];

describe('отказы поднимаются своим ключом', () => {
  it.each(THROWN)('$code — $title', async ({ code, call }) => {
    expect(await codeOfRefusal(call)).toBe(code);
  });
});

describe('расхождения собираются своим ключом', () => {
  it.each(FOUND)('$code — $title', ({ code, call }) => {
    expect(call().map((item) => item.code)).toContain(code);
  });
});

describe('полнота перечня', () => {
  it('у каждого ключа BackupErrorCode есть проверка', () => {
    const covered = new Set<string>([
      ...THROWN.map((item) => item.code),
      ...FOUND.map((item) => item.code),
    ]);
    const missing = Object.values(BackupErrorCode).filter((code) => !covered.has(code));
    // Новый ключ без проверки — это отказ, который никто не видел ни разу.
    expect(missing).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Чтение набора                                                             */
/* ------------------------------------------------------------------------- */

describe('чтение набора копии', () => {
  it('целый набор читается и отдаёт слепок', async () => {
    const written = await writeBackupSet(dir, 'intact');
    const set = await openBackupSet(written.dumpPath);
    expect(set.manifest).toEqual(written.manifest);
    expect(set.base).toBe(written.base);
    expect(set.manifestPath).toBe(written.manifestPath);
  });

  it('набор открывается по любому из трёх файлов', async () => {
    const written = await writeBackupSet(dir, 'by-any-file');
    for (const path of [written.dumpPath, written.manifestPath, written.checksumsPath]) {
      expect((await openBackupSet(path)).base).toBe(written.base);
    }
  });

  it('подменённый слепок отвергается наравне с дампом', async () => {
    // Сверка идёт против слепка: подменённый слепок сделал бы проверку
    // тождеством «сходится с самим собой».
    const written = await writeBackupSet(dir, 'digest-manifest');
    await writeFile(
      written.manifestPath,
      JSON.stringify({ ...written.manifest, census: census({ auditRecords: '0' }) }, null, 2),
      'utf8',
    );
    const error = await openBackupSet(written.dumpPath).catch((item: unknown) => item);
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).code).toBe(BackupErrorCode.digestMismatch);
    expect((error as BackupError).details.file).toBe(basename(written.manifestPath));
  });

  it('расхождение суммы названо файлом и обеими суммами в укороченном виде', async () => {
    const written = await writeBackupSet(dir, 'digest-details');
    await writeFile(written.dumpPath, Buffer.from('другое содержимое'));
    const error = (await openBackupSet(written.dumpPath).catch(
      (item: unknown) => item,
    )) as BackupError;
    expect(error.details.file).toBe(basename(written.dumpPath));
    expect(error.details.expected).toHaveLength(8);
    expect(error.details.actual).toHaveLength(8);
    expect(error.details.expected).not.toBe(error.details.actual);
  });

  it('пересчитанные суммы не спасают: слепок несёт свою запись о дампе', async () => {
    const written = await writeBackupSet(dir, 'resigned-sums');
    // Так выглядит не злой умысел, а обычная приёмка в хранилище: файл доехал
    // обрезанным, приёмная сторона взяла хеш того, что получила, и положила
    // рядом. Первый контур после этого сходится сам с собой.
    const truncated = Buffer.from('PGDMP');
    await writeFile(written.dumpPath, truncated);
    const manifestText = await readFile(written.manifestPath, 'utf8');
    await writeFile(
      written.checksumsPath,
      renderChecksums([
        { digest: sha256(truncated), file: basename(written.dumpPath) },
        { digest: sha256(manifestText), file: basename(written.manifestPath) },
      ]),
      'utf8',
    );
    const error = (await openBackupSet(written.dumpPath).catch(
      (item: unknown) => item,
    )) as BackupError;
    expect(error.code).toBe(BackupErrorCode.digestMismatch);
    expect(error.details.reason).toBe('manifest');
  });

  it('путь без каталога читается так же: проверку запускают из каталога с копией', async () => {
    // Прежняя редакция резала имя по длине `dirname`, а у пути `x.dump` это
    // `.` — от имени отрезались два первых знака, и целый набор объявлялся
    // неполным. Смена каталога здесь безопасна: файл набора исполняется в
    // отдельном процессе (`pool: 'forks'` — умолчание vitest).
    const written = await writeBackupSet(dir, 'bare-name');
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const set = await openBackupSet(`bare-name.dump`);
      expect(set.manifest.database).toBe(manifest().database);
    } finally {
      process.chdir(cwd);
    }
  });
});
