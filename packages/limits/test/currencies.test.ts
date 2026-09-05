import { describe, expect, it } from 'vitest';
import {
  type CurrencyReadiness,
  LIMITS_REFUSAL_KEYS,
  LimitsErrorCode,
  PROVISIONAL_DEAL_CURRENCIES,
  admitDealCurrency,
  admitsCurrency,
  dealCurrencyList,
  unmetPreconditions,
  withdrawDealCurrency,
} from '../src/index';

function readiness(overrides: Partial<CurrencyReadiness> = {}): CurrencyReadiness {
  return {
    currency: 'USD',
    nominalAccountOpened: true,
    statementReconciliationRunning: true,
    officialRateObserved: true,
    toleranceDeclared: true,
    markupDeclared: true,
    ...overrides,
  };
}

describe('перечень валют сделки — величина с границами, а не массив', () => {
  it('пустой перечень не собирается: продукта без валюты сделки не существует', () => {
    expect(() => dealCurrencyList([])).toThrowError(LimitsErrorCode.currencyListEmpty);
  });

  it('перечень без лари не собирается', () => {
    // Не «узкий продукт», а продукт, которого не существует: расчёт по
    // недвижимости в Грузии возможен только в национальной валюте.
    expect(() => dealCurrencyList(['USD'])).toThrowError(
      LimitsErrorCode.settlementCurrencyMissing,
    );
  });

  it('одна валюта дважды — отказ, а не «дважды включена»', () => {
    expect(() => dealCurrencyList(['GEL', 'USD', 'USD'])).toThrowError(
      LimitsErrorCode.currencyDuplicated,
    );
  });

  it('неизвестный код не проходит и из хранилища: типы границу процесса не переживают', () => {
    expect(() => dealCurrencyList(['GEL', 'GBP'])).toThrow();
  });

  it('порядок канонизирован: два одинаковых перечня не различаются перестановкой', () => {
    expect(dealCurrencyList(['USD', 'GEL', 'EUR']).codes).toEqual(['EUR', 'GEL', 'USD']);
  });

  it('временное значение содержит ровно то, что установлено, — лари', () => {
    expect(PROVISIONAL_DEAL_CURRENCIES.codes).toEqual(['GEL']);
  });
});

describe('включение валюты: пять предпосылок, каждая — отказ, а не предупреждение', () => {
  const cases: readonly (readonly [keyof CurrencyReadiness, string])[] = [
    ['nominalAccountOpened', LIMITS_REFUSAL_KEYS.nominalAccountMissing],
    ['statementReconciliationRunning', LIMITS_REFUSAL_KEYS.reconciliationMissing],
    ['officialRateObserved', LIMITS_REFUSAL_KEYS.officialRateMissing],
    ['toleranceDeclared', LIMITS_REFUSAL_KEYS.toleranceNotDeclared],
    ['markupDeclared', LIMITS_REFUSAL_KEYS.markupNotDeclared],
  ];

  for (const [field, expected] of cases) {
    it(`нет предпосылки «${field}» — отказ с названной причиной`, () => {
      const result = admitDealCurrency(
        PROVISIONAL_DEAL_CURRENCIES,
        readiness({ [field]: false } as Partial<CurrencyReadiness>),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(expected);
    });
  }

  it('невыполненные предпосылки перечисляются все сразу — для экрана владельца', () => {
    expect(
      unmetPreconditions(readiness({ nominalAccountOpened: false, markupDeclared: false })),
    ).toEqual([LIMITS_REFUSAL_KEYS.nominalAccountMissing, LIMITS_REFUSAL_KEYS.markupNotDeclared]);
  });

  it('все пять выполнены — валюта входит в перечень, старый перечень не меняется', () => {
    const before = PROVISIONAL_DEAL_CURRENCIES;
    const result = admitDealCurrency(before, readiness());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.codes).toEqual(['GEL', 'USD']);
    expect(before.codes).toEqual(['GEL']);
  });

  it('повторное включение — отказ: это не изменение, а шум в журнале', () => {
    const result = admitDealCurrency(PROVISIONAL_DEAL_CURRENCIES, readiness({ currency: 'GEL' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(LIMITS_REFUSAL_KEYS.currencyAlreadyAdmitted);
  });
});

describe('выключение валюты', () => {
  const both = dealCurrencyList(['GEL', 'USD']);

  it('по валюте есть открытые позиции — выключить нельзя, причина названа', () => {
    const result = withdrawDealCurrency(both, 'USD', 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(LIMITS_REFUSAL_KEYS.currencyHasOpenPositions);
  });

  it('открытых позиций нет — валюта выходит из перечня', () => {
    const result = withdrawDealCurrency(both, 'USD', 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.codes).toEqual(['GEL']);
    expect(admitsCurrency(both, 'USD')).toBe(true);
  });

  it('лари не выключается никогда, даже при нулевых позициях', () => {
    const result = withdrawDealCurrency(both, 'GEL', 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(LIMITS_REFUSAL_KEYS.settlementCurrencyLocked);
  });

  it('валюты нет в перечне — выключать нечего', () => {
    const result = withdrawDealCurrency(both, 'EUR', 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(LIMITS_REFUSAL_KEYS.currencyNotAdmitted);
  });

  it('дробное число открытых позиций — испорченный вызов, а не отказ', () => {
    // Позиций не бывает полторы: дробь здесь означает, что кто-то посчитал их
    // долей от чего-то, и продолжать по такому числу нельзя.
    expect(() => withdrawDealCurrency(both, 'USD', 1.5)).toThrowError(
      LimitsErrorCode.openPositionsInvalid,
    );
  });
});
