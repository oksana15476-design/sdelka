import type { Result } from '@sdelka/domain';
import {
  type Journal,
  accountBalance,
  accrueFee,
  appendEntries,
  balanceByCurrency,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  clientTopUp,
  emptyJournal,
  feeReceivable,
  lockForTranche,
  receiveFee,
  settleTrancheToClientAccount,
  transitFee,
  trancheSettlement,
} from '@sdelka/ledger';
import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type FeeBearing,
  type TariffQuotation,
  bornByPayer,
  bornByRecipient,
  bornBySplit,
  quoteTrancheTariff,
  tariffPlan,
  tariffSeriesFromStore,
  tariffVersionRef,
} from '../src/index';
import { at, version } from './support/fixtures';
import { attestDealParties } from './support/ledger';

const BUYER = clientKey('c-buyer');
const SELLER = clientKey('c-seller');
const DEAL = { dealId: 'D1', trancheId: 't1' };
const PRINCIPAL = money('GEL', 21_349_500n);

function meta(id: string, minute: number): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-04T12:${String(minute).padStart(2, '0')}:00Z` };
}

function quoteFor(bearing: FeeBearing): TariffQuotation<'GEL'> {
  const series = tariffSeriesFromStore([
    version({
      id: 'tariff/2026-09-04.1',
      value: tariffPlan({ rateBp: 50, currency: 'GEL', bearing }),
      recordedAt: at(0),
      effectiveFrom: at(0),
      supersedes: null,
    }),
  ]);
  if (!series.ok) throw new Error(series.error);
  return unwrap(quoteTrancheTariff(series.value, at(1), PRINCIPAL));
}

function unwrap<T>(result: Result<T, string>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/**
 * Полный путь денег по одной тарифицированной сделке: покупатель пополнил счёт
 * ровно на брутто, деньги заперты под транш, комиссия начислена по названной
 * версии тарифа и удержана в расчёте.
 *
 * Сети здесь нет и быть не может: ни одного мока платёжного провайдера — это
 * прямое требование `CLAUDE.md` к денежному домену.
 */
function journalFor(quotation: TariffQuotation<'GEL'>): Journal {
  const settlement = trancheSettlement(
    DEAL,
    BUYER,
    SELLER,
    attestDealParties(DEAL, BUYER, SELLER),
    quotation.plan.ceiling,
  );
  const accrual = accrueFee(meta('e3', 3), DEAL, quotation.fee, tariffVersionRef(quotation));
  return appendEntries(emptyJournal, [
    clientTopUp(meta('e1', 1), BUYER, quotation.required),
    lockForTranche(meta('e2', 2), BUYER, DEAL, quotation.required),
    accrual,
    settleTrancheToClientAccount(
      meta('e4', 4),
      settlement,
      quotation.required,
      accrual.accrues === null ? null : accrual,
    ),
  ]);
}

describe('смена плательщика двигает суммы проводок, но не форму записи', () => {
  const cases: readonly (readonly [string, FeeBearing, bigint, bigint])[] = [
    ['несёт получатель', bornByRecipient(), 21_349_500n, 21_242_753n],
    ['несёт покупатель', bornByPayer(), 21_456_247n, 21_349_500n],
    ['сплит пополам', bornBySplit(5_000, 5_000), 21_402_874n, 21_296_127n],
  ];

  for (const [name, bearing, expectedGross, expectedNet] of cases) {
    it(`${name}: брутто и нетто меняются, комиссия — нет`, () => {
      const quotation = quoteFor(bearing);
      const journal = journalFor(quotation);

      expect(quotation.required.minor).toBe(expectedGross);
      expect(quotation.net.minor).toBe(expectedNet);
      expect(quotation.fee.minor).toBe(106_747n);

      // Запертая часть плательщика ушла в ноль, получатель получил нетто.
      expect(accountBalance(journal, clientLockedAccount(BUYER, 'D1', 't1'), 'GEL').minor).toBe(0n);
      expect(accountBalance(journal, clientFreeAccount(SELLER), 'GEL').minor).toBe(expectedNet);
    });
  }

  it('сумма журнала остаётся нулевой при любом плательщике', () => {
    for (const [, bearing] of cases) {
      const journal = journalFor(quoteFor(bearing));
      // Инвариант «сумма проводок равна нулю» — по каждой записи и по журналу
      // целиком, повалютно.
      const total = new Map<string, bigint>();
      for (const entry of journal.entries) {
        for (const [currency, amount] of balanceByCurrency(entry.postings)) {
          expect(amount).toBe(0n);
          total.set(currency, (total.get(currency) ?? 0n) + amount);
        }
      }
      expect([...total.values()].every((amount) => amount === 0n)).toBe(true);
      expect(checkLedgerInvariants(journal)).toEqual([]);
    }
  });

  it('проводки действительно различаются: это не один и тот же журнал под тремя именами', () => {
    const amounts = cases.map(([, bearing]) =>
      journalFor(quoteFor(bearing))
        .entries.flatMap((entry) => entry.postings.map((posting) => posting.amount.minor))
        .join(','),
    );
    expect(new Set(amounts).size).toBe(3);
  });
});

describe('красная линия №2: комиссия не задерживается на номинальном счёте', () => {
  it('при любом плательщике номинальный счёт после расчёта держит ровно обязательство перед получателем', () => {
    for (const [, bearing, , expectedNet] of [
      ['', bornByRecipient(), 0n, 21_242_753n],
      ['', bornByPayer(), 0n, 21_349_500n],
      ['', bornBySplit(5_000, 5_000), 0n, 21_296_127n],
    ] as const) {
      const quotation = quoteFor(bearing);
      const journal = journalFor(quotation);

      // На номинальном счёте осталось нетто получателя — и ни одной тетри
      // комиссии: она ушла в транзит в той же записи расчёта.
      expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(expectedNet);
      expect(accountBalance(journal, transitFee, 'GEL').minor).toBe(quotation.fee.minor);
      expect(accountBalance(journal, feeReceivable, 'GEL').minor).toBe(0n);
    }
  });

  it('комиссия доходит до операционного счёта третьей записью, а не оседает в транзите', () => {
    const quotation = quoteFor(bornByPayer());
    const withReceipt = appendEntries(journalFor(quotation), [
      receiveFee(meta('e5', 5), DEAL, quotation.fee),
    ]);
    expect(accountBalance(withReceipt, transitFee, 'GEL').minor).toBe(0n);
    expect(accountBalance(withReceipt, bankOperating('GEL'), 'GEL').minor).toBe(
      quotation.fee.minor,
    );
    expect(accountBalance(withReceipt, bankNominal('GEL'), 'GEL').minor).toBe(
      quotation.net.minor,
    );
    expect(checkLedgerInvariants(withReceipt)).toEqual([]);
  });
});

describe('ссылка на версию тарифа: не метка рядом с суммой, а часть одного значения', () => {
  it('запись начисления называет ту версию, по которой посчитана комиссия', () => {
    const quotation = quoteFor(bornByRecipient());
    const journal = journalFor(quotation);
    const accrual = journal.entries.find((entry) => entry.accrues !== null);
    expect(accrual?.accrues?.tariffVersionId).toBe('tariff/2026-09-04.1');
    expect(accrual?.accrues?.fee.minor).toBe(quotation.fee.minor);
    expect(quotation.versionId).toBe(accrual?.accrues?.tariffVersionId);
  });

  it('идентификатор версии настройки проходит в журнал учёта без преобразования', () => {
    // `<домен>/<ГГГГ-ММ-ДД>.<n>`: ни `:`, ни `|` в нём невыразимы, поэтому
    // `assertAccountIdentifier` учёта его принимает как есть.
    const quotation = quoteFor(bornByRecipient());
    expect(() => accrueFee(meta('x1', 9), DEAL, quotation.fee, tariffVersionRef(quotation)))
      .not.toThrow();
  });
});
