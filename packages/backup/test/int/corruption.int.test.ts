import { createHash } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { DbErrorCode } from '@sdelka/db';
import { LedgerErrorCode } from '@sdelka/ledger';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { failureLine } from '../../src/cli/report.ts';
import type { BackupResult } from '../../src/dump.ts';
import { createBackup } from '../../src/dump.ts';
import { BackupError, BackupErrorCode } from '../../src/errors.ts';
import { renderChecksums } from '../../src/manifest.ts';
import type { Pool } from '../../src/pool.ts';
import { backupPool } from '../../src/pool.ts';
import { openBackupSet, restoreForDrill } from '../../src/restore.ts';
import type { VerificationReport } from '../../src/verify.ts';
import { verifyRestored } from '../../src/verify.ts';
import {
  createDatabase,
  drillSuite,
  dropDatabase,
  loudly,
  migrateDatabase,
  pooled,
  removeDirectory,
  scratchDirectory,
  scratchName,
  tamper,
  withDatabaseName,
} from './support/drill.ts';
import { CHAIN_MAIN, seedSource } from './support/seed.ts';

/**
 * **Проверка обязана падать.** Набор, проверяющий только удачный путь, здесь
 * бесполезен: «файл прочитался, `pg_restore` не ругался» проходит и на
 * обрезанном дампе, и на копии не той базы, и на пустой базе — то есть ровно в
 * тех трёх случаях, ради которых проверку и пишут.
 *
 * Поэтому каждое учение здесь ломает копию **своим** способом и требует не
 * «отказа вообще», а **имени поломки**: дежурному нужен состав, а не факт.
 *
 * Порядок способов — от «файл испорчен» к «данные испорчены»:
 *
 * 1. байт в дампе — контрольная сумма;
 * 2. обрезанный дамп с пересчитанными суммами — запись слепка;
 * 3. обрезанный дамп с пересобранным набором целиком — восстановление;
 * 4. пропавшая запись журнала аудита — перепись;
 * 5. подменённая запись журнала аудита — цепочка (проверкой из `@sdelka/audit`);
 * 6. уехавшая сумма проводки — сумма журнала;
 * 7. откаченная версия схемы — ворота старта;
 * 8. пустая база — «проверять было нечего».
 */
const { run, title, cluster } = await drillSuite('учение: испорченная копия');

let admin: Pool | null = null;
let sourceName = '';
let emptyName = '';
let targetName = '';
let directory = '';
let cluster_ = '';
let backup: BackupResult | null = null;
let emptyBackup: BackupResult | null = null;

function targetUrl(): string {
  return withDatabaseName(cluster_, targetName);
}

/** Свежее восстановление: цель пересоздаётся целиком, прошлый прогон не мешает. */
async function restored(set: BackupResult): Promise<void> {
  await loudly(async () => {
    await restoreForDrill({
      set: await openBackupSet(set.dumpPath),
      targetUrl: targetUrl(),
      adminUrl: cluster_,
    });
  });
}

async function verify(
  manifest: BackupResult['manifest'],
  allowEmpty = false,
): Promise<VerificationReport> {
  const pool = backupPool(targetUrl());
  try {
    return await verifyRestored(pool, { manifest, allowEmpty });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Ключи расхождений в порядке появления. Сравнивать удобнее именно их. */
function codes(report: VerificationReport): readonly string[] {
  return report.findings.map((item) => item.code);
}

function detailsOf(report: VerificationReport, code: string): Record<string, string> {
  return { ...report.findings.find((item) => item.code === code)?.details };
}

beforeAll(async () => {
  if (cluster === null) return;
  cluster_ = cluster;
  admin = pooled(cluster);
  sourceName = scratchName('src');
  emptyName = scratchName('src');
  targetName = scratchName('dst');
  directory = await scratchDirectory();

  await loudly(async () => {
    await createDatabase(admin as Pool, sourceName);
    const sourceUrl = withDatabaseName(cluster, sourceName);
    await migrateDatabase(sourceUrl);
    await seedSource(sourceUrl);
    backup = await createBackup({ connectionString: sourceUrl, directory });

    // Вторая база — накаченная и **пустая**: копия с неё внешне безупречна.
    await createDatabase(admin as Pool, emptyName);
    const emptyUrl = withDatabaseName(cluster, emptyName);
    await migrateDatabase(emptyUrl);
    emptyBackup = await createBackup({ connectionString: emptyUrl, directory });
  });
}, 240_000);

afterAll(async () => {
  if (admin === null) return;
  await dropDatabase(admin, sourceName);
  await dropDatabase(admin, emptyName);
  await dropDatabase(admin, targetName);
  await removeDirectory(directory);
  await admin.end().catch(() => undefined);
}, 60_000);

run(title, () => {
  it('байт в дампе: набор не открывается вовсе', async () => {
    if (cluster === null || backup === null) return;
    const original = await readFile(backup.dumpPath);
    try {
      const damaged = Buffer.from(original);
      // Один байт в середине. `pg_restore` на таком не спотыкается: он читает
      // молча ровно до места порчи.
      const at = Math.floor(damaged.length / 2);
      damaged[at] = (damaged[at] ?? 0) ^ 0xff;
      await writeFile(backup.dumpPath, damaged);

      const error = (await openBackupSet(backup.dumpPath).catch(
        (item: unknown) => item,
      )) as BackupError;
      expect(error).toBeInstanceOf(BackupError);
      expect(error.code).toBe(BackupErrorCode.digestMismatch);
      // Названо, что именно не сошлось: файл и обе суммы.
      expect(error.details.file).toBe(basename(backup.dumpPath));
      expect(error.details.expected).not.toBe(error.details.actual);
    } finally {
      await writeFile(backup.dumpPath, original);
    }
  });

  it('обрезанный дамп с пересчитанными суммами: ловится записью слепка', async () => {
    if (cluster === null || backup === null) return;
    const original = await readFile(backup.dumpPath);
    const originalSums = await readFile(backup.checksumsPath, 'utf8');
    try {
      const truncated = original.subarray(0, Math.floor(original.length / 2));
      await writeFile(backup.dumpPath, truncated);
      const manifestText = await readFile(backup.manifestPath, 'utf8');
      const sha256 = (payload: Buffer | string): string =>
        createHash('sha256').update(payload).digest('hex');
      await writeFile(
        backup.checksumsPath,
        renderChecksums([
          { digest: sha256(truncated), file: basename(backup.dumpPath) },
          { digest: sha256(manifestText), file: basename(backup.manifestPath) },
        ]),
        'utf8',
      );

      const error = (await openBackupSet(backup.dumpPath).catch(
        (item: unknown) => item,
      )) as BackupError;
      expect(error.code).toBe(BackupErrorCode.digestMismatch);
      expect(error.details.reason).toBe('manifest');
    } finally {
      await writeFile(backup.dumpPath, original);
      await writeFile(backup.checksumsPath, originalSums, 'utf8');
    }
  });

  it('обрезанный дамп с пересобранным набором целиком: ловится восстановлением', async () => {
    if (cluster === null || backup === null) return;
    // Крайний случай: пересчитаны **и** суммы, и слепок. Сверить копию с самой
    // собой больше нечем — остаётся только поднять её, и она не поднимается.
    const truncated = (await readFile(backup.dumpPath)).subarray(0, 4_096);
    const base = `${directory}/resigned`;
    const dumpPath = `${base}.dump`;
    await (await open(dumpPath, 'w', 0o600)).close();
    await writeFile(dumpPath, truncated);
    const sha256 = (payload: Buffer | string): string =>
      createHash('sha256').update(payload).digest('hex');
    const manifestText = `${JSON.stringify(
      {
        ...backup.manifest,
        dumpFile: 'resigned.dump',
        dumpBytes: truncated.byteLength.toString(),
        dumpSha256: sha256(truncated),
      },
      null,
      2,
    )}\n`;
    await writeFile(`${base}.manifest.json`, manifestText, 'utf8');
    await writeFile(
      `${base}.sha256`,
      renderChecksums([
        { digest: sha256(truncated), file: 'resigned.dump' },
        { digest: sha256(manifestText), file: 'resigned.manifest.json' },
      ]),
      'utf8',
    );

    const set = await openBackupSet(dumpPath);
    const error = (await restoreForDrill({
      set,
      targetUrl: targetUrl(),
      adminUrl: cluster_,
    }).catch((item: unknown) => item)) as BackupError;
    expect(error).toBeInstanceOf(BackupError);
    expect(error.code).toBe(BackupErrorCode.commandFailed);
    expect(error.details.command).toBe('pg_restore');
    // Сказано, чем именно не понравилось: хвост вывода `pg_restore`.
    expect(error.details.stderr ?? '').toContain('pg_restore');
  }, 120_000);

  it('пропавшая запись журнала аудита: перепись называет цепочку и обе длины', async () => {
    if (cluster === null || backup === null) return;
    await restored(backup);
    await tamper(targetUrl(), [
      `DELETE FROM sdelka.audit_record
        WHERE chain_id = '${CHAIN_MAIN}'
          AND seq = (SELECT max(seq) FROM sdelka.audit_record WHERE chain_id = '${CHAIN_MAIN}')`,
    ]);

    const report = await verify(backup.manifest);
    expect(report.ok).toBe(false);
    // Цепочка после отрезанного хвоста **остаётся целой**: проверка сцепки
    // такого не видит по построению — начало цепочки сходится с самим собой.
    // Ловит это только перепись, и в этом весь её смысл.
    expect(report.chainsVerified).toBe(2);
    expect(codes(report)).toContain(BackupErrorCode.tableRowsMismatch);
    expect(codes(report)).toContain(BackupErrorCode.chainLengthMismatch);
    expect(codes(report)).toContain(BackupErrorCode.chainHeadMismatch);
    expect(detailsOf(report, BackupErrorCode.tableRowsMismatch)).toEqual({
      table: 'audit_record',
      expected: '4',
      actual: '3',
    });
    expect(detailsOf(report, BackupErrorCode.chainLengthMismatch)).toEqual({
      chainId: CHAIN_MAIN,
      expected: '3',
      actual: '2',
    });
  }, 120_000);

  it('подменённая запись журнала аудита: ловится проверкой цепочки из @sdelka/audit', async () => {
    if (cluster === null || backup === null) return;
    await restored(backup);
    // Правится **конверт**, а не хеш: число записей и голова цепочки в колонке
    // остаются прежними, то есть перепись сходится. Расхождение видит только
    // пересчёт хеша, и он берётся существующей проверкой (`readChain` →
    // `verifyChain`), а не пишется здесь второй раз.
    await tamper(targetUrl(), [
      `UPDATE sdelka.audit_record
          SET recorded_at = recorded_at + interval '1 second'
        WHERE chain_id = '${CHAIN_MAIN}' AND seq = 1`,
    ]);

    const report = await verify(backup.manifest);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain(DbErrorCode.auditRecordHashMismatch);
    expect(detailsOf(report, DbErrorCode.auditRecordHashMismatch).chainId).toBe(CHAIN_MAIN);
    // Одна цепочка из двух проверена, вторая — порвана.
    expect(report.chainsVerified).toBe(1);
  }, 120_000);

  it('уехавшая сумма проводки: отказ называет ключ инварианта учёта', async () => {
    if (cluster === null || backup === null) return;
    await restored(backup);
    // Строк столько же, сумма другая. Число строк такого не ловит вовсе.
    await tamper(targetUrl(), [
      `UPDATE sdelka.ledger_posting
          SET amount_minor = amount_minor + 1
        WHERE entry_id = 'drill-e2-top-up' AND direction = 'debit'`,
    ]);

    const outcome = await verify(backup.manifest).catch((error: unknown) => error);
    // Перечня расхождений здесь **не будет**, и это правильно: журнал
    // поднимается теми же правилами учёта, что и в бою (`readJournal` →
    // `appendEntry`), и несбалансированную запись они не принимают вовсе.
    // Проверка отвечает отказом раньше, чем успевает сравнить суммы, — тем же
    // ключом, что поднялся бы на проде, и с величиной расхождения.
    expect(outcome).toBeInstanceOf(Error);
    expect(failureLine(outcome)).toBe(
      `${LedgerErrorCode.entryUnbalanced} currency=GEL difference=1`,
    );
  }, 120_000);

  it('откаченная версия схемы: ворота старта и перепись говорят об этом хором', async () => {
    if (cluster === null || backup === null) return;
    await restored(backup);
    await tamper(targetUrl(), [
      `DELETE FROM sdelka.schema_migration
        WHERE version = (SELECT max(version) FROM sdelka.schema_migration)`,
    ]);

    const report = await verify(backup.manifest);
    expect(report.ok).toBe(false);
    // Ворота старта приложения — тот же код, что и в бою.
    expect(codes(report)).toContain(DbErrorCode.schemaBehind);
    expect(codes(report)).toContain(BackupErrorCode.schemaVersionMismatch);
    expect(report.schemaVersion).toBe('');
  }, 120_000);

  it('копия пустой базы: «проверять было нечего» — это отказ, а не успех', async () => {
    if (cluster === null || emptyBackup === null) return;
    await restored(emptyBackup);
    const report = await verify(emptyBackup.manifest);
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual([BackupErrorCode.nothingChecked]);
    expect(detailsOf(report, BackupErrorCode.nothingChecked)).toEqual({
      auditRecords: '0',
      journalEntries: '0',
    });
  }, 120_000);

  it('пустоту разрешает только явный флаг — и тогда копия признаётся целой', async () => {
    if (cluster === null || emptyBackup === null) return;
    const report = await verify(emptyBackup.manifest, true);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  }, 120_000);
});
