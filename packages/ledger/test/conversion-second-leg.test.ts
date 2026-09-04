import {
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
  accountBalance,
  appendEntries,
  bankNominal,
  checkLedgerInvariants,
  clientKey,
  clientTopUp,
  coverage,
  emptyJournal,
  executeConversion,
  freeBalance,
  fxExecution,
  isClientObligationAccount,
  openFxPositions,
  receiveConversion,
  sendForConversion,
  shouldStopAcceptingDeals,
} from '../src/index';

/**
 * Вторая нога конвертации — открытый дефект прошлого батча.
 *
 * Разделение конвертации на два момента закрыло только ногу исходной валюты.
 * Нога встречной повторяла прежнюю форму целиком: `Дт bank:nominal:gel` и
 * `Кт client:{c}:free` в одной записи, внешнего источника лари нет.
 *
 * Проба, снятая до правки на этом же журнале:
 *
 * ```
 * clientTopUp(USD 80 000) → sendForConversion → receiveConversion
 * nominal GEL = 21349500n     (счёт был пуст, лари извне не поступали)
 * coverage    = [GEL 21349500/21349500 = 1/1, USD 0/0]
 * invariants  = []            shouldStopAcceptingDeals = false
 * ```
 *
 * То есть покрытие в целевой валюте после конвертации равнялось единице
 * **тождественно, при любой сумме**, и больше ничего не проверяло.
 */
const owner = clientKey('c1');
const asOf = isoDate('2026-09-03');
const rates = fxRates('USD', 'GEL', {
  client: rationalFromDecimalString('2.6686875'),
  reference: rationalFromDecimalString('2.6875'),
  official: rationalFromDecimalString('2.7000'),
});
const usd = money('USD', 8_000_000n);
const converted = convert(usd, rates, asOf, 'trunc');
const spread = platformSpread(converted, 'trunc');
const exchange = fxExecution('x1', converted);

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-03T10:${String(minute).padStart(2, '0')}:00Z` };
}

describe('вторая нога конвертации: встречная валюта приходит через контрагента', () => {
  it('never creates the target-currency asset and its obligation in one entry', () => {
    // Это и есть форма дефекта, высказанная как утверждение о журнале: ни одна
    // запись обмена не создаёт одновременно актив в целевой валюте и
    // обязательство под него. Утверждение проверяется по всем записям, а не по
    // имени конструктора, — иначе оно снова разъедется с реализацией.
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, usd),
      sendForConversion(at('c1', 5), owner, exchange),
      executeConversion(at('c2', 10), owner, exchange),
      receiveConversion(at('c3', 15), owner, exchange, spread),
    ]);

    for (const entry of journal.entries) {
      const bringsCustodyIn = entry.postings.some(
        (posting) => posting.account.kind === 'bank_nominal' && posting.direction === 'debit',
      );
      const createsObligation = entry.postings.some(
        (posting) =>
          isClientObligationAccount(posting.account) && posting.direction === 'credit',
      );
      // Единственное законное исключение — зачисление извне (`clientTopUp`):
      // там деньги приходят от плательщика, а не появляются.
      if (entry.memoKey === 'ledger.entry.client_top_up') continue;
      expect([entry.memoKey, bringsCustodyIn && createsObligation]).toEqual([
        entry.memoKey,
        false,
      ]);
    }
  });

  it('leaves the target currency off the nominal account until the counterparty delivers', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, usd),
      sendForConversion(at('c1', 5), owner, exchange),
      executeConversion(at('c2', 10), owner, exchange),
    ]);
    // Прежде здесь было 21 349 500 на счёте, которого никто не пополнял.
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(0n);
    expect(freeBalance(journal, owner, 'GEL').minor).toBe(21_349_500n);
  });

  /**
   * Честно о том, чего это **не** закрывает.
   *
   * Между M2 и M3 позиция в целевой валюте лежит на счёте расчётов с
   * контрагентом, а он объявлен клиентским активом — деньги клиента, просто не
   * у нас. Поэтому портфельное покрытие в этот промежуток по-прежнему сходится
   * в единицу, и это не дыра, а определение: обеспечение у обязательства есть,
   * оно просто не на нашем счёте.
   *
   * Состояние «встречная валюта не поставлена» не выражается ни отрицательным
   * остатком, ни покрытием. Его ловит только возраст позиции.
   */
  it('catches the undelivered counter-currency by the age of the position, and only by it', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, usd),
      sendForConversion(at('c1', 5), owner, exchange),
      executeConversion(at('c2', 10), owner, exchange),
    ]);

    // Покрытие молчит, и это правда о деньгах, а не дефект.
    expect(coverage(journal).map((item) => [item.currency, item.covered])).toEqual([
      ['GEL', true],
      ['USD', true],
    ]);
    // Свежая позиция — не расхождение: между тремя моментами она обязана быть
    // ненулевой.
    expect(checkLedgerInvariants(journal)).toEqual([]);

    const stale = checkLedgerInvariants(journal, { asOf: '2026-09-06T10:00:00Z' });
    expect(stale.map((item) => [item.code, item.subject, item.currency, item.amountMinor])).toEqual(
      [[InvariantCode.fxPositionOpen, 'fx:settlement:c1:x1', 'GEL', 21_349_500n]],
    );
    // Приём новых сделок этим не останавливается: покрытие не нарушено
    // (см. `InvariantCode.fxPositionOpen`).
    expect(shouldStopAcceptingDeals(journal, { asOf: '2026-09-06T10:00:00Z' })).toBe(false);
  });

  it('catches the source currency handed over and never exchanged', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, usd),
      sendForConversion(at('c1', 5), owner, exchange),
    ]);
    const stale = checkLedgerInvariants(journal, { asOf: '2026-09-06T10:00:00Z' });
    expect(stale.map((item) => [item.code, item.subject, item.currency, item.amountMinor])).toEqual(
      [[InvariantCode.fxPositionOpen, 'fx:settlement:c1:x1', 'USD', 8_000_000n]],
    );
  });

  /**
   * Ключ конверсии в коде счёта — не украшение.
   *
   * Прежде счёт расчётов был один на все обмены всех клиентов: зависшая позиция
   * одного обмена нетилась встречной ногой другого, и «сколько нам не
   * поставили» не было величиной вовсе. Здесь две конверсии одного клиента:
   * первая зависла, вторая закрыта, — и открытая позиция ровно одна.
   */
  it('ages the exchange, not the last movement inside it', () => {
    // Момент 2 сначала гасит ногу исходной валюты и лишь потом открывает ногу
    // встречной. Если считать плоскость по проводке, позиция на миг
    // обнуляется, и возраст обмена начинал бы отсчёт заново с каждой записи —
    // то есть зависший обмен никогда бы не состарился.
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, usd),
      sendForConversion(at('c1', 5), owner, exchange),
      executeConversion(at('c2', 40), owner, exchange),
    ]);
    expect(openFxPositions(journal).map((position) => [position.openedAt, position.lastMovedAt])).toEqual(
      [['2026-09-03T10:05:00Z', '2026-09-03T10:40:00Z']],
    );
  });

  it('counts positions per exchange, so one stuck conversion is not netted by another', () => {
    const second = fxExecution('x2', convert(money('USD', 1_000_000n), rates, asOf, 'trunc'));
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, money('USD', 9_000_000n)),
      sendForConversion(at('c1', 5), owner, exchange),
      executeConversion(at('c2', 10), owner, exchange),
      sendForConversion(at('d1', 20), owner, second),
      executeConversion(at('d2', 25), owner, second),
      receiveConversion(at('d3', 30), owner, second, platformSpread(second.converted, 'trunc')),
    ]);

    expect(
      openFxPositions(journal).map((position) => [
        position.conversionId,
        position.balances.map((item) => [item.currency, item.amount.minor]),
      ]),
    ).toEqual([['x1', [['GEL', 21_349_500n]]]]);
  });
});
