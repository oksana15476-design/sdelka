import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  InvariantCode,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  accountBalance,
  accrueFee,
  appendEntries,
  appendEntry,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  clientTopUp,
  coverage,
  coverageByFundsSource,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  feePositions,
  freeBalance,
  isEveryTrancheCovered,
  isFullyCovered,
  lockForTranche,
  negativeClientBalances,
  receiveFee,
  settleTrancheToClientAccount,
  shouldStopAcceptingDeals,
  trancheSettlement,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';
import { uncheckedEntry } from './support/unchecked-entry';

const buyer = clientKey('c1');
const seller = clientKey('c2');
/** Постороннее лицо: к сделке A отношения не имеет ни в какой роли. */
const stranger = clientKey('c9');
const dealA = { dealId: 'A', trancheId: 't1' };
const dealB = { dealId: 'B', trancheId: 't1' };
const feeIncome = { kind: 'fee_income' } as const;
const feeReceivableAccount = { kind: 'fee_receivable' } as const;
const transitFeeAccount = { kind: 'transit_fee' } as const;
const suspense = { kind: 'suspense_unidentified' } as const;

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

/** Деньги покупателя пришли и заперты под транш сделки A. */
function lockedUnderA(amount: bigint) {
  return appendEntries(emptyJournal, [
    clientTopUp(at('f1'), buyer, money('GEL', amount)),
    lockForTranche(at('f2', 5), buyer, dealA, money('GEL', amount)),
  ]);
}

describe('красная линия №2: комиссия не остаётся на номинальном счёте ни на минуту', () => {
  /**
   * **[изменённое ожидание, с основанием]** Прежде этот тест ждал комиссию на
   * операционном счёте сразу после расчёта, и в этом была ошибка: номинальный
   * счёт в одном банке, операционный в другом, межбанковский перевод занимает
   * день-два (§3.2). Запись расчёта утверждала, что перевод уже дошёл, — то
   * есть врала о факте, которого ещё нет, и делала «удержано» и «получено»
   * одной величиной вопреки CORE.md Ф10 и Ф16.
   *
   * Красная линия №2 при этом держится и проверяется здесь же: комиссия уходит
   * **с номинального счёта** в той же записи. Она не «лежит на операционном в
   * тот же миг» — она перестаёт быть клиентскими деньгами в тот же миг.
   */
  it('moves the fee off the nominal account inside the settlement entry itself', () => {
    let journal = lockedUnderA(100_000n);
    const accrual = accrueFee(at('s0', 8), dealA, money('GEL', 500n), 'plan-1');
    journal = appendEntry(journal, accrual);
    journal = appendEntry(
      journal,
      settleTrancheToClientAccount(
        at('s1', 10),
        trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
        money('GEL', 100_000n),
        accrual,
      ),
    );

    expect(freeBalance(journal, seller, 'GEL').minor).toBe(99_500n);
    expect(accountBalance(journal, feeIncome, 'GEL').minor).toBe(500n);
    // Требование погашено удержанием, деньги в транзите, на операционный счёт
    // ещё не дошли — три величины Ф16 раздельно.
    expect(accountBalance(journal, feeReceivableAccount, 'GEL').minor).toBe(0n);
    expect(accountBalance(journal, transitFeeAccount, 'GEL').minor).toBe(500n);
    expect(accountBalance(journal, bankOperating('GEL'), 'GEL').minor).toBe(0n);
    // На номинальном — ровно обязательство перед получателем и ни копейкой
    // больше.
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(99_500n);

    // Файл транша закрыт с обеих сторон: ни обязательства, ни остатка средств.
    const trancheFile = coverageByFundsSource(journal).find(
      (item) => item.source.kind === 'tranche' && item.source.deal.dealId === 'A',
    );
    expect(trancheFile?.obligations.minor).toBe(0n);
    expect(trancheFile?.custody.minor).toBe(0n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
    expect(shouldStopAcceptingDeals(journal)).toBe(false);

    // Третья запись — перевод дошёл. Только теперь «получено».
    journal = appendEntry(journal, receiveFee(at('s1b', 15), dealA, money('GEL', 500n)));
    expect(accountBalance(journal, bankOperating('GEL'), 'GEL').minor).toBe(500n);
    expect(accountBalance(journal, transitFeeAccount, 'GEL').minor).toBe(0n);
    const position = feePositions(journal)[0];
    expect([
      position?.accrued.minor,
      position?.notWithheld.minor,
      position?.withheld.minor,
      position?.received.minor,
      position?.inTransit.minor,
    ]).toEqual([500n, 0n, 500n, 500n, 0n]);
  });

  it('shows the withheld fee that never reached the operating account as not received', () => {
    // Крайний случай И14.1: «комиссия удержана, но перевод на операционный счёт
    // не прошёл: это отдельное видимое состояние, а не „получено“».
    let journal = lockedUnderA(100_000n);
    const accrual = accrueFee(at('s0', 8), dealA, money('GEL', 500n), 'plan-1');
    journal = appendEntries(journal, [
      accrual,
      settleTrancheToClientAccount(
        at('s1', 10),
        trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
        money('GEL', 100_000n),
        accrual,
      ),
    ]);
    const position = feePositions(journal)[0];
    expect(position?.withheld.minor).toBe(500n);
    expect(position?.received.minor).toBe(0n);
    expect(position?.inTransit.minor).toBe(500n);
    // Свежий транзит расхождением не является — он обязан быть ненулевым между
    // двумя моментами. Расхождением его делает возраст.
    expect(checkLedgerInvariants(journal)).toEqual([]);
    const stale = checkLedgerInvariants(journal, { asOf: '2026-09-06T10:00:00Z' });
    expect(stale.map((item) => [item.code, item.subject, item.amountMinor])).toEqual([
      [InvariantCode.transitStale, 'transit:fee', 500n],
    ]);
  });

  it('refuses to withhold a fee that was never accrued', () => {
    // Первый контур — типы: `settleTrancheToClientAccount` принимает токен
    // начисления, а не сумму. Второй — баланс: собранная в обход словаря
    // запись уводит требование в минус.
    const journal = appendEntry(
      lockedUnderA(100_000n),
      uncheckedEntry({
        ...at('s4', 10),
        kind: 'settlement',
        memoKey: 'ledger.entry.tranche_settled',
        postings: [
          debit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
          credit(clientFreeAccount(seller), money('GEL', 99_500n), { clientKey: seller }),
          credit(feeReceivableAccount, money('GEL', 500n), dealA),
          credit(bankNominal('GEL'), money('GEL', 100_000n), dealA),
          debit(bankNominal('GEL'), money('GEL', 99_500n), { clientKey: seller }),
          debit(transitFeeAccount, money('GEL', 500n), dealA),
        ],
      }),
    );
    const violations = checkLedgerInvariants(journal);
    expect(violations.map((item) => [item.code, item.subject, item.amountMinor])).toEqual([
      [InvariantCode.platformAssetNegative, 'fee:receivable', -500n],
    ]);
  });

  it('settles without a fee the same way when the plan charges nothing', () => {
    let journal = lockedUnderA(100_000n);
    journal = appendEntry(
      journal,
      settleTrancheToClientAccount(
        at('s2', 10),
        trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
        money('GEL', 100_000n),
        null,
      ),
    );
    // Плана без комиссии начисление не порождает вовсе: нулевая комиссия — это
    // её отсутствие, а не проводка на ноль.
    expect(() => accrueFee(at('s2b', 11), dealA, money('GEL', 0n), 'plan-1')).toThrow();
    expect(freeBalance(journal, seller, 'GEL').minor).toBe(100_000n);
    expect(accountBalance(journal, bankOperating('GEL'), 'GEL').minor).toBe(0n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  it('catches the forgotten sweep in a journal that already contains it', () => {
    // Первый контур — конструктор — такую запись не соберёт (`entry.test.ts`).
    // Но журнал приходит из базы, в том числе с записями, сделанными до этой
    // проверки. Второй контур обязан видеть комиссию, оставленную на счёте
    // клиентских средств, как расхождение, а не как запас: до этого батча
    // профицит по файлу считался покрытием и не докладывался никому.
    let journal = lockedUnderA(100_000n);
    journal = appendEntry(
      journal,
      uncheckedEntry({
        ...at('s3', 10),
        kind: 'settlement',
        memoKey: 'ledger.entry.payout',
        postings: [
          debit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
          credit(clientFreeAccount(seller), money('GEL', 99_500n), { clientKey: seller }),
          credit(feeIncome, money('GEL', 500n)),
          credit(bankNominal('GEL'), money('GEL', 99_500n), dealA),
          debit(bankNominal('GEL'), money('GEL', 99_500n), { clientKey: seller }),
        ],
      }),
    );

    // Всё, что существовало раньше, молчит: портфель сходится, отрицательных
    // остатков нет, «все транши обеспечены» отвечает «да» — профицит по файлу
    // проходит проверку `custody >= obligations`.
    expect(isFullyCovered(journal)).toBe(true);
    expect(isEveryTrancheCovered(journal)).toBe(true);
    expect(negativeClientBalances(journal)).toEqual([]);

    const violations = checkLedgerInvariants(journal);
    const surplus = violations.find((item) => item.code === InvariantCode.custodySurplus);
    expect(surplus?.subject).toBe('A:t1');
    expect(surplus?.amountMinor).toBe(500n);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });
});

describe('красная линия №1: получатель расчёта связан со сделкой в самой записи', () => {
  it('refuses the settlement shape for an unrelated client when nothing declares it', () => {
    // Воспроизведение дефекта: расчёт по сделке A в пользу лица, к сделке A
    // отношения не имеющего. Прежде эта форма принималась для любого лица —
    // «условие расчёта проверяет автомат», — после чего деньги законно
    // запирались под чужую сделку B.
    expectCode(
      () =>
        createJournalEntry({
          ...at('r1', 10),
          kind: 'settlement',
          memoKey: 'ledger.entry.tranche_settled',
          postings: [
            debit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
            credit(clientFreeAccount(stranger), money('GEL', 100_000n), { clientKey: stranger }),
            credit(bankNominal('GEL'), money('GEL', 100_000n), dealA),
            debit(bankNominal('GEL'), money('GEL', 100_000n), { clientKey: stranger }),
          ],
        }),
      LedgerErrorCode.entryClientOwnerMismatch,
    );
  });

  it('keeps the declaration in the entry, so the claim is a fact of the journal', () => {
    const entry = settleTrancheToClientAccount(
      at('r2', 10),
      trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
      money('GEL', 100_000n),
      accrueFee(at('r2a', 9), dealA, money('GEL', 500n), 'plan-1'),
    );
    expect(entry.settles?.deal).toEqual(dealA);
    expect(entry.settles?.payer).toBe(buyer);
    expect(entry.settles?.recipient).toBe(seller);
    // У записи, которая расчётом не является, объявления нет.
    expect(clientTopUp(at('r3', 15), buyer, money('GEL', 100n)).settles).toBeNull();
  });

  it('refuses a settlement between the two sides of one person', () => {
    // FUNCTIONAL.md §2.1: одна и та же личность на обеих сторонах одной сделки
    // — отказ при заведении, а не задача оператору. Возврат самому себе — не
    // расчёт: у него своя запись.
    expectCode(
      () => trancheSettlement(dealA, buyer, buyer, attestDealParties(dealA, buyer, buyer)),
      LedgerErrorCode.settlementSelfDealing,
    );
  });

  it('refuses a declaration the domain did not attest for these very parties', () => {
    // Вторая половина дефекта: прежде объявление изготавливал тот же
    // вызывающий, который строил проводки, — самосертификация. Теперь связь
    // «получатель ↔ сделка» приходит извне обязательным аргументом, которого
    // учёту нечем подделать, и подтверждение с чужой сделки или на чужое лицо
    // к этому расчёту не подходит.
    expectCode(
      () =>
        trancheSettlement(dealA, buyer, stranger, attestDealParties(dealA, buyer, seller)),
      LedgerErrorCode.settlementAttestationMismatch,
    );
    expectCode(
      () => trancheSettlement(dealA, buyer, seller, attestDealParties(dealB, buyer, seller)),
      LedgerErrorCode.settlementAttestationMismatch,
    );
    expectCode(
      () =>
        trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, stranger, seller)),
      LedgerErrorCode.settlementAttestationMismatch,
    );
    // Красная линия №5: выплата невозможна без ссылки на пакет доказательств.
    expectCode(
      () =>
        trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller, '')),
      LedgerErrorCode.settlementAttestationMismatch,
    );
    // Ссылка остаётся в журнале вместе с объявлением.
    const settles = trancheSettlement(
      dealA,
      buyer,
      seller,
      attestDealParties(dealA, buyer, seller, 'pack-42'),
    );
    expect(settles.evidenceRef).toBe('pack-42');
  });

  it('refuses a declaration that the postings do not match', () => {
    const settles = trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller));
    // Посторонний счёт клиента в записи расчёта: деньги сделки A уходят лицу,
    // которого объявление не называет.
    expectCode(
      () =>
        createJournalEntry({
          ...at('r4', 10),
          kind: 'settlement',
          memoKey: 'ledger.entry.tranche_settled',
          settles,
          postings: [
            debit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
            credit(clientFreeAccount(stranger), money('GEL', 100_000n), { clientKey: stranger }),
            credit(bankNominal('GEL'), money('GEL', 100_000n), dealA),
            debit(bankNominal('GEL'), money('GEL', 100_000n), { clientKey: stranger }),
          ],
        }),
      LedgerErrorCode.entrySettlementShapeMismatch,
    );

    // Объявление, к которому запись не применена: права на движение между
    // владельцами оно не даёт — иначе им прикрывали бы любой перевод.
    expectCode(
      () =>
        createJournalEntry({
          ...at('r5', 15),
          kind: 'settlement',
          memoKey: 'ledger.entry.tranche_settled',
          settles,
          postings: [
            debit(clientFreeAccount(buyer), money('GEL', 100n), { clientKey: buyer }),
            credit(clientFreeAccount(seller), money('GEL', 100n), { clientKey: seller }),
          ],
        }),
      LedgerErrorCode.entrySettlementShapeMismatch,
    );

    // Направление задано: деньги получателя не запираются под сделку
    // плательщика. Это финансирование чужой сделки, а не расчёт.
    expectCode(
      () =>
        createJournalEntry({
          ...at('r6', 20),
          kind: 'settlement',
          memoKey: 'ledger.entry.tranche_settled',
          settles,
          postings: [
            debit(clientFreeAccount(seller), money('GEL', 100_000n), { clientKey: seller }),
            credit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
            credit(bankNominal('GEL'), money('GEL', 100_000n), { clientKey: seller }),
            debit(bankNominal('GEL'), money('GEL', 100_000n), dealA),
          ],
        }),
      LedgerErrorCode.entrySettlementShapeMismatch,
    );

    // Кастодиан из чужого файла в расчёте: деньги другой сделки закрывали бы
    // обязательство этой.
    expectCode(
      () =>
        createJournalEntry({
          ...at('r7', 25),
          kind: 'settlement',
          memoKey: 'ledger.entry.tranche_settled',
          settles,
          postings: [
            debit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
            credit(clientFreeAccount(seller), money('GEL', 100_000n), { clientKey: seller }),
            credit(bankNominal('GEL'), money('GEL', 100_000n), dealB),
            debit(bankNominal('GEL'), money('GEL', 100_000n), { clientKey: seller }),
          ],
        }),
      LedgerErrorCode.entrySettlementShapeMismatch,
    );
  });

  it('allows the reverse direction only as a correction, which carries a reference', () => {
    // Ошибочный расчёт исправляется обратной записью со ссылкой на исходную
    // (красная линия №11), а не правкой журнала.
    const entry = createJournalEntry({
      ...at('r8', 30),
      kind: 'correction',
      correctsEntryId: 'r2',
      memoKey: 'ledger.entry.tranche_settlement_reversed',
      settles: trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
      postings: [
        debit(clientFreeAccount(seller), money('GEL', 100_000n), { clientKey: seller }),
        credit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
        credit(bankNominal('GEL'), money('GEL', 100_000n), { clientKey: seller }),
        debit(bankNominal('GEL'), money('GEL', 100_000n), dealA),
      ],
    });
    expect(entry.correctsEntryId).toBe('r2');
    expect(entry.settles?.recipient).toBe(seller);
  });

  it('leaves the settled money free to fund the recipient own next deal', () => {
    // Граница из FUNCTIONAL.md §2.1: расчёт завершён, деньги на свободной части
    // — они собственные, и запрета пускать их на свою следующую сделку нет.
    let journal = lockedUnderA(100_000n);
    journal = appendEntry(
      journal,
      settleTrancheToClientAccount(
        at('r9', 10),
        trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
        money('GEL', 100_000n),
      ),
    );
    journal = appendEntry(
      journal,
      lockForTranche(at('r10', 15), seller, dealB, money('GEL', 100_000n)),
    );
    expect(freeBalance(journal, seller, 'GEL').minor).toBe(0n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });
});

describe('двухзаписная отмывка через непознанные поступления', () => {
  it('refuses to push a client obligation back into the unidentified pool', () => {
    const journal = lockedUnderA(100_000n);
    expect(journal.entries).toHaveLength(2);
    // Первый шаг схемы: обязательство по траншу гасится «в непознанные», деньги
    // на номинальном счёте остаются отнесёнными к траншу A. Ни одна проводка
    // кастодиана в записи не участвует, поэтому ни красная линия №1, ни
    // покрытие её не касаются.
    expectCode(
      () =>
        createJournalEntry({
          ...at('l1', 10),
          kind: 'settlement',
          memoKey: 'ledger.entry.suspense_received',
          postings: [
            debit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
            credit(suspense, money('GEL', 100_000n)),
          ],
        }),
      LedgerErrorCode.entryObligationIntoIntakePool,
    );
  });

  it('reports the drained tranche when the journal already carries the scheme', () => {
    // Тот же ответ на вопрос «чем ловится, кроме пофайлового обеспечения
    // постфактум»: до этого батча — ничем. Схема проходила все проверки,
    // потому что у непознанных нет файла, а опустевший файл транша оказывался
    // в профиците, который считался покрытием.
    let journal = lockedUnderA(100_000n);
    journal = appendEntry(
      journal,
      uncheckedEntry({
        ...at('l2', 10),
        kind: 'settlement',
        memoKey: 'ledger.entry.suspense_received',
        postings: [
          debit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
          credit(suspense, money('GEL', 100_000n)),
        ],
      }),
    );
    journal = appendEntry(
      journal,
      uncheckedEntry({
        ...at('l3', 15),
        kind: 'settlement',
        memoKey: 'ledger.entry.suspense_identified',
        postings: [
          debit(suspense, money('GEL', 100_000n)),
          credit(clientFreeAccount(stranger), money('GEL', 100_000n), { clientKey: stranger }),
          credit(bankNominal('GEL'), money('GEL', 100_000n)),
          debit(bankNominal('GEL'), money('GEL', 100_000n), { clientKey: stranger }),
        ],
      }),
    );

    // Деньги покупателя стали свободными деньгами постороннего лица.
    expect(freeBalance(journal, stranger, 'GEL').minor).toBe(100_000n);
    // И всё, что было до этого батча, молчит.
    expect(coverage(journal).every((item) => item.covered)).toBe(true);
    expect(isEveryTrancheCovered(journal)).toBe(true);
    expect(negativeClientBalances(journal)).toEqual([]);

    // Единственный сигнал — профицит опустевшего файла транша.
    const violations = checkLedgerInvariants(journal);
    expect(violations.map((item) => item.code)).toEqual([InvariantCode.custodySurplus]);
    expect(violations[0]?.subject).toBe('A:t1');
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });
});
