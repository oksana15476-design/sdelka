import { HOUR } from '@sdelka/domain';
import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  LimitsErrorCode,
  PROVISIONAL_AMOUNT_TOLERANCE,
  PROVISIONAL_MATERIALITY_THRESHOLD,
  PROVISIONAL_QUEUE_AGE_BANDS,
  amountTolerance,
  dealCurrencyList,
  materialityThreshold,
  queueAgeBands,
} from '../src/index';

const DOC = 'docs/product/SETTINGS.md';

describe('допуск по сумме поступления отвергается на записи, а не при применении', () => {
  it('доля целым числом базисных пунктов: дробь не проходит', () => {
    // Плавающая точка заходит в денежный домен именно так — через поле формы.
    expect(() => amountTolerance({ absolute: [], shareBp: 0.5, rationaleDocRef: DOC })).toThrowError(
      LimitsErrorCode.shareNotInteger,
    );
  });

  it('отрицательная доля — отказ', () => {
    expect(() => amountTolerance({ absolute: [], shareBp: -1, rationaleDocRef: DOC })).toThrowError(
      LimitsErrorCode.shareOutOfRange,
    );
  });

  it('доля больше самой суммы — отказ: 10 000 б.п. это и есть сумма', () => {
    expect(() =>
      amountTolerance({ absolute: [], shareBp: 10_001, rationaleDocRef: DOC }),
    ).toThrowError(LimitsErrorCode.shareOutOfRange);
    expect(amountTolerance({ absolute: [], shareBp: 10_000, rationaleDocRef: DOC }).shareBp).toBe(
      10_000,
    );
  });

  it('ноль — законное значение доли: строгое равенство', () => {
    expect(amountTolerance({ absolute: [], shareBp: 0, rationaleDocRef: DOC }).shareBp).toBe(0);
  });

  it('отрицательный абсолют — отказ', () => {
    expect(() =>
      amountTolerance({ absolute: [money('GEL', -1n)], shareBp: 50, rationaleDocRef: DOC }),
    ).toThrowError(LimitsErrorCode.amountNegative);
  });

  it('одна валюта дважды — отказ, а не «последняя побеждает»', () => {
    expect(() =>
      amountTolerance({
        absolute: [money('GEL', 5_000n), money('GEL', 9_000n)],
        shareBp: 50,
        rationaleDocRef: DOC,
      }),
    ).toThrowError(LimitsErrorCode.currencyDuplicated);
  });

  it('валюта не из перечня сделки — отказ, если перечень предъявлен', () => {
    expect(() =>
      amountTolerance(
        { absolute: [money('USD', 2_000n)], shareBp: 50, rationaleDocRef: DOC },
        dealCurrencyList(['GEL']),
      ),
    ).toThrowError(LimitsErrorCode.currencyNotAdmitted);
  });

  it('порог без письменного обоснования не собирается', () => {
    expect(() => amountTolerance({ absolute: [], shareBp: 50, rationaleDocRef: '  ' })).toThrowError(
      LimitsErrorCode.thresholdUnjustified,
    );
  });

  it('временное значение перенесено из приёма без изменения величин', () => {
    expect(PROVISIONAL_AMOUNT_TOLERANCE.shareBp).toBe(50);
    expect(PROVISIONAL_AMOUNT_TOLERANCE.absolute.map((item) => [item.currency, item.minor])).toEqual(
      [
        ['EUR', 2_000n],
        ['GEL', 5_000n],
        ['USD', 2_000n],
      ],
    );
  });

  it('суммы хранятся целыми минорными единицами, а не числом', () => {
    for (const amount of PROVISIONAL_AMOUNT_TOLERANCE.absolute) {
      expect(typeof amount.minor).toBe('bigint');
    }
  });
});

describe('возрастные границы очереди разбора', () => {
  const base = { rankCurrency: 'GEL' as const, rationaleDocRef: DOC };

  it('нижняя граница выше верхней — отказ на записи настройки', () => {
    expect(() =>
      queueAgeBands({ ...base, escalationAfterMs: [24 * HOUR, 4 * HOUR] }),
    ).toThrowError(LimitsErrorCode.ageBandsNotAscending);
  });

  it('две одинаковые границы — тоже отказ: уровень выбирался бы порядком массива', () => {
    expect(() =>
      queueAgeBands({ ...base, escalationAfterMs: [4 * HOUR, 4 * HOUR] }),
    ).toThrowError(LimitsErrorCode.ageBandsNotAscending);
  });

  it('дробная граница — отказ: единица времени целая', () => {
    expect(() => queueAgeBands({ ...base, escalationAfterMs: [1.5] })).toThrowError(
      LimitsErrorCode.ageBandNotPositiveInteger,
    );
  });

  it('нулевая и отрицательная границы — отказ', () => {
    expect(() => queueAgeBands({ ...base, escalationAfterMs: [0] })).toThrowError(
      LimitsErrorCode.ageBandNotPositiveInteger,
    );
    expect(() => queueAgeBands({ ...base, escalationAfterMs: [-1] })).toThrowError(
      LimitsErrorCode.ageBandNotPositiveInteger,
    );
  });

  it('ни одной границы — отказ: очередь без норматива не эскалирует никогда', () => {
    expect(() => queueAgeBands({ ...base, escalationAfterMs: [] })).toThrowError(
      LimitsErrorCode.ageBandsEmpty,
    );
  });

  it('валюта ранжирования не из перечня сделки — отказ, если перечень предъявлен', () => {
    expect(() =>
      queueAgeBands(
        { escalationAfterMs: [4 * HOUR], rankCurrency: 'USD', rationaleDocRef: DOC },
        dealCurrencyList(['GEL']),
      ),
    ).toThrowError(LimitsErrorCode.currencyNotAdmitted);
  });

  it('временное значение перенесено из комплаенса без изменения величин', () => {
    expect(PROVISIONAL_QUEUE_AGE_BANDS.escalationAfter.map((item) => item as number)).toEqual([
      4 * HOUR,
      24 * HOUR,
      72 * HOUR,
    ]);
    expect(PROVISIONAL_QUEUE_AGE_BANDS.rankCurrency).toBe('GEL');
  });
});

describe('порог значимости', () => {
  it('порог не в лари — отказ: норма названа в национальной валюте', () => {
    expect(() =>
      materialityThreshold({
        monthlyTurnover: money('USD', 900_000_000n),
        warnAtBp: 7_500,
        rationaleDocRef: DOC,
      }),
    ).toThrowError(LimitsErrorCode.currencyNotSettlement);
  });

  it('нулевой и отрицательный порог — отказ: значимо стало бы всё', () => {
    for (const minor of [0n, -1n]) {
      expect(() =>
        materialityThreshold({
          monthlyTurnover: money('GEL', minor),
          warnAtBp: 7_500,
          rationaleDocRef: DOC,
        }),
      ).toThrowError(LimitsErrorCode.amountNotPositive);
    }
  });

  it('предупреждение позже самого порога — отказ', () => {
    // Сигнал, который не успевает предупредить, — это не строгость, а
    // выключенный сигнал.
    expect(() =>
      materialityThreshold({
        monthlyTurnover: money('GEL', 900_000_000n),
        warnAtBp: 10_001,
        rationaleDocRef: DOC,
      }),
    ).toThrowError(LimitsErrorCode.shareOutOfRange);
  });

  it('предупреждение при нулевом обороте — отказ', () => {
    expect(() =>
      materialityThreshold({
        monthlyTurnover: money('GEL', 900_000_000n),
        warnAtBp: 0,
        rationaleDocRef: DOC,
      }),
    ).toThrowError(LimitsErrorCode.shareOutOfRange);
  });

  it('временное значение: норма внешняя, доля предупреждения наша', () => {
    expect(PROVISIONAL_MATERIALITY_THRESHOLD.monthlyTurnover.minor).toBe(900_000_000n);
    expect(PROVISIONAL_MATERIALITY_THRESHOLD.monthlyTurnover.currency).toBe('GEL');
    expect(PROVISIONAL_MATERIALITY_THRESHOLD.warnAtBp).toBe(7_500);
  });
});
