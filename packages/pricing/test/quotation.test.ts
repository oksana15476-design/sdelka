import type { Result } from '@sdelka/domain';
import { type Money, money, split } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  PRICING_REFUSAL_KEYS,
  PricingError,
  PricingErrorCode,
  type TariffPlan,
  type TariffQuotation,
  bornByPayer,
  bornByRecipient,
  bornBySplit,
  quoteTrancheTariff,
  tariffPlan,
  tariffSeriesFromStore,
} from '../src/index';
import { at, version } from './support/fixtures';

/** Сумма из примера проводок `FUNCTIONAL.md` §3.3: 213 495,00 ₾. */
const PRINCIPAL = money('GEL', 21_349_500n);

function quoteWith(
  plan: TariffPlan,
  principal: Money<'GEL'> = PRINCIPAL,
): Result<TariffQuotation<'GEL'>, string> {
  const series = tariffSeriesFromStore([
    version({
      id: 'tariff/2026-09-04.1',
      value: plan,
      recordedAt: at(0),
      effectiveFrom: at(0),
      supersedes: null,
    }),
  ]);
  if (!series.ok) throw new Error(series.error);
  return quoteTrancheTariff(series.value, at(1), principal);
}

function unwrap<T>(result: Result<T, string>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe('база ставки — сумма сделки, поэтому комиссия не зависит от плательщика', () => {
  const plans = {
    recipient: tariffPlan({ rateBp: 50, currency: 'GEL', bearing: bornByRecipient() }),
    payer: tariffPlan({ rateBp: 50, currency: 'GEL', bearing: bornByPayer() }),
    split: tariffPlan({ rateBp: 50, currency: 'GEL', bearing: bornBySplit(5_000, 5_000) }),
  } as const;

  it('комиссия одна и та же при всех трёх плательщиках', () => {
    const fees = Object.values(plans).map((plan) => unwrap(quoteWith(plan)).fee.minor);
    // 21 349 500 · 50 / 10 000 = 106 747,5 → усечение в пользу клиента.
    expect(fees).toEqual([106_747n, 106_747n, 106_747n]);
  });

  it('несёт получатель: брутто равно сумме сделки, вычет из неё', () => {
    const quotation = unwrap(quoteWith(plans.recipient));
    expect(quotation.required.minor).toBe(21_349_500n);
    expect(quotation.net.minor).toBe(21_242_753n);
    expect(quotation.payerShare.minor).toBe(0n);
    expect(quotation.recipientShare.minor).toBe(106_747n);
  });

  it('несёт покупатель: брутто выросло на комиссию, продавец получает сумму сделки целиком', () => {
    const quotation = unwrap(quoteWith(plans.payer));
    expect(quotation.required.minor).toBe(21_456_247n);
    expect(quotation.net.minor).toBe(21_349_500n);
    expect(quotation.payerShare.minor).toBe(106_747n);
    expect(quotation.recipientShare.minor).toBe(0n);
  });

  it('сплит пополам: остаток от округления достаётся получателю, не нам и не покупателю дважды', () => {
    const quotation = unwrap(quoteWith(plans.split));
    // 106 747 / 2 = 53 373,5. Доля получателя усечена (53 373) — спорная
    // минорная единица осталась у той стороны, чьи деньги мы уменьшаем.
    expect(quotation.recipientShare.minor).toBe(53_373n);
    expect(quotation.payerShare.minor).toBe(53_374n);
    expect(quotation.required.minor).toBe(21_402_874n);
    expect(quotation.net.minor).toBe(21_296_127n);
  });

  it('тождество «брутто минус нетто равно комиссии» держится при любом плательщике', () => {
    for (const plan of Object.values(plans)) {
      const quotation = unwrap(quoteWith(plan));
      expect(quotation.required.minor - quotation.net.minor).toBe(quotation.fee.minor);
      expect(quotation.payerShare.minor + quotation.recipientShare.minor).toBe(
        quotation.fee.minor,
      );
    }
  });

  it('строка удержания расщепляет брутто ровно в нетто — одно вычисление комиссии, не два', () => {
    for (const plan of Object.values(plans)) {
      const quotation = unwrap(quoteWith(plan));
      const result = split(quotation.required, quotation.deductions);
      expect(result.recipient.minor).toBe(quotation.net.minor);
      expect(result.deductions[0]?.amount.minor).toBe(quotation.fee.minor);
    }
  });
});

describe('фикс, минимум и максимум', () => {
  it('фиксированная часть прибавляется к доле', () => {
    const plan = tariffPlan({ rateBp: 50, currency: 'GEL', fixed: 100n });
    expect(unwrap(quoteWith(plan)).fee.minor).toBe(106_847n);
  });

  it('минимум поднимает комиссию, максимум её срезает', () => {
    const withMinimum = tariffPlan({ rateBp: 0, currency: 'GEL', minimum: 500n });
    expect(unwrap(quoteWith(withMinimum)).fee.minor).toBe(500n);

    const withMaximum = tariffPlan({ rateBp: 50, currency: 'GEL', maximum: 1_000n });
    expect(unwrap(quoteWith(withMaximum)).fee.minor).toBe(1_000n);
  });

  it('нулевая сумма сделки тарифицируется нулём, а не отказом', () => {
    const plan = tariffPlan({ rateBp: 50, currency: 'GEL' });
    const quotation = unwrap(quoteWith(plan, money('GEL', 0n)));
    expect(quotation.fee.minor).toBe(0n);
    expect(quotation.required.minor).toBe(0n);
    expect(quotation.net.minor).toBe(0n);
  });
});

describe('отказы тарификации — значения, которые вызывающий обязан разобрать', () => {
  it('минимум больше сделки: отказ, а не съеденная сумма продавца', () => {
    const plan = tariffPlan({ rateBp: 0, currency: 'GEL', minimum: 500n });
    const quotation = quoteWith(plan, money('GEL', 100n));
    expect(quotation.ok).toBe(false);
    if (!quotation.ok) expect(quotation.error).toBe(PRICING_REFUSAL_KEYS.feeExceedsPrincipal);
  });

  it('удержание за потолком отказывает до сбора проводок', () => {
    // Комиссию несёт покупатель, поэтому суммы получателя она не съедает — и
    // тем не менее 500 из 600 брутто это 83 %, а потолок учёта два процента.
    const plan = tariffPlan({
      rateBp: 0,
      currency: 'GEL',
      minimum: 500n,
      bearing: bornByPayer(),
    });
    const quotation = quoteWith(plan, money('GEL', 100n));
    expect(quotation.ok).toBe(false);
    if (!quotation.ok) expect(quotation.error).toBe(PRICING_REFUSAL_KEYS.feeAboveCeiling);
  });

  it('ставка ровно в потолок проходит: граница включающая', () => {
    const plan = tariffPlan({ rateBp: 200, currency: 'GEL' });
    expect(unwrap(quoteWith(plan)).fee.minor).toBe(426_990n);
  });

  it('план в чужой валюте к сделке не применяется и по курсу не пересчитывается', () => {
    const plan = tariffPlan({ rateBp: 50, currency: 'USD', fixed: 100n });
    const series = tariffSeriesFromStore([
      version({
        id: 'tariff/2026-09-04.1',
        value: plan,
        recordedAt: at(0),
        effectiveFrom: at(0),
        supersedes: null,
      }),
    ]);
    if (!series.ok) throw new Error(series.error);
    const quotation = quoteTrancheTariff(series.value, at(1), PRINCIPAL);
    expect(quotation.ok).toBe(false);
    if (!quotation.ok) expect(quotation.error).toBe(PRICING_REFUSAL_KEYS.planCurrencyNotDeclared);
  });

  it('отрицательная сумма сделки — испорченный вызов, а не отказ', () => {
    const plan = tariffPlan({ rateBp: 50, currency: 'GEL' });
    try {
      quoteWith(plan, money('GEL', -1n));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PricingError);
      expect((error as PricingError).code).toBe(PricingErrorCode.principalNegative);
    }
  });
});
