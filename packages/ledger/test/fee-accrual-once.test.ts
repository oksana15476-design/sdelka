import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  InvariantCode,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  accountBalance,
  accrueFee,
  accrueFeeOnce,
  appendEntries,
  appendEntry,
  checkLedgerInvariants,
  clientFreeAccount,
  clientKey,
  clientTopUp,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  feeAccrualFor,
  feePositions,
  feeReceivable,
  lockForTranche,
  openFeeReceivables,
  receiveFee,
  reverseFeeAccrual,
  settleTrancheToClientAccount,
  trancheSettlement,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';
import { unguardedJournal } from './support/unguarded-journal';

const buyer = clientKey('c1');
const seller = clientKey('c2');
const dealA = { dealId: 'A', trancheId: 't1' };
const feeIncome = { kind: 'fee_income' } as const;
const gross = money('GEL', 10_000_000n);
const fee = money('GEL', 50_000n);

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

/** Транш, обеспеченный деньгами покупателя: до расчёта остаётся один шаг. */
function lockedUnderA() {
  return appendEntries(emptyJournal, [
    clientTopUp(at('f1'), buyer, gross),
    lockForTranche(at('f2', 1), buyer, dealA, gross),
  ]);
}

function settlement(id: string, minute: number, withheld: Parameters<
  typeof settleTrancheToClientAccount
>[3]) {
  return settleTrancheToClientAccount(
    at(id, minute),
    trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
    gross,
    withheld,
  );
}

/**
 * FUNCTIONAL.md §4.6 и CORE.md Ф16: начислено, удержано и получено — три разные
 * величины. Начисление обязано быть **одним на транш**: «начислено» — свойство
 * транша, а не счётчик вызовов конструктора.
 */
describe('идемпотентность начисления комиссии', () => {
  /**
   * Проба, ради которой правило появилось.
   *
   * Два `accrueFee` по одному траншу давали `fee:receivable` вдвое, доход
   * признавался дважды, и `checkLedgerInvariants` возвращала **пустой список**.
   * Теперь второе начисление в журнал не попадает вовсе.
   */
  it('refuses a second accrual for the same tranche', () => {
    const journal = appendEntry(lockedUnderA(), accrueFee(at('a1', 2), dealA, fee, 'plan-1'));
    expectCode(
      () => appendEntry(journal, accrueFee(at('a2', 3), dealA, fee, 'plan-1')),
      LedgerErrorCode.journalFeeAccruedTwice,
    );
  });

  /**
   * Признак начисления — **проводки**, а не объявление `accrues`. Объявление
   * необязательно (`fee:income` остаётся обычным счётом дохода), поэтому
   * правило, стоящее на нём, обходилось бы низкоуровневой дверью без единой
   * уловки: просто не объявлять.
   */
  it('counts an accrual assembled without a declaration', () => {
    const undeclared = createJournalEntry({
      ...at('a1', 2),
      kind: 'settlement',
      memoKey: 'ledger.entry.fee_accrued',
      postings: [debit(feeReceivable, fee, dealA), credit(feeIncome, fee, dealA)],
    });
    const journal = appendEntry(lockedUnderA(), undeclared);
    expectCode(
      () => appendEntry(journal, accrueFee(at('a2', 3), dealA, fee, 'plan-1')),
      LedgerErrorCode.journalFeeAccruedTwice,
    );
  });

  it('leaves an accrual for another tranche alone', () => {
    const journal = appendEntry(lockedUnderA(), accrueFee(at('a1', 2), dealA, fee, 'plan-1'));
    const other = { dealId: 'B', trancheId: 't1' };
    expect(() => appendEntry(journal, accrueFee(at('a2', 3), other, fee, 'plan-1'))).not.toThrow();
  });

  it('does not mistake withholding or reversal for a second accrual', () => {
    const accrual = accrueFee(at('a1', 2), dealA, fee, 'plan-1');
    let journal = appendEntry(lockedUnderA(), accrual);
    journal = appendEntry(journal, settlement('a2', 3, accrual));
    journal = appendEntry(journal, receiveFee(at('a3', 4), dealA, fee));
    expect(accountBalance(journal, feeReceivable, 'GEL').minor).toBe(0n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  /** Повтор — не второе начисление, а то же самое: журнал не меняется. */
  it('returns the same accrual on a repeat and appends nothing', () => {
    const first = accrueFeeOnce(lockedUnderA(), at('a1', 2), dealA, fee, 'plan-1');
    expect(first.appended).toBe(true);
    expect(first.journal.entries).toHaveLength(3);

    const repeat = accrueFeeOnce(first.journal, at('a2', 3), dealA, fee, 'plan-1');
    expect(repeat.appended).toBe(false);
    expect(repeat.journal).toBe(first.journal);
    expect(repeat.accrual.id).toBe('a1');
    expect(repeat.accrual.accruedFee.minor).toBe(fee.minor);
    expect(accountBalance(repeat.journal, feeIncome, 'GEL').minor).toBe(fee.minor);
    expect(accountBalance(repeat.journal, feeReceivable, 'GEL').minor).toBe(fee.minor);
  });

  /**
   * §4.2 запрещает пересчёт задним числом. Повтор с другой суммой — не повтор,
   * а расхождение тарифа, и вернуть на него старое начисление значило бы это
   * расхождение спрятать.
   */
  it('refuses a repeat that asks for a different fee or plan version', () => {
    const first = accrueFeeOnce(lockedUnderA(), at('a1', 2), dealA, fee, 'plan-1');
    expectCode(
      () => accrueFeeOnce(first.journal, at('a2', 3), dealA, money('GEL', 60_000n), 'plan-1'),
      LedgerErrorCode.entryFeeAccrualMismatch,
    );
    expectCode(
      () => accrueFeeOnce(first.journal, at('a2', 3), dealA, fee, 'plan-2'),
      LedgerErrorCode.entryFeeAccrualMismatch,
    );
  });

  /**
   * §4.4: уход в возвратную ветвь снимает начисление исправлением. Снятое
   * начисление не возвращается токеном — удержание по нему увело бы
   * `fee:receivable` в минус.
   */
  it('does not hand back an accrual that was reversed', () => {
    const accrual = accrueFee(at('a1', 2), dealA, fee, 'plan-1');
    const journal = appendEntries(lockedUnderA(), [
      accrual,
      reverseFeeAccrual(at('a2', 3), accrual),
    ]);
    expect(feeAccrualFor(journal, dealA)).toBeNull();
  });
});

/**
 * «Начислено и никогда не удержано» — состояние, которого до этого батча не
 * выражало ничто: `transitStale` покрывает транзиты, покрытие и отрицательные
 * остатки к требованию платформы не относятся.
 */
describe('дебиторка по комиссии видна как расхождение', () => {
  /**
   * Та же проба, но на журнале, пришедшем из базы: два начисления уже записаны,
   * `appendEntry` их не отсеет — она их не видела. Расчёт удержал одно, второе
   * осталось требованием навсегда.
   *
   * До инварианта список нарушений здесь был пуст: покрытие цело (комиссия из
   * клиентских денег не бралась), отрицательных остатков нет, транзит в порядке.
   */
  it('catches a doubled accrual that only one settlement could withhold', () => {
    const first = accrueFee(at('a1', 2), dealA, fee, 'plan-1');
    const second = accrueFee(at('a2', 3), dealA, fee, 'plan-1');
    const journal = unguardedJournal([
      ...lockedUnderA().entries,
      first,
      second,
      settlement('a3', 4, first),
    ]);

    // Доход признан дважды, требование удержано один раз.
    expect(accountBalance(journal, feeIncome, 'GEL').minor).toBe(fee.minor * 2n);
    expect(accountBalance(journal, feeReceivable, 'GEL').minor).toBe(fee.minor);
    expect(feePositions(journal)[0]?.notWithheld.minor).toBe(fee.minor);

    const position = openFeeReceivables(journal)[0];
    expect(position?.trancheDrained).toBe(true);
    expect(position?.outstanding.minor).toBe(fee.minor);

    expect(
      checkLedgerInvariants(journal).map((item) => [item.code, item.subject, item.amountMinor]),
    ).toEqual([[InvariantCode.feeNotWithheld, 'A:t1', fee.minor]]);
  });

  /**
   * Второй случай под тем же кодом: сделка ушла в возвратную ветвь, начисление
   * не сняли. §4.4 говорит, что комиссия за расчёт тогда не начисляется;
   * оставшееся требование — признанный доход без удержания.
   */
  it('catches an accrual left behind when the tranche was refunded', () => {
    const accrual = accrueFee(at('a1', 2), dealA, fee, 'plan-1');
    const journal = appendEntries(lockedUnderA(), [
      accrual,
      // Отвязка: деньги вернулись в свободную часть, транш пуст.
      createJournalEntry({
        ...at('a2', 3),
        kind: 'settlement',
        memoKey: 'ledger.entry.unlocked_to_client',
        postings: [
          debit({ kind: 'client_locked', clientKey: buyer, ...dealA } as const, gross, dealA),
          credit(clientFreeAccount(buyer), gross, { clientKey: buyer }),
          credit({ kind: 'bank_nominal', currency: 'GEL' } as const, gross, dealA),
          debit({ kind: 'bank_nominal', currency: 'GEL' } as const, gross, { clientKey: buyer }),
        ],
      }),
    ]);
    expect(
      checkLedgerInvariants(journal).map((item) => [item.code, item.subject]),
    ).toEqual([[InvariantCode.feeNotWithheld, 'A:t1']]);
  });

  /**
   * Пока транш ждёт расчёта, «начислено, не удержано» — законное состояние
   * (§4.6). Расхождением оно становится по возрасту, и окно у него своё: см.
   * `feeReceivableStale`.
   */
  it('keeps a fresh receivable quiet and reports a stale one', () => {
    const journal = appendEntry(lockedUnderA(), accrueFee(at('a1', 2), dealA, fee, 'plan-1'));
    expect(checkLedgerInvariants(journal)).toEqual([]);

    const stale = checkLedgerInvariants(journal, { asOf: '2026-09-06T10:00:00Z' });
    expect(stale.map((item) => [item.code, item.subject, item.amountMinor])).toEqual([
      [InvariantCode.feeReceivableStale, 'A:t1', fee.minor],
    ]);

    // Своё окно — не транзитное: с длинным окном требование молчит, а транзит,
    // если бы он был, продолжал бы считаться по своему.
    expect(
      checkLedgerInvariants(journal, {
        asOf: '2026-09-06T10:00:00Z',
        feeStaleAfterMs: 7 * 24 * 60 * 60 * 1000,
      }),
    ).toEqual([]);
  });

  it('does not report a receivable driven below zero — that has its own code', () => {
    const journal = unguardedJournal([
      ...lockedUnderA().entries,
      createJournalEntry({
        ...at('a1', 2),
        kind: 'settlement',
        memoKey: 'ledger.entry.fee_accrued',
        postings: [credit(feeReceivable, fee, dealA), debit(feeIncome, fee, dealA)],
      }),
    ]);
    const codes = checkLedgerInvariants(journal, { asOf: '2026-09-06T10:00:00Z' }).map(
      (item) => item.code,
    );
    expect(codes).toContain(InvariantCode.platformAssetNegative);
    expect(codes).not.toContain(InvariantCode.feeNotWithheld);
    expect(codes).not.toContain(InvariantCode.feeReceivableStale);
  });
});
