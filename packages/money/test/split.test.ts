import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  MoneyErrorCode,
  allocate,
  fromDecimalString,
  money,
  rational,
  rationalFromDecimalString,
  split,
  splitPartsTotal,
} from '../src/index';

const platformFee = { key: 'fee:income', rate: rationalFromDecimalString('0.005') };

describe('split: сумма частей строго равна исходной', () => {
  it('splits the FUNCTIONAL.md §3.3 settlement', () => {
    const total = money('GEL', 21_349_500n);
    const result = split(total, [platformFee]);
    expect(result.deductions[0]?.amount.minor).toBe(106_747n);
    expect(result.recipient.minor).toBe(21_242_753n);
    expect(splitPartsTotal(result).minor).toBe(total.minor);
  });

  it('gives the rounding remainder to the recipient, never to the platform', () => {
    // 0,5% от 1 001 тетри = 5,005 тетри. Платформа получает 5, клиент — 996.
    const result = split(money('GEL', 1001n), [platformFee]);
    expect(result.deductions[0]?.amount.minor).toBe(5n);
    expect(result.recipient.minor).toBe(996n);
    expect(splitPartsTotal(result).minor).toBe(1001n);
  });

  it('applies deductions in the fixed documented order and off the original amount', () => {
    const total = money('GEL', 100_000n);
    const partner = { key: 'partner:fee', rate: rationalFromDecimalString('0.001') };
    const direct = split(total, [platformFee, partner]);
    const swapped = split(total, [partner, platformFee]);
    expect(direct.recipient.minor).toBe(swapped.recipient.minor);
    expect(direct.deductions.map((part) => part.key)).toEqual(['fee:income', 'partner:fee']);
    expect(swapped.deductions.map((part) => part.key)).toEqual(['partner:fee', 'fee:income']);
  });

  it('supports fixed part, minimum and maximum', () => {
    const withFixed = split(money('GEL', 10_000n), [
      { key: 'fee:income', rate: rationalFromDecimalString('0.005'), fixed: 200n },
    ]);
    expect(withFixed.deductions[0]?.amount.minor).toBe(250n);

    const withMinimum = split(money('GEL', 10_000n), [
      { key: 'fee:income', rate: rationalFromDecimalString('0.005'), minimum: 500n },
    ]);
    expect(withMinimum.deductions[0]?.amount.minor).toBe(500n);

    const withMaximum = split(money('GEL', 10_000_000n), [
      { key: 'fee:income', rate: rationalFromDecimalString('0.005'), maximum: 1_000n },
    ]);
    expect(withMaximum.deductions[0]?.amount.minor).toBe(1_000n);
  });

  it('never rounds twice: a chain of deductions still sums to the total', () => {
    const total = money('GEL', 33_333n);
    const result = split(total, [
      { key: 'fee:income', rate: rational(1n, 3n) },
      { key: 'partner:fee', rate: rational(1n, 7n) },
      { key: 'psp:fee:expense', rate: rational(1n, 11n) },
    ]);
    expect(splitPartsTotal(result).minor).toBe(total.minor);
  });

  it('rejects deductions above the amount instead of producing a negative payout', () => {
    try {
      split(money('GEL', 1_000n), [{ key: 'fee:income', fixed: 1_001n }]);
      expect.unreachable();
    } catch (error) {
      expect((error as MoneyError).code).toBe(MoneyErrorCode.splitDeductionsExceedTotal);
    }
  });

  it('rejects duplicate deduction keys and negative amounts', () => {
    expect(() => split(money('GEL', 1_000n), [platformFee, platformFee])).toThrow(MoneyError);
    expect(() => split(money('GEL', -1n), [])).toThrow(MoneyError);
  });

  it('handles a zero-decimal currency without special casing', () => {
    const result = split(fromDecimalString('JPY', '1001'), [platformFee]);
    expect(result.deductions[0]?.amount.minor).toBe(5n);
    expect(result.recipient.minor).toBe(996n);
  });
});

describe('allocate: пропорциональное деление', () => {
  it('keeps the sum exact and hands the remainder to the chosen share', () => {
    const parts = allocate(money('GEL', 100n), [1n, 1n, 1n], 0);
    expect(parts.map((part) => part.minor)).toEqual([34n, 33n, 33n]);
    expect(parts.reduce((acc, part) => acc + part.minor, 0n)).toBe(100n);
  });

  it('rejects an empty or zero weight set and an out-of-range remainder index', () => {
    expect(() => allocate(money('GEL', 100n), [], 0)).toThrow(MoneyError);
    expect(() => allocate(money('GEL', 100n), [0n, 0n], 0)).toThrow(MoneyError);
    expect(() => allocate(money('GEL', 100n), [1n], 5)).toThrow(MoneyError);
    expect(() => allocate(money('GEL', 100n), [-1n, 2n], 0)).toThrow(MoneyError);
  });
});
