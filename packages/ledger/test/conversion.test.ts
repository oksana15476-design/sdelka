import {
  type Money,
  convert,
  fxRates,
  isoDate,
  money,
  platformSpread,
  rationalFromDecimalString,
} from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  InvariantCode,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  accountBalance,
  appendEntries,
  appendEntry,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientKey,
  clientStatement,
  clientTopUp,
  coverage,
  coverageByFundsSource,
  emptyJournal,
  freeBalance,
  fxSettlement,
  receiveConversion,
  sendForConversion,
  shouldStopAcceptingDeals,
} from '../src/index';

const owner = clientKey('c1');
const asOf = isoDate('2026-09-03');
const fxIncome = { kind: 'fx_income' } as const;

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

// FUNCTIONAL.md §3.3, шаг 2: 80 000 USD, клиентский курс 2,6686875, эталонный
// 2,6875 — 213 495 ₾ клиенту и 1 505 ₾ спреда.
const rates = fxRates('USD', 'GEL', {
  client: rationalFromDecimalString('2.6686875'),
  reference: rationalFromDecimalString('2.6875'),
  official: rationalFromDecimalString('2.7000'),
});
const eightyThousandUsd: Money = money('USD', 8_000_000n);
const converted = convert(eightyThousandUsd, rates, asOf, 'trunc');
const spread = platformSpread(converted, 'trunc');

describe('конвертация — операция с внешним контрагентом, а не появление денег', () => {
  it('moves the source currency out through the counterparty before the target arrives', () => {
    let journal = appendEntry(emptyJournal, clientTopUp(at('t1'), owner, eightyThousandUsd));
    journal = appendEntry(journal, sendForConversion(at('c1', 5), owner, eightyThousandUsd));

    // Момент 1: доллары ушли с номинального счёта контрагенту. Обязательство
    // перед клиентом не тронуто — он должен получить ровно то, что отдал.
    expect(accountBalance(journal, bankNominal('USD'), 'USD').minor).toBe(0n);
    expect(accountBalance(journal, fxSettlement, 'USD').minor).toBe(8_000_000n);
    expect(freeBalance(journal, owner, 'USD').minor).toBe(8_000_000n);

    // Деньги у контрагента — всё ещё клиентские: покрытие единица, файл клиента
    // обеспечен, стоп-кран не сработал. Иначе каждая конвертация останавливала
    // бы приём новых сделок на время расчётов с контрагентом.
    expect(coverage(journal).map((item) => [item.currency, item.covered])).toEqual([
      ['USD', true],
    ]);
    expect(checkLedgerInvariants(journal)).toEqual([]);
    expect(shouldStopAcceptingDeals(journal)).toBe(false);
  });

  it('closes the claim on the counterparty when the target currency arrives', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, eightyThousandUsd),
      sendForConversion(at('c1', 5), owner, eightyThousandUsd),
      receiveConversion(at('c2', 10), owner, converted, spread),
    ]);

    expect(accountBalance(journal, fxSettlement, 'USD').minor).toBe(0n);
    expect(freeBalance(journal, owner, 'USD').minor).toBe(0n);
    expect(freeBalance(journal, owner, 'GEL').minor).toBe(21_349_500n);
    // На номинальном счёте — ровно деньги клиента. Спред пришёл на операционный
    // и на номинальном не лежал ни минуты (красная линия №2).
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(21_349_500n);
    expect(accountBalance(journal, bankOperating('GEL'), 'GEL').minor).toBe(150_500n);
    expect(accountBalance(journal, fxIncome, 'GEL').minor).toBe(150_500n);

    expect(checkLedgerInvariants(journal)).toEqual([]);
    // Обе валюты видны в выписке раздельно и не пересчитываются друг в друга.
    const statement = clientStatement(journal, owner);
    expect(statement.free.map((item) => [item.currency, item.amount.minor])).toEqual([
      ['GEL', 21_349_500n],
      ['USD', 0n],
    ]);
  });

  /**
   * Проба верификатора, перенесённая в учёт.
   *
   * Прежняя запись дебетовала `bank:nominal:{целевая}` на всю сумму без единого
   * внешнего источника: номинальный в долларах был ноль и становился 500 000.
   * Обязательство перед клиентом и покрытие под него создавала одна и та же
   * запись, поэтому покрытие тождественно равнялось единице и не проверяло
   * больше ничего.
   *
   * Теперь встречная валюта приходит только против требования к контрагенту, а
   * требования не бывает без момента 1. Закрытие несуществующего требования
   * уводит `fx:settlement` в минус — отрицательный остаток клиентского счёта,
   * инвариант и стоп-кран.
   */
  it('cannot receive the target currency without having sent the source', () => {
    const journal = appendEntry(
      emptyJournal,
      receiveConversion(at('c2'), owner, converted, spread),
    );
    const violations = checkLedgerInvariants(journal);
    const negative = violations.filter(
      (item) => item.code === InvariantCode.negativeClientBalance,
    );
    expect(negative.map((item) => [item.subject, item.amountMinor])).toEqual([
      // Обязательство клиента в долларах ушло в минус — он ничего не отдавал…
      ['client:c1:free', -8_000_000n],
      // …и требования к контрагенту, которое эта запись гасит, не существует.
      ['fx:settlement', -8_000_000n],
    ]);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });

  it('keeps the counterparty position visible per file while the exchange is open', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, eightyThousandUsd),
      sendForConversion(at('c1', 5), owner, eightyThousandUsd),
    ]);
    const byFile = coverageByFundsSource(journal).map((item) => [
      item.source.kind === 'client' ? item.source.clientKey : 'tranche',
      item.currency,
      item.custody.minor,
      item.obligations.minor,
    ]);
    // Деньги у контрагента остаются в файле клиента: ни недостачи, ни профицита.
    expect(byFile).toEqual([[owner, 'USD', 8_000_000n, 8_000_000n]]);
  });

  /**
   * «Хватает ли свободного остатка» конструктор не проверяет — журнала он не
   * видит и видеть не должен (та же граница, что у `lockForTranche`).
   * Предпроверка — `freeBalance` у того, кто строит запись; второй контур —
   * отрицательный остаток клиентского счёта.
   *
   * Момент 1 при этом молчит намеренно: отнесение кастодиана уходит из файла
   * клиента и в него же возвращается на `fx:settlement`, файл сходится. Ловится
   * это моментом 2, где обязательство клиента уходит в минус, — и до тех пор
   * никакая валюта клиенту не зачислена.
   */
  it('catches a client converting more than they hold, at the second moment', () => {
    let journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, money('USD', 1_000_000n)),
      sendForConversion(at('c1', 5), owner, eightyThousandUsd),
    ]);
    expect(checkLedgerInvariants(journal).map((item) => item.code)).toEqual([
      // Долларов на номинальном счёте столько не было.
      InvariantCode.negativeClientBalance,
    ]);

    journal = appendEntry(journal, receiveConversion(at('c2', 10), owner, converted, spread));
    expect(freeBalance(journal, owner, 'USD').minor).toBe(-7_000_000n);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });

  it('refuses to record a loss on conversion as income', () => {
    // Клиентский курс лучше эталонного: спред отрицательный. Это убыток
    // платформы, и проводка у него другая — выворачивать направление молча
    // значило бы записать убыток доходом.
    const generous = fxRates('USD', 'GEL', {
      client: rationalFromDecimalString('2.6875'),
      reference: rationalFromDecimalString('2.6686875'),
      official: rationalFromDecimalString('2.7000'),
    });
    const loss = convert(eightyThousandUsd, generous, asOf, 'trunc');
    expectCode(
      () => receiveConversion(at('c2'), owner, loss, platformSpread(loss, 'trunc')),
      LedgerErrorCode.entryNegativeSpread,
    );
  });

  it('records a conversion without spread without a zero posting', () => {
    const atCost = fxRates('USD', 'GEL', {
      client: rationalFromDecimalString('2.6875'),
      reference: rationalFromDecimalString('2.6875'),
      official: rationalFromDecimalString('2.7000'),
    });
    const even = convert(eightyThousandUsd, atCost, asOf, 'trunc');
    const entry = receiveConversion(at('c2'), owner, even, platformSpread(even, 'trunc'));
    expect(entry.postings).toHaveLength(4);
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, eightyThousandUsd),
      sendForConversion(at('c1', 5), owner, eightyThousandUsd),
      entry,
    ]);
    expect(freeBalance(journal, owner, 'GEL').minor).toBe(21_500_000n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });
});
