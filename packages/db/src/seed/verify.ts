import type { PoolClient } from '../pool.ts';
import { readChain } from '../store/audit.ts';

/**
 * Проверка засеянной базы — **запросами к базе**, а не утверждениями засева.
 *
 * Смысл ровно в этом: мир, из которого шли шаги, уже проверил себя сам
 * (`sealed` после каждого шага). Здесь спрашивается то, что осталось лежать:
 * сходится ли журнал в ноль, покрыты ли клиентские средства единицей, цела ли
 * цепочка вечного журнала. Проверка, которая верит на слово тому же коду, что
 * писал, не проверяет ничего.
 *
 * Находка — **значение с техническим ключом**, а не текст: команда печатает
 * ключ, тест сверяет ключ, перевод живёт в локализации (`CLAUDE.md`).
 */
export interface SeedFinding {
  readonly code: string;
  readonly detail: string;
}

/** Ключи находок. Совпадают с ключами учёта там, где правило то же самое. */
export const SEED_FINDINGS = {
  entryUnbalanced: 'ledger.invariant.entry_unbalanced',
  coverageOff: 'ledger.invariant.coverage_below_one',
  ledgerInvariant: 'ledger.invariant',
  chainBroken: 'audit.chain.broken',
  chainEmpty: 'audit.chain.empty',
} as const;

/**
 * Сумма проводок каждой записи равна нулю — **по валютам**.
 *
 * По валютам, а не в целом: запись обмена держит две валюты, и общая сумма по
 * ней не значила бы ничего. Правило то же, что у отложенного триггера схемы
 * (`assert_entry_balanced`), и повторяется здесь намеренно: триггер отвечает за
 * момент записи, а этот запрос — за то, что лежит **сейчас**.
 */
async function unbalancedEntries(client: PoolClient): Promise<readonly SeedFinding[]> {
  const result = await client.query<{ entry_id: string; currency: string; difference: string }>(
    `SELECT p.entry_id, p.currency, sum(p.signed_minor)::text AS difference
       FROM sdelka.v_posting p
      GROUP BY p.entry_id, p.currency
     HAVING sum(p.signed_minor) <> 0`,
  );
  return result.rows.map((row) => ({
    code: SEED_FINDINGS.entryUnbalanced,
    detail: `entry_id=${row.entry_id} currency=${row.currency} difference=${row.difference}`,
  }));
}

/**
 * Покрытие клиентских средств равно единице (красная линия №3).
 *
 * Сравниваются целые минорные единицы, а не отношение с плавающей точкой:
 * «примерно единица» — это не единица (красная линия №4). Валюта без
 * клиентских денег отношения не образует и в ответе не появляется.
 */
export interface CoverageRow {
  readonly currency: string;
  readonly custodyMinor: bigint;
  readonly obligationsMinor: bigint;
}

export async function coverage(client: PoolClient): Promise<readonly CoverageRow[]> {
  const result = await client.query<{
    currency: string;
    custody_minor: string;
    obligations_minor: string;
  }>(`SELECT currency, custody_minor::text, obligations_minor::text FROM sdelka.v_coverage`);
  return result.rows.map((row) => ({
    currency: row.currency,
    custodyMinor: BigInt(row.custody_minor),
    obligationsMinor: BigInt(row.obligations_minor),
  }));
}

function coverageFindings(rows: readonly CoverageRow[]): readonly SeedFinding[] {
  return rows
    .filter((row) => row.custodyMinor !== row.obligationsMinor)
    .map((row) => ({
      code: SEED_FINDINGS.coverageOff,
      detail:
        `currency=${row.currency} custody=${row.custodyMinor}` +
        ` obligations=${row.obligationsMinor}`,
    }));
}

/** Все расхождения учёта, которые база считает сама (`v_ledger_invariant_violation`). */
async function ledgerViolations(client: PoolClient): Promise<readonly SeedFinding[]> {
  const result = await client.query<{
    code: string;
    currency: string | null;
    subject: string | null;
    amount_minor: string | null;
  }>(
    `SELECT code, currency, subject, amount_minor::text
       FROM sdelka.v_ledger_invariant_violation`,
  );
  return result.rows.map((row) => ({
    code: row.code,
    detail: `currency=${row.currency ?? '-'} subject=${row.subject ?? '-'} amount=${row.amount_minor ?? '-'}`,
  }));
}

/**
 * Цепочка вечного журнала цела.
 *
 * Целостность считает `readChain`: он поднимает записи и прогоняет их через
 * `verifyChain` (`@sdelka/audit`) — то есть сверяет генезис, нумерацию и хеши.
 * Отдельной реализации проверки здесь нет намеренно: вторая реализация
 * означала бы второй ответ на вопрос «цела ли цепочка».
 */
async function chainFindings(
  client: PoolClient,
  chainIds: readonly string[],
): Promise<readonly SeedFinding[]> {
  const findings: SeedFinding[] = [];
  for (const chainId of chainIds) {
    try {
      const chain = await readChain(client, chainId);
      if (chain.records.length === 0) {
        findings.push({ code: SEED_FINDINGS.chainEmpty, detail: `chain_id=${chainId}` });
      }
    } catch (error) {
      findings.push({
        code: SEED_FINDINGS.chainBroken,
        detail: `chain_id=${chainId} ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return findings;
}

export interface SeedVerification {
  readonly findings: readonly SeedFinding[];
  readonly coverage: readonly CoverageRow[];
  readonly entries: number;
  readonly records: number;
}

/**
 * Проверка после засева. Пустой список находок — база в том виде, в котором её
 * можно показывать: журнал сходится, клиентские средства покрыты, цепочка цела.
 */
export async function verifySeed(
  client: PoolClient,
  chainIds: readonly string[],
): Promise<SeedVerification> {
  const rows = await coverage(client);
  const findings = [
    ...(await unbalancedEntries(client)),
    ...coverageFindings(rows),
    ...(await ledgerViolations(client)),
    ...(await chainFindings(client, chainIds)),
  ];
  const counted = await client.query<{ entries: string; records: string }>(
    `SELECT (SELECT count(*) FROM sdelka.ledger_entry)::text AS entries,
            (SELECT count(*) FROM sdelka.audit_record)::text AS records`,
  );
  return {
    findings: Object.freeze(findings),
    coverage: rows,
    entries: Number(counted.rows[0]?.entries ?? '0'),
    records: Number(counted.rows[0]?.records ?? '0'),
  };
}
