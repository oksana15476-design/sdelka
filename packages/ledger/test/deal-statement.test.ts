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
  accrueFee,
  appendEntries,
  clientKey,
  clientTopUp,
  dealStatement,
  emptyJournal,
  executeConversion,
  fxExecution,
  lockForTranche,
  receiveConversion,
  receiveFee,
  sendForConversion,
  settleTrancheToClientAccount,
  trancheSettlement,
  unlockToClientAccount,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';

const buyer = clientKey('c1');
const seller = clientKey('c2');
const other = clientKey('c9');
const dealA = { dealId: 'A', trancheId: 't1' };
const dealB = { dealId: 'B', trancheId: 't1' };
const asOf = isoDate('2026-09-03');

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-03T10:${String(minute).padStart(2, '0')}:00Z` };
}

const rates = fxRates('USD', 'GEL', {
  client: rationalFromDecimalString('2.6686875'),
  reference: rationalFromDecimalString('2.6875'),
  official: rationalFromDecimalString('2.7000'),
});
const exchange = fxExecution('x1', convert(money('USD', 8_000_000n), rates, asOf, 'trunc'));

/**
 * Выписка по сделке — история И14.2, «базовый артефакт доверия» (CORE.md §3).
 */
describe('выписка по сделке для обеих сторон', () => {
  const accrual = accrueFee(at('e4', 15), dealA, money('GEL', 500n), 'plan-2026-01');
  const journal = appendEntries(emptyJournal, [
    // Посторонняя сделка того же клиента: в выписку по A она попасть не должна.
    clientTopUp(at('e0'), other, money('GEL', 50_000n)),
    lockForTranche(at('e0b', 1), other, dealB, money('GEL', 50_000n)),
    clientTopUp(at('e1', 2), buyer, money('USD', 8_000_000n)),
    sendForConversion(at('e2a', 3), buyer, exchange),
    executeConversion(at('e2b', 4), buyer, exchange),
    receiveConversion(at('e2c', 5), buyer, exchange, platformSpread(exchange.converted, 'trunc')),
    lockForTranche(at('e3', 10), buyer, dealA, money('GEL', 100_000n)),
    accrual,
    settleTrancheToClientAccount(
      at('e5', 20),
      trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
      money('GEL', 100_000n),
      accrual,
    ),
    receiveFee(at('e6', 25), dealA, money('GEL', 500n)),
  ]);

  it('collects every journal event that touched the tranche, and nothing else', () => {
    const statement = dealStatement(journal, dealA);
    expect(statement.events.map((event) => event.entryId)).toEqual(['e3', 'e4', 'e5', 'e6']);
    // Ни зачисление постороннего клиента, ни его сделка, ни моменты обмена
    // (они относятся к файлу клиента, а не транша) в выписку по A не попали.
    expect(statement.events.some((event) => event.entryId === 'e0b')).toBe(false);
  });

  /**
   * В выписку попадают записи **целиком**. Иначе главная строка для получателя
   * — зачисление нетто на его свободную часть — выпала бы: она отнесена к файлу
   * получателя, а не к файлу транша.
   */
  it('shows both legs of the settlement, so the recipient sees what they received', () => {
    const settlement = dealStatement(journal, dealA).events.find(
      (event) => event.entryId === 'e5',
    );
    expect(
      settlement?.postings.map((posting) => [
        posting.accountCode,
        posting.direction,
        posting.amount.minor,
      ]),
    ).toEqual([
      ['client:c1:tranche:A:t1', 'debit', 100_000n],
      ['client:c2:free', 'credit', 99_500n],
      ['fee:receivable', 'credit', 500n],
      ['bank:nominal:gel', 'credit', 100_000n],
      ['bank:nominal:gel', 'debit', 99_500n],
      ['transit:fee', 'debit', 500n],
    ]);
  });

  it('carries the three fee amounts of the deal, separately', () => {
    const statement = dealStatement(journal, dealA);
    expect(
      statement.fee.map((item) => [
        item.currency,
        item.accrued.minor,
        item.notWithheld.minor,
        item.withheld.minor,
        item.received.minor,
      ]),
    ).toEqual([['GEL', 500n, 0n, 500n, 500n]]);
  });

  it('carries the exchange rate as a fact of the entry, not a recomputation', () => {
    // И14.2 требует показать курсы. Восстановить курс из двух сумм задним
    // числом нельзя — усечение необратимо, — поэтому он приезжает объявлением.
    const statement = dealStatement(journal, { dealId: 'A', trancheId: 't1' });
    expect(statement.events.every((event) => event.converts === null)).toBe(true);

    // По файлу клиента курс виден там, где обмен и происходил.
    const conversion = journal.entries.find((entry) => entry.id === 'e2c');
    expect(conversion?.converts?.converted.rates.official.value).toEqual(
      rationalFromDecimalString('2.7000'),
    );
  });

  it('forms the statement for a rolled-back deal the same way', () => {
    // Крайний случай И14.2: «сделка откачена — выписка формируется так же и
    // показывает, почему». Учёт отдаёт факт отвязки; «почему» — ключ
    // локализации записи, а не текст.
    const rolledBack = appendEntries(emptyJournal, [
      clientTopUp(at('r1'), buyer, money('GEL', 100_000n)),
      lockForTranche(at('r2', 5), buyer, dealA, money('GEL', 100_000n)),
      unlockToClientAccount(at('r3', 10), buyer, dealA, money('GEL', 100_000n)),
    ]);
    const statement = dealStatement(rolledBack, dealA);
    expect(statement.events.map((event) => [event.entryId, event.memoKey])).toEqual([
      ['r2', 'ledger.entry.locked_for_tranche'],
      ['r3', 'ledger.entry.unlocked_to_client'],
    ]);
    // Комиссии по откаченной сделке нет вовсе — §4.4, «отмена: не начислена».
    expect(statement.fee).toEqual([]);
  });
});
