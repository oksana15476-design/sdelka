import { rational } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  PricingError,
  PricingErrorCode,
  RATE_SCALE_BP,
  assertBasisPoints,
  basisPointsForDisplay,
  shareOf,
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

describe('доля хранится целым: красная линия №4', () => {
  it('переводит базисные пункты в точную дробь без плавающей точки', () => {
    expect(shareOf(50)).toEqual(rational(50n, RATE_SCALE_BP));
    expect(shareOf(0)).toEqual(rational(0n, 1n));
    expect(shareOf(10_000)).toEqual(rational(1n, 1n));
  });

  it('отвергает дробное значение — плавающую точку, зашедшую через форму', () => {
    expectCode(() => assertBasisPoints(50.5, 'rateBp'), PricingErrorCode.rateNotInteger);
    expectCode(() => assertBasisPoints(0.1 + 0.2, 'rateBp'), PricingErrorCode.rateNotInteger);
    expectCode(() => assertBasisPoints(Number.NaN, 'rateBp'), PricingErrorCode.rateNotInteger);
    expectCode(
      () => assertBasisPoints(Number.POSITIVE_INFINITY, 'rateBp'),
      PricingErrorCode.rateNotInteger,
    );
  });

  it('отвергает долю вне нуля и единицы', () => {
    expectCode(() => assertBasisPoints(-1, 'rateBp'), PricingErrorCode.rateOutOfRange);
    expectCode(() => assertBasisPoints(10_001, 'rateBp'), PricingErrorCode.rateOutOfRange);
  });

  it('обратный перевод только для показа и с усечением', () => {
    // 1/3 в базисных пунктах не выражается: 3333,33… усекается до 3333. Именно
    // поэтому в расчёте обратного перевода нет ни одного.
    expect(basisPointsForDisplay(rational(1n, 3n))).toBe(3333);
    expect(basisPointsForDisplay(shareOf(50))).toBe(50);
  });
});
