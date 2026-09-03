/**
 * Технические ключи ошибок для разработчика. Не пользовательский текст:
 * формулировки для клиента живут в словарях локализации (CLAUDE.md, «Три языка»).
 */
export const AuditErrorCode = {
  hashInvalid: 'audit.hash.invalid',
  instantInvalid: 'audit.instant.invalid',
  canonicalUnsupportedValue: 'audit.canonical.unsupported_value',
  canonicalNonIntegerNumber: 'audit.canonical.non_integer_number',
  canonicalCycle: 'audit.canonical.cycle',
  canonicalTooDeep: 'audit.canonical.too_deep',
  tokenInvalid: 'audit.token.invalid',
  currencyInvalid: 'audit.currency.invalid',
  rawIdentifier: 'audit.value.raw_identifier',
  policyRefInvalid: 'audit.policy_ref.invalid',
  chainEmpty: 'audit.chain.empty',
  chainIdMismatch: 'audit.chain.id_mismatch',
  recordIdDuplicate: 'audit.record.id_duplicate',
  recordTimeRegression: 'audit.record.time_regression',
  correctionTargetMissing: 'audit.correction.target_missing',
  correctionSelfReference: 'audit.correction.self_reference',
  timestampTargetMissing: 'audit.timestamp.target_missing',
  rawSourceByteLengthInvalid: 'audit.raw_source.byte_length_invalid',
} as const;

export type AuditErrorCode = (typeof AuditErrorCode)[keyof typeof AuditErrorCode];

/**
 * Детали ошибки — только строки, и только те, что заведомо не персональные
 * данные: путь до поля, имя правила, вид записи. Само значение в детали не
 * кладём никогда (дисциплина `compliance/src/pii.ts`): если проверка сработала,
 * значение с высокой вероятностью и есть номер документа или реквизиты, и
 * попадание его в лог — ровно та утечка, которую проверка предотвращает.
 */
export class AuditError extends Error {
  readonly code: AuditErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: AuditErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'AuditError';
    this.code = code;
    this.details = details;
  }
}
