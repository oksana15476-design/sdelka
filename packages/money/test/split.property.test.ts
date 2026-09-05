import { describe, expect, it } from 'vitest';
import {
  type Deduction,
  MoneyError,
  MoneyErrorCode,
  money,
  rational,
  split,
  splitPartsTotal,
} from '../src/index';

/**
 * Свойства расщепления платежа.
 *
 * Почему этот файл появился. Свойство «сумма частей равна исходной» держало
 * весь `split` и **не могло** покраснеть на классе «удержание ушло в минус»:
 * при отрицательной доле сумма частей остаётся верной
 * (20 000 000 = 20 000 001 + (−1)), а получатель получает больше, чем
 * поступило. Утверждения о знаке долей в соседнем пакете тоже были, но их
 * генератор порождал только неотрицательные ставки и фиксированные части и не
 * порождал границ вовсе, поэтому «доля ≥ 0» выполнялось тождественно.
 *
 * Отсюда два правила этого файла:
 *  1. **Область определения генератора включает отрицательные величины** —
 *     ставку, фиксированную часть, пол и потолок, а также отрицательную
 *     исходную сумму. Проверка, к которой генератор не доходит, не проверена.
 *  2. **Счётчики непустоты.** Каждый класс исхода (отказ по знаку, отказ по
 *     превышению, отказ по отрицательной сумме, успешное расщепление) обязан
 *     встретиться в прогоне не реже порога. Если генератор однажды снова
 *     сузят до неотрицательных величин, упадёт счётчик, а не тишина.
 *
 * Случайность детерминирована seed'ом — упавший прогон воспроизводится.
 * Отдельной зависимости ради генератора в денежном ядре нет (так же устроен
 * генератор в `@sdelka/domain`).
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const KEYS = ['fee:income', 'partner:fee', 'psp:fee:expense'] as const;

/**
 * Ожидание считается **независимо от ветвлений `split`**: усечение — деление
 * bigint (оно и есть trunc), границы — одна функция `clamp`. Совпадение с
 * реализацией здесь не переписано из неё, а выведено из FUNCTIONAL.md §4.3:
 * ставка от исходной суммы, плюс фиксированная часть, затем пол, затем потолок.
 */
function clamp(value: bigint, floor: bigint | undefined, ceiling: bigint | undefined): bigint {
  let result = value;
  if (floor !== undefined && result < floor) {
    result = floor;
  }
  if (ceiling !== undefined && result > ceiling) {
    result = ceiling;
  }
  return result;
}

function expectedAmount(totalMinor: bigint, deduction: Deduction): bigint {
  const rated =
    deduction.rate === undefined
      ? 0n
      : (totalMinor * deduction.rate.numerator) / deduction.rate.denominator;
  return clamp(rated + (deduction.fixed ?? 0n), deduction.minimum, deduction.maximum);
}

function bigIntBetween(random: () => number, low: number, high: number): bigint {
  return BigInt(low + Math.floor(random() * (high - low + 1)));
}

interface GeneratedCase {
  readonly totalMinor: bigint;
  readonly deductions: readonly Deduction[];
}

function generate(random: () => number): GeneratedCase {
  const totalMinor =
    random() < 0.05
      ? bigIntBetween(random, -10_000, -1)
      : random() < 0.15
        ? bigIntBetween(random, 0, 5)
        : bigIntBetween(random, 0, 10_000_000);
  const count = Math.floor(random() * (KEYS.length + 1));
  const deductions: Deduction[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = KEYS[index] ?? 'fee:income';
    // Ставка: обычно от 0 до 10 %, но каждая седьмая — отрицательная.
    const rate =
      random() < 0.85
        ? rational(random() < 0.15 ? bigIntBetween(random, -100, -1) : bigIntBetween(random, 0, 1_000), 10_000n)
        : undefined;
    const fixed =
      random() < 0.5
        ? random() < 0.3
          ? bigIntBetween(random, -500, -1)
          : bigIntBetween(random, 0, 500)
        : undefined;
    const minimum =
      random() < 0.3
        ? random() < 0.3
          ? bigIntBetween(random, -200, -1)
          : bigIntBetween(random, 0, 400)
        : undefined;
    const maximum =
      random() < 0.3
        ? random() < 0.3
          ? bigIntBetween(random, -50, -1)
          : bigIntBetween(random, 0, 2_000)
        : undefined;
    deductions.push({
      key,
      ...(rate === undefined ? {} : { rate }),
      ...(fixed === undefined ? {} : { fixed }),
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
    });
  }
  return { totalMinor, deductions };
}

/** Через какую дверь удержание ушло в минус — ради счётчиков непустоты. */
function negativeDoor(totalMinor: bigint, deduction: Deduction): 'maximum' | 'rate' | 'fixed' {
  if (deduction.maximum !== undefined && deduction.maximum < 0n) {
    return 'maximum';
  }
  if (deduction.rate !== undefined && deduction.rate.numerator < 0n) {
    const rated = (totalMinor * deduction.rate.numerator) / deduction.rate.denominator;
    if (rated < 0n) {
      return 'rate';
    }
  }
  return 'fixed';
}

describe('split: свойства на области, включающей отрицательные величины', () => {
  it('either splits the amount into non-negative parts or refuses with the reason', () => {
    const random = makeRandom(20260905);
    const counters = {
      accepted: 0,
      acceptedWithDeductions: 0,
      negativeAmount: 0,
      negativeDeduction: 0,
      exceedTotal: 0,
      doorMaximum: 0,
      doorRate: 0,
      doorFixed: 0,
    };

    for (let run = 0; run < 2_000; run += 1) {
      const { totalMinor, deductions } = generate(random);
      const total = money('GEL', totalMinor);
      const amounts = deductions.map((deduction) => expectedAmount(totalMinor, deduction));
      const firstNegative = amounts.findIndex((amount) => amount < 0n);
      const deducted = amounts.reduce((sum, amount) => sum + amount, 0n);

      if (totalMinor < 0n) {
        // Отрицательная исходная сумма отвергается раньше всего остального.
        counters.negativeAmount += 1;
        try {
          split(total, deductions);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(MoneyError);
          expect((error as MoneyError).code).toBe(MoneyErrorCode.negativeAmount);
        }
        continue;
      }

      if (firstNegative !== -1) {
        // Класс, ради которого написан файл: удержание в минус — это выплата
        // получателю сверх поступившего, то есть чужими деньгами.
        const guilty = deductions[firstNegative];
        counters.negativeDeduction += 1;
        const door = negativeDoor(totalMinor, guilty as Deduction);
        counters[door === 'maximum' ? 'doorMaximum' : door === 'rate' ? 'doorRate' : 'doorFixed'] += 1;
        try {
          split(total, deductions);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(MoneyError);
          expect((error as MoneyError).code).toBe(MoneyErrorCode.splitNegativeDeduction);
          // Отказ называет то удержание, которое ушло в минус, а не любое.
          expect((error as MoneyError).details).toEqual({ key: (guilty as Deduction).key });
        }
        continue;
      }

      if (deducted > totalMinor) {
        counters.exceedTotal += 1;
        try {
          split(total, deductions);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(MoneyError);
          expect((error as MoneyError).code).toBe(MoneyErrorCode.splitDeductionsExceedTotal);
        }
        continue;
      }

      const result = split(total, deductions);
      counters.accepted += 1;
      if (deductions.length > 0) {
        counters.acceptedWithDeductions += 1;
      }
      // Сумма частей строго равна исходной — и **при этом** ни одна часть не
      // отрицательна: первое без второго истинно и для выплаты сверх суммы.
      expect(splitPartsTotal(result).minor).toBe(totalMinor);
      expect(result.recipient.minor).toBeGreaterThanOrEqual(0n);
      expect(result.recipient.minor).toBeLessThanOrEqual(totalMinor);
      expect(result.deductions).toHaveLength(deductions.length);
      result.deductions.forEach((part, index) => {
        expect(part.key).toBe(deductions[index]?.key);
        expect(part.amount.currency).toBe('GEL');
        expect(part.amount.minor).toBeGreaterThanOrEqual(0n);
        expect(part.amount.minor).toBe(amounts[index]);
      });
      expect(result.recipient.minor).toBe(totalMinor - deducted);
    }

    // Счётчики непустоты: сужение области генератора обязано ронять тест.
    expect(counters.accepted).toBeGreaterThan(500);
    expect(counters.acceptedWithDeductions).toBeGreaterThan(300);
    expect(counters.negativeAmount).toBeGreaterThan(20);
    expect(counters.negativeDeduction).toBeGreaterThan(50);
    expect(counters.exceedTotal).toBeGreaterThan(10);
    expect(counters.doorMaximum).toBeGreaterThan(5);
    expect(counters.doorRate).toBeGreaterThan(5);
    expect(counters.doorFixed).toBeGreaterThan(5);
  });

  /**
   * База каждой ставки — исходная сумма, а не остаток после предыдущего
   * удержания (FUNCTIONAL.md §4.3). Следствие, проверяемое здесь: порядок
   * массива не меняет ни одной доли — ни при удаче, ни при отказе.
   */
  it('does not depend on the order of the deductions', () => {
    const random = makeRandom(7);
    let compared = 0;
    for (let run = 0; run < 1_000; run += 1) {
      const { totalMinor, deductions } = generate(random);
      if (totalMinor < 0n || deductions.length < 2) {
        continue;
      }
      const reversed = [...deductions].reverse();
      const direct = attempt(totalMinor, deductions);
      const swapped = attempt(totalMinor, reversed);
      if (typeof direct === 'string' || typeof swapped === 'string') {
        // Отказ обязан быть одинаковым по коду в обоих порядках, кроме случая
        // «в минус ушли два разных удержания» — там код тот же, разнится ключ.
        expect(typeof direct).toBe(typeof swapped);
        expect(direct).toBe(swapped);
        compared += 1;
        continue;
      }
      expect(direct.recipient).toBe(swapped.recipient);
      expect([...direct.byKey.entries()].sort()).toEqual([...swapped.byKey.entries()].sort());
      compared += 1;
    }
    expect(compared).toBeGreaterThan(300);
  });
});

function attempt(
  totalMinor: bigint,
  deductions: readonly Deduction[],
): string | { recipient: bigint; byKey: Map<string, bigint> } {
  try {
    const result = split(money('GEL', totalMinor), deductions);
    return {
      recipient: result.recipient.minor,
      byKey: new Map(result.deductions.map((part) => [part.key, part.amount.minor])),
    };
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyError);
    return (error as MoneyError).code;
  }
}
