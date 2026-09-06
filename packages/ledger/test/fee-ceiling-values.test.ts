import { money, rational } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEE_CEILING,
  LedgerError,
  LedgerErrorCode,
  feeCeiling,
  feeCeilingCap,
  feeWithinCeiling,
  strictestFeeCeiling,
} from '../src/index';

/**
 * Потолок удержания как **величина**: сама доля, округление и границы.
 *
 * Мутационный прогон показал, что от потолка проверялось только его применение
 * в записи расчёта, а сама арифметика — нет: подмена направления округления
 * (`'trunc'` → `'ceil'`) и обеих границ `feeWithinCeiling` не роняла ни одного
 * теста. Обе подмены — про деньги клиента: округление вверх забирает спорную
 * минорную единицу у получателя (FUNCTIONAL.md §4.3 п.5, красная линия №4), а
 * сдвиг границы отвергает или пропускает удержание **ровно по потолку**.
 */

describe('доля потолка считается в целых минорных единицах', () => {
  it('truncates the cap in favour of the recipient', () => {
    // Два процента от 101 — это 2,02 минорной единицы. Спорная единица
    // достаётся получателю, поэтому потолок равен двум, а не трём.
    expect(feeCeilingCap(money('GEL', 101n)).minor).toBe(2n);
    expect(feeCeilingCap(money('GEL', 149n)).minor).toBe(2n);
    expect(feeCeilingCap(money('GEL', 150n)).minor).toBe(3n);
  });

  it('keeps the currency of the gross amount', () => {
    expect(feeCeilingCap(money('USD', 100_000n))).toEqual(money('USD', 2_000n));
  });

  it('gives zero for a gross amount smaller than the step', () => {
    expect(feeCeilingCap(money('GEL', 49n)).minor).toBe(0n);
  });

  it('refuses to measure a negative gross amount', () => {
    try {
      feeCeilingCap(money('GEL', -1n));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe(LedgerErrorCode.feeCeilingInvalid);
      expect((error as LedgerError).details.reason).toBe('negative_gross');
    }
  });

  it('applies the declared share, not the default one', () => {
    expect(feeCeilingCap(money('GEL', 100_000n), feeCeiling(rational(1n, 2n))).minor).toBe(50_000n);
    expect(DEFAULT_FEE_CEILING.maxShare).toEqual(rational(2n, 100n));
  });
});

describe('границы «укладывается в потолок»', () => {
  const gross = money('GEL', 100_000n);

  it('accepts a withholding exactly at the cap', () => {
    // 2 000 — это ровно два процента от 100 000. Граница принадлежит
    // разрешённой стороне, и проверяется здесь именно она.
    expect(feeWithinCeiling(gross, money('GEL', 2_000n))).toBe(true);
    expect(feeWithinCeiling(gross, money('GEL', 2_001n))).toBe(false);
  });

  it('accepts a withholding of nothing', () => {
    expect(feeWithinCeiling(gross, money('GEL', 0n))).toBe(true);
  });

  it('refuses a negative withholding instead of reading it as slack', () => {
    // Отрицательное удержание означает, что получателю досталось больше брутто;
    // потолком такую запись мерить нечем, и ответ здесь «нет», а не «да».
    expect(feeWithinCeiling(gross, money('GEL', -1n))).toBe(false);
  });

  it('refuses to compare two different currencies', () => {
    expect(feeWithinCeiling(gross, money('USD', 1n))).toBe(false);
    expect(feeWithinCeiling(gross, money('GEL', 1n))).toBe(true);
  });

  it('measures against the declared ceiling when one is given', () => {
    expect(feeWithinCeiling(gross, money('GEL', 2_000n), feeCeiling(rational(1n, 100n)))).toBe(
      false,
    );
    expect(feeWithinCeiling(gross, money('GEL', 1_000n), feeCeiling(rational(1n, 100n)))).toBe(true);
  });
});

describe('объявленный потолок только сужает', () => {
  it('keeps the stricter of two shares', () => {
    const strict = feeCeiling(rational(1n, 100n));
    const loose = feeCeiling(rational(1n, 1n));
    expect(strictestFeeCeiling(strict, loose).maxShare).toEqual(rational(1n, 100n));
    expect(strictestFeeCeiling(loose, strict).maxShare).toEqual(rational(1n, 100n));
    expect(strictestFeeCeiling(loose, DEFAULT_FEE_CEILING).maxShare).toEqual(rational(2n, 100n));
  });

  it('refuses a share that is not a share at all', () => {
    for (const [share, reason] of [
      [rational(-1n, 100n), 'negative'],
      [rational(101n, 100n), 'above_one'],
    ] as const) {
      try {
        feeCeiling(share);
        expect.unreachable();
      } catch (error) {
        expect((error as LedgerError).code).toBe(LedgerErrorCode.feeCeilingInvalid);
        expect((error as LedgerError).details.reason).toBe(reason);
      }
    }
  });

  it('accepts the whole and the nothing as values', () => {
    expect(feeCeiling(rational(1n, 1n)).maxShare).toEqual(rational(1n, 1n));
    expect(feeCeiling(rational(0n, 1n)).maxShare).toEqual(rational(0n, 1n));
  });
});
