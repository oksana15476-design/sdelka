import { type Money, convert, fxRates, isoDate, money, platformSpread, rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  InvariantCode,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  accountBalance,
  appendEntries,
  appendEntry,
  bankOperating,
  checkLedgerInvariants,
  clientKey,
  clientTopUp,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  executeConversion,
  fxExecution,
  fxSettlement,
  openFxPositions,
  receiveConversion,
  sendForConversion,
} from '../src/index';

const alice = clientKey('c1');
const bob = clientKey('c2');
const asOf = isoDate('2026-09-03');

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

const rates = fxRates('USD', 'GEL', {
  client: rationalFromDecimalString('2.6686875'),
  reference: rationalFromDecimalString('2.6875'),
  official: rationalFromDecimalString('2.7000'),
});
const eightyThousandUsd: Money = money('USD', 8_000_000n);
const converted = convert(eightyThousandUsd, rates, asOf, 'trunc');
const spread = platformSpread(converted, 'trunc');

// Оба клиента назвали свой обмен одинаково. `x1` — не выдумка теста: ключ
// приходит из внешней системы, и совпадение имён там правило, а не редкость.
const exchange = fxExecution('x1', converted);

/**
 * FUNCTIONAL.md §3.3: открытая позиция по обмену — **единственное**, чем ловится
 * «встречная валюта не поставлена». Ни отрицательным остатком, ни покрытием это
 * состояние не выражается, поэтому слияние двух позиций в одну не оставляло
 * следа нигде.
 */
describe('ключ конверсии принадлежит одному клиенту и одному обмену', () => {
  it('gives two clients two different accounts for the same conversion key', () => {
    expect(fxSettlement(alice, 'x1')).not.toEqual(fxSettlement(bob, 'x1'));
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), alice, eightyThousandUsd),
      sendForConversion(at('a1', 1), alice, exchange),
    ]);
    expect(accountBalance(journal, fxSettlement(alice, 'x1'), 'USD').minor).toBe(8_000_000n);
    expect(accountBalance(journal, fxSettlement(bob, 'x1'), 'USD').minor).toBe(0n);
  });

  /**
   * Проба, ради которой владелец попал в код счёта.
   *
   * У Алисы обмен завис на первом моменте: доллары контрагенту отданы, лари не
   * поставлены. У Боба тот же ключ и полный цикл из трёх моментов. Пока счёт
   * был один на обоих, ноги Боба гасили позицию Алисы: `openFxPositions`
   * возвращала пустой список, инвариант `fxPositionOpen` молчал, и «нам не
   * поставили встречную валюту» переставало быть величиной.
   */
  it('does not let one client closed exchange flatten another one still open', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), alice, eightyThousandUsd),
      clientTopUp(at('t2', 1), bob, eightyThousandUsd),
      sendForConversion(at('a1', 2), alice, exchange),
      sendForConversion(at('b1', 3), bob, exchange),
      executeConversion(at('b2', 4), bob, exchange),
      receiveConversion(at('b3', 5), bob, exchange, spread),
    ]);

    const open = openFxPositions(journal);
    expect(
      open.map((item) => [item.owner, item.conversionId, item.accountCode]),
    ).toEqual([[alice, 'x1', 'fx:settlement:c1:x1']]);
    expect(open[0]?.balances.map((item) => [item.currency, item.amount.minor])).toEqual([
      ['USD', 8_000_000n],
    ]);

    // И через двое суток это расхождение, названное по счёту, а не по ключу:
    // «висит обмен x1» без имени клиента дежурному сказать нечего.
    expect(
      checkLedgerInvariants(journal, { asOf: '2026-09-06T10:00:00Z' }).map((item) => [
        item.code,
        item.subject,
        item.amountMinor,
      ]),
    ).toEqual([[InvariantCode.fxPositionOpen, 'fx:settlement:c1:x1', 8_000_000n]]);
  });

  /**
   * Уникальность ключа не проверялась нигде: `fxExecution` сверяет объявление с
   * самим собой, `assertConversionDeclared` — проводки записи с объявлением, и
   * ни одна из двух не могла заметить, что тем же ключом уже назван другой
   * обмен. Второй обмен открывал позицию поверх старой.
   */
  it('refuses to reuse a conversion key for a different exchange', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), alice, money('USD', 20_000_000n)),
      sendForConversion(at('a1', 1), alice, exchange),
      executeConversion(at('a2', 2), alice, exchange),
      receiveConversion(at('a3', 3), alice, exchange, spread),
    ]);
    // Позиция закрыта — и всё равно ключ занят: он назван, и назван один раз.
    expect(openFxPositions(journal)).toEqual([]);

    const another = fxExecution('x1', convert(money('USD', 1_000_000n), rates, asOf, 'trunc'));
    expectCode(
      () => appendEntry(journal, sendForConversion(at('a4', 4), alice, another)),
      LedgerErrorCode.journalConversionKeyReused,
    );
  });

  /**
   * Недопоставка: контрагент поставил меньше и объявил это честно — по тому же
   * курсу, на меньшую сумму. Другого способа записать её сегодня нет
   * (`assertConversionDeclared` требует, чтобы проводка равнялась объявленной
   * ноге), и требование полного совпадения объявлений сделало бы реальное
   * событие незаписываемым. Требование остаётся непогашенным, позиция —
   * открытой: недопоставка видна, а не растворяется в покрытии.
   */
  it('lets an open position take a smaller delivery of the same pair', () => {
    let journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), alice, eightyThousandUsd),
      sendForConversion(at('a1', 1), alice, exchange),
      executeConversion(at('a2', 2), alice, exchange),
    ]);
    const partial = fxExecution('x1', convert(money('USD', 4_000_000n), rates, asOf, 'trunc'));
    journal = appendEntry(
      journal,
      receiveConversion(at('a3', 3), alice, partial, platformSpread(partial.converted, 'trunc')),
    );
    const open = openFxPositions(journal);
    expect(open).toHaveLength(1);
    expect(open[0]?.balances.map((item) => [item.currency, item.amount.minor])).toEqual([
      ['GEL', converted.target.minor - partial.converted.target.minor],
    ]);
  });

  it('refuses a reused key whose currency pair is not the one it was opened with', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), alice, eightyThousandUsd),
      sendForConversion(at('a1', 1), alice, exchange),
    ]);
    const backwards = fxExecution(
      'x1',
      convert(
        money('GEL', 1_000_000n),
        fxRates('GEL', 'USD', {
          client: rationalFromDecimalString('0.37'),
          reference: rationalFromDecimalString('0.372'),
          official: rationalFromDecimalString('0.371'),
        }),
        asOf,
        'trunc',
      ),
    );
    expectCode(
      () => appendEntry(journal, sendForConversion(at('a2', 2), alice, backwards)),
      LedgerErrorCode.journalConversionKeyReused,
    );
  });

  it('lets the same exchange be applied by all three of its moments', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), alice, eightyThousandUsd),
      sendForConversion(at('a1', 1), alice, exchange),
      executeConversion(at('a2', 2), alice, exchange),
      receiveConversion(at('a3', 3), alice, exchange, spread),
    ]);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  /**
   * Второй контур на построении записи: одна запись трогает **один** счёт
   * обмена. Сверка по ключу конверсии здесь пропустила бы форму насквозь — у
   * обеих ног ключ `x1`, — а гасят они позиции разных клиентов.
   *
   * Форма собрана «профинансированной» намеренно: без кредита операционного
   * счёта её отвергает `assertNoUnfundedClientFileGain`, и отказ объяснялся бы
   * им, а не проверкой счёта обмена.
   */
  it('refuses one entry that nets the same key across two clients', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('x1'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fx_sent_for_conversion',
          converts: exchange,
          postings: [
            debit(fxSettlement(alice, 'x1'), eightyThousandUsd, { clientKey: alice }),
            credit(fxSettlement(bob, 'x1'), eightyThousandUsd, { clientKey: bob }),
            debit({ kind: 'shortfall_expense' } as const, eightyThousandUsd, { clientKey: alice }),
            credit(bankOperating('USD'), eightyThousandUsd),
          ],
        }),
      LedgerErrorCode.entryConversionUndeclared,
    );
  });
});
