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
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  executeConversion,
  freeBalance,
  fxExecution,
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
const exchange = fxExecution('x1', converted);
const settlementAccount = fxSettlement(owner, 'x1');

/** Все три момента обмена подряд — обычный путь. */
function convertedJournal() {
  return appendEntries(emptyJournal, [
    clientTopUp(at('t1'), owner, eightyThousandUsd),
    sendForConversion(at('c1', 5), owner, exchange),
    executeConversion(at('c2', 10), owner, exchange),
    receiveConversion(at('c3', 15), owner, exchange, spread),
  ]);
}

describe('конвертация — операция с внешним контрагентом, а не появление денег', () => {
  it('moves the source currency out through the counterparty before anything else', () => {
    let journal = appendEntry(emptyJournal, clientTopUp(at('t1'), owner, eightyThousandUsd));
    journal = appendEntry(journal, sendForConversion(at('c1', 5), owner, exchange));

    // Момент 1: доллары ушли с номинального счёта контрагенту. Обязательство
    // перед клиентом не тронуто — обмен ещё не исполнен.
    expect(accountBalance(journal, bankNominal('USD'), 'USD').minor).toBe(0n);
    expect(accountBalance(journal, settlementAccount, 'USD').minor).toBe(8_000_000n);
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

  /**
   * **[изменённое ожидание, и это исправление дефекта, а не правка теста]**
   *
   * Прежняя редакция ждала здесь `bank:nominal:gel === 21 349 500` сразу после
   * второй записи — то есть ждала, что лари появятся на счёте в тот же миг,
   * когда возникает обязательство в лари. Это была форма дефекта, записанная
   * как ожидание: обе стороны создавала одна запись, и покрытие в целевой
   * валюте после конвертации тождественно равнялось единице при любой сумме.
   *
   * Теперь момент исполнения обмена лари на счёт не приносит: он переоформляет
   * обязательство против требования к контрагенту (FUNCTIONAL.md §3.3, M2).
   */
  it('re-denominates the obligation without putting a single lari on the account', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, eightyThousandUsd),
      sendForConversion(at('c1', 5), owner, exchange),
      executeConversion(at('c2', 10), owner, exchange),
    ]);

    expect(freeBalance(journal, owner, 'USD').minor).toBe(0n);
    expect(freeBalance(journal, owner, 'GEL').minor).toBe(21_349_500n);
    // Обязательство в лари есть, лари на номинальном счёте нет: их ещё не
    // поставили.
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(0n);
    expect(accountBalance(journal, settlementAccount, 'GEL').minor).toBe(21_349_500n);
    expect(accountBalance(journal, settlementAccount, 'USD').minor).toBe(0n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  it('closes the claim on the counterparty when the target currency arrives', () => {
    const journal = convertedJournal();

    expect(accountBalance(journal, settlementAccount, 'USD').minor).toBe(0n);
    expect(accountBalance(journal, settlementAccount, 'GEL').minor).toBe(0n);
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
   * Встречная валюта приходит только против требования к контрагенту, а
   * требования не бывает без предыдущих моментов. Закрытие несуществующего
   * требования уводит `fx:settlement:{k}` в минус — отрицательный остаток
   * клиентского счёта, инвариант и стоп-кран.
   */
  it('cannot receive the target currency without having sent the source', () => {
    const journal = appendEntry(emptyJournal, receiveConversion(at('c3'), owner, exchange, spread));
    const violations = checkLedgerInvariants(journal);
    expect(
      violations
        .filter((item) => item.code === InvariantCode.negativeClientBalance)
        .map((item) => [item.subject, item.amountMinor]),
    ).toEqual([['fx:settlement:c1:x1', -21_349_500n]]);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });

  it('cannot re-denominate the obligation without having sent the source', () => {
    // Симметричный случай: M2 без M1 уводит требование в исходной валюте в
    // минус — обмена, который переоформляется, не было.
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, eightyThousandUsd),
      executeConversion(at('c2', 10), owner, exchange),
    ]);
    const violations = checkLedgerInvariants(journal);
    expect(
      violations
        .filter((item) => item.code === InvariantCode.negativeClientBalance)
        .map((item) => [item.subject, item.amountMinor]),
    ).toEqual([['fx:settlement:c1:x1', -8_000_000n]]);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });

  it('keeps the counterparty position visible per file while the exchange is open', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, eightyThousandUsd),
      sendForConversion(at('c1', 5), owner, exchange),
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
   * клиента и в него же возвращается на счёт расчётов, файл сходится. Ловится
   * это моментом 2, где обязательство клиента уходит в минус, — и до тех пор
   * никакая валюта клиенту не зачислена.
   */
  it('catches a client converting more than they hold, at the second moment', () => {
    let journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, money('USD', 1_000_000n)),
      sendForConversion(at('c1', 5), owner, exchange),
    ]);
    expect(checkLedgerInvariants(journal).map((item) => item.code)).toEqual([
      // Долларов на номинальном счёте столько не было.
      InvariantCode.negativeClientBalance,
    ]);

    journal = appendEntry(journal, executeConversion(at('c2', 10), owner, exchange));
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
      () =>
        receiveConversion(
          at('c3'),
          owner,
          fxExecution('x2', loss),
          platformSpread(loss, 'trunc'),
        ),
      LedgerErrorCode.entryNegativeSpread,
    );
  });

  it('records a conversion without spread without a zero posting', () => {
    const atCost = fxRates('USD', 'GEL', {
      client: rationalFromDecimalString('2.6875'),
      reference: rationalFromDecimalString('2.6875'),
      official: rationalFromDecimalString('2.7000'),
    });
    const even = fxExecution('x3', convert(eightyThousandUsd, atCost, asOf, 'trunc'));
    const entry = receiveConversion(at('c3'), owner, even, platformSpread(even.converted, 'trunc'));
    // Момент 3 без спреда — ровно две проводки: пришло от контрагента, закрыто
    // требование.
    expect(entry.postings).toHaveLength(2);
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, eightyThousandUsd),
      sendForConversion(at('c1', 5), owner, even),
      executeConversion(at('c2', 10), owner, even),
      entry,
    ]);
    expect(freeBalance(journal, owner, 'GEL').minor).toBe(21_500_000n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });
});

describe('объявление обмена — курс становится фактом журнала (§4.5, И14.2)', () => {
  it('keeps the three rates and the date on every entry of the exchange', () => {
    const journal = convertedJournal();
    const declared = journal.entries.filter((entry) => entry.converts !== null);
    expect(declared).toHaveLength(3);
    for (const entry of declared) {
      expect(entry.converts?.conversionId).toBe('x1');
      expect(entry.converts?.converted.rates.client.value).toEqual(
        rationalFromDecimalString('2.6686875'),
      );
      expect(entry.converts?.converted.asOf).toBe(asOf);
    }
  });

  it('refuses a declaration whose target is not the source at the client rate', () => {
    expectCode(
      () => fxExecution('x4', { ...converted, target: money('GEL', 21_500_000n) }),
      LedgerErrorCode.entryConversionDeclarationMismatch,
    );
  });

  it('refuses to touch the counterparty account without declaring the exchange', () => {
    // Та же запись, что и момент 1, но обмен не объявлен: валюта уходит
    // контрагенту неизвестно по какому курсу и в счёт какого обмена.
    expectCode(
      () =>
        createJournalEntry({
          ...at('c1'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fx_sent_for_conversion',
          postings: [
            credit(bankNominal('USD'), eightyThousandUsd, { clientKey: owner }),
            debit(settlementAccount, eightyThousandUsd, { clientKey: owner }),
          ],
        }),
      LedgerErrorCode.entryConversionUndeclared,
    );
  });

  it('refuses a posting whose amount is neither leg of the declared exchange', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('c1'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fx_sent_for_conversion',
          converts: exchange,
          postings: [
            credit(bankNominal('USD'), money('USD', 100n), { clientKey: owner }),
            debit(settlementAccount, money('USD', 100n), { clientKey: owner }),
          ],
        }),
      LedgerErrorCode.entryConversionUndeclared,
    );
  });

  it('refuses one entry that nets two different exchanges', () => {
    // Ключ конверсии для того и стоит в коде счёта: позиция одного обмена не
    // гасится встречной ногой другого.
    expectCode(
      () =>
        createJournalEntry({
          ...at('c1'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fx_sent_for_conversion',
          converts: exchange,
          postings: [
            credit(fxSettlement(owner, 'x9'), eightyThousandUsd, { clientKey: owner }),
            debit(settlementAccount, eightyThousandUsd, { clientKey: owner }),
          ],
        }),
      LedgerErrorCode.entryConversionUndeclared,
    );
  });
});
