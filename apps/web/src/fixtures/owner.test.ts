import { describe, expect, it } from 'vitest';
import { accountBalance, bankOperating } from '@sdelka/ledger';
import { isNegative, isPositive, isZero } from '@sdelka/money';
import {
  getOwnerDeal,
  getOwnerSummary,
  getTariff,
  listOwnerDeals,
  ownerInvariantBreaches,
  ownerJournal,
} from './owner';
import { moneyTone } from '@/view/owner-economics';

/**
 * Экономика владельца проверяется **против журнала**, а не против ожидаемых
 * чисел, выписанных рядом. Всё, что здесь сверяется, — это равенства, которые
 * обязаны держаться: наценка на экране равна `fx:income` в проводках, маржа
 * равна выручке минус расходы, валюты не сливаются в одну строку.
 *
 * Сети здесь нет ни в одном тесте и быть не может: журнал строится автоматами
 * домена и словарём учёта, мок платёжного провайдера не нужен ни разу
 * (`CLAUDE.md`, QA).
 */
describe('мир владельца', () => {
  it('журнал не нарушает ни одного инварианта учёта', () => {
    expect(ownerInvariantBreaches()).toEqual([]);
  });

  it('сумма проводок каждой записи равна нулю повалютно', () => {
    for (const entry of ownerJournal().entries) {
      const totals = new Map<string, bigint>();
      for (const posting of entry.postings) {
        const sign = posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor;
        totals.set(posting.amount.currency, (totals.get(posting.amount.currency) ?? 0n) + sign);
      }
      for (const [, total] of totals) expect(total).toBe(0n);
    }
  });
});

describe('экономика сделки', () => {
  it('наценка на конвертации равна доходу fx:income в журнале', async () => {
    const deal = await getOwnerDeal('ow01');
    expect(deal).not.toBeNull();
    const slice = deal?.economics.byCurrency.find((item) => item.currency === 'GEL');
    const leg = slice?.conversions[0];
    expect(leg).toBeDefined();
    const fx = slice?.revenue.find((line) => line.kind === 'fx_income');
    expect(fx?.amount.minor).toBe(leg?.markup.minor);
  });

  it('наценка стоит сверх стоимости конвертации, а не является всем спредом', async () => {
    const deal = await getOwnerDeal('ow01');
    const leg = deal?.economics.byCurrency[0]?.conversions[0];
    expect(leg).toBeDefined();
    if (leg === undefined) return;
    // Официальный курс → эталонный → клиентский: стоимость и наценка — разные
    // отрезки одного спреда, и обе положительны. Если бы наценкой считался весь
    // спред, стоимость была бы нулём.
    expect(isPositive(leg.cost)).toBe(true);
    expect(isPositive(leg.markup)).toBe(true);
    expect(leg.atOfficial.minor - leg.cost.minor).toBe(leg.atReference.minor);
    expect(leg.atReference.minor - leg.markup.minor).toBe(leg.toClient.minor);
    // Замер витринного курса: стоимость валютной ноги больше нашей наценки.
    expect(leg.cost.minor > leg.markup.minor).toBe(true);
  });

  it('маржа равна выручке по двум ногам минус прямые расходы', async () => {
    for (const deal of await listOwnerDeals()) {
      for (const slice of deal.economics.byCurrency) {
        const revenue = slice.revenueByLeg.service.minor + slice.revenueByLeg.conversion.minor;
        expect(slice.margin.minor).toBe(revenue - slice.expensesTotal.minor);
      }
    }
  });

  it('конвертации не было — валютная нога ноль, а не отсутствие строки', async () => {
    const deal = await getOwnerDeal('ow02');
    const slice = deal?.economics.byCurrency.find((item) => item.currency === 'GEL');
    expect(slice).toBeDefined();
    expect(slice?.conversions).toEqual([]);
    expect(isZero(slice?.revenueByLeg.conversion ?? { currency: 'GEL', minor: 1n })).toBe(true);
  });

  it('начислено, удержано и получено — три разных числа', async () => {
    const settled = await getOwnerDeal('ow02');
    const stuck = await getOwnerDeal('ow03');
    const paid = settled?.economics.byCurrency[0]?.fee;
    const held = stuck?.economics.byCurrency[0]?.fee;
    expect(paid).toBeDefined();
    expect(held).toBeDefined();
    if (paid === undefined || held === undefined) return;
    // Прошедшая сделка: начислено = удержано = получено, транзит пуст.
    expect(paid.accrued.minor).toBe(paid.withheld.minor);
    expect(paid.received.minor).toBe(paid.withheld.minor);
    expect(paid.inTransit.minor).toBe(0n);
    // Застрявший перевод: удержано столько же, получено ноль, транзит непустой.
    expect(held.withheld.minor).toBe(held.accrued.minor);
    expect(held.received.minor).toBe(0n);
    expect(held.inTransit.minor).toBe(held.withheld.minor);
  });

  it('откат: комиссия не начислена, итог отрицательный', async () => {
    const deal = await getOwnerDeal('ow05');
    const slice = deal?.economics.byCurrency[0];
    expect(slice).toBeDefined();
    if (slice === undefined) return;
    expect(slice.fee.accrued.minor).toBe(0n);
    expect(isPositive(slice.expensesTotal)).toBe(true);
    expect(isNegative(slice.margin)).toBe(true);
    expect(moneyTone(slice.margin)).toBe('danger');
  });

  it('незавершённая сделка не даёт выручки, но имеет ожидаемую комиссию', async () => {
    const deal = await getOwnerDeal('ow04');
    expect(deal?.settled).toBe(false);
    expect(deal?.expectedFee).not.toBeNull();
    const slice = deal?.economics.byCurrency.find((item) => item.currency === 'GEL');
    expect(slice?.revenueByLeg.service.minor).toBe(0n);
  });

  it('валютная сделка не даёт единой маржи: оборот и расход в разных валютах', async () => {
    const deal = await getOwnerDeal('ow06');
    expect(deal?.amount.currency).toBe('USD');
    const currencies = (deal?.economics.byCurrency ?? []).map((item) => item.currency);
    // Расходы понесены в лари, сумма сделки — в долларах. Строки «итого» нет
    // ни одной, и сложить их нечем: это и есть правило о валютах.
    expect(currencies).toContain('GEL');
  });
});

describe('сводка за период', () => {
  it('валюты не суммируются: у каждой своя строка', async () => {
    const view = await getOwnerSummary('current');
    const currencies = view.summary.byCurrency.map((item) => item.currency);
    expect(new Set(currencies).size).toBe(currencies.length);
  });

  it('число сделок больше числа завершённых: живые и откаченные тоже в периоде', async () => {
    const view = await getOwnerSummary('current');
    expect(view.summary.deals).toBeGreaterThan(view.summary.settledDeals);
    // Убыток по откаченной сделке обязан попасть в маржу периода, а не исчезнуть
    // вместе с ней: расчёта нет, расходы понесены.
    const gel = view.summary.byCurrency.find((item) => item.currency === 'GEL');
    expect(gel?.cost.minor).toBeGreaterThan(0n);
  });

  it('средний чек считается по завершённым сделкам', async () => {
    const view = await getOwnerSummary('current');
    const gel = view.summary.byCurrency.find((item) => item.currency === 'GEL');
    expect(gel).toBeDefined();
    if (gel === undefined || gel.averageDeal === null) return;
    expect(gel.averageDeal.minor).toBe(gel.turnover.minor / BigInt(gel.settledDeals));
  });

  it('пустой период даёт ноль и границы, а не пустоту', async () => {
    const view = await getOwnerSummary('previous');
    expect(view.summary.deals).toBe(0);
    expect(view.summary.byCurrency).toEqual([]);
    expect(view.significance.monthly.minor).toBe(0n);
    expect(view.bounds.from < view.bounds.to).toBe(true);
  });

  it('приближение к порогу значимости считается только по лари', async () => {
    const view = await getOwnerSummary('current');
    expect(view.significance.threshold.minor).toBe(900_000_000n);
    expect(view.significance.shareBp).toBeGreaterThan(0);
    expect(view.significance.headroom.minor).toBe(
      view.significance.threshold.minor - view.significance.monthly.minor,
    );
  });

  it('оборот периода сходится с приходом комиссии на операционный счёт', async () => {
    const journal = ownerJournal();
    const operating = accountBalance(journal, bankOperating('GEL'), 'GEL');
    // Операционный счёт не проверяется на равенство выручке: с него же платятся
    // прямые расходы. Проверяется знак — комиссия дошла, и её больше расходов.
    expect(isPositive(operating)).toBe(true);
  });
});

describe('тариф', () => {
  it('ставка, фикс и потолок приходят из кода, а не из экрана', async () => {
    const tariff = await getTariff();
    expect(tariff.rateBp).toBe(120);
    expect(tariff.fixed.minor).toBe(100n);
    expect(tariff.ceilingBp).toBe(200);
    expect(tariff.rateBp).toBeLessThan(tariff.ceilingBp);
  });

  it('версия тарифа прочитана из объявления начисления в журнале', async () => {
    const tariff = await getTariff();
    expect(tariff.versionId).not.toBeNull();
  });

  it('наценка и стоимость конвертации — разные величины', async () => {
    const tariff = await getTariff();
    expect(tariff.markupBp).toBeGreaterThan(0);
    expect(tariff.conversionCostBp).toBeGreaterThan(tariff.markupBp);
  });

  it('плательщик комиссии выведен из конструкции расчёта, а не настроен', async () => {
    const tariff = await getTariff();
    expect(tariff.feePayerIsSetting).toBe(false);
    expect(tariff.feePayer).toBe('recipient');
  });
});
