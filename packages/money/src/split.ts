import { type CurrencyCode } from './currency';
import { MoneyError, MoneyErrorCode } from './errors';
import { type Money, money } from './money';
import { type Rational, RATIONAL_ZERO, applyRational } from './rational';

/**
 * Удержание из входящей суммы: комиссия платформы, вознаграждение партнёра.
 * `key` — технический ключ строки расчёта, не текст для клиента.
 */
export interface Deduction {
  readonly key: string;
  readonly rate?: Rational;
  readonly fixed?: bigint;
  readonly minimum?: bigint;
  readonly maximum?: bigint;
}

export interface SplitPart<C extends CurrencyCode> {
  readonly key: string;
  readonly amount: Money<C>;
}

export interface SplitResult<C extends CurrencyCode> {
  readonly total: Money<C>;
  readonly deductions: readonly SplitPart<C>[];
  readonly recipient: Money<C>;
}

/**
 * Расщепление платежа по FUNCTIONAL.md §4.3.
 *
 * Порядок фиксирован: удержания считаются в порядке массива, каждое — от
 * исходной суммы к распределению, а не от остатка после предыдущего. Так
 * результат не зависит от порядка вычислений и от того, сколько удержаний.
 *
 * Каждое удержание округляется вниз (trunc от неотрицательной величины) ровно
 * один раз, из точной рациональной величины. Получателю достаётся остаток —
 * то есть **остаток от округления всегда у получателя, а не у платформы**
 * (FUNCTIONAL.md §4.3 п.5, CORE.md Ф8). Инвариант: сумма частей строго равна
 * исходной сумме, потому что доля получателя вычитанием, а не вычислением.
 *
 * База каждой ставки — сумма к распределению. Документ не описывает случай,
 * когда вознаграждение партнёра считается от остатка после комиссии
 * платформы; выбран вариант «от исходной суммы», он же единственный, при
 * котором порядок массива не меняет итог удержаний.
 */
export function split<C extends CurrencyCode>(
  total: Money<C>,
  deductions: readonly Deduction[],
): SplitResult<C> {
  if (total.minor < 0n) {
    throw new MoneyError(MoneyErrorCode.negativeAmount, { amount: total.minor.toString() });
  }
  const seen = new Set<string>();
  const parts: SplitPart<C>[] = [];
  let deducted = 0n;
  for (const deduction of deductions) {
    if (seen.has(deduction.key)) {
      throw new MoneyError(MoneyErrorCode.splitDuplicateKey, { key: deduction.key });
    }
    seen.add(deduction.key);
    const rate = deduction.rate ?? RATIONAL_ZERO;
    const fixed = deduction.fixed ?? 0n;
    let amount = applyRational(total.minor, rate, 'trunc') + fixed;
    if (deduction.minimum !== undefined && amount < deduction.minimum) {
      amount = deduction.minimum;
    }
    if (deduction.maximum !== undefined && amount > deduction.maximum) {
      amount = deduction.maximum;
    }
    if (amount < 0n) {
      throw new MoneyError(MoneyErrorCode.splitNegativeDeduction, { key: deduction.key });
    }
    deducted += amount;
    parts.push({ key: deduction.key, amount: money(total.currency, amount) });
  }
  if (deducted > total.minor) {
    throw new MoneyError(MoneyErrorCode.splitDeductionsExceedTotal, {
      total: total.minor.toString(),
      deducted: deducted.toString(),
    });
  }
  return Object.freeze({
    total,
    deductions: Object.freeze(parts),
    recipient: money(total.currency, total.minor - deducted),
  });
}

export function splitPartsTotal<C extends CurrencyCode>(result: SplitResult<C>): Money<C> {
  let total = result.recipient.minor;
  for (const part of result.deductions) {
    total += part.amount.minor;
  }
  return money(result.total.currency, total);
}

/**
 * Пропорциональное деление суммы по целым весам. Каждая доля округляется вниз,
 * весь остаток от округления достаётся доле `remainderIndex` — по тому же
 * правилу «остаток получателю». Сумма долей строго равна исходной сумме.
 */
export function allocate<C extends CurrencyCode>(
  total: Money<C>,
  weights: readonly bigint[],
  remainderIndex: number,
): readonly Money<C>[] {
  if (weights.length === 0) {
    throw new MoneyError(MoneyErrorCode.allocateNoWeights);
  }
  if (remainderIndex < 0 || remainderIndex >= weights.length) {
    throw new MoneyError(MoneyErrorCode.allocateRemainderIndexOutOfRange, {
      remainderIndex: String(remainderIndex),
      weights: String(weights.length),
    });
  }
  let weightTotal = 0n;
  for (const weight of weights) {
    if (weight < 0n) {
      throw new MoneyError(MoneyErrorCode.allocateNegativeWeight, { weight: weight.toString() });
    }
    weightTotal += weight;
  }
  if (weightTotal === 0n) {
    throw new MoneyError(MoneyErrorCode.allocateNoWeights);
  }
  const shares: bigint[] = [];
  let allocated = 0n;
  for (const weight of weights) {
    const share = (total.minor * weight) / weightTotal;
    shares.push(share);
    allocated += share;
  }
  const remainder = total.minor - allocated;
  const current = shares[remainderIndex];
  if (current === undefined) {
    throw new MoneyError(MoneyErrorCode.allocateRemainderIndexOutOfRange, {
      remainderIndex: String(remainderIndex),
    });
  }
  shares[remainderIndex] = current + remainder;
  return Object.freeze(shares.map((share) => money(total.currency, share)));
}
