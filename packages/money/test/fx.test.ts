import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  MoneyErrorCode,
  accountingFxDifference,
  convert,
  convertAtRate,
  fxBreakdown,
  fxRate,
  fxRates,
  isoDate,
  money,
  platformSpread,
  rationalFromDecimalString,
} from '../src/index';

// Данные из FUNCTIONAL.md §3.3: 80 000 USD, рыночный курс 2,6875, спред 0,7%.
const source = money('USD', 8_000_000n);
const rates = fxRates('USD', 'GEL', {
  client: rationalFromDecimalString('2.6686875'),
  reference: rationalFromDecimalString('2.6875'),
  official: rationalFromDecimalString('2.7000'),
});
const asOf = isoDate('2026-09-03');

describe('три валютных измерения', () => {
  it('stores client, reference and official rate together with both amounts', () => {
    const converted = convert(source, rates, asOf, 'trunc');
    expect(converted.source).toEqual(source);
    expect(converted.target.currency).toBe('GEL');
    expect(converted.target.minor).toBe(21_349_500n);
    expect(converted.rates).toBe(rates);
    expect(converted.asOf).toBe(asOf);
  });

  it('reproduces the documented spread of 1 505 GEL', () => {
    const converted = convert(source, rates, asOf, 'trunc');
    const spread = platformSpread(converted, 'trunc');
    expect(spread.kind).toBe('platform_spread');
    expect(spread.amount.minor).toBe(150_500n);
  });

  it('keeps the accounting fx difference separate from the spread', () => {
    const converted = convert(source, rates, asOf, 'trunc');
    const breakdown = fxBreakdown(converted, 'trunc');
    expect(breakdown.accounting.amount.minor).toBe(250_500n);
    expect(breakdown.spread.amount.minor).toBe(150_500n);
    // CORE.md Ф5: это разные показатели. Они не равны и не складываются.
    expect(breakdown.accounting.amount.minor).not.toBe(breakdown.spread.amount.minor);
  });

  it('reports a zero accounting difference when the official rate equals the client rate', () => {
    const sameOfficial = fxRates('USD', 'GEL', {
      client: rationalFromDecimalString('2.6686875'),
      reference: rationalFromDecimalString('2.6875'),
      official: rationalFromDecimalString('2.6686875'),
    });
    const converted = convert(source, sameOfficial, asOf, 'trunc');
    expect(accountingFxDifference(converted, 'trunc').amount.minor).toBe(0n);
    expect(platformSpread(converted, 'trunc').amount.minor).toBe(150_500n);
  });

  it('refuses a rate whose pair is one currency, and a malformed date', () => {
    expect(() => fxRate('USD', 'USD', rationalFromDecimalString('1'))).toThrow(MoneyError);
    expect(() =>
      fxRates('USD', 'USD', {
        client: rationalFromDecimalString('1'),
        reference: rationalFromDecimalString('1'),
        official: rationalFromDecimalString('1'),
      }),
    ).toThrow(MoneyError);
    expect(() => isoDate('03.09.2026')).toThrow(MoneyError);
  });

  it('refuses a rate that is zero or negative', () => {
    expect(() => fxRate('USD', 'GEL', rationalFromDecimalString('0'))).toThrow(MoneyError);
    expect(() => fxRate('USD', 'GEL', rationalFromDecimalString('-2.5'))).toThrow(MoneyError);
  });
});

describe('направление — часть величины курса', () => {
  /**
   * Проба верификатора, воспроизведённая до починки: у клиента 200 000 ₾, курс
   * 2,50 (лари за доллар), конвертация GEL→USD. Прежняя редакция умножала на
   * `rates.client` в любом направлении и зачисляла клиенту 500 000 долларов
   * вместо 80 000 — запись собиралась, покрытие рапортовало единицу по обеим
   * валютам, ни один инвариант не срабатывал.
   *
   * Теперь курс 2,50 объявлен как USD→GEL, и приложить его к сумме в лари
   * нельзя ни по типам, ни в рантайме.
   */
  const twoHundredThousandGel = money('GEL', 20_000_000n);
  const usdToGel = fxRate('USD', 'GEL', rationalFromDecimalString('2.50'));

  it('refuses to apply a USD→GEL rate to an amount in GEL', () => {
    expect(() =>
      // @ts-expect-error курс не своей пары не проходит и по типам
      convertAtRate(twoHundredThousandGel, usdToGel, 'trunc'),
    ).toThrow(MoneyError);
    try {
      // @ts-expect-error та же величина, теперь ради кода ошибки
      convertAtRate(twoHundredThousandGel, usdToGel, 'trunc');
    } catch (error) {
      expect((error as MoneyError).code).toBe(MoneyErrorCode.fxRatePairMismatch);
    }
  });

  it('converts GEL→USD only by a GEL→USD rate, and the answer is 80 000', () => {
    // Обратная сторона той же пары — **другая котировка**, а не перевёрнутая
    // дробь: перевёрнутый курс отдал бы клиенту наш спред. 0,40 — курс
    // провайдера на обратное направление.
    const gelToUsd = fxRates('GEL', 'USD', {
      client: rationalFromDecimalString('0.40'),
      reference: rationalFromDecimalString('0.402'),
      official: rationalFromDecimalString('0.4008'),
    });
    const converted = convert(twoHundredThousandGel, gelToUsd, asOf, 'trunc');
    expect(converted.target.currency).toBe('USD');
    expect(converted.target.minor).toBe(8_000_000n); // 80 000 $, а не 500 000
  });

  it('refuses a rates set whose pair does not match the source amount', () => {
    expect(() => convert(twoHundredThousandGel, rates as never, asOf, 'trunc')).toThrow(MoneyError);
  });

  /**
   * Второй запрет в `assertRateApplies` — курс, у которого база и котировка
   * совпали. Через `fxRate` такую величину не собрать, и до появления этого
   * теста в неё не заходил ни один прогон: `fxRatePairMismatch` перехватывал
   * все входы раньше, а снятие запрета оставалось незамеченным.
   *
   * Вход существует ровно потому, что типы не переживают границу процесса:
   * курс приходит из базы и от провайдера, там пара — две строки, и они могут
   * совпасть. Курс «лари за лари» умножает сумму на произвольное число, оставив
   * валюту прежней, — молча и без единого признака ошибки.
   */
  it('refuses a rate whose own pair collapsed to one currency, as data from the wire can', () => {
    const fromTheWire = {
      base: 'GEL',
      quote: 'GEL',
      value: rationalFromDecimalString('2.50'),
    } as unknown as Parameters<typeof convertAtRate<'GEL', 'GEL'>>[1];
    try {
      convertAtRate(twoHundredThousandGel, fromTheWire, 'trunc');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MoneyError);
      expect((error as MoneyError).code).toBe(MoneyErrorCode.fxCurrencyMismatch);
      expect((error as MoneyError).details).toEqual({ source: 'GEL', target: 'GEL' });
    }
  });
});

describe('направление округления при конвертации', () => {
  /**
   * FUNCTIONAL.md §4.3: «Направление задаётся явным параметром на каждом вызове,
   * значения по умолчанию у операции нет». Отсутствие умолчания проверяется
   * арностью: параметр со значением по умолчанию в `length` не считается, и
   * возврат умолчания уронит этот тест, а не пройдёт незамеченным. Типовую
   * сторону («вызов без параметра не компилируется») держит `pnpm typecheck`.
   *
   * Числа уменьшились на единицу против прежней редакции и обязаны были
   * уменьшиться: целевая валюта больше не аргумент вызова, она пришла в самом
   * курсе. Смысл проверки прежний — округление остаётся последним обязательным
   * параметром, и умолчание у него по-прежнему уронит тест.
   */
  it('has no overload without the rounding argument', () => {
    expect(convert.length).toBe(4);
    expect(convertAtRate.length).toBe(3);
    expect(platformSpread.length).toBe(2);
    expect(accountingFxDifference.length).toBe(2);
    expect(fxBreakdown.length).toBe(2);
  });

  it('truncates rather than rounds to nearest, in whichever direction is asked', () => {
    // 1 005 USD по курсу 2,6686875 — это 2 682,0309... лари: усечение отбрасывает
    // 0,09 тетри, ceil добавляет тетри. Разница копеечная и в этом весь смысл:
    // молчаливое умолчание теряет её тысячу раз (FUNCTIONAL.md §4.3).
    const odd = money('USD', 100_500n);
    expect(convertAtRate(odd, rates.client, 'trunc').minor).toBe(268_203n);
    expect(convertAtRate(odd, rates.client, 'ceil').minor).toBe(268_204n);
    expect(convertAtRate(odd, rates.client, 'floor').minor).toBe(268_203n);
  });

  it('accounts for currencies with a different number of minor digits', () => {
    // JPY — 0 знаков. Пересчёт «минорные на курс» без поправки на порядок дал бы
    // сумму в сто раз больше: 100,00 USD по 150 — это 15 000 иен, а не 1 500 000.
    const hundredDollars = money('USD', 10_000n);
    const usdToJpy = fxRate('USD', 'JPY', rationalFromDecimalString('150'));
    expect(convertAtRate(hundredDollars, usdToJpy, 'trunc').minor).toBe(15_000n);
    const fifteenThousandYen = money('JPY', 15_000n);
    const jpyToUsd = fxRate('JPY', 'USD', rationalFromDecimalString('0.0066666'));
    expect(convertAtRate(fifteenThousandYen, jpyToUsd, 'trunc').minor).toBe(9_999n);
  });
});
