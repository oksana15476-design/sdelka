import type { Census } from '../../src/census.ts';
import { CENSUS_FORMAT_VERSION } from '../../src/census.ts';
import type { BackupManifest } from '../../src/manifest.ts';
import { MANIFEST_FORMAT_VERSION } from '../../src/manifest.ts';

/**
 * Слепки для бессетевого набора.
 *
 * Перепись собирается **руками**, а не снятием с базы: набор проверяет сверку,
 * а не съём. Значения при этом настоящей формы — количества строками (красная
 * линия №4), хеши шестидесяти четырёх знаков, суммы проводок в ноль. Форма
 * важна: сверка сравнивает строки, и `0` против `-0` она обязана различать
 * ровно так же, как их различает `census.ts`.
 */
export function census(overrides: Partial<Census> = {}): Census {
  return Object.freeze({
    formatVersion: CENSUS_FORMAT_VERSION,
    schemaVersion: '0023',
    migrations: Object.freeze([
      Object.freeze({ version: '0001', checksum: '1'.repeat(64) }),
      Object.freeze({ version: '0023', checksum: '2'.repeat(64) }),
    ]),
    tables: Object.freeze([
      Object.freeze({ table: 'audit_record', rows: '3' }),
      Object.freeze({ table: 'ledger_entry', rows: '2' }),
      Object.freeze({ table: 'ledger_posting', rows: '4' }),
    ]),
    auditRecords: '3',
    chains: Object.freeze([
      Object.freeze({ chainId: 'chain-a', records: '2', head: 'a'.repeat(64) }),
      Object.freeze({ chainId: 'chain-b', records: '1', head: 'b'.repeat(64) }),
    ]),
    journalEntries: '2',
    postingSums: Object.freeze([
      Object.freeze({ currency: 'GEL', sumMinor: '0' }),
      Object.freeze({ currency: 'USD', sumMinor: '0' }),
    ]),
    coverage: Object.freeze([
      Object.freeze({
        currency: 'GEL',
        custodyMinor: '20000000',
        obligationsMinor: '20000000',
        covered: true,
      }),
    ]),
    ...overrides,
  });
}

export function manifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return Object.freeze({
    formatVersion: MANIFEST_FORMAT_VERSION,
    takenAt: '2026-03-01T03:15:00.000Z',
    database: 'sdelka_source',
    serverVersion: '16.4',
    toolVersion: 'pg_dump (PostgreSQL) 16.4',
    dumpFile: 'sdelka-sdelka_source-20260301T031500Z.dump',
    dumpBytes: '4096',
    dumpSha256: 'f'.repeat(64),
    census: census(),
    ...overrides,
  });
}

/**
 * Перепись с теми же строками в другом порядке.
 *
 * Порядок в переписи задан `ORDER BY`, но полагаться на него сверке нельзя:
 * сортировка зависит от `LC_COLLATE`, а восстановленная база не обязана иметь
 * ту же локаль, что источник. Сверка, чувствительная к порядку, объявила бы
 * целую копию порванной — и объявила бы это списком на все таблицы разом.
 */
export function shuffled(source: Census): Census {
  return Object.freeze({
    ...source,
    tables: Object.freeze([...source.tables].reverse()),
    chains: Object.freeze([...source.chains].reverse()),
    postingSums: Object.freeze([...source.postingSums].reverse()),
    coverage: Object.freeze([...source.coverage].reverse()),
  });
}
