import {
  MoneyError,
  MoneyErrorCode,
  type PlatformSpread,
  convert,
  fxRates,
  isoDate,
  money,
  rationalFromDecimalString,
} from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  LedgerError,
  LedgerErrorCode,
  type Posting,
  accountCode,
  accrueFee,
  appendEntries,
  clientKey,
  clientTopUp,
  emptyJournal,
  feeAccrualFor,
  fxExecution,
  overpaymentToClientAccount,
  receiveConversion,
  refundToSourceAccount,
  writeOffTransitArrived,
} from '../src/index';

/**
 * Словарь записей: **форма проводок** и сверка валют на входе.
 *
 * Мутационный прогон показал две дыры. Первая: два конструктора — возврат на
 * счёт-источник и приход транзита списания — не звал ни один тест, и вид
 * записи у них можно было заменить с `settlement` на `correction`, не уронив
 * ничего. Вторая: сверка валют на входе. Там, где следом идёт `add` или
 * `subtract`, она дублируется библиотекой сумм и ошибка та же; но у переплаты
 * и у спреда следом ничего нет, и без сверки запись собиралась из двух разных
 * валют молча.
 */

const owner = clientKey('c1');
const deal = { dealId: 'd1', trancheId: 't1' };
const neighbour = { dealId: 'd1', trancheId: 't2' };

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-03T10:${String(minute).padStart(2, '0')}:00Z` };
}

function shape(postings: readonly Posting[]) {
  return postings.map((posting) => [
    accountCode(posting.account),
    posting.direction,
    posting.amount.currency,
    posting.amount.minor,
    posting.attribution,
  ]);
}

describe('возврат на счёт-источник', () => {
  /**
   * И12.2 и красная линия №9: деньги уходят с номинального счёта на счёт, с
   * которого пришли. Обе проводки — в файле клиента: транша у этих денег больше
   * нет, его закрыл момент 1 (`unlockToClientAccount`).
   */
  it('debits the free part of the client and credits the nominal account, in the client file', () => {
    const entry = refundToSourceAccount(at('r1'), owner, money('GEL', 100_000n));
    expect(entry.kind).toBe('settlement');
    expect(entry.memoKey).toBe('ledger.entry.refund_to_source');
    expect(entry.correctsEntryId).toBeNull();
    expect(shape(entry.postings)).toEqual([
      ['client:c1:free', 'debit', 'GEL', 100_000n, { clientKey: owner }],
      ['bank:nominal:gel', 'credit', 'GEL', 100_000n, { clientKey: owner }],
    ]);
  });
});

describe('приход транзита списания', () => {
  /**
   * Момент 2 списания невостребованных: межбанковский перевод дошёл. Это факт
   * банковской выписки, а не переход транша, — и запись у него обычная, не
   * исправление.
   */
  it('moves the money from transit to the operating account', () => {
    const entry = writeOffTransitArrived(at('a1'), money('GEL', 100_000n));
    expect(entry.kind).toBe('settlement');
    expect(entry.memoKey).toBe('ledger.entry.write_off_transit_arrived');
    expect(shape(entry.postings)).toEqual([
      ['bank:operating:gel', 'debit', 'GEL', 100_000n, null],
      ['transit:writeoff', 'credit', 'GEL', 100_000n, null],
    ]);
  });
});

describe('переплата — свойство одного платежа', () => {
  /**
   * Требуемое и излишек приходят одним платежом, поэтому валюта у них одна.
   * Платёж в другой валюте — это другое поступление, а не излишек по этому, и
   * собрать из них одну запись нельзя: она сошлась бы повалютно и выглядела бы
   * законной.
   */
  it('refuses a required amount and an excess in two different currencies', () => {
    try {
      overpaymentToClientAccount(at('o1'), owner, deal, money('GEL', 100_000n), money('USD', 10n));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MoneyError);
      expect((error as MoneyError).code).toBe(MoneyErrorCode.currencyMismatch);
    }
  });

  it('refuses an overpayment without an excess by its own code', () => {
    try {
      overpaymentToClientAccount(at('o2'), owner, deal, money('GEL', 100_000n), money('GEL', 0n));
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.entryNonPositiveExcess);
    }
  });

  it('splits one payment into the tranche and the free part', () => {
    const entry = overpaymentToClientAccount(
      at('o3'),
      owner,
      deal,
      money('GEL', 100_000n),
      money('GEL', 500n),
    );
    expect(shape(entry.postings)).toEqual([
      ['bank:nominal:gel', 'debit', 'GEL', 100_000n, deal],
      ['client:c1:tranche:d1:t1', 'credit', 'GEL', 100_000n, deal],
      ['bank:nominal:gel', 'debit', 'GEL', 500n, { clientKey: owner }],
      ['client:c1:free', 'credit', 'GEL', 500n, { clientKey: owner }],
    ]);
  });
});

describe('спред на конвертации — та же валюта, что и встречная нога', () => {
  const rates = fxRates('USD', 'GEL', {
    client: rationalFromDecimalString('2.6686875'),
    reference: rationalFromDecimalString('2.6875'),
    official: rationalFromDecimalString('2.7000'),
  });
  const converted = convert(money('USD', 8_000_000n), rates, isoDate('2026-09-03'), 'trunc');
  const exchange = fxExecution('x1', converted);

  it('refuses a spread in another currency', () => {
    const foreign: PlatformSpread<'USD'> = {
      kind: 'platform_spread',
      amount: money('USD', 1_505n),
    };
    try {
      receiveConversion(at('c3'), owner, exchange, foreign);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MoneyError);
      expect((error as MoneyError).code).toBe(MoneyErrorCode.currencyMismatch);
    }
  });

  it('refuses a negative spread instead of turning a loss into income', () => {
    const negative: PlatformSpread<'GEL'> = {
      kind: 'platform_spread',
      amount: money('GEL', -1n),
    };
    try {
      receiveConversion(at('c4'), owner, exchange, negative);
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.entryNegativeSpread);
    }
  });
});

describe('начисление комиссии', () => {
  /**
   * §4.2: на сделке хранится идентификатор версии плана, применённой в момент
   * создания. Он входит в объявление записи, поэтому обязан быть годным
   * идентификатором — иначе версию плана нельзя отличить от другой в сверке.
   */
  it('refuses a tariff version identifier that could not be part of a code', () => {
    try {
      accrueFee(at('f1'), deal, money('GEL', 2_000n), 'v:1');
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.accountInvalidIdentifier);
      expect((error as LedgerError).details.field).toBe('tariffVersionId');
    }
  });

  it('refuses a fee of nothing', () => {
    try {
      accrueFee(at('f2'), deal, money('GEL', 0n), 'tariff-1');
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.entryNonPositiveFee);
    }
  });

  /**
   * Начисление ищется по **паре** «сделка, транш». Соседний транш той же
   * сделки — другой транш: удержать по нему комиссию, начисленную по первому,
   * значит увести требование в минус.
   */
  it('is found by the whole tranche reference, not by the deal alone', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, money('GEL', 100_000n)),
      accrueFee(at('f3', 1), deal, money('GEL', 2_000n), 'tariff-1'),
    ]);
    expect(feeAccrualFor(journal, deal)?.accruedFee.minor).toBe(2_000n);
    expect(feeAccrualFor(journal, neighbour)).toBeNull();
  });

  /**
   * Токен начисления нужен типам, а не журналу: запись, попавшая в журнал,
   * обязана остаться ровно `JournalEntry` — с той же формой при сериализации,
   * при сравнении в тестах и в выгрузке для бухгалтерии.
   */
  it('carries its token in fields that are not part of the entry', () => {
    const accrual = accrueFee(at('f4'), deal, money('GEL', 2_000n), 'tariff-1');
    expect(Object.keys(accrual).sort()).toEqual([
      'accrues',
      'converts',
      'correctsEntryId',
      'funds',
      'id',
      'kind',
      'memoKey',
      'occurredAt',
      'postings',
      'settles',
    ]);
    expect(accrual.accruedFee.minor).toBe(2_000n);
    expect(accrual.tariffVersionId).toBe('tariff-1');
  });
});
