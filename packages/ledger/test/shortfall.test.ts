import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  InvariantCode,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  absorbShortfall,
  accountBalance,
  accrueFee,
  appendEntries,
  appendEntry,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientKey,
  clientTopUp,
  coverage,
  coverageByFundsSource,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  freeBalance,
  fundShortfall,
  isFullyCovered,
  lockForTranche,
  receiveFee,
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
    accrueFee(at('f3', 2), dealA, money('GEL', feeMinor), 'plan-1'),
    settleTrancheToClientAccount(
      at('f4', 3),
      trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
      money('GEL', 10_000_000n),
      accrueFee(at('f3', 2), dealA, money('GEL', feeMinor), 'plan-1'),
    ),
    // Комиссия дошла до операционного счёта: довносить недостачу можно только
    // теми деньгами, которые у платформы **есть**, а удержанная комиссия ещё
    // день-два лежит в транзите (§3.2). Прежде расчёт клал её на операционный
    // счёт в тот же миг — и это было неправдой.
    receiveFee(at('f5', 4), dealA, money('GEL', feeMinor)),
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
    const recognised = absorbShortfall(at('s1', 5), payer, received, shortfall);
    journal = appendEntry(journal, recognised);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);

    journal = appendEntry(journal, fundShortfall(at('s2', 10), recognised));

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
    const recognised = absorbShortfall(at('s1'), payer, received, shortfall);
    const journal = appendEntries(emptyJournal, [
      recognised,
      fundShortfall(at('s2', 5), recognised),
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
    const recognised = absorbShortfall(at('s1'), payer, received, shortfall);
    expect(() => fundShortfall(at('s2'), recognised)).not.toThrow();
  });

  /**
   * **Исправленный дефект: `fundShortfall` был единственным конструктором без
   * проверки входа.** Прежняя подпись `(meta, owner, amount)` — универсальный
   * примитив «положить деньги платформы в файл произвольного клиента на
   * произвольную сумму», и `assertNoUnfundedClientFileGain` пропускал его по
   * построению: такое финансирование законно. Ни словарь, ни конструктор
   * записи не задавали ни одного вопроса.
   *
   * Контуров теперь два, и здесь проверяется второй — журнальный. Первый,
   * типовой, проверить тестом нельзя: `fundShortfall(meta, owner, amount)` не
   * компилируется, а несобираемая форма тестом не выражается.
   */
  it('catches money put into a client file beyond what was recognised', () => {
    let journal = operatingFundedBy(50_000n);
    const recognised = absorbShortfall(at('s1', 5), payer, received, shortfall);
    journal = appendEntries(journal, [recognised, fundShortfall(at('s2', 10), recognised)]);
    expect(checkLedgerInvariants(journal)).toEqual([]);

    // Довнесение сверх признанного: форма законная — деньги платформы ушли с
    // её счёта, — и до появления инварианта её не видел никто. Профицит файла
    // ловит только последствие; сам факт «положили больше, чем признали»
    // называет `shortfallOverfunded`.
    journal = appendEntry(
      journal,
      createJournalEntry({
        ...at('s3', 15),
        kind: 'settlement',
        memoKey: 'ledger.entry.shortfall_funded',
        postings: [
          debit(bankNominal('GEL'), money('GEL', 7_000n), { clientKey: payer }),
          credit(bankOperating('GEL'), money('GEL', 7_000n)),
        ],
      }),
    );
    const violations = checkLedgerInvariants(journal);
    expect(
      violations
        .filter((item) => item.code === InvariantCode.shortfallOverfunded)
        .map((item) => [item.subject, item.currency, item.amountMinor]),
    ).toEqual([[payer, 'GEL', 7_000n]]);
  });
});

/**
 * Третий контур довнесения: **ссылка на признание**.
 *
 * Токен закрыл словарь, инвариант закрыл сложение постфактум, и между ними
 * оставалась щель, которую не видел ни один: токен — значение, его никто не
 * гасит, и признание могло вообще не попасть в журнал. `absorbShortfall`
 * возвращает запись, положить её в журнал — отдельное действие, и никто не
 * обязывал его сделать.
 */
describe('довнесение закрывает конкретное признание', () => {
  it('refuses a top-up whose recognition never reached the journal', () => {
    // Признание построено и **не** добавлено: на номинальном счёте деньги
    // платформы, признанного расхода за ними нет.
    const recognised = absorbShortfall(at('s1'), payer, received, shortfall);
    expectCode(
      () => appendEntry(operatingFundedBy(50_000n), fundShortfall(at('s2', 10), recognised)),
      LedgerErrorCode.journalShortfallRecognitionMissing,
    );
  });

  it('refuses to fund one recognition twice', () => {
    let journal = operatingFundedBy(50_000n);
    const recognised = absorbShortfall(at('s1', 5), payer, received, shortfall);
    journal = appendEntries(journal, [recognised, fundShortfall(at('s2', 10), recognised)]);
    expect(checkLedgerInvariants(journal)).toEqual([]);

    // Тот же токен, другой идентификатор записи: по идентификатору такое
    // довнесение не отличить от первого, и до ссылки его ловил только
    // `shortfallOverfunded` — сложением за всю историю, постфактум.
    expectCode(
      () => appendEntry(journal, fundShortfall(at('s3', 15), recognised)),
      LedgerErrorCode.journalShortfallFundedTwice,
    );
  });

  it('refuses a declaration that points at an entry recognising nothing for this client', () => {
    let journal = operatingFundedBy(50_000n);
    const recognised = absorbShortfall(at('s1', 5), payer, received, shortfall);
    journal = appendEntry(journal, recognised);
    // Ссылка есть, признание есть — но признано оно по другому клиенту.
    expectCode(
      () =>
        appendEntry(
          journal,
          createJournalEntry({
            ...at('s2', 10),
            kind: 'settlement',
            memoKey: 'ledger.entry.shortfall_funded',
            funds: { recognisedEntryId: 's1', owner: buyer, amount: shortfall },
            postings: [
              debit(bankNominal('GEL'), shortfall, { clientKey: buyer }),
              credit(bankOperating('GEL'), shortfall),
            ],
          }),
        ),
      LedgerErrorCode.journalShortfallRecognitionMissing,
    );
  });

  /**
   * Объявление не украшение: запись обязана делать ровно то, что объявила.
   * Довнесение, попутно поднимающее чужой файл, довнесением не является — и до
   * объявления такая форма была неотличима от честной.
   */
  it('refuses a top-up that raises a file other than the declared one', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('s2', 10),
          kind: 'settlement',
          memoKey: 'ledger.entry.shortfall_funded',
          funds: { recognisedEntryId: 's1', owner: payer, amount: shortfall },
          postings: [
            debit(bankNominal('GEL'), shortfall, { clientKey: buyer }),
            credit(bankOperating('GEL'), shortfall),
          ],
        }),
      LedgerErrorCode.entryShortfallFundingMismatch,
    );
  });

  it('refuses a top-up for more than it declares', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('s2', 10),
          kind: 'settlement',
          memoKey: 'ledger.entry.shortfall_funded',
          funds: { recognisedEntryId: 's1', owner: payer, amount: shortfall },
          postings: [
            debit(bankNominal('GEL'), money('GEL', 20_000n), { clientKey: payer }),
            credit(bankOperating('GEL'), money('GEL', 20_000n)),
          ],
        }),
      LedgerErrorCode.entryShortfallFundingMismatch,
    );
  });
});
