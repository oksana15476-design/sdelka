import {
  type Journal,
  appendEntry,
  bankNominal,
  bankOperating,
  clientAccount,
  createJournalEntry,
  credit,
  debit,
  unclaimedLiability,
} from '@sdelka/ledger';
import { type Rational, split } from '@sdelka/money';
import type { Intent } from '../../src/index';

/**
 * Проекция намерений транша в проводки. Живёт в тестах намеренно: домен не
 * знает про учёт, а учёт не знает про автомат — их связывает приложение.
 * Здесь она нужна, чтобы проверять инварианты учёта на переходах автомата.
 */
export interface ProjectionOptions {
  readonly feeRate: Rational;
}

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `entry-${sequence}`;
}

export function projectIntents(
  journal: Journal,
  intents: readonly Intent[],
  options: ProjectionOptions,
): Journal {
  let result = journal;
  for (const intent of intents) {
    if (intent.type !== 'post_journal_entry') continue;
    const attribution = { dealId: intent.dealId, trancheId: intent.trancheId };
    const client = clientAccount(intent.dealId, intent.trancheId);
    const custody = bankNominal(intent.amount.currency);
    switch (intent.template) {
      case 'funds_received':
        result = appendEntry(
          result,
          createJournalEntry({
            id: nextId(),
            occurredAt: '2026-09-03T10:00:00Z',
            kind: 'settlement',
            memoKey: 'ledger.entry.funds_received',
            postings: [
              debit(custody, intent.amount, attribution),
              credit(client, intent.amount, attribution),
            ],
          }),
        );
        break;
      case 'payout_with_fee': {
        // Выплата и комиссия — одна запись (красная линия №2).
        const parts = split(intent.amount, [{ key: 'fee:income', rate: options.feeRate }]);
        const fee = parts.deductions[0]?.amount;
        result = appendEntry(
          result,
          createJournalEntry({
            id: nextId(),
            occurredAt: '2026-09-03T12:00:00Z',
            kind: 'settlement',
            memoKey: 'ledger.entry.payout',
            postings: [
              debit(client, intent.amount, attribution),
              credit(custody, parts.recipient, attribution),
              ...(fee !== undefined && fee.minor > 0n
                ? [credit({ kind: 'fee_income' }, fee)]
                : []),
            ],
          }),
        );
        break;
      }
      case 'refund':
        result = appendEntry(
          result,
          createJournalEntry({
            id: nextId(),
            occurredAt: '2026-09-03T12:00:00Z',
            kind: 'settlement',
            memoKey: 'ledger.entry.refund',
            postings: [
              debit(client, intent.amount, attribution),
              credit(custody, intent.amount, attribution),
            ],
          }),
        );
        break;
      case 'write_off':
        // Случай Б из FUNCTIONAL.md §3.1: невостребованные средства. Это и есть
        // терминальное `written_off`. Обязательство дебетуется, деньги уходят с
        // номинального счёта — на нём не остаётся остатка без признанного
        // обязательства, — и превращаются не в доход, а в другой долг:
        // `unclaimed:liability` на операционном счёте.
        //
        // Случай А (недостача при зачислении) состоянием транша не является и
        // здесь не проецируется: он живёт в проводке поступления.
        result = appendEntry(
          result,
          createJournalEntry({
            id: nextId(),
            occurredAt: '2026-09-04T12:00:00Z',
            kind: 'settlement',
            memoKey: 'ledger.entry.unclaimed',
            postings: [
              debit(client, intent.amount, attribution),
              credit(custody, intent.amount, attribution),
              debit(bankOperating(intent.amount.currency), intent.amount),
              credit(unclaimedLiability, intent.amount),
            ],
          }),
        );
        break;
    }
  }
  return result;
}
