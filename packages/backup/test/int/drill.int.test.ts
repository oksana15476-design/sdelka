import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { expect, it } from 'vitest';
import { createBackup } from '../../src/dump.ts';
import type { BackupResult } from '../../src/dump.ts';
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
  withDatabaseName,
} from './support/drill.ts';
import { CHAIN_MAIN, CHAIN_SIDE, seedSource } from './support/seed.ts';
import type { Pool } from '../../src/pool.ts';
import type { Seeded } from './support/seed.ts';

/**
 * Полный круг: **накатили → положили данные → сняли копию → уронили схему
 * целиком → восстановились → проверили**.
 *
 * Схема источника сносится **до** восстановления и намеренно: пока источник
 * цел, круг доказывает только то, что файл прочитался. После сноса
 * восстановленная база — единственное, где эти данные есть, и совпадение с
 * переписью означает ровно то, ради чего копия и снимается: кому сколько
 * причитается, доказуемо после потери базы.
 */
const { run, title, cluster } = await drillSuite('учение: снятие, восстановление, проверка');

let admin: Pool | null = null;
let sourceName = '';
let targetName = '';
let directory = '';
let seeded: Seeded | null = null;
let backup: BackupResult | null = null;
let report: VerificationReport | null = null;
let sourceSchemaAfterDrop: string | null = 'не проверено';
let schemaVersion = '';
let restoredLargeAmount = '';

run(title, () => {
  it.sequential('круг проходит целиком', async () => {
    if (cluster === null) return;
    await loudly(async () => {
    admin = pooled(cluster);
    sourceName = scratchName('src');
    targetName = scratchName('dst');
    directory = await scratchDirectory();
    const sourceUrl = withDatabaseName(cluster, sourceName);
    const targetUrl = withDatabaseName(cluster, targetName);

    await createDatabase(admin, sourceName);
    schemaVersion = await migrateDatabase(sourceUrl);
    seeded = await seedSource(sourceUrl);

    backup = await createBackup({ connectionString: sourceUrl, directory });

    // Схема источника сносится целиком: дальше копия — единственное место, где
    // эти данные существуют.
    const source = pooled(sourceUrl);
    try {
      await source.query('DROP SCHEMA sdelka CASCADE');
      const present = await source.query<{ oid: string | null }>(
        "SELECT to_regclass('sdelka.audit_record')::text AS oid",
      );
      sourceSchemaAfterDrop = present.rows[0]?.oid ?? null;
    } finally {
      await source.end().catch(() => undefined);
    }

    const set = await openBackupSet(backup.dumpPath);
    // Служебная база берётся по умолчанию (`postgres` того же кластера) — тем
    // самым проверяется путь, которым команда ходит в бою.
    await restoreForDrill({ set, targetUrl });

    const pool = backupPool(targetUrl);
    try {
      report = await verifyRestored(pool, { manifest: set.manifest, allowEmpty: false });
      const large = await pool.query<{ amount_minor: string }>(
        `SELECT amount_minor FROM sdelka.ledger_posting
          WHERE entry_id = 'drill-e1-top-up' AND direction = 'debit'`,
      );
      restoredLargeAmount = large.rows[0]?.amount_minor ?? '';
    } finally {
      await pool.end().catch(() => undefined);
    }
    });
  }, 240_000);

  it('источника больше нет: проверять нечего, кроме копии', () => {
    if (cluster === null) return;
    expect(sourceSchemaAfterDrop).toBeNull();
  });

  it('проверка восстановленного сошлась по всем предметам', () => {
    if (cluster === null) return;
    // Расхождения печатаются целиком: «не сошлось» без состава нечинимо.
    expect(report?.findings).toEqual([]);
    expect(report?.ok).toBe(true);
  });

  it('версия схемы восстановленного — та, что ждёт код', () => {
    if (cluster === null) return;
    expect(report?.schemaVersion).toBe(schemaVersion);
    expect(backup?.manifest.census.schemaVersion).toBe(schemaVersion);
  });

  it('обе цепочки вечного журнала проверены существующей проверкой из @sdelka/audit', () => {
    if (cluster === null) return;
    expect(report?.chainsVerified).toBe(2);
    expect(backup?.manifest.census.chains.map((item) => item.chainId).sort()).toEqual(
      [CHAIN_MAIN, CHAIN_SIDE].sort(),
    );
  });

  it('число записей обоих журналов доехало', () => {
    if (cluster === null) return;
    expect(report?.auditRecords).toBe(String(seeded?.auditRecords));
    expect(report?.journalEntries).toBe(String(seeded?.journalEntries));
  });

  it('сумма проводок по каждой валюте — ноль', () => {
    if (cluster === null) return;
    const sums = backup?.manifest.census.postingSums ?? [];
    expect(sums.length).toBeGreaterThan(0);
    expect(sums.every((item) => item.sumMinor === '0')).toBe(true);
  });

  it('покрытие клиентских средств посчитано и сходится', () => {
    if (cluster === null) return;
    const points = backup?.manifest.census.coverage ?? [];
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(point.covered).toBe(true);
      expect(point.custodyMinor).toBe(point.obligationsMinor);
    }
  });

  it('сумма больше 2^53 доехала знак в знак (красная линия №4)', () => {
    if (cluster === null) return;
    expect(restoredLargeAmount).toBe('9007199254740993000');
    expect(BigInt(restoredLargeAmount)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    // Через число это значение проходит с потерей — и потеря молчаливая:
    // `String(Number(...))` печатает ту же строку, а разница в 24 единицы
    // видна только в `bigint`. Проверять надо именно значением.
    expect(BigInt(Number(restoredLargeAmount))).not.toBe(BigInt(restoredLargeAmount));
  });

  it('слепок не содержит строки подключения ни в каком виде', async () => {
    if (cluster === null || backup === null) return;
    const text = await readFile(backup.manifestPath, 'utf8');
    expect(text).not.toContain('postgresql://');
    expect(text).not.toContain('@');
    expect(text).toContain(sourceName);
  });

  it('права на файлы копии — 0600, на каталог — 0700', async () => {
    if (cluster === null || backup === null) return;
    // В копии персональные данные и вечный журнал: читать её посторонним
    // нельзя ни секунды, поэтому файл дампа заводится с правами **до** запуска
    // `pg_dump`, а не правится после.
    for (const path of [backup.dumpPath, backup.manifestPath, backup.checksumsPath]) {
      expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600');
    }
    expect(((await stat(directory)).mode & 0o777).toString(8)).toBe('700');
  });

  it('целостность копии проверяется и без нашего кода: sha256sum -c', () => {
    if (cluster === null || backup === null) return;
    const outcome = spawnSync('sha256sum', ['-c', basename(backup.checksumsPath)], {
      cwd: directory,
      encoding: 'utf8',
    });
    if (outcome.error !== undefined) {
      // Без coreutils проверить нечем — но и молчать нельзя: свойство заявлено
      // в `manifest.ts` и обязано быть либо проверено, либо названо непроверенным.
      console.warn('[@sdelka/backup] sha256sum недоступен, формат сумм не проверен снаружи');
      return;
    }
    expect(outcome.stdout).toContain('OK');
    expect(outcome.status).toBe(0);
  });

  it.sequential('за собой убрано: обе базы снесены', async () => {
    if (cluster === null || admin === null) return;
    await dropDatabase(admin, sourceName);
    await dropDatabase(admin, targetName);
    await removeDirectory(directory);
    const left = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = ANY($1)',
      [[sourceName, targetName]],
    );
    expect(left.rows).toEqual([]);
    await admin.end().catch(() => undefined);
  }, 60_000);
});
