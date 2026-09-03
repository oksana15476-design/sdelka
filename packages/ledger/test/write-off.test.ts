import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type Journal,
  accountBalance,
  accountCode,
  accountType,
  appendEntry,
  bankNominal,
  bankOperating,
  clientKey,
  clientLockedAccount,
  coverageByTranche,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  fundsOwnership,
  fxAccountingDiff,
  isEveryTrancheCovered,
  shortfallExpense,
  unclaimedLiability,
} from '../src/index';

const deal = { dealId: 'd1', trancheId: 't1' };
// Владелец счёта — ключ личности (FUNCTIONAL.md §2.1): один клиент, один счёт
// на все его сделки в любых ролях. Здесь он один и тот же во всех записях.
const owner = clientKey('c1');
const client = clientLockedAccount(owner, deal.dealId, deal.trancheId);
const owed = money('GEL', 100_000n);

/** Деньги по траншу дошли полностью и лежат на номинальном счёте. */
function collectedJournal(): Journal {
  return appendEntry(
    emptyJournal,
    createJournalEntry({
      id: 'in-1',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.funds_received',
      postings: [debit(bankNominal('GEL'), owed, deal), credit(client, owed, deal)],
    }),
  );
}

describe('счета из FUNCTIONAL.md §3.1', () => {
  it('carries the codes, the types and the funds ownership', () => {
    expect(accountCode(shortfallExpense)).toBe('shortfall:expense');
    expect(accountCode(unclaimedLiability)).toBe('unclaimed:liability');
    expect(accountCode(fxAccountingDiff)).toBe('fx:accounting:diff');
    expect(accountType(shortfallExpense)).toBe('expense');
    // Невостребованные средства — обязательство, а не доход: они не становятся
    // нашими, пока юрист не ответил, как с ними обращаться ([открыто] §3.1).
    expect(accountType(unclaimedLiability)).toBe('liability');
    expect(fundsOwnership(shortfallExpense)).toBe('platform');
    expect(fundsOwnership(unclaimedLiability)).toBe('client');
  });
});

describe('случай А: недостача при зачислении (FUNCTIONAL.md §3.1)', () => {
  /** Корреспондент снял 100 при проходе: пришло 99 900, должны 100 000. */
  const received = money('GEL', 99_900n);
  const shortfall = money('GEL', 100n);

  it('brings the obligation up to the full amount at the platform expense', () => {
    const journal = appendEntry(
      emptyJournal,
      createJournalEntry({
        id: 'in-2',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.funds_received',
        postings: [
          debit(bankNominal('GEL'), received, deal),
          debit(shortfallExpense, shortfall),
          credit(client, owed, deal),
        ],
      }),
    );
    // Обязательство — на полную сумму, разницу признали расходом сразу.
    expect(accountBalance(journal, client, 'GEL').minor).toBe(owed.minor);
    expect(accountBalance(journal, shortfallExpense, 'GEL').minor).toBe(shortfall.minor);
    // Здесь прежнее направление «дебет расхода, кредит обязательства» верно:
    // оно доводит обязательство до полной суммы за счёт платформы.
  });

  it('leaves the tranche uncovered until the platform actually moves the money', () => {
    // §3.1 описывает случай А одной записью, но признание расхода — это ещё не
    // перевод. Пока платформа физически не довнесла 100 на номинальный счёт,
    // обеспечение транша меньше единицы: обязательство 100 000 против 99 900
    // фактических. Второй записи в документе нет — вынесено в отчёт.
    let journal = appendEntry(
      emptyJournal,
      createJournalEntry({
        id: 'in-3',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.funds_received',
        postings: [
          debit(bankNominal('GEL'), received, deal),
          debit(shortfallExpense, shortfall),
          credit(client, owed, deal),
        ],
      }),
    );
    expect(isEveryTrancheCovered(journal)).toBe(false);
    expect(coverageByTranche(journal)[0]?.difference.minor).toBe(-shortfall.minor);

    journal = appendEntry(
      journal,
      createJournalEntry({
        id: 'topup-1',
        occurredAt: '2026-09-03T10:05:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.shortfall_topup',
        postings: [
          debit(bankNominal('GEL'), shortfall, deal),
          credit(bankOperating('GEL'), shortfall),
        ],
      }),
    );
    expect(isEveryTrancheCovered(journal)).toBe(true);
  });
});

describe('случай Б: невостребованные средства, терминальное written_off', () => {
  it('closes the obligation, empties the nominal account and keeps the debt', () => {
    const journal = appendEntry(
      collectedJournal(),
      createJournalEntry({
        id: 'off-1',
        occurredAt: '2026-09-04T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.unclaimed',
        postings: [
          debit(client, owed, deal),
          credit(bankNominal('GEL'), owed, deal),
          debit(bankOperating('GEL'), owed),
          credit(unclaimedLiability, owed),
        ],
      }),
    );
    expect(accountBalance(journal, client, 'GEL').minor).toBe(0n);
    // На номинальном счёте не остаётся денег без признанного обязательства:
    // остаток без обязательства делает счёт нечистым (§3.1).
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(0n);
    expect(accountBalance(journal, bankOperating('GEL'), 'GEL').minor).toBe(owed.minor);
    // Деньги не стали доходом: это по-прежнему долг, просто не против транша.
    expect(accountBalance(journal, unclaimedLiability, 'GEL').minor).toBe(owed.minor);
    expect(isEveryTrancheCovered(journal)).toBe(true);
  });

  it('refuses to empty the nominal account of another tranche', () => {
    // Красная линия №1: кредит кастодиана обязан быть отнесён к тому траншу,
    // чьё обязательство дебетуется. Иначе невостребованное по одной сделке
    // уносило бы деньги другой.
    expect(() =>
      createJournalEntry({
        id: 'off-2',
        occurredAt: '2026-09-04T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.unclaimed',
        postings: [
          debit(client, owed, deal),
          credit(bankNominal('GEL'), owed, { dealId: 'd2', trancheId: 't2' }),
          debit(bankOperating('GEL'), owed),
          credit(unclaimedLiability, owed),
        ],
      }),
    ).toThrow();
  });

  /**
   * Прежняя редакция §3.1 предписывала «дебет расхода, кредит клиентского
   * обязательства» именно для этого случая. Тест сохранён: он показывает, что
   * направление случая А, применённое к случаю Б, удваивает обязательство и
   * роняет обеспечение — это и есть та ошибка, из-за которой одно слово
   * покрывало две противоположные операции.
   */
  it('shows why case A direction applied to case B breaks the coverage', () => {
    const journal = appendEntry(
      collectedJournal(),
      createJournalEntry({
        id: 'off-3',
        occurredAt: '2026-09-04T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.unclaimed',
        postings: [debit(shortfallExpense, owed), credit(client, owed, deal)],
      }),
    );
    expect(accountBalance(journal, client, 'GEL').minor).toBe(2n * owed.minor);
    expect(coverageByTranche(journal)[0]?.covered).toBe(false);
    expect(coverageByTranche(journal)[0]?.difference.minor).toBe(-owed.minor);
  });
});
