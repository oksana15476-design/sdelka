/**
 * Технические ключи ошибок для разработчика. Не пользовательский текст.
 *
 * Граница та же, что в `@sdelka/settings`: **бросают** здесь только испорченные
 * величины — тариф, который вообще не является тарифом (ставка дробная, доли
 * сплита не сходятся, наценка выше потолка). Отказ по конкретной сделке —
 * значение (`Result` и `PRICING_REFUSAL_KEYS` в `keys.ts`), потому что он
 * приходится на живой транш и вызывающий обязан его разобрать.
 */
export const PricingErrorCode = {
  /**
   * Ставка задана не целым числом базисных пунктов. Дробное значение здесь —
   * это плавающая точка, зашедшая в денежный домен через настройку
   * (красная линия №4): `0.1 + 0.2` в базисных пунктах даёт ставку, которая не
   * равна себе после сохранения и чтения.
   */
  rateNotInteger: 'pricing.rate.not_integer',
  /** Ставка вне `0…10 000` базисных пунктов: доля меньше нуля или больше единицы. */
  rateOutOfRange: 'pricing.rate.out_of_range',
  /** Ставка выше потолка удержания этого же плана (`SETTINGS.md` §9 п.6). */
  rateAboveCeiling: 'pricing.rate.above_ceiling',
  /** Фиксированная часть, минимум или максимум отрицательны. */
  amountNegative: 'pricing.amount.negative',
  /** Минимум больше максимума: коридор, которого не существует. */
  minimumAboveMaximum: 'pricing.amount.minimum_above_maximum',
  /** Плательщик комиссии вне закрытого перечня. */
  feePayerUnknown: 'pricing.fee_payer.unknown',
  /**
   * Доли сплита в сумме не равны 100 %. Не «почти сто» и не «сто с запасом»:
   * недобор — молчаливая потеря нашей выручки, перебор — молчаливый лишний
   * рубль с клиентов (`SETTINGS.md` §9 п.8).
   */
  splitSharesNotWhole: 'pricing.split.shares_not_whole',
  /** Наценка задана не целым числом базисных пунктов. */
  markupNotInteger: 'pricing.markup.not_integer',
  /** Наценка вне допустимого диапазона: отрицательная или выше потолка. */
  markupOutOfRange: 'pricing.markup.out_of_range',
  /** Потолок наценки сам вне `0…10 000` базисных пунктов. */
  markupCapOutOfRange: 'pricing.markup.cap_out_of_range',
  /** Наценка объявлена парой, у которой обе валюты совпадают. */
  markupPairInvalid: 'pricing.markup.pair_invalid',
  /** В расписании наценок одна пара объявлена дважды. */
  markupPairDuplicated: 'pricing.markup.pair_duplicated',
  /** Наценка применена не к своей паре валют. */
  markupPairMismatch: 'pricing.markup.pair_mismatch',
  /** Сумма сделки в одной валюте, а фиксированная часть тарифа — в другой. */
  currencyMismatch: 'pricing.currency.mismatch',
  /** Сумма сделки отрицательна: тарифицировать нечего. */
  principalNegative: 'pricing.principal.negative',
} as const;

export type PricingErrorCode = (typeof PricingErrorCode)[keyof typeof PricingErrorCode];

export class PricingError extends Error {
  readonly code: PricingErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: PricingErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'PricingError';
    this.code = code;
    this.details = details;
  }
}
