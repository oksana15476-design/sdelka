import { fxRate, rational, rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  PROVISIONAL_MARKUP_CAP_BP,
  PricingError,
  PricingErrorCode,
  PRICING_REFUSAL_KEYS,
  clientRateFrom,
  fxMarkup,
  fxMarkupSchedule,
  fxMarkupScheduleFromStore,
  markupFor,
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

const REFERENCE = fxRate('USD', 'GEL', rationalFromDecimalString('2.7000'));

describe('спред отвергается на входе, а не при расчёте', () => {
  it('принимает наценку внутри диапазона', () => {
    expect(fxMarkup('USD', 'GEL', 70).markupBp).toBe(70);
    expect(fxMarkup('USD', 'GEL', 0).markupBp).toBe(0);
    expect(fxMarkup('USD', 'GEL', PROVISIONAL_MARKUP_CAP_BP).markupBp).toBe(
      PROVISIONAL_MARKUP_CAP_BP,
    );
  });

  it('отвергает отрицательную наценку: клиентский курс лучше эталонного', () => {
    expectCode(() => fxMarkup('USD', 'GEL', -1), PricingErrorCode.markupOutOfRange);
  });

  it('отвергает наценку выше потолка — опечатка в разряде не проходит', () => {
    // 0,7 % и 7 % отличаются одним нажатием.
    expectCode(() => fxMarkup('USD', 'GEL', 700), PricingErrorCode.markupOutOfRange);
    expect(fxMarkup('USD', 'GEL', 700, 1_000).markupBp).toBe(700);
  });

  it('отвергает наценку в сто процентов и больше независимо от потолка', () => {
    expectCode(
      () => fxMarkup('USD', 'GEL', 10_000, 10_000),
      PricingErrorCode.markupOutOfRange,
    );
  });

  it('отвергает дробную наценку', () => {
    expectCode(() => fxMarkup('USD', 'GEL', 70.5), PricingErrorCode.markupNotInteger);
  });

  it('отвергает негодный потолок: границы самой границы', () => {
    expectCode(() => fxMarkup('USD', 'GEL', 70, -1), PricingErrorCode.markupCapOutOfRange);
    expectCode(() => fxMarkup('USD', 'GEL', 70, 10_001), PricingErrorCode.markupCapOutOfRange);
    expectCode(() => fxMarkup('USD', 'GEL', 70, 50.5), PricingErrorCode.markupCapOutOfRange);
  });

  it('отвергает пару из одной валюты', () => {
    expectCode(() => fxMarkup('GEL', 'GEL', 70), PricingErrorCode.markupPairInvalid);
  });
});

describe('расписание наценок по парам', () => {
  it('одна пара объявляется один раз', () => {
    expectCode(
      () => fxMarkupSchedule([fxMarkup('USD', 'GEL', 70), fxMarkup('USD', 'GEL', 90)]),
      PricingErrorCode.markupPairDuplicated,
    );
  });

  it('пара, которой расписание не знает, — отказ, а не нулевая наценка', () => {
    const schedule = fxMarkupSchedule([fxMarkup('USD', 'GEL', 70)]);
    const found = markupFor(schedule, 'EUR', 'GEL');
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.error).toBe(PRICING_REFUSAL_KEYS.markupPairNotDeclared);
  });

  it('расписание из хранилища проходит те же границы', () => {
    expectCode(
      () => fxMarkupScheduleFromStore([{ base: 'USD', quote: 'GEL', markupBp: 700 }]),
      PricingErrorCode.markupOutOfRange,
    );
    const schedule = fxMarkupScheduleFromStore([{ base: 'USD', quote: 'GEL', markupBp: 70 }]);
    expect(schedule.entries).toHaveLength(1);
  });
});

describe('клиентский курс выводится из эталонного целочисленно', () => {
  it('client = reference · (10000 − markupBp) / 10000', () => {
    const client = clientRateFrom(REFERENCE, fxMarkup('USD', 'GEL', 70));
    // 2,7 · 9930 / 10000 = 2,68110 — точной дробью, без единой операции с
    // плавающей точкой.
    expect(client.value).toEqual(rational(268_110n, 100_000n));
    expect(client.base).toBe('USD');
    expect(client.quote).toBe('GEL');
  });

  it('нулевая наценка оставляет эталонный курс как есть', () => {
    expect(clientRateFrom(REFERENCE, fxMarkup('USD', 'GEL', 0)).value).toEqual(REFERENCE.value);
  });

  it('клиентский курс никогда не лучше эталонного — по построению', () => {
    for (const bp of [0, 1, 70, 250, PROVISIONAL_MARKUP_CAP_BP]) {
      const client = clientRateFrom(REFERENCE, fxMarkup('USD', 'GEL', bp));
      expect(client.value.numerator * REFERENCE.value.denominator).toBeLessThanOrEqual(
        REFERENCE.value.numerator * client.value.denominator,
      );
    }
  });

  it('наценка не применяется к чужой паре даже из хранилища', () => {
    const foreign = { base: 'EUR', quote: 'GEL', markupBp: 70 } as unknown as ReturnType<
      typeof fxMarkup<'USD', 'GEL'>
    >;
    expectCode(() => clientRateFrom(REFERENCE, foreign), PricingErrorCode.markupPairMismatch);
  });
});
