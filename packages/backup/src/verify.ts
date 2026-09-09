import { assertSchemaCurrent, readChain } from '@sdelka/db';
import { InvariantCode } from '@sdelka/ledger';
import type { Census, ChainSummary, CoveragePoint, PostingSum, TableCount } from './census.ts';
import { takeCensus } from './census.ts';
import { BackupErrorCode } from './errors.ts';
import type { BackupManifest } from './manifest.ts';
import type { Pool, PoolClient } from './pool.ts';

/**
 * Проверка восстановленного состояния.
 *
 * **Главное правило: проверка обязана уметь провалиться.** Проверка вида
 * «файл прочитался, `pg_restore` не ругался» проходит на обрезанном дампе, на
 * копии не той базы и на пустой базе — то есть ровно в тех трёх случаях, ради
 * которых её и пишут. Поэтому здесь сверяется не факт чтения, а **перепись**:
 * что было в источнике на момент снимка против того, что есть в восстановленном.
 *
 * Четыре предмета проверки — в порядке от «эту базу вообще нельзя читать» к
 * «данные не сходятся»:
 *
 * 1. **версия схемы** — тем же кодом, что и ворота старта приложения
 *    (`assertSchemaCurrent`), и теми же ключами отказа;
 * 2. **перепись** — состав таблиц, число строк, суммы проводок, покрытие;
 * 3. **цепочки вечного журнала** — `readChain` из `@sdelka/db`, который внутри
 *    зовёт `verifyChain` из `@sdelka/audit`. Второй проверки цепочки здесь нет
 *    и быть не должно: две реализации одного правила расходятся, и расходятся
 *    молча;
 * 4. **здоровье восстановленного** — нулевая сумма проводок и покрытие не ниже
 *    единицы, теми же кодами инвариантов (`InvariantCode`), что и в бою.
 *
 * Расхождения **собираются все**, а не только первое. Дежурному нужен состав
 * поломки: «разошлась одна таблица» и «разошлось всё» чинятся по-разному, а
 * различает их только полный перечень.
 */
export interface Finding {
  readonly code: string;
  readonly details: Readonly<Record<string, string>>;
}

function finding(code: string, details: Readonly<Record<string, string>>): Finding {
  return Object.freeze({ code, details: Object.freeze({ ...details }) });
}

/** Код отказа из чужой ошибки. У `DbError`, `AuditError` и `BackupError` он есть. */
export function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

function detailsOf(error: unknown): Readonly<Record<string, string>> {
  if (typeof error === 'object' && error !== null && 'details' in error) {
    const details = (error as { details: unknown }).details;
    if (typeof details === 'object' && details !== null) {
      return details as Readonly<Record<string, string>>;
    }
  }
  return {};
}

/* ------------------------------------------------------------------------- */
/* Сверка переписи — чистая функция, проверяемая без базы                    */
/* ------------------------------------------------------------------------- */

function byKey<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, T> {
  return new Map(items.map((item) => [key(item), item]));
}

function compareTables(expected: readonly TableCount[], actual: readonly TableCount[]): Finding[] {
  const found: Finding[] = [];
  const actualByName = byKey(actual, (item) => item.table);
  const expectedNames = new Set(expected.map((item) => item.table));
  for (const item of expected) {
    const other = actualByName.get(item.table);
    if (other === undefined) {
      found.push(finding(BackupErrorCode.tableSetMismatch, { table: item.table, side: 'missing' }));
      continue;
    }
    if (other.rows !== item.rows) {
      found.push(
        finding(BackupErrorCode.tableRowsMismatch, {
          table: item.table,
          expected: item.rows,
          actual: other.rows,
        }),
      );
    }
  }
  for (const item of actual) {
    if (!expectedNames.has(item.table)) {
      found.push(finding(BackupErrorCode.tableSetMismatch, { table: item.table, side: 'extra' }));
    }
  }
  return found;
}

function compareChains(expected: readonly ChainSummary[], actual: readonly ChainSummary[]): Finding[] {
  const found: Finding[] = [];
  const actualById = byKey(actual, (item) => item.chainId);
  const expectedIds = new Set(expected.map((item) => item.chainId));
  for (const item of expected) {
    const other = actualById.get(item.chainId);
    if (other === undefined) {
      found.push(
        finding(BackupErrorCode.chainSetMismatch, { chainId: item.chainId, side: 'missing' }),
      );
      continue;
    }
    if (other.records !== item.records) {
      found.push(
        finding(BackupErrorCode.chainLengthMismatch, {
          chainId: item.chainId,
          expected: item.records,
          actual: other.records,
        }),
      );
    }
    if (other.head !== item.head) {
      // Голову печатаем **обрезанной**: восьми знаков хватает, чтобы отличить
      // одну от другой в отчёте, а полное значение дежурному ни к чему.
      found.push(
        finding(BackupErrorCode.chainHeadMismatch, {
          chainId: item.chainId,
          expected: item.head.slice(0, 8),
          actual: other.head.slice(0, 8),
        }),
      );
    }
  }
  for (const item of actual) {
    if (!expectedIds.has(item.chainId)) {
      found.push(
        finding(BackupErrorCode.chainSetMismatch, { chainId: item.chainId, side: 'extra' }),
      );
    }
  }
  return found;
}

function comparePostings(expected: readonly PostingSum[], actual: readonly PostingSum[]): Finding[] {
  const found: Finding[] = [];
  const actualBy = byKey(actual, (item) => item.currency);
  const currencies = new Set([
    ...expected.map((item) => item.currency),
    ...actual.map((item) => item.currency),
  ]);
  for (const currency of [...currencies].sort()) {
    const left = expected.find((item) => item.currency === currency)?.sumMinor ?? '0';
    const right = actualBy.get(currency)?.sumMinor ?? '0';
    if (left !== right) {
      found.push(
        finding(BackupErrorCode.postingSumMismatch, { currency, expected: left, actual: right }),
      );
    }
  }
  return found;
}

function compareCoverage(
  expected: readonly CoveragePoint[],
  actual: readonly CoveragePoint[],
): Finding[] {
  const found: Finding[] = [];
  const actualBy = byKey(actual, (item) => item.currency);
  const currencies = new Set([
    ...expected.map((item) => item.currency),
    ...actual.map((item) => item.currency),
  ]);
  for (const currency of [...currencies].sort()) {
    const left = expected.find((item) => item.currency === currency);
    const right = actualBy.get(currency);
    if (
      left?.custodyMinor !== right?.custodyMinor ||
      left?.obligationsMinor !== right?.obligationsMinor
    ) {
      found.push(
        finding(BackupErrorCode.coverageMismatch, {
          currency,
          expectedCustody: left?.custodyMinor ?? '-',
          expectedObligations: left?.obligationsMinor ?? '-',
          actualCustody: right?.custodyMinor ?? '-',
          actualObligations: right?.obligationsMinor ?? '-',
        }),
      );
    }
  }
  return found;
}

export function compareCensus(expected: Census, actual: Census): readonly Finding[] {
  const found: Finding[] = [];
  if (expected.schemaVersion !== actual.schemaVersion) {
    found.push(
      finding(BackupErrorCode.schemaVersionMismatch, {
        expected: expected.schemaVersion,
        actual: actual.schemaVersion,
      }),
    );
  }
  const expectedMigrations = expected.migrations.map((item) => `${item.version}:${item.checksum}`);
  const actualMigrations = actual.migrations.map((item) => `${item.version}:${item.checksum}`);
  if (expectedMigrations.join(',') !== actualMigrations.join(',')) {
    found.push(
      finding(BackupErrorCode.schemaVersionMismatch, {
        reason: 'migration_set',
        expected: String(expectedMigrations.length),
        actual: String(actualMigrations.length),
      }),
    );
  }
  found.push(...compareTables(expected.tables, actual.tables));
  found.push(...compareChains(expected.chains, actual.chains));
  found.push(...comparePostings(expected.postingSums, actual.postingSums));
  found.push(...compareCoverage(expected.coverage, actual.coverage));
  return Object.freeze(found);
}

/* ------------------------------------------------------------------------- */
/* Здоровье восстановленного — тоже без базы                                 */
/* ------------------------------------------------------------------------- */

export interface HealthOptions {
  /**
   * Разрешить признать целой копию, в которой нет ни одной записи обоих
   * журналов. По умолчанию **запрещено**: см. `nothingChecked`.
   */
  readonly allowEmpty: boolean;
}

export function healthFindings(census: Census, options: HealthOptions): readonly Finding[] {
  const found: Finding[] = [];
  if (!options.allowEmpty && census.auditRecords === '0' && census.journalEntries === '0') {
    found.push(
      finding(BackupErrorCode.nothingChecked, {
        auditRecords: census.auditRecords,
        journalEntries: census.journalEntries,
      }),
    );
  }
  for (const item of census.postingSums) {
    if (item.sumMinor !== '0') {
      // Тот же ключ, что и у инварианта в бою: правило одно, значит и
      // сообщение дежурному одно.
      found.push(
        finding(InvariantCode.entryUnbalanced, {
          currency: item.currency,
          subject: 'journal',
          amountMinor: item.sumMinor,
        }),
      );
    }
  }
  for (const item of census.coverage) {
    if (!item.covered) {
      found.push(
        finding(InvariantCode.coverageBelowOne, {
          currency: item.currency,
          subject: 'portfolio',
          custody: item.custodyMinor,
          obligations: item.obligationsMinor,
        }),
      );
    }
  }
  return Object.freeze(found);
}

/* ------------------------------------------------------------------------- */
/* Проверка по живой восстановленной базе                                    */
/* ------------------------------------------------------------------------- */

export interface VerificationReport {
  readonly ok: boolean;
  readonly schemaVersion: string;
  readonly chainsVerified: number;
  readonly auditRecords: string;
  readonly journalEntries: string;
  readonly findings: readonly Finding[];
}

/**
 * Цепочки проверяются **чтением через `readChain`**. Он поднимает записи из
 * колонок, пересчитывает хеш каждой (`recordDigest`) и прогоняет цепочку через
 * `verifyChain`; разрыв поднимает ошибку с именем — `db.audit.chain_gap`,
 * `db.audit.prev_hash_mismatch`, `db.audit.record_hash_mismatch`,
 * `db.audit.genesis_required`. Ни одной строки проверки цепочки в этом пакете
 * нет намеренно.
 */
async function verifyChains(
  client: PoolClient,
  census: Census,
  found: Finding[],
): Promise<number> {
  let verified = 0;
  for (const chain of census.chains) {
    try {
      await readChain(client, chain.chainId);
      verified += 1;
    } catch (error) {
      found.push(
        finding(codeOf(error), { chainId: chain.chainId, ...detailsOf(error) }),
      );
    }
  }
  return verified;
}

export interface VerifyOptions extends HealthOptions {
  readonly manifest: BackupManifest;
}

export async function verifyRestored(
  pool: Pool,
  options: VerifyOptions,
): Promise<VerificationReport> {
  const found: Finding[] = [];
  let schemaVersion = '';
  try {
    // Ворота старта приложения, а не своя проверка версии: если восстановленная
    // база не годится приложению, она не годится и как копия.
    schemaVersion = await assertSchemaCurrent(pool);
  } catch (error) {
    found.push(finding(codeOf(error), detailsOf(error)));
  }
  const client = await pool.connect();
  try {
    const census = await takeCensus(client);
    found.push(...compareCensus(options.manifest.census, census));
    found.push(...healthFindings(census, { allowEmpty: options.allowEmpty }));
    const chainsVerified = await verifyChains(client, census, found);
    return Object.freeze({
      ok: found.length === 0,
      schemaVersion,
      chainsVerified,
      auditRecords: census.auditRecords,
      journalEntries: census.journalEntries,
      findings: Object.freeze(found),
    });
  } finally {
    client.release();
  }
}
