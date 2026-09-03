import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type Journal,
  accountBalance,
  accountCode,
  appendEntry,
  bankNominal,
  clientAccount,
  coverageByTranche,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  fundsOwnership,
  fxAccountingDiff,
  isEveryTrancheCovered,
  writeoffExpense,
} from '../src/index';

const deal = { dealId: 'd1', trancheId: 't1' };
const client = clientAccount(deal.dealId, deal.trancheId);
const collected = money('GEL', 100_000n);

/** Деньги по траншу собраны и лежат на номинальном счёте. */
function collectedJournal(): Journal {
  return appendEntry(
    emptyJournal,
    createJournalEntry({
      id: 'in-1',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.funds_received',
      postings: [debit(bankNominal('GEL'), collected, deal), credit(client, collected, deal)],
    }),
  );
}

describe('счёт списания и учётная курсовая разница в плане счетов', () => {
  it('carries the codes and the funds ownership from FUNCTIONAL.md §3.1', () => {
    expect(accountCode(writeoffExpense)).toBe('writeoff:expense');
    expect(accountCode(fxAccountingDiff)).toBe('fx:accounting:diff');
    // Оба — средства платформы: списание идёт за её счёт, курсовая разница её же.
    expect(fundsOwnership(writeoffExpense)).toBe('platform');
    expect(fundsOwnership(fxAccountingDiff)).toBe('platform');
  });

  it('closes the client obligation against the platform expense, leaving the nominal alone', () => {
    const journal = appendEntry(
      collectedJournal(),
      createJournalEntry({
        id: 'off-1',
        occurredAt: '2026-09-04T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.write_off',
        postings: [debit(client, collected, deal), credit(writeoffExpense, collected)],
      }),
    );
    expect(accountBalance(journal, client, 'GEL').minor).toBe(0n);
    // Номинальный счёт не тронут: остаток тот же, что после поступления.
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(collected.minor);
    expect(isEveryTrancheCovered(journal)).toBe(true);
  });

  /**
   * FUNCTIONAL.md §3.1 задаёт списание буквально как «дебет `writeoff:expense`,
   * кредит `client:{deal}:{tranche}`». В этом плане счетов кредит обязательства
   * его **увеличивает**, поэтому буквальная проводка не гасит обязательство, а
   * удваивает его: по траншу становится 200 000 обязательства против 100 000
   * собранных, покрытие проваливается и приём сделок останавливается
   * (красная линия №3). Тест фиксирует не желаемое поведение, а причину, по
   * которой проекция строит проводку в обратную сторону. Направление — вопрос
   * к владельцу, см. отчёт по батчу.
   */
  it('shows why the literal direction from the document is not the one implemented', () => {
    const journal = appendEntry(
      collectedJournal(),
      createJournalEntry({
        id: 'off-2',
        occurredAt: '2026-09-04T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.write_off',
        postings: [debit(writeoffExpense, collected), credit(client, collected, deal)],
      }),
    );
    expect(accountBalance(journal, client, 'GEL').minor).toBe(2n * collected.minor);
    const tranche = coverageByTranche(journal)[0];
    expect(tranche?.covered).toBe(false);
    expect(tranche?.difference.minor).toBe(-collected.minor);
  });
});
