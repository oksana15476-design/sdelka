import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  LedgerError,
  LedgerErrorCode,
  balanceByCurrency,
  bankNominal,
  clientAccount,
  createJournalEntry,
  credit,
  debit,
} from '../src/index';

const deal = { dealId: 'd1', trancheId: 't1' };
const client = clientAccount(deal.dealId, deal.trancheId);
const feeIncome = { kind: 'fee_income' } as const;
const fxIncome = { kind: 'fx_income' } as const;

function expectCode(run: () => unknown, code: LedgerErrorCode): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
  }
}

describe('journal entry: сумма проводок равна нулю', () => {
  it('accepts the FUNCTIONAL.md §3.3 funding entry', () => {
    const entry = createJournalEntry({
      id: 'e1',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.funds_received',
      postings: [
        debit(bankNominal('USD'), money('USD', 8_000_000n), deal),
        credit(client, money('USD', 8_000_000n), deal),
      ],
    });
    expect(entry.postings).toHaveLength(2);
    expect(entry.correctsEntryId).toBeNull();
    expect([...balanceByCurrency(entry.postings).values()]).toEqual([0n]);
  });

  it('rejects an unbalanced entry instead of storing it', () => {
    expectCode(
      () =>
        createJournalEntry({
          id: 'e2',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.funds_received',
          postings: [
            debit(bankNominal('USD'), money('USD', 8_000_000n), deal),
            credit(client, money('USD', 7_999_999n), deal),
          ],
        }),
      LedgerErrorCode.entryUnbalanced,
    );
  });

  it('balances every currency separately, not in conversion', () => {
    // Одна запись конвертации из FUNCTIONAL.md §3.3, шаг 2: обе ноги внутри
    // одной записи, каждая валюта сходится сама по себе.
    const entry = createJournalEntry({
      id: 'e3',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.conversion',
      postings: [
        debit(client, money('USD', 8_000_000n), deal),
        credit(bankNominal('USD'), money('USD', 8_000_000n), deal),
        debit(bankNominal('GEL'), money('GEL', 21_500_000n), deal),
        credit(client, money('GEL', 21_349_500n), deal),
        credit(fxIncome, money('GEL', 150_500n)),
      ],
    });
    expect([...balanceByCurrency(entry.postings).values()]).toEqual([0n, 0n]);

    // А «сходится в пересчёте» — не сходится: курс не заменяет проводку.
    expectCode(
      () =>
        createJournalEntry({
          id: 'e4',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.conversion',
          postings: [
            debit(bankNominal('GEL'), money('GEL', 21_500_000n), deal),
            credit(client, money('USD', 8_000_000n), deal),
          ],
        }),
      LedgerErrorCode.entryUnbalanced,
    );
  });

  it('requires at least two postings and strictly positive amounts', () => {
    expectCode(
      () =>
        createJournalEntry({
          id: 'e5',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.funds_received',
          postings: [debit(bankNominal('USD'), money('USD', 0n), deal)],
        }),
      LedgerErrorCode.entryTooFewPostings,
    );
    expectCode(
      () =>
        createJournalEntry({
          id: 'e6',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.funds_received',
          postings: [
            debit(bankNominal('USD'), money('USD', -1n), deal),
            credit(client, money('USD', -1n), deal),
          ],
        }),
      LedgerErrorCode.postingNonPositiveAmount,
    );
  });

  it('ties a correction to the entry it corrects and forbids the reference elsewhere', () => {
    expectCode(
      () =>
        createJournalEntry({
          id: 'e7',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'correction',
          memoKey: 'ledger.entry.correction',
          postings: [
            debit(client, money('GEL', 100n), deal),
            credit(bankNominal('GEL'), money('GEL', 100n), deal),
          ],
        }),
      LedgerErrorCode.entryCorrectionWithoutReference,
    );
    expectCode(
      () =>
        createJournalEntry({
          id: 'e8',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.funds_received',
          correctsEntryId: 'e1',
          postings: [
            debit(bankNominal('GEL'), money('GEL', 100n), deal),
            credit(client, money('GEL', 100n), deal),
          ],
        }),
      LedgerErrorCode.entrySettlementWithReference,
    );
  });

  it('accepts the settlement entry where fee income is recognised in the same journal', () => {
    const entry = createJournalEntry({
      id: 'e9',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.payout',
      postings: [
        debit(client, money('GEL', 21_349_500n), deal),
        credit(bankNominal('GEL'), money('GEL', 21_242_753n), deal),
        credit(feeIncome, money('GEL', 106_747n)),
      ],
    });
    expect(entry.postings).toHaveLength(3);
  });
});
