import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  InvariantCode,
  type Journal,
  LedgerError,
  LedgerErrorCode,
  accountBalance,
  appendEntries,
  appendEntry,
  bankNominal,
  checkLedgerInvariants,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  clientStatement,
  clientTopUp,
  coverageByFundsSource,
  coverageByTranche,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  freeBalance,
  identifySuspense,
  isEveryFundsSourceCovered,
  isEveryTrancheCovered,
  isFullyCovered,
  lockForTranche,
  overpaymentToClientAccount,
  settleTrancheToClientAccount,
  shouldStopAcceptingDeals,
  trancheSettlement,
  unlockToClientAccount,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';

// Ключ личности переводится в ключ счёта в compliance: здесь он непрозрачный.
const buyer = clientKey('c1');
const seller = clientKey('c2');
const suspense = { kind: 'suspense_unidentified' } as const;
const dealA = { dealId: 'A', trancheId: 't1' };
const dealB = { dealId: 'B', trancheId: 't1' };

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-03T10:${String(minute).padStart(2, '0')}:00Z` };
}

function expectCode(run: () => unknown, code: LedgerErrorCode): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
  }
}

describe('ключ счёта клиента', () => {
  it('refuses anything that would collide with an account code', () => {
    // Двоеточие — разделитель кода счёта, вертикальная черта — разделитель
    // внутренних ключей источника средств. Ключ личности содержит двоеточие
    // (`страна:тип:отпечаток`), поэтому в ledger он попадает только переведённым.
    expectCode(() => clientKey('GE:passport:abc'), LedgerErrorCode.accountInvalidIdentifier);
    expectCode(() => clientKey('c|1'), LedgerErrorCode.accountInvalidIdentifier);
    expectCode(() => clientKey(''), LedgerErrorCode.accountInvalidIdentifier);
    expectCode(() => clientKey('c'.repeat(129)), LedgerErrorCode.accountInvalidIdentifier);
    expect(clientKey('GE.passport.abc-1_2')).toBe('GE.passport.abc-1_2');
  });
});

describe('отнесение проводок к клиенту', () => {
  it('rejects a tranche attribution on the free part of the account', () => {
    // Свободная часть — файл владельца. Отнесение к траншу означало бы, что
    // деньги одновременно свободны и заперты.
    expectCode(
      () =>
        createJournalEntry({
          ...at('a1'),
          kind: 'settlement',
          memoKey: 'ledger.entry.client_top_up',
          postings: [
            debit(bankNominal('GEL'), money('GEL', 100n), { clientKey: buyer }),
            credit(clientFreeAccount(buyer), money('GEL', 100n), dealA),
          ],
        }),
      LedgerErrorCode.postingClientAttributionMismatch,
    );
  });

  it('rejects the free part of one client attributed to another', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('a2'),
          kind: 'settlement',
          memoKey: 'ledger.entry.client_top_up',
          postings: [
            debit(bankNominal('GEL'), money('GEL', 100n), { clientKey: buyer }),
            credit(clientFreeAccount(buyer), money('GEL', 100n), { clientKey: seller }),
          ],
        }),
      LedgerErrorCode.postingClientAttributionMismatch,
    );
  });

  it('rejects a client attribution on the locked part', () => {
    // Запертые деньги живут в файле транша: иначе обеспечение транша считалось
    // бы по чужому файлу, и опора красной линии №1 на отнесение исчезает.
    expectCode(
      () =>
        createJournalEntry({
          ...at('a3'),
          kind: 'settlement',
          memoKey: 'ledger.entry.funds_received',
          postings: [
            debit(bankNominal('GEL'), money('GEL', 100n), dealA),
            credit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100n), {
              clientKey: buyer,
            }),
          ],
        }),
      LedgerErrorCode.postingClientAttributionMismatch,
    );
  });
});

describe('зачисление на счёт клиента и привязка к сделке — разные события (И12.1)', () => {
  it('credits the free part and keeps the money covered', () => {
    const journal = appendEntry(emptyJournal, clientTopUp(at('t1'), buyer, money('GEL', 100_000n)));
    expect(accountBalance(journal, clientFreeAccount(buyer), 'GEL').minor).toBe(100_000n);
    expect(freeBalance(journal, buyer, 'GEL').minor).toBe(100_000n);
    expect(isFullyCovered(journal)).toBe(true);
    expect(isEveryFundsSourceCovered(journal)).toBe(true);
    // Запертого нет вовсе: сделка ещё не выбрана.
    expect(clientStatement(journal, buyer).locked).toEqual([]);
  });

  it('moves the custody file along with the obligation when the money is locked', () => {
    let journal = appendEntry(emptyJournal, clientTopUp(at('t1'), buyer, money('GEL', 100_000n)));
    journal = appendEntry(
      journal,
      lockForTranche(at('t2', 5), buyer, dealA, money('GEL', 60_000n)),
    );

    expect(freeBalance(journal, buyer, 'GEL').minor).toBe(40_000n);
    expect(
      accountBalance(journal, clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), 'GEL')
        .minor,
    ).toBe(60_000n);

    // Транш обеспечен ровно потому, что вместе с обязательством переехало
    // отнесение кастодиана: без двух встречных проводок по номинальному счёту
    // (FUNCTIONAL.md §3.1) он стал бы необеспеченным в момент привязки.
    const tranche = coverageByTranche(journal)[0];
    expect(tranche?.custody.minor).toBe(60_000n);
    expect(tranche?.obligations.minor).toBe(60_000n);
    expect(isEveryTrancheCovered(journal)).toBe(true);

    // Файл клиента уменьшился на ту же сумму и остался обеспеченным.
    const clientFile = coverageByFundsSource(journal).find(
      (item) => item.source.kind === 'client' && item.source.clientKey === buyer,
    );
    expect(clientFile?.custody.minor).toBe(40_000n);
    expect(clientFile?.obligations.minor).toBe(40_000n);
    expect(isEveryFundsSourceCovered(journal)).toBe(true);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  it('gives the money back to the free part when the reservation is released', () => {
    let journal = appendEntry(emptyJournal, clientTopUp(at('t1'), buyer, money('GEL', 100_000n)));
    journal = appendEntry(
      journal,
      lockForTranche(at('t2', 5), buyer, dealA, money('GEL', 60_000n)),
    );
    journal = appendEntry(
      journal,
      unlockToClientAccount(at('t3', 10), buyer, dealA, money('GEL', 60_000n)),
    );
    expect(freeBalance(journal, buyer, 'GEL').minor).toBe(100_000n);
    expect(clientStatement(journal, buyer).locked.every((item) => item.amount.minor === 0n)).toBe(
      true,
    );
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  it('keeps an unidentified payment out of the client statement until it is identified', () => {
    // И12.1: непознанное поступление не отображается как остаток клиента и не
    // зачисляется на сделку (FUNCTIONAL.md §3.3, шаг 1).
    let journal = appendEntry(
      emptyJournal,
      createJournalEntry({
        ...at('s1'),
        kind: 'settlement',
        memoKey: 'ledger.entry.unidentified_incoming',
        postings: [
          debit(bankNominal('GEL'), money('GEL', 100_000n)),
          credit(suspense, money('GEL', 100_000n)),
        ],
      }),
    );
    expect(clientStatement(journal, buyer).free).toEqual([]);
    expect(freeBalance(journal, buyer, 'GEL').minor).toBe(0n);
    // Непознанное не попадает ни в один файл, но видно в портфельном покрытии.
    expect(coverageByFundsSource(journal)).toEqual([]);
    expect(isFullyCovered(journal)).toBe(true);

    journal = appendEntry(journal, identifySuspense(at('s2', 5), buyer, money('GEL', 100_000n)));
    expect(accountBalance(journal, suspense, 'GEL').minor).toBe(0n);
    expect(freeBalance(journal, buyer, 'GEL').minor).toBe(100_000n);
    expect(isEveryFundsSourceCovered(journal)).toBe(true);
  });
});

describe('переплата (FUNCTIONAL.md §4.3.2)', () => {
  it('puts the excess into the free part right away, not after the deal closes', () => {
    // Деньги, не попавшие под условие расчёта, обязаны остаться отзывными
    // (красная линия №7): удержание излишка до закрытия сделки — удержание
    // чужих денег без основания.
    const journal = appendEntry(
      emptyJournal,
      overpaymentToClientAccount(
        at('o1'),
        buyer,
        dealA,
        money('GEL', 100_000n),
        money('GEL', 2_500n),
      ),
    );
    expect(
      accountBalance(journal, clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), 'GEL')
        .minor,
    ).toBe(100_000n);
    expect(freeBalance(journal, buyer, 'GEL').minor).toBe(2_500n);
    expect(isEveryFundsSourceCovered(journal)).toBe(true);
  });

  it('refuses to record an overpayment without an excess', () => {
    expectCode(
      () =>
        overpaymentToClientAccount(
          at('o2'),
          buyer,
          dealA,
          money('GEL', 100_000n),
          money('GEL', 0n),
        ),
      LedgerErrorCode.entryNonPositiveExcess,
    );
  });
});

describe('расчёт по сделке в пользу получателя (И12.1)', () => {
  it('lands the seller money in the free part of the same account, fee recognised at once', () => {
    let journal = appendEntry(emptyJournal, clientTopUp(at('p1'), buyer, money('GEL', 100_000n)));
    journal = appendEntry(
      journal,
      lockForTranche(at('p2', 5), buyer, dealA, money('GEL', 100_000n)),
    );
    journal = appendEntry(
      journal,
      settleTrancheToClientAccount(
        at('p3', 10),
        trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
        money('GEL', 100_000n),
        money('GEL', 500n),
      ),
    );

    // Деньги продавца — в свободной части его собственного счёта, а не в
    // отдельном «счёте продавца»: счёт один на все роли (FUNCTIONAL.md §2.1).
    expect(freeBalance(journal, seller, 'GEL').minor).toBe(99_500n);
    expect(
      accountBalance(journal, clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), 'GEL')
        .minor,
    ).toBe(0n);
    expect(accountBalance(journal, { kind: 'fee_income' }, 'GEL').minor).toBe(500n);
    // Остаток комиссии на номинальном счёте виден как превышение средств над
    // обязательствами и обязан быть выведен на операционный в тот же банковский
    // день (FUNCTIONAL.md §3.3, шаг 5).
    expect(isEveryTrancheCovered(journal)).toBe(true);
    expect(isEveryFundsSourceCovered(journal)).toBe(true);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });
});

describe('одна личность, несколько ролей (И12.1, FUNCTIONAL.md §2.1)', () => {
  it('shows one balance across deals in both roles: free apart from locked', () => {
    // Клиент продал по сделке A (роль получателя) и покупает по сделке B
    // (роль плательщика). Счёт один, ключ — ключ личности.
    const person = clientKey('c9');
    let journal = appendEntry(emptyJournal, clientTopUp(at('m1'), buyer, money('GEL', 300_000n)));
    journal = appendEntry(
      journal,
      lockForTranche(at('m2', 5), buyer, dealA, money('GEL', 300_000n)),
    );
    journal = appendEntry(
      journal,
      settleTrancheToClientAccount(
        at('m3', 10),
        trancheSettlement(dealA, buyer, person, attestDealParties(dealA, buyer, person)),
        money('GEL', 300_000n),
      ),
    );
    journal = appendEntry(
      journal,
      lockForTranche(at('m4', 15), person, dealB, money('GEL', 120_000n)),
    );
    journal = appendEntry(
      journal,
      lockForTranche(at('m5', 20), person, { dealId: 'C', trancheId: 't1' }, money('GEL', 50_000n)),
    );

    const statement = clientStatement(journal, person);
    expect(statement.free).toHaveLength(1);
    expect(statement.free[0]?.amount.minor).toBe(130_000n);
    // По каждой запертой сумме известно, под какой сделкой она заперта. До
    // какого момента — дедлайн транша, состояние автомата, а не факт журнала.
    expect(statement.locked.map((item) => [item.deal.dealId, item.amount.minor])).toEqual([
      ['B', 120_000n],
      ['C', 50_000n],
    ]);
    expect(statement.lockedTotal[0]?.amount.minor).toBe(170_000n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  it('keeps two currencies side by side without converting them', () => {
    // И12.1, крайний случай: валюта поступления не совпадает с валютой сделки
    // до конвертации — показываются обе, без пересчёта «для удобства».
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('c1'), buyer, money('GEL', 100_000n)),
      clientTopUp(at('c2', 5), buyer, money('USD', 8_000n)),
      lockForTranche(at('c3', 10), buyer, dealA, money('USD', 8_000n)),
    ]);
    const statement = clientStatement(journal, buyer);
    expect(statement.free.map((item) => [item.currency, item.amount.minor])).toEqual([
      ['GEL', 100_000n],
      ['USD', 0n],
    ]);
    expect(statement.locked.map((item) => [item.currency, item.amount.minor])).toEqual([
      ['USD', 8_000n],
    ]);
  });
});

describe('деньги под живой сделкой не финансируют другую (И12.1, И12.4)', () => {
  function locked(): Journal {
    return appendEntries(emptyJournal, [
      clientTopUp(at('g1'), buyer, money('GEL', 100_000n)),
      lockForTranche(at('g2', 5), buyer, dealA, money('GEL', 100_000n)),
    ]);
  }

  it('has no dictionary entry that takes two tranches at all', () => {
    // Запрет выражен структурой: ни у одной функции словаря записей на входе
    // нет двух траншей, поэтому перенос со сделки A на сделку B в нём не просто
    // запрещён — он невыразим. Здесь проверяется вторая, низкоуровневая дверь:
    // `createJournalEntry` отвергает форму напрямую (красная линия №1).
    expectCode(
      () =>
        createJournalEntry({
          ...at('g3', 10),
          kind: 'settlement',
          memoKey: 'ledger.entry.locked_for_tranche',
          postings: [
            debit(
              clientLockedAccount(buyer, dealA.dealId, dealA.trancheId),
              money('GEL', 100_000n),
              dealA,
            ),
            credit(
              clientLockedAccount(buyer, dealB.dealId, dealB.trancheId),
              money('GEL', 100_000n),
              dealB,
            ),
          ],
        }),
      LedgerErrorCode.entryLockedToLocked,
    );
  });

  it('lets the money reach deal B only after deal A gives it back', () => {
    // И12.1, крайний случай: сделка A может откатиться, и тогда деньги обязаны
    // вернуться. Поэтому путь на сделку B идёт через свободную часть, а отвязка
    // — это событие автомата сделки A (`reserve_expired`, отзыв, отмена), а не
    // решение плательщика в момент, когда сделка A ещё жива.
    let journal = locked();
    journal = appendEntry(
      journal,
      unlockToClientAccount(at('g4', 15), buyer, dealA, money('GEL', 100_000n)),
    );
    journal = appendEntry(
      journal,
      lockForTranche(at('g5', 20), buyer, dealB, money('GEL', 100_000n)),
    );
    expect(freeBalance(journal, buyer, 'GEL').minor).toBe(0n);
    expect(
      accountBalance(journal, clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), 'GEL')
        .minor,
    ).toBe(0n);
    expect(
      accountBalance(journal, clientLockedAccount(buyer, dealB.dealId, dealB.trancheId), 'GEL')
        .minor,
    ).toBe(100_000n);
    expect(isEveryTrancheCovered(journal)).toBe(true);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });
});

describe('красная линия №1 между файлами клиентов', () => {
  it('rejects settling one client obligation with custody attributed to another', () => {
    // Тот же запрет, что и между траншами, но на втором виде файла: деньги,
    // лежащие на номинальном счёте за клиентом X, не гасят обязательство перед
    // клиентом Y. Проверка стоит при построении записи, а не в отчётности
    // (FUNCTIONAL.md §3.1).
    expectCode(
      () =>
        createJournalEntry({
          ...at('x1'),
          kind: 'settlement',
          memoKey: 'ledger.entry.client_withdrawal',
          postings: [
            debit(clientFreeAccount(seller), money('GEL', 100n), { clientKey: seller }),
            credit(bankNominal('GEL'), money('GEL', 100n), { clientKey: buyer }),
          ],
        }),
      LedgerErrorCode.entryClientFundsCrossSubsidy,
    );
  });

  it('allows a client to take their own free money out (И12.2, ledger side)', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('x2'), buyer, money('GEL', 100n)),
      createJournalEntry({
        ...at('x3', 5),
        kind: 'settlement',
        memoKey: 'ledger.entry.client_withdrawal',
        postings: [
          debit(clientFreeAccount(buyer), money('GEL', 100n), { clientKey: buyer }),
          credit(bankNominal('GEL'), money('GEL', 100n), { clientKey: buyer }),
        ],
      }),
    ]);
    expect(freeBalance(journal, buyer, 'GEL').minor).toBe(0n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });
});

describe('инварианты счёта клиента', () => {
  it('catches locking more than the free balance and stops accepting deals', () => {
    // Конструктор записи журнала не видит: он проверяет форму одной записи, а
    // не историю. Предпроверка — `freeBalance`; второй контур — инвариант.
    let journal = appendEntry(emptyJournal, clientTopUp(at('n1'), buyer, money('GEL', 10_000n)));
    expect(freeBalance(journal, buyer, 'GEL').minor).toBe(10_000n);
    journal = appendEntry(
      journal,
      lockForTranche(at('n2', 5), buyer, dealA, money('GEL', 15_000n)),
    );
    const violations = checkLedgerInvariants(journal);
    expect(violations.map((item) => item.code)).toContain(InvariantCode.negativeClientBalance);
    expect(violations.some((item) => item.subject === 'client:c1:free')).toBe(true);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });

  it('catches an obligation to a client that no money on the nominal account backs', () => {
    // Второй вид файла: обязательство перед клиентом вне сделки без денег на
    // номинальном счёте — такое же расхождение, как необеспеченный транш.
    const journal = appendEntry(
      emptyJournal,
      createJournalEntry({
        ...at('u1'),
        kind: 'settlement',
        memoKey: 'ledger.entry.shortfall_recognised',
        postings: [
          debit({ kind: 'shortfall_expense' }, money('GEL', 100n)),
          credit(clientFreeAccount(buyer), money('GEL', 100n), { clientKey: buyer }),
        ],
      }),
    );
    const violations = checkLedgerInvariants(journal);
    expect(violations.map((item) => item.code)).toContain(InvariantCode.clientAccountUncovered);
    const uncovered = violations.find(
      (item) => item.code === InvariantCode.clientAccountUncovered,
    );
    expect(uncovered?.subject).toBe(buyer);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });
});
