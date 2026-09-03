import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  InvariantCode,
  appendEntry,
  bankNominal,
  checkLedgerInvariants,
  clientAccount,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  shouldStopAcceptingDeals,
} from '../src/index';

const dealA = { dealId: 'A', trancheId: 't1' };
const dealB = { dealId: 'B', trancheId: 't1' };

describe('инварианты учёта в коде', () => {
  it('reports nothing on a clean journal', () => {
    const journal = appendEntry(
      emptyJournal,
      createJournalEntry({
        id: 'e1',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.funds_received',
        postings: [
          debit(bankNominal('USD'), money('USD', 100n), dealA),
          credit(clientAccount('A', 't1'), money('USD', 100n), dealA),
        ],
      }),
    );
    expect(checkLedgerInvariants(journal)).toEqual([]);
    expect(shouldStopAcceptingDeals(journal)).toBe(false);
  });

  it('reports a negative client balance and stops accepting deals', () => {
    const journal = appendEntry(
      emptyJournal,
      createJournalEntry({
        id: 'e1',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.payout',
        postings: [
          debit(clientAccount('A', 't1'), money('USD', 50n), dealA),
          credit(bankNominal('USD'), money('USD', 50n), dealA),
        ],
      }),
    );
    const codes = checkLedgerInvariants(journal).map((violation) => violation.code);
    expect(codes).toContain(InvariantCode.negativeClientBalance);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });

  it('reports a per-tranche shortfall that the portfolio hides', () => {
    let journal = emptyJournal;
    for (const [id, deal] of [
      ['e1', dealA],
      ['e2', dealB],
    ] as const) {
      journal = appendEntry(
        journal,
        createJournalEntry({
          id,
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.funds_received',
          postings: [
            debit(bankNominal('USD'), money('USD', 100n), deal),
            credit(clientAccount(deal.dealId, deal.trancheId), money('USD', 100n), deal),
          ],
        }),
      );
    }
    journal = appendEntry(
      journal,
      createJournalEntry({
        id: 'e3',
        occurredAt: '2026-09-03T12:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.payout',
        postings: [
          debit(clientAccount('B', 't1'), money('USD', 100n), dealB),
          credit(bankNominal('USD'), money('USD', 100n), dealA),
        ],
      }),
    );
    const violations = checkLedgerInvariants(journal);
    expect(violations.map((violation) => violation.code)).toEqual([InvariantCode.trancheUncovered]);
    expect(violations[0]?.subject).toBe('A:t1');
    expect(violations[0]?.amountMinor).toBe(-100n);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });
});
