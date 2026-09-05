import { DEFAULT_FEE_CEILING, feeCeiling } from '@sdelka/ledger';
import { rational } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  PROVISIONAL_TARIFF_PLAN,
  PricingError,
  PricingErrorCode,
  bornByPayer,
  bornBySplit,
  feeBearingFromStore,
  tariffPlan,
  tariffPlanFromStore,
} from '../src/index';

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(PricingError);
    expect((error as PricingError).code).toBe(code);
  }
}

describe('тарифный план как величина', () => {
  it('умолчания плательщика — сегодняшняя конструкция расчёта: несёт получатель', () => {
    expect(tariffPlan({ rateBp: 50, currency: 'GEL' }).bearing).toEqual({ payer: 'recipient' });
  });

  it('временное значение помечено временным и не выдаёт себя за норму', () => {
    // Значение существует, чтобы в тестах и в первой версии журнала было одно
    // названное число вместо трёх разных, разложенных по коду. Само число —
    // вопрос владельца (DECISIONS-REVIEW §J1).
    expect(PROVISIONAL_TARIFF_PLAN.rateBp).toBe(50);
    expect(PROVISIONAL_TARIFF_PLAN.fixed).toBe(0n);
    expect(PROVISIONAL_TARIFF_PLAN.bearing).toEqual({ payer: 'recipient' });
  });

  it('отвергает отрицательные фикс, минимум и максимум', () => {
    expectCode(
      () => tariffPlan({ rateBp: 50, currency: 'GEL', fixed: -1n }),
      PricingErrorCode.amountNegative,
    );
    expectCode(
      () => tariffPlan({ rateBp: 50, currency: 'GEL', minimum: -1n }),
      PricingErrorCode.amountNegative,
    );
    expectCode(
      () => tariffPlan({ rateBp: 50, currency: 'GEL', maximum: -1n }),
      PricingErrorCode.amountNegative,
    );
  });

  it('отвергает коридор, которого не существует: минимум выше максимума', () => {
    expectCode(
      () => tariffPlan({ rateBp: 50, currency: 'GEL', minimum: 500n, maximum: 100n }),
      PricingErrorCode.minimumAboveMaximum,
    );
  });

  it('отвергает ставку выше потолка удержания того же плана', () => {
    // 300 б.п. = 3 % против жёстких двух процентов учёта.
    expectCode(() => tariffPlan({ rateBp: 300, currency: 'GEL' }), PricingErrorCode.rateAboveCeiling);
  });

  it('потолок плана может предел учёта только сузить, но не расширить', () => {
    const wide = tariffPlan({
      rateBp: 50,
      currency: 'GEL',
      ceiling: feeCeiling(rational(1n, 1n)),
    });
    expect(wide.ceiling).toEqual(DEFAULT_FEE_CEILING);

    const narrow = tariffPlan({
      rateBp: 50,
      currency: 'GEL',
      ceiling: feeCeiling(rational(1n, 100n)),
    });
    expect(narrow.ceiling.maxShare).toEqual(rational(1n, 100n));
  });

  it('ставка выше суженного потолка того же плана отвергается', () => {
    expectCode(
      () => tariffPlan({ rateBp: 150, currency: 'GEL', ceiling: feeCeiling(rational(1n, 100n)) }),
      PricingErrorCode.rateAboveCeiling,
    );
  });
});

describe('плательщик комиссии', () => {
  it('доли сплита обязаны давать ровно сто процентов', () => {
    expect(bornBySplit(4_000, 6_000)).toEqual({
      payer: 'split',
      payerShareBp: 4_000,
      recipientShareBp: 6_000,
    });
    expectCode(() => bornBySplit(4_000, 5_000), PricingErrorCode.splitSharesNotWhole);
    expectCode(() => bornBySplit(5_000, 6_000), PricingErrorCode.splitSharesNotWhole);
  });

  it('перечень закрыт: значение из хранилища вне перечня — отказ, а не умолчание', () => {
    expect(feeBearingFromStore('payer')).toEqual(bornByPayer());
    expectCode(() => feeBearingFromStore('platform'), PricingErrorCode.feePayerUnknown);
  });

  it('сплит без долей не превращается в половину молча', () => {
    expectCode(() => feeBearingFromStore('split'), PricingErrorCode.splitSharesNotWhole);
    expectCode(
      () => feeBearingFromStore('split', { payerShareBp: 5_000 }),
      PricingErrorCode.splitSharesNotWhole,
    );
  });
});

describe('план из хранилища проходит те же границы', () => {
  it('собирается из строки таблицы', () => {
    const plan = tariffPlanFromStore({
      rateBp: 50,
      currency: 'GEL',
      fixed: 100n,
      minimum: null,
      maximum: null,
      payer: 'split',
      payerShareBp: 5_000,
      recipientShareBp: 5_000,
    });
    expect(plan.bearing).toEqual({ payer: 'split', payerShareBp: 5_000, recipientShareBp: 5_000 });
  });

  it('дробная ставка из базы не проходит: типы границу процесса не переживают', () => {
    expectCode(
      () =>
        tariffPlanFromStore({
          rateBp: 50.000000001,
          currency: 'GEL',
          fixed: 0n,
          minimum: null,
          maximum: null,
          payer: 'recipient',
        }),
      PricingErrorCode.rateNotInteger,
    );
  });
});
