import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  MoneyErrorCode,
  absolute,
  add,
  assertCurrencyCode,
  compare,
  equals,
  fromDecimalString,
  isCurrencyCode,
  isNegative,
  isPositive,
  isZero,
  maximum,
  minimum,
  minorUnitScale,
  money,
  multiplyByInteger,
  negate,
  subtract,
  sum,
  toDecimalString,
  zero,
} from '../src/index';
import { expectMoneyError } from './support/errors';

describe('money: construction and parsing', () => {
  it('builds from minor units', () => {
    expect(money('GEL', 213_495_00n).minor).toBe(21349500n);
  });

  it('parses decimal strings without floating point', () => {
    expect(fromDecimalString('GEL', '2134.95').minor).toBe(213495n);
    expect(fromDecimalString('GEL', '0.01').minor).toBe(1n);
    expect(fromDecimalString('GEL', '-0.01').minor).toBe(-1n);
    expect(fromDecimalString('GEL', '7').minor).toBe(700n);
    expect(fromDecimalString('GEL', '+7.5').minor).toBe(750n);
  });

  it('keeps precision that double would lose', () => {
    const a = fromDecimalString('USD', '0.1');
    const b = fromDecimalString('USD', '0.2');
    expect(add(a, b).minor).toBe(30n);
    expect(toDecimalString(add(a, b))).toBe('0.30');
  });

  it('parses amounts far beyond the safe integer range', () => {
    const huge = fromDecimalString('USD', '99999999999999999999.99');
    expect(huge.minor).toBe(9999999999999999999999n);
    expect(toDecimalString(huge)).toBe('99999999999999999999.99');
  });

  it('rejects malformed input instead of guessing', () => {
    for (const text of ['1e3', '1 000.00', '1,00', '', '.5', 'abc', '1.2.3', 'NaN', 'Infinity']) {
      expect(() => fromDecimalString('GEL', text)).toThrow(MoneyError);
    }
  });

  it('rejects extra fraction digits rather than rounding silently', () => {
    try {
      fromDecimalString('GEL', '1.005');
      expect.unreachable();
    } catch (error) {
      expect((error as MoneyError).code).toBe(MoneyErrorCode.parseTooManyFractionDigits);
    }
  });
});

describe('money: minor unit exponent is a property of the currency', () => {
  it('does not hardcode 100', () => {
    expect(minorUnitScale('GEL')).toBe(100n);
    expect(minorUnitScale('JPY')).toBe(1n);
  });

  it('parses and prints a zero-decimal currency', () => {
    const value = fromDecimalString('JPY', '1500');
    expect(value.minor).toBe(1500n);
    expect(toDecimalString(value)).toBe('1500');
    expect(() => fromDecimalString('JPY', '1500.5')).toThrow(MoneyError);
  });

  it('round-trips every currency', () => {
    expect(toDecimalString(fromDecimalString('EUR', '-12.34'))).toBe('-12.34');
    expect(toDecimalString(fromDecimalString('USD', '0.00'))).toBe('0.00');
    expect(toDecimalString(money('JPY', -7n))).toBe('-7');
  });
});

describe('money: arithmetic', () => {
  const gel = (text: string) => fromDecimalString('GEL', text);

  it('adds, subtracts, negates and multiplies by integers', () => {
    expect(add(gel('10.00'), gel('0.05')).minor).toBe(1005n);
    expect(subtract(gel('10.00'), gel('0.05')).minor).toBe(995n);
    expect(negate(gel('10.00')).minor).toBe(-1000n);
    expect(multiplyByInteger(gel('10.00'), 3n).minor).toBe(3000n);
  });

  it('compares and sums', () => {
    expect(compare(gel('1.00'), gel('2.00'))).toBe(-1);
    expect(compare(gel('2.00'), gel('2.00'))).toBe(0);
    expect(compare(gel('3.00'), gel('2.00'))).toBe(1);
    expect(sum('GEL', [gel('1.00'), gel('2.50')]).minor).toBe(350n);
  });

  it('throws on currency mismatch at runtime as well as at compile time', () => {
    const usd = fromDecimalString('USD', '1.00');
    // @ts-expect-error красная линия: сложение разных валют — ошибка типа
    expect(() => add(gel('1.00'), usd)).toThrow(MoneyError);
    expectMoneyError(
      // @ts-expect-error та же величина, теперь ради кода ошибки
      () => subtract(gel('1.00'), usd),
      MoneyErrorCode.currencyMismatch,
      { left: 'GEL', right: 'USD' },
    );
  });

  /**
   * `sum` — единственная операция, куда валюта приходит отдельным аргументом, а
   * не выводится из самих сумм: список может быть пуст. Поэтому у неё своя
   * проверка на каждый элемент, и она обязана иметь падающий тест — иначе
   * сложение лари с долларами проходит молча, а результат подписан лари.
   */
  it('refuses to sum amounts in a currency other than the one it is asked for', () => {
    const usd = fromDecimalString('USD', '1.00');
    expectMoneyError(
      // @ts-expect-error красная линия: чужая валюта в списке — ошибка типа
      () => sum('GEL', [gel('1.00'), usd]),
      MoneyErrorCode.currencyMismatch,
      { left: 'GEL', right: 'USD' },
    );
    expect(sum('GEL', []).minor).toBe(0n);
    expect(sum('GEL', []).currency).toBe('GEL');
  });
});

/**
 * Предикаты и границы. Отдельный набор появился после мутационного прогона:
 * `isPositive`, `isNegative`, `absolute`, `minimum` вызываются из домена,
 * учёта и приложения (десятки мест), но в самом `@sdelka/money` не были
 * задеты ни одним тестом — подмена `>` на `>=` в `isPositive` переживала весь
 * набор пакета. Знак и границы — вход в решения «хватает ли средств»
 * и «есть ли недостача», поэтому проверяются здесь, а не косвенно.
 */
describe('money: знак, границы и равенство', () => {
  const gel = (minor: bigint) => money('GEL', minor);

  it('tells zero from positive and negative without treating zero as either', () => {
    expect(isZero(gel(0n))).toBe(true);
    expect(isZero(gel(1n))).toBe(false);
    expect(isZero(gel(-1n))).toBe(false);
    expect(isPositive(gel(0n))).toBe(false);
    expect(isPositive(gel(1n))).toBe(true);
    expect(isNegative(gel(0n))).toBe(false);
    expect(isNegative(gel(-1n))).toBe(true);
    expect(zero('GEL')).toEqual(money('GEL', 0n));
  });

  it('takes the absolute value and keeps the currency', () => {
    expect(absolute(gel(-250n)).minor).toBe(250n);
    expect(absolute(gel(250n)).minor).toBe(250n);
    expect(absolute(gel(0n)).minor).toBe(0n);
    expect(absolute(money('JPY', -7n)).currency).toBe('JPY');
  });

  it('picks the smaller and the larger amount, ties included', () => {
    expect(minimum(gel(1n), gel(2n)).minor).toBe(1n);
    expect(minimum(gel(2n), gel(1n)).minor).toBe(1n);
    expect(maximum(gel(1n), gel(2n)).minor).toBe(2n);
    expect(maximum(gel(2n), gel(1n)).minor).toBe(2n);
    expect(minimum(gel(-5n), gel(0n)).minor).toBe(-5n);
    expect(maximum(gel(2n), gel(2n)).minor).toBe(2n);
  });

  it('never calls equal two amounts in different currencies', () => {
    expect(equals(gel(100n), gel(100n))).toBe(true);
    expect(equals(gel(100n), gel(101n))).toBe(false);
    // Сто тетри и сто центов — не одна величина, сколько бы ни совпадало число.
    expect(equals(gel(100n), money('USD', 100n))).toBe(false);
  });
});

describe('currency: код валюты с границы процесса', () => {
  /**
   * Валюта приходит строкой из базы и от провайдера. `assertCurrencyCode` —
   * единственное место, где строка становится `CurrencyCode`; без падающего
   * теста снятие проверки пропускает внутрь ядра валюту, у которой нет ни
   * числа знаков, ни множителя.
   */
  it('refuses an unknown currency instead of letting the string through', () => {
    expect(isCurrencyCode('GEL')).toBe(true);
    expect(isCurrencyCode('XXX')).toBe(false);
    expect(isCurrencyCode('toString')).toBe(false);
    expect(assertCurrencyCode('GEL')).toBe('GEL');
    expectMoneyError(() => assertCurrencyCode('RUB'), MoneyErrorCode.unknownCurrency, {
      currency: 'RUB',
    });
    expectMoneyError(() => assertCurrencyCode('gel'), MoneyErrorCode.unknownCurrency, {
      currency: 'gel',
    });
  });
});
