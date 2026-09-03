import { money, rationalEquals, rational } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type Journal,
  accountBalance,
  appendEntry,
  bankNominal,
  clientAccount,
  coverage,
  coverageByTranche,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  isEveryTrancheCovered,
  isFullyCovered,
  negativeClientBalances,
} from '../src/index';

const dealA = { dealId: 'A', trancheId: 't1' };
const dealB = { dealId: 'B', trancheId: 't1' };
const clientA = clientAccount(dealA.dealId, dealA.trancheId);
const clientB = clientAccount(dealB.dealId, dealB.trancheId);
const feeIncome = { kind: 'fee_income' } as const;

function funded(journal: Journal, id: string, deal: typeof dealA, amount: bigint): Journal {
  return appendEntry(
    journal,
    createJournalEntry({
      id,
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.funds_received',
      postings: [
        debit(bankNominal('USD'), money('USD', amount), deal),
        credit(clientAccount(deal.dealId, deal.trancheId), money('USD', amount), deal),
      ],
    }),
  );
}

describe('покрытие клиентских средств', () => {
  it('reports actual amounts, not a boolean', () => {
    const journal = funded(emptyJournal, 'e1', dealA, 100n);
    const [usd] = coverage(journal);
    expect(usd?.currency).toBe('USD');
    expect(usd?.custody.minor).toBe(100n);
    expect(usd?.obligations.minor).toBe(100n);
    expect(usd?.difference.minor).toBe(0n);
    expect(usd?.covered).toBe(true);
    expect(usd && usd.ratio !== null && rationalEquals(usd.ratio, rational(1n, 1n))).toBe(true);
  });

  it('reports coverage per currency, not in conversion', () => {
    let journal = funded(emptyJournal, 'e1', dealA, 100n);
    journal = appendEntry(
      journal,
      createJournalEntry({
        id: 'e2',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.funds_received',
        postings: [
          debit(bankNominal('GEL'), money('GEL', 500n), dealB),
          credit(clientB, money('GEL', 500n), dealB),
        ],
      }),
    );
    expect(coverage(journal).map((item) => item.currency)).toEqual(['GEL', 'USD']);
    expect(isFullyCovered(journal)).toBe(true);
  });

  it('shows the platform residue left on the nominal account after a settlement', () => {
    let journal = funded(emptyJournal, 'e1', dealA, 100_000n);
    journal = appendEntry(
      journal,
      createJournalEntry({
        id: 'e2',
        occurredAt: '2026-09-03T12:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.payout',
        postings: [
          debit(clientA, money('USD', 100_000n), dealA),
          credit(bankNominal('USD'), money('USD', 99_500n), dealA),
          credit(feeIncome, money('USD', 500n)),
        ],
      }),
    );
    const [usd] = coverage(journal);
    // Комиссия признана в том же журнале и до вывода на операционный счёт
    // видна как превышение средств над обязательствами — ровно та величина,
    // которая обязана обнулиться в тот же банковский день (FUNCTIONAL.md §3.3, шаг 5).
    expect(usd?.obligations.minor).toBe(0n);
    expect(usd?.custody.minor).toBe(500n);
    expect(usd?.difference.minor).toBe(500n);
    expect(usd?.covered).toBe(true);
  });
});

describe('пофайловая сверка (CORE.md Ф10, красная линия №1)', () => {
  it('catches a per-deal shortfall while the portfolio coverage still balances', () => {
    let journal = funded(emptyJournal, 'e1', dealA, 100n);
    journal = funded(journal, 'e2', dealB, 100n);
    // Ошибка, которую портфельная сверка не видит: выплата по сделке B
    // финансируется средствами, отнесёнными к сделке A.
    journal = appendEntry(
      journal,
      createJournalEntry({
        id: 'e3',
        occurredAt: '2026-09-03T12:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.payout',
        postings: [
          debit(clientB, money('USD', 100n), dealB),
          credit(bankNominal('USD'), money('USD', 100n), dealA),
        ],
      }),
    );

    const [portfolio] = coverage(journal);
    expect(portfolio?.custody.minor).toBe(100n);
    expect(portfolio?.obligations.minor).toBe(100n);
    expect(portfolio?.covered).toBe(true);

    const byTranche = coverageByTranche(journal);
    const a = byTranche.find((item) => item.deal.dealId === 'A');
    const b = byTranche.find((item) => item.deal.dealId === 'B');
    expect(a?.custody.minor).toBe(0n);
    expect(a?.obligations.minor).toBe(100n);
    expect(a?.covered).toBe(false);
    expect(b?.covered).toBe(true);
    expect(isEveryTrancheCovered(journal)).toBe(false);
  });

  it('holds for a clean two-deal journal', () => {
    let journal = funded(emptyJournal, 'e1', dealA, 100n);
    journal = funded(journal, 'e2', dealB, 250n);
    expect(isEveryTrancheCovered(journal)).toBe(true);
    expect(coverageByTranche(journal)).toHaveLength(2);
  });
});

describe('остатки счетов', () => {
  it('computes the natural balance of an account', () => {
    const journal = funded(emptyJournal, 'e1', dealA, 100n);
    expect(accountBalance(journal, clientA, 'USD').minor).toBe(100n);
    expect(accountBalance(journal, bankNominal('USD'), 'USD').minor).toBe(100n);
    expect(accountBalance(journal, clientB, 'USD').minor).toBe(0n);
  });

  it('detects a negative client balance', () => {
    const journal = appendEntry(
      emptyJournal,
      createJournalEntry({
        id: 'e1',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.payout',
        postings: [
          debit(clientA, money('USD', 50n), dealA),
          credit(bankNominal('USD'), money('USD', 50n), dealA),
        ],
      }),
    );
    const violations = negativeClientBalances(journal);
    expect(violations.map((item) => item.accountCode)).toEqual([
      'bank:nominal:usd',
      'client:A:t1',
    ]);
  });
});
