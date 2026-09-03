/**
 * Коды ошибок — технические ключи для разработчика, не текст для клиента.
 * Пользовательские формулировки живут в словарях локализации (см. CLAUDE.md, «Три языка»).
 */
export const MoneyErrorCode = {
  currencyMismatch: 'money.currency_mismatch',
  unknownCurrency: 'money.unknown_currency',
  parseFormat: 'money.parse.format',
  parseTooManyFractionDigits: 'money.parse.too_many_fraction_digits',
  rationalZeroDenominator: 'money.rational.zero_denominator',
  negativeAmount: 'money.negative_amount',
  splitDeductionsExceedTotal: 'money.split.deductions_exceed_total',
  splitNegativeDeduction: 'money.split.negative_deduction',
  splitDuplicateKey: 'money.split.duplicate_key',
  allocateNoWeights: 'money.allocate.no_weights',
  allocateNegativeWeight: 'money.allocate.negative_weight',
  allocateRemainderIndexOutOfRange: 'money.allocate.remainder_index_out_of_range',
  fxCurrencyMismatch: 'money.fx.currency_mismatch',
} as const;

export type MoneyErrorCode = (typeof MoneyErrorCode)[keyof typeof MoneyErrorCode];

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: MoneyErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'MoneyError';
    this.code = code;
    this.details = details;
  }
}
