import { money, rationalEquals, rational } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type Journal,
  LedgerError,
  accountBalance,
  appendEntry,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientKey,
  clientLockedAccount,
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
import { uncheckedEntry } from './support/unchecked-entry';

const dealA = { dealId: 'A', trancheId: 't1' };
const dealB = { dealId: 'B', trancheId: 't1' };
// Владелец счёта — ключ личности (FUNCTIONAL.md §2.1): один клиент, один счёт
// на все его сделки в любых ролях. Здесь он один и тот же во всех записях.
const owner = clientKey('c1');
const clientA = clientLockedAccount(owner, dealA.dealId, dealA.trancheId);
const clientB = clientLockedAccount(owner, dealB.dealId, dealB.trancheId);
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
        credit(clientLockedAccount(owner, deal.dealId, deal.trancheId), money('USD', amount), deal),
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

  it('leaves no platform residue on the nominal account after a settlement', () => {
    // Прежняя редакция теста фиксировала обратное: комиссия признавалась
    // доходом, оставалась на номинальном счёте превышением средств над
    // обязательствами и ждала отдельного вывода. Это и был дефект — превышение
    // портфельная сверка считает покрытием, а забыть вывод ничего не мешало.
    // Теперь запись без ноги операционного счёта не собирается вовсе.
    expect(() =>
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
    ).toThrow(LedgerError);

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
          credit(bankNominal('USD'), money('USD', 100_000n), dealA),
          credit(feeIncome, money('USD', 500n)),
          debit(bankOperating('USD'), money('USD', 500n)),
        ],
      }),
    );
    const [usd] = coverage(journal);
    expect(usd?.obligations.minor).toBe(0n);
    // Ни одной копейки клиентских средств и ни одной нашей: счёт пуст.
    expect(usd?.custody.minor).toBe(0n);
    expect(usd?.difference.minor).toBe(0n);
    expect(usd?.covered).toBe(true);
    // Комиссия признана доходом и лежит на операционном счёте, а не на счёте
    // клиентских средств (красная линия №2).
    expect(accountBalance(journal, bankOperating('USD'), 'USD').minor).toBe(500n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });
});

describe('пофайловая сверка (CORE.md Ф10, красная линия №1)', () => {
  it('catches a per-deal shortfall while the portfolio coverage still balances', () => {
    let journal = funded(emptyJournal, 'e1', dealA, 100n);
    journal = funded(journal, 'e2', dealB, 100n);
    // Ошибка, которую портфельная сверка не видит: выплата по сделке B
    // финансируется средствами, отнесёнными к сделке A. Собрать её через
    // конструктор больше нельзя — красная линия №1 отвергает такую запись
    // (FUNCTIONAL.md §3.1), — но отчёт обязан видеть уже существующее
    // расхождение, поэтому запись кладётся в журнал в обход конструктора.
    const crossSubsidy = {
      id: 'e3',
      occurredAt: '2026-09-03T12:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.payout',
      postings: [
        debit(clientB, money('USD', 100n), dealB),
        credit(bankNominal('USD'), money('USD', 100n), dealA),
      ],
    } as const;
    expect(() => createJournalEntry(crossSubsidy)).toThrow(LedgerError);
    journal = appendEntry(journal, uncheckedEntry(crossSubsidy));

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
    // Код счёта изменился вместе с планом счетов (E12-1, FUNCTIONAL.md §3.1):
    // обязательство под транш теперь несёт и владельца. Само утверждение то же:
    // отрицательный остаток клиентского счёта обязан быть виден.
    expect(violations.map((item) => item.accountCode)).toEqual([
      'bank:nominal:usd',
      'client:c1:tranche:A:t1',
    ]);
  });
});
