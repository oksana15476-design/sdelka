import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  LedgerError,
  LedgerErrorCode,
  appendEntry,
  bankNominal,
  bankOperating,
  clientAccount,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  fundsOwnership,
  isClientCustodyAccount,
  isClientObligationAccount,
  isEveryTrancheCovered,
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

describe('красная линия №1: средства одной сделки не гасят обязательство другой', () => {
  const other = { dealId: 'd2', trancheId: 't2' };

  it('rejects settling one tranche obligation against custody attributed to another', () => {
    // Ровно та проводка, которой пытались бы списать дыру по d1 деньгами d2
    // (FUNCTIONAL.md §3.1): дебет обязательства, кредит номинального счёта,
    // встречной выплаты этому же клиенту нет.
    try {
      createJournalEntry({
        id: 'x1',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.write_off',
        postings: [
          debit(client, money('GEL', 50_000n), deal),
          credit(bankNominal('GEL'), money('GEL', 50_000n), other),
        ],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.entryClientFundsCrossSubsidy);
    }
  });

  it('rejects the same move hidden behind an unidentified posting', () => {
    // Проводка по номинальному счёту без отнесения разрешена только рядом с
    // непознанным поступлением. Эта запись пользуется тем послаблением, чтобы
    // увести с номинального счёта обезличенные средства под гашение d1.
    try {
      createJournalEntry({
        id: 'x2',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.write_off',
        postings: [
          debit(client, money('GEL', 50_000n), deal),
          credit(bankNominal('GEL'), money('GEL', 50_000n)),
          debit(bankNominal('GEL'), money('GEL', 100n)),
          credit(suspense, money('GEL', 100n)),
        ],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.entryClientFundsCrossSubsidy);
    }
  });

  it('rejects it in a correction entry too', () => {
    // У законного исправления обратная форма (дебет номинального, кредит
    // обязательства), поэтому исключения для `correction` здесь нет.
    try {
      createJournalEntry({
        id: 'x3',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'correction',
        correctsEntryId: 'x0',
        memoKey: 'ledger.entry.write_off',
        postings: [
          debit(client, money('GEL', 50_000n), deal),
          credit(bankNominal('GEL'), money('GEL', 50_000n), other),
        ],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.entryClientFundsCrossSubsidy);
    }
  });

  it('allows the payout of the tranche own funds, fee included', () => {
    const entry = createJournalEntry({
      id: 'x4',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.payout',
      postings: [
        debit(client, money('GEL', 50_000n), deal),
        credit(bankNominal('GEL'), money('GEL', 49_750n), deal),
        credit(feeIncome, money('GEL', 250n)),
      ],
    });
    expect(entry.postings).toHaveLength(3);
  });

  /**
   * Известная и осознанно оставленная дыра. Запись ниже переносит обеспечение
   * с транша d1 на транш d2, не трогая ни одного обязательства: по форме она
   * неотличима от законного вывода комиссии на операционный счёт, где кредит
   * кастодиана тоже стоит без дебета обязательства. При построении записи её не
   * поймать — ловит пофайловое обеспечение (`coverageByTranche`), но уже после
   * факта. Закрывается вместе со сверкой в E7; до тех пор тест держит дыру
   * видимой, чтобы её не сочли невозможной.
   */
  it('does not catch a custody re-attribution between tranches — known gap, closed in E7', () => {
    const entry = createJournalEntry({
      id: 'x6',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.custody_reattribution',
      postings: [
        debit(bankNominal('GEL'), money('GEL', 1_000n), other),
        credit(bankNominal('GEL'), money('GEL', 1_000n), deal),
      ],
    });
    expect(entry.postings).toHaveLength(2);
    // Отчётность видит то, чего не увидело построение записи.
    const journal = appendEntry(emptyJournal, entry);
    expect(isEveryTrancheCovered(journal)).toBe(false);
  });

  it('allows returning an unidentified incoming payment', () => {
    // Непознанное поступление возвращается теми же обезличенными средствами:
    // сделки у него нет, и это не дефект отнесения, а его определение.
    const entry = createJournalEntry({
      id: 'x5',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.unidentified_returned',
      postings: [
        debit(suspense, money('GEL', 100n)),
        credit(bankNominal('GEL'), money('GEL', 100n)),
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
