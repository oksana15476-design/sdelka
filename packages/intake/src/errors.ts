/**
 * Коды ошибок — технические ключи для разработчика, не текст для клиента.
 * Пользовательские формулировки живут в словарях трёх языков (`CLAUDE.md`).
 */
export const IntakeErrorCode = {
  policyVersionInvalid: 'intake.policy_version.invalid',
  basisPointsOutOfRange: 'intake.basis_points.out_of_range',
  toleranceNegative: 'intake.tolerance.negative',
  amountNegative: 'intake.amount.negative',
  currencyMismatch: 'intake.currency.mismatch',
  referenceAlphabet: 'intake.reference.alphabet',
  referenceEmptySegment: 'intake.reference.empty_segment',
  quoteTtlInvalid: 'intake.quote.ttl_invalid',
  quoteSameCurrency: 'intake.quote.same_currency',
  weightsNotHundred: 'intake.matching.weights_not_hundred',
} as const;

export type IntakeErrorCode = (typeof IntakeErrorCode)[keyof typeof IntakeErrorCode];

export class IntakeError extends Error {
  readonly code: IntakeErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: IntakeErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'IntakeError';
    this.code = code;
    this.details = details;
  }
}
