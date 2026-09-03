import {
  type Journal,
  appendEntry,
  bankNominal,
  clientAccount,
  createJournalEntry,
  credit,
  debit,
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
        // FUNCTIONAL.md §3.1 не содержит счёта для ручного списания: проводка
        // не определена документом. Пока её нет, проекция отказывается угадывать.
        throw new Error('ledger.template.write_off_undefined');
    }
  }
  return result;
}
