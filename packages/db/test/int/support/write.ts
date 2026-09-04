import {
  type Account,
  type FundsRef,
  type Journal,
  type JournalEntry,
  type Posting,
  isClientRef,
} from '@sdelka/ledger';
import type { PoolClient } from '../../../src/pool.ts';
import { toBigInt } from '../../../src/pool.ts';

/**
 * Заливка журнала в базу.
 *
 * Направление одностороннее: **TS → SQL**. Обратной гидратации `JournalEntry`
 * из строк нет и не будет — `DealPartiesAttestation` держится на ambient-символе,
 * и любая реконструкция потребовала бы приведения типа, то есть уничтожила бы
 * ровно ту защиту, ради которой символ и заведён. Чтение из базы даёт плоские
 * строки, а не доменное значение.
 */
interface AccountColumns {
  readonly accountKind: string;
  readonly accountCurrency: string | null;
  readonly clientKey: string | null;
  readonly accountDealId: string | null;
  readonly accountTrancheId: string | null;
  readonly conversionId: string | null;
}

export function accountColumns(account: Account): AccountColumns {
  return {
    accountKind: account.kind,
    accountCurrency: 'currency' in account ? account.currency : null,
    clientKey: 'clientKey' in account ? account.clientKey : null,
    accountDealId: 'dealId' in account ? account.dealId : null,
    accountTrancheId: 'trancheId' in account ? account.trancheId : null,
    conversionId: 'conversionId' in account ? account.conversionId : null,
  };
}

interface AttributionColumns {
  readonly clientKey: string | null;
  readonly dealId: string | null;
  readonly trancheId: string | null;
}

export function attributionColumns(ref: FundsRef | null): AttributionColumns {
  if (ref === null) return { clientKey: null, dealId: null, trancheId: null };
  return isClientRef(ref)
    ? { clientKey: ref.clientKey, dealId: null, trancheId: null }
    : { clientKey: null, dealId: ref.dealId, trancheId: ref.trancheId };
}

async function writePosting(
  client: PoolClient,
  entryId: string,
  ord: number,
  posting: Posting,
): Promise<void> {
  const account = accountColumns(posting.account);
  const attribution = attributionColumns(posting.attribution);
  await client.query(
    `INSERT INTO sdelka.ledger_posting (
       entry_id, ord, account_kind, account_currency, client_key,
       account_deal_id, account_tranche_id, conversion_id,
       direction, currency, amount_minor,
       attribution_client_key, attribution_deal_id, attribution_tranche_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      entryId,
      ord,
      account.accountKind,
      account.accountCurrency,
      account.clientKey,
      account.accountDealId,
      account.accountTrancheId,
      account.conversionId,
      posting.direction,
      posting.amount.currency,
      // Сумма уходит в базу **строкой**, а не числом: `bigint` через число не
      // проходит нигде, включая параметр запроса.
      posting.amount.minor.toString(),
      attribution.clientKey,
      attribution.dealId,
      attribution.trancheId,
    ],
  );
}

export async function writeEntry(client: PoolClient, entry: JournalEntry): Promise<void> {
  const settles = entry.settles;
  await client.query(
    `INSERT INTO sdelka.ledger_entry (
       entry_id, occurred_at, kind, memo_key, corrects_entry_id,
       settles_deal_id, settles_tranche_id, settles_payer, settles_recipient, settles_evidence_ref
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.id,
      entry.occurredAt,
      entry.kind,
      entry.memoKey,
      entry.correctsEntryId,
      settles?.deal.dealId ?? null,
      settles?.deal.trancheId ?? null,
      settles?.payer ?? null,
      settles?.recipient ?? null,
      settles?.evidenceRef ?? null,
    ],
  );
  let ord = 0;
  for (const posting of entry.postings) {
    await writePosting(client, entry.id, ord, posting);
    ord += 1;
  }
}

export async function writeJournal(client: PoolClient, journal: Journal): Promise<void> {
  for (const entry of journal.entries) {
    await writeEntry(client, entry);
  }
}

export interface ViolationRow {
  readonly code: string;
  readonly currency: string | null;
  readonly subject: string;
  readonly amountMinor: bigint;
}

/** Сводка нарушений из базы, в том же порядке сортировки, что и у зеркала. */
export async function readViolations(client: PoolClient): Promise<readonly ViolationRow[]> {
  const result = await client.query<{
    code: string;
    currency: string | null;
    subject: string;
    amount_minor: string;
  }>(
    `SELECT code, currency, subject, amount_minor
       FROM sdelka.v_ledger_invariant_violation
      ORDER BY code, currency, subject, amount_minor`,
  );
  return result.rows.map((row) => ({
    code: row.code,
    currency: row.currency,
    subject: row.subject,
    amountMinor: toBigInt(row.amount_minor),
  }));
}
