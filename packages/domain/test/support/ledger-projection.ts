import {
  type Journal,
  appendEntry,
  bankNominal,
  clientAccount,
  createJournalEntry,
  credit,
  debit,
  writeoffExpense,
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
        // Списание идёт за счёт платформы, а не других клиентов: обязательство
        // перед клиентом закрывается счётом `writeoff:expense`, номинальный счёт
        // не трогается (FUNCTIONAL.md §3.1). Проводка «дебет обязательства,
        // кредит номинального счёта» — та самая, что закрывала бы дыру по одной
        // сделке деньгами другой, и она отвергается при построении записи.
        //
        // Направление здесь обратно буквальному тексту §3.1 («дебет
        // writeoff:expense, кредит client:{deal}:{tranche}»): в этом плане
        // счетов клиентское обязательство — пассив, и кредит его увеличивает,
        // то есть буквальная проводка не гасила бы обязательство, а удваивала
        // его и роняла покрытие по траншу. Демонстрация — в
        // `packages/ledger/test/write-off.test.ts`. Направление вынесено
        // владельцу как расхождение документа с планом счетов.
        result = appendEntry(
          result,
          createJournalEntry({
            id: nextId(),
            occurredAt: '2026-09-04T12:00:00Z',
            kind: 'settlement',
            memoKey: 'ledger.entry.write_off',
            postings: [
              debit(client, intent.amount, attribution),
              credit(writeoffExpense, intent.amount),
            ],
          }),
        );
        break;
    }
  }
  return result;
}
