import { describe, expect, it } from 'vitest';
import {
  MoneyErrorCode,
  allocate,
  fromDecimalString,
  money,
  rational,
  rationalFromDecimalString,
  split,
  splitPartsTotal,
} from '../src/index';
import { expectMoneyError } from './support/errors';

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

  /**
   * FUNCTIONAL.md §4.3, шаг 3: «База — исходная сумма поступления, а не остаток
   * после нашей комиссии». Проверяется перестановкой шагов 2 и 3: при базе
   * «остаток» партнёр получил бы 212 427 в одном порядке и 213 495 в другом, а
   * платформа — 106 747 против 105 680. Тест падает ровно на такой реализации,
   * и это единственное, что он должен доказывать.
   */
  it('takes the partner fee off the incoming amount, so swapping steps 2 and 3 changes nothing', () => {
    const total = money('GEL', 21_349_500n);
    const partner = { key: 'partner:fee', rate: rationalFromDecimalString('0.01') };
    const direct = split(total, [platformFee, partner]);
    const swapped = split(total, [partner, platformFee]);

    const amountOf = (result: ReturnType<typeof split>, key: string): bigint | undefined =>
      result.deductions.find((part) => part.key === key)?.amount.minor;

    expect(amountOf(direct, 'fee:income')).toBe(106_747n);
    expect(amountOf(direct, 'partner:fee')).toBe(213_495n);
    expect(amountOf(swapped, 'fee:income')).toBe(amountOf(direct, 'fee:income'));
    expect(amountOf(swapped, 'partner:fee')).toBe(amountOf(direct, 'partner:fee'));
    expect(swapped.recipient.minor).toBe(direct.recipient.minor);
    expect(splitPartsTotal(direct).minor).toBe(total.minor);
    expect(splitPartsTotal(swapped).minor).toBe(total.minor);
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

  it('leaves the whole amount to the recipient when there is nothing to deduct', () => {
    const total = money('GEL', 21_349_500n);
    const result = split(total, []);
    expect(result.deductions).toEqual([]);
    expect(result.recipient.minor).toBe(total.minor);
    expect(splitPartsTotal(result).minor).toBe(total.minor);
  });

  it('rejects deductions above the amount instead of producing a negative payout', () => {
    expectMoneyError(
      () => split(money('GEL', 1_000n), [{ key: 'fee:income', fixed: 1_001n }]),
      MoneyErrorCode.splitDeductionsExceedTotal,
      { total: '1000', deducted: '1001' },
    );
  });

  it('rejects duplicate deduction keys and negative amounts', () => {
    expectMoneyError(
      () => split(money('GEL', 1_000n), [platformFee, platformFee]),
      MoneyErrorCode.splitDuplicateKey,
      { key: 'fee:income' },
    );
    // Код обязателен: без него снятие проверки на отрицательную сумму уводит
    // тот же вход на `splitDeductionsExceedTotal` (0 > −1), и тест зеленеет.
    expectMoneyError(() => split(money('GEL', -1n), []), MoneyErrorCode.negativeAmount, {
      amount: '-1',
    });
  });

  /**
   * Красные линии №1 и №2: удержание не может уйти в минус, потому что
   * отрицательное удержание — это выплата получателю **больше**, чем поступило
   * на номинальный счёт, за счёт чужих денег.
   *
   * Проверка `deducted > total.minor` этот класс не ловит по построению: сумма
   * частей остаётся равной исходной (20 000 000 = 20 000 001 + (−1)), поэтому
   * инвариант «сумма частей строго равна исходной» тоже остаётся истинным.
   * Единственное, что отделяет платформу от такой выплаты, — проверка знака,
   * и вот три двери, через которые в неё входят.
   */
  it('refuses a deduction that would turn into a payment to the recipient', () => {
    // Дверь первая: потолок удержания задан отрицательным. Сценарий из аудита —
    // 200 000 ₾ с потолком −0,01 ₾ отдавали получателю 200 000,01 ₾.
    expectMoneyError(
      () =>
        split(money('GEL', 20_000_000n), [
          { key: 'fee:income', rate: rationalFromDecimalString('0.005'), maximum: -1n },
        ]),
      MoneyErrorCode.splitNegativeDeduction,
      { key: 'fee:income' },
    );
    // Дверь вторая: отрицательная фиксированная часть перевешивает ставку.
    expectMoneyError(
      () =>
        split(money('GEL', 10_000n), [
          { key: 'fee:income', rate: rationalFromDecimalString('0.005'), fixed: -100n },
        ]),
      MoneyErrorCode.splitNegativeDeduction,
      { key: 'fee:income' },
    );
    // Дверь третья: отрицательная ставка.
    expectMoneyError(
      () =>
        split(money('GEL', 10_000n), [
          { key: 'fee:income', rate: rationalFromDecimalString('-0.005') },
        ]),
      MoneyErrorCode.splitNegativeDeduction,
      { key: 'fee:income' },
    );
    // Отрицательный пол сам по себе в минус увести не может — он поднимает
    // удержание, а не опускает, — но и не спасает уже отрицательное:
    // −50 поднимается до −5 и всё равно отвергается.
    expectMoneyError(
      () =>
        split(money('GEL', 10_000n), [
          { key: 'fee:income', rate: rationalFromDecimalString('-0.005'), minimum: -5n },
        ]),
      MoneyErrorCode.splitNegativeDeduction,
      { key: 'fee:income' },
    );
    // Отказ наступает на самом удержании, а не после сборки результата: ключ в
    // `details` — того удержания, которое ушло в минус, хотя оно не последнее.
    expectMoneyError(
      () =>
        split(money('GEL', 20_000_000n), [
          { key: 'fee:income', rate: rationalFromDecimalString('0.005'), maximum: -1n },
          { key: 'partner:fee', fixed: 100n },
        ]),
      MoneyErrorCode.splitNegativeDeduction,
      { key: 'fee:income' },
    );
  });

  it('leaves a negative floor inert when the deduction is already non-negative', () => {
    const result = split(money('GEL', 10_000n), [
      { key: 'fee:income', rate: rationalFromDecimalString('0.005'), minimum: -100n },
    ]);
    expect(result.deductions[0]?.amount.minor).toBe(50n);
  });

  /**
   * Порядок применения границ: потолок ставится **после** пола, поэтому при
   * несовместимой паре (минимум выше максимума) побеждает максимум.
   *
   * Тест фиксирует поведение, а не выбирает его: FUNCTIONAL.md §4.3 такой пары
   * не описывает. [открыто] — отвергать ли `minimum > maximum` на входе как
   * заведомо противоречивый тариф; вопрос продуктовый, поднят в отчёте.
   */
  it('applies the ceiling after the floor when the two contradict each other', () => {
    const result = split(money('GEL', 10_000n), [
      { key: 'fee:income', rate: rationalFromDecimalString('0.005'), minimum: 500n, maximum: 100n },
    ]);
    expect(result.deductions[0]?.amount.minor).toBe(100n);
    expect(result.recipient.minor).toBe(9_900n);
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

  /**
   * Все четыре отказа — с кодом, а у индекса остатка ещё и с `details`.
   *
   * Без кода пустой набор весов проходил бы через соседнюю проверку («индекс
   * остатка вне диапазона»: 0 >= 0 для пустого массива) и снятие запрета на
   * пустые веса оставалось бы незамеченным. У самого индекса остатка соседняя
   * проверка на дне функции даёт **тот же код**, и различает их только состав
   * пояснения: ранний отказ называет допустимый диапазон (`weights`), поздний —
   * нет. Поэтому здесь утверждается и он.
   */
  it('rejects an empty or zero weight set and an out-of-range remainder index', () => {
    expectMoneyError(() => allocate(money('GEL', 100n), [], 0), MoneyErrorCode.allocateNoWeights, {});
    expectMoneyError(
      () => allocate(money('GEL', 100n), [0n, 0n], 0),
      MoneyErrorCode.allocateNoWeights,
      {},
    );
    expectMoneyError(
      () => allocate(money('GEL', 100n), [1n], 5),
      MoneyErrorCode.allocateRemainderIndexOutOfRange,
      { remainderIndex: '5', weights: '1' },
    );
    expectMoneyError(
      () => allocate(money('GEL', 100n), [1n, 2n], -1),
      MoneyErrorCode.allocateRemainderIndexOutOfRange,
      { remainderIndex: '-1', weights: '2' },
    );
    expectMoneyError(
      () => allocate(money('GEL', 100n), [-1n, 2n], 0),
      MoneyErrorCode.allocateNegativeWeight,
      { weight: '-1' },
    );
  });
});
