import type { Journal, JournalEntry } from '@sdelka/ledger';
import type { PoolClient } from '../../../src/pool.ts';
import { toBigInt } from '../../../src/pool.ts';
import { accountColumns, attributionColumns } from '../../../src/store/journal.ts';

/**
 * Заливка журнала для набора-зеркала.
 *
 * **Почему это не порт хранилища и почему так и должно быть.** Набор
 * `mirror.int.test.ts` сверяет два независимых воплощения одних и тех же
 * правил: представления SQL (`v_ledger_invariant_violation`) и
 * `checkLedgerInvariants` в TS. Ему нужно класть в таблицы **любые** проводки,
 * включая те, которые порт писать отказывается: расчёт с начислением комиссии,
 * три записи обмена, довнесение недостачи. Отказ порта на них — не дефект
 * набора, а честный ответ на то, что в `sdelka.ledger_entry` нет колонок под
 * объявления `converts`, `accrues` и `funds` (см. `DbErrorCode.
 * entryDeclarationNotStorable`). Пропустить эти случаи мимо зеркала значило бы
 * перестать сверять представления там, где они сложнее всего.
 *
 * Поэтому здесь остались только `INSERT`ы, а **проекция «счёт и отнесение в
 * колонки» одна** и берётся из `src/store/journal.ts`. Второй проекции рядом с
 * настоящей быть не должно: она разъедется, и набор начнёт проверять схему тем
 * кодом, которым продукт в неё не пишет.
 *
 * Прежняя редакция этого файла утверждала, что обратной гидратации
 * `JournalEntry` «нет и не будет». Теперь она есть — разбор довода в заголовке
 * `src/store/journal.ts`.
 */
async function writePosting(
  client: PoolClient,
  entryId: string,
  ord: number,
  posting: JournalEntry['postings'][number],
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
