import {
  type Journal,
  accountBalance,
  appendEntries,
  checkLedgerInvariants,
  clientFreeAccount,
  clientKey,
  clientTopUp,
  coverage,
  emptyJournal,
} from '@sdelka/ledger';
import { type CurrencyCode, money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  LIMITS_REFUSAL_KEYS,
  admitDealCurrency,
  dealCurrenciesSeriesFromStore,
  dealCurrencyAdmittedAt,
  dealCurrencyList,
  withdrawDealCurrency,
} from '../src/index';
import { at, version } from './support/fixtures';

/**
 * Настройка валют против уже существующих счетов.
 *
 * Проба, ради которой этот файл существует: **включение и выключение валюты не
 * трогает ни одного счёта и ни одной проводки**. Счёт учёта несёт свою валюту
 * сам, покрытие считается по каждой валюте отдельно, и ни один из этих
 * механизмов не спрашивает у настройки, включена ли валюта. Проверяется на
 * журнале, а не рассуждением: журнал строится словарём `@sdelka/ledger`, сети
 * здесь нет и мока платёжного провайдера нет ни одного.
 */

const BUYER = clientKey('c-buyer');
const SELLER = clientKey('c-seller');

function meta(id: string, minute: number): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-04T12:${String(minute).padStart(2, '0')}:00Z` };
}

/** Журнал в двух валютах: лари у покупателя, доллары у продавца. */
function twoCurrencyJournal(): Journal {
  return appendEntries(emptyJournal, [
    clientTopUp(meta('e1', 1), BUYER, money('GEL', 21_349_500n)),
    clientTopUp(meta('e2', 2), SELLER, money('USD', 8_084_560n)),
  ]);
}

/**
 * Открытые позиции по валюте — **по журналу**, а не по списку сделок.
 * Считает вызывающий: журнал этому пакету не принадлежит, и знать о нём он не
 * должен (`SETTINGS.md` §В3 п.6).
 */
function openPositions(journal: Journal, currency: CurrencyCode): number {
  const row = coverage(journal).find((item) => item.currency === currency);
  return row === undefined || row.obligations.minor === 0n ? 0 : 1;
}

describe('покрытие считается по каждой валюте отдельно', () => {
  it('две валюты — две строки покрытия, и каждая сходится со своей', () => {
    const rows = coverage(twoCurrencyJournal());
    expect(rows.map((row) => row.currency)).toEqual(['GEL', 'USD']);
    for (const row of rows) {
      expect(row.custody.currency).toBe(row.currency);
      expect(row.obligations.currency).toBe(row.currency);
      expect(row.custody.minor).toBe(row.obligations.minor);
      expect(row.covered).toBe(true);
    }
    expect(checkLedgerInvariants(twoCurrencyJournal())).toEqual([]);
  });

  it('суммы разных валют не складываются: строка лари не знает о долларах', () => {
    const rows = coverage(twoCurrencyJournal());
    const gel = rows.find((row) => row.currency === 'GEL');
    const usd = rows.find((row) => row.currency === 'USD');
    expect(gel?.custody.minor).toBe(21_349_500n);
    expect(usd?.custody.minor).toBe(8_084_560n);
  });
});

describe('изменение перечня валют не трогает существующие счета', () => {
  it('включение валюты не двигает ни одной проводки и не заводит строки покрытия', () => {
    const journal = twoCurrencyJournal();
    const before = coverage(journal);

    const admitted = admitDealCurrency(dealCurrencyList(['GEL', 'USD']), {
      currency: 'EUR',
      nominalAccountOpened: true,
      statementReconciliationRunning: true,
      officialRateObserved: true,
      toleranceDeclared: true,
      markupDeclared: true,
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value.codes).toEqual(['EUR', 'GEL', 'USD']);

    // Строки покрытия те же, что были: покрытие выводится из журнала, а не из
    // перечня. Валюта без единой проводки строкой не становится — иначе
    // включение валюты само по себе давало бы покрытие ниже единицы.
    expect(coverage(journal)).toEqual(before);
    expect(coverage(journal).map((row) => row.currency)).not.toContain('EUR');
  });

  it('каждый счёт остаётся в своей валюте: остаток спрашивается валютой', () => {
    const journal = twoCurrencyJournal();
    expect(accountBalance(journal, clientFreeAccount(BUYER), 'GEL').minor).toBe(21_349_500n);
    // Тот же счёт в чужой валюте — ноль, а не пересчёт по курсу.
    expect(accountBalance(journal, clientFreeAccount(BUYER), 'USD').minor).toBe(0n);
    expect(accountBalance(journal, clientFreeAccount(SELLER), 'USD').minor).toBe(8_084_560n);
  });

  it('выключение валюты, по которой лежат деньги, отвергается', () => {
    const journal = twoCurrencyJournal();
    const result = withdrawDealCurrency(
      dealCurrencyList(['GEL', 'USD']),
      'USD',
      openPositions(journal, 'USD'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(LIMITS_REFUSAL_KEYS.currencyHasOpenPositions);
  });

  it('выключение валюты не обнуляет остатка и не меняет покрытия по ней', () => {
    // Позиции закрыты снаружи — журнал остаётся тем же самым, и это главное:
    // настройка меняет то, что будет заведено дальше, и ничего из заведённого.
    const journal = twoCurrencyJournal();
    const before = coverage(journal);
    const withdrawn = withdrawDealCurrency(dealCurrencyList(['GEL', 'USD']), 'USD', 0);
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;
    expect(withdrawn.value.codes).toEqual(['GEL']);
    expect(coverage(journal)).toEqual(before);
    expect(accountBalance(journal, clientFreeAccount(SELLER), 'USD').minor).toBe(8_084_560n);
  });

  it('сделка, заведённая до выключения, деньгами обеспечена и после него', () => {
    const built = dealCurrenciesSeriesFromStore([
      version({
        id: 'deal_currencies/2026-09-04.1',
        value: dealCurrencyList(['GEL', 'USD']),
        recordedAt: at(0),
        effectiveFrom: at(0),
        supersedes: null,
      }),
      version({
        id: 'deal_currencies/2026-09-04.2',
        value: dealCurrencyList(['GEL']),
        recordedAt: at(10),
        effectiveFrom: at(10),
        supersedes: 'deal_currencies/2026-09-04.1',
      }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const journal = twoCurrencyJournal();
    expect(dealCurrencyAdmittedAt(built.value, at(1), 'USD').ok).toBe(true);
    const usd = coverage(journal).find((row) => row.currency === 'USD');
    expect(usd?.covered).toBe(true);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });
});
