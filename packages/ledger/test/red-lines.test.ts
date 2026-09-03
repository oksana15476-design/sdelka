import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  LedgerError,
  LedgerErrorCode,
  bankNominal,
  bankOperating,
  clientAccount,
  createJournalEntry,
  credit,
  debit,
  fundsOwnership,
  isClientCustodyAccount,
  isClientObligationAccount,
} from '../src/index';

const deal = { dealId: 'd1', trancheId: 't1' };
const client = clientAccount(deal.dealId, deal.trancheId);
const feeIncome = { kind: 'fee_income' } as const;
const suspense = { kind: 'suspense_unidentified' } as const;

describe('красная линия №2: комиссия не оседает на клиентских средствах', () => {
  it('rejects an entry whose fee lands on a client funds account', () => {
    try {
      createJournalEntry({
        id: 'e1',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.payout',
        postings: [
          debit(feeIncome, money('GEL', 106_747n)),
          credit(bankNominal('GEL'), money('GEL', 106_747n), deal),
        ],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.entryFeeIntoClientFunds);
    }
  });

  it('rejects the same move onto a client obligation account', () => {
    try {
      createJournalEntry({
        id: 'e2',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.payout',
        postings: [
          debit(feeIncome, money('GEL', 100n)),
          credit(client, money('GEL', 100n), deal),
        ],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.entryFeeIntoClientFunds);
    }
  });

  it('allows returning a wrongly charged fee only through a correction entry', () => {
    const entry = createJournalEntry({
      id: 'e3',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'correction',
      correctsEntryId: 'e0',
      memoKey: 'ledger.entry.fee_reversal',
      postings: [debit(feeIncome, money('GEL', 100n)), credit(client, money('GEL', 100n), deal)],
    });
    expect(entry.correctsEntryId).toBe('e0');
  });

  it('allows sweeping the fee onto the operating account', () => {
    const entry = createJournalEntry({
      id: 'e4',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.fee_sweep',
      postings: [
        debit(bankOperating('GEL'), money('GEL', 106_747n)),
        credit(bankNominal('GEL'), money('GEL', 106_747n), deal),
      ],
    });
    expect(entry.postings).toHaveLength(2);
  });
});

describe('счета помечены по принадлежности средств', () => {
  it('marks client funds and platform funds apart', () => {
    expect(fundsOwnership(bankNominal('GEL'))).toBe('client');
    expect(fundsOwnership(client)).toBe('client');
    expect(fundsOwnership(suspense)).toBe('client');
    expect(fundsOwnership(bankOperating('GEL'))).toBe('platform');
    expect(fundsOwnership(feeIncome)).toBe('platform');
    expect(isClientCustodyAccount(bankNominal('USD'))).toBe(true);
    expect(isClientCustodyAccount(bankOperating('USD'))).toBe(false);
    expect(isClientObligationAccount(client)).toBe(true);
    expect(isClientObligationAccount(suspense)).toBe(true);
  });
});

describe('отнесение проводок к сделке', () => {
  it('rejects a custody posting without attribution', () => {
    try {
      createJournalEntry({
        id: 'e5',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.funds_received',
        postings: [
          debit(bankNominal('USD'), money('USD', 100n)),
          credit(client, money('USD', 100n), deal),
        ],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.postingCustodyWithoutAttribution);
    }
  });

  it('allows an unidentified incoming payment to have no deal at all', () => {
    const entry = createJournalEntry({
      id: 'e6',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.unidentified_incoming',
      postings: [
        debit(bankNominal('USD'), money('USD', 100n)),
        credit(suspense, money('USD', 100n)),
      ],
    });
    expect(entry.postings[0]?.attribution).toBeNull();
  });

  it('rejects attribution that contradicts the client account it is posted to', () => {
    try {
      createJournalEntry({
        id: 'e7',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.funds_received',
        postings: [
          debit(bankNominal('USD'), money('USD', 100n), deal),
          credit(client, money('USD', 100n), { dealId: 'd2', trancheId: 't9' }),
        ],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.postingAttributionMismatch);
    }
  });
});
