/** Технические ключи ошибок для разработчика. Не пользовательский текст. */
export const ComplianceErrorCode = {
  fingerprintInvalid: 'compliance.fingerprint.invalid',
  countryCodeInvalid: 'compliance.country_code.invalid',
  basisPointsOutOfRange: 'compliance.basis_points.out_of_range',
  nameObservationEmpty: 'compliance.name_observation.empty',
  policyVersionInvalid: 'compliance.policy_version.invalid',
  dualControlRequirementInvalid: 'compliance.dual_control.requirement_invalid',
  capabilityNotGranted: 'compliance.capability.not_granted',
  aggregateNegative: 'compliance.aggregate.negative',
  aggregateCurrencyMismatch: 'compliance.aggregate.currency_mismatch',
  aggregatePartsExceedTotal: 'compliance.aggregate.parts_exceed_total',
} as const;

export type ComplianceErrorCode = (typeof ComplianceErrorCode)[keyof typeof ComplianceErrorCode];

export class ComplianceError extends Error {
  readonly code: ComplianceErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: ComplianceErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'ComplianceError';
    this.code = code;
    this.details = details;
  }
}
