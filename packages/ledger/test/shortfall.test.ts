import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  InvariantCode,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  absorbShortfall,
  accountBalance,
  appendEntries,
  appendEntry,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientKey,
  clientTopUp,
  coverage,
  coverageByFundsSource,
  emptyJournal,
  freeBalance,
  fundShortfall,
  isFullyCovered,
  lockForTranche,
  settleTrancheToClientAccount,
  shouldStopAcceptingDeals,
  trancheSettlement,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';

const buyer = clientKey('c1');
const seller = clientKey('c2');
const payer = clientKey('c3');
const dealA = { dealId: 'A', trancheId: 't1' };
const shortfallExpenseAccount = { kind: 'shortfall_expense' } as const;

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-03T10:${String(minute).padStart(2, '0')}:00Z` };
}

function expectCode(run: () => unknown, code: LedgerErrorCodeType): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
  }
}

/**
 * Операционный счёт, пополненный комиссией за услугу: довносить недостачу
 * можно только теми деньгами, которые у платформы есть. Здесь это заработанная
 * и выведенная в расчёте комиссия — тот же путь, что и в жизни.
 */
function operatingFundedBy(feeMinor: bigint) {
  return appendEntries(emptyJournal, [
    clientTopUp(at('f1'), buyer, money('GEL', 10_000_000n)),
    lockForTranche(at('f2', 1), buyer, dealA, money('GEL', 10_000_000n)),
    settleTrancheToClientAccount(
      at('f3', 2),
      trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
      money('GEL', 10_000_000n),
      money('GEL', feeMinor),
    ),
  ]);
}

// FUNCTIONAL.md §3.1, случай А: обещано 100 000, корреспондент снял 100 при
// проходе, пришло 99 900.
const received = money('GEL', 9_990_000n);
const shortfall = money('GEL', 10_000n);
const promised = money('GEL', 10_000_000n);

describe('недостача, покрытая платформой (§3.1, случай А)', () => {
  it('brings the obligation up to the promised amount at our own expense', () => {
    const journal = appendEntry(
      emptyJournal,
      absorbShortfall(at('s1'), payer, received, shortfall),
    );

    expect(freeBalance(journal, payer, 'GEL').minor).toBe(promised.minor);
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(received.minor);
    expect(accountBalance(journal, shortfallExpenseAccount, 'GEL').minor).toBe(shortfall.minor);
  });

  /**
   * ⚠ Одной записи мало, и это проверяется, а не написано в комментарии.
   * Признание расхода — не перевод денег: до довнесения на номинальном счёте
   * 99 900 против обязательства в 100 000.
   */
  it('leaves the client file uncovered until the top-up, and stops new deals', () => {
    const journal = appendEntry(
      emptyJournal,
      absorbShortfall(at('s1'), payer, received, shortfall),
    );

    expect(isFullyCovered(journal)).toBe(false);
    expect(coverage(journal).map((item) => [item.currency, item.difference.minor])).toEqual([
      ['GEL', -10_000n],
    ]);
    const codes = checkLedgerInvariants(journal).map((item) => item.code);
    expect(codes).toContain(InvariantCode.coverageBelowOne);
    expect(codes).toContain(InvariantCode.clientAccountUncovered);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });

  it('restores coverage with the second entry — the transfer from the operating account', () => {
    let journal = operatingFundedBy(50_000n);
    journal = appendEntry(journal, absorbShortfall(at('s1', 5), payer, received, shortfall));
    expect(shouldStopAcceptingDeals(journal)).toBe(true);

    journal = appendEntry(journal, fundShortfall(at('s2', 10), payer, shortfall));

    expect(isFullyCovered(journal)).toBe(true);
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(
      // 99 900 клиента, 100 довнесённых и 10 000 000 покупателя, ушедшие
      // получателю в расчёте, за вычетом выведенной комиссии.
      9_990_000n + 10_000n + 9_950_000n,
    );
    expect(accountBalance(journal, bankOperating('GEL'), 'GEL').minor).toBe(50_000n - 10_000n);
    const payerFile = coverageByFundsSource(journal).find(
      (item) => item.source.kind === 'client' && item.source.clientKey === payer,
    );
    expect(payerFile?.difference.minor).toBe(0n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
    expect(shouldStopAcceptingDeals(journal)).toBe(false);
  });

  /**
   * Довнесение с пустого операционного счёта — дыра, закрытая обещанием, за
   * которым ничего нет. Пофайловое обеспечение при этом сходится: файл клиента
   * восстановлен, и до появления `negativeBankBalance` расхождение исчезало из
   * отчёта целиком.
   */
  it('reports a bank account driven below zero by the top-up', () => {
    const journal = appendEntries(emptyJournal, [
      absorbShortfall(at('s1'), payer, received, shortfall),
      fundShortfall(at('s2', 5), payer, shortfall),
    ]);

    expect(isFullyCovered(journal)).toBe(true);
    const violations = checkLedgerInvariants(journal);
    expect(violations.map((item) => [item.code, item.subject, item.amountMinor])).toEqual([
      [InvariantCode.negativeBankBalance, 'bank:operating:gel', -10_000n],
    ]);
  });

  it('refuses a shortfall that is not a shortfall', () => {
    expectCode(
      () => absorbShortfall(at('s1'), payer, received, money('GEL', 0n)),
      LedgerErrorCode.entryNonPositiveShortfall,
    );
    expectCode(
      () => absorbShortfall(at('s1'), payer, received, money('GEL', -1n)),
      LedgerErrorCode.entryNonPositiveShortfall,
    );
  });

  it('refuses a shortfall in another currency than the payment', () => {
    expect(() => absorbShortfall(at('s1'), payer, received, money('USD', 100n))).toThrow();
  });

  /**
   * Прирост обеспечения клиентского файла без встречного обязательства
   * запрещён всем, кроме собственных денег платформы, ушедших с её счёта в той
   * же записи (`assertNoUnfundedClientFileGain`). Довнесение — единственный
   * законный случай, и он собирается; та же форма без кредита операционного
   * счёта не собирается вовсе.
   */
  it('is the only funded way to raise a client file', () => {
    expect(() => fundShortfall(at('s2'), payer, shortfall)).not.toThrow();
  });
});
