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
  /** Предъявленные байты не сходятся с записанной ссылкой: длиной или отпечатком. */
  rawSourceNotAttested: 'audit.raw_source.not_attested',
  /**
   * Субъект записи не той природы, что её вид: вход, отказ во входе и смена
   * роли — про учётную запись, изменение настройки — про настройку. Запись о
   * входе, поданная под сделкой, сделала бы выборку по субъекту ложью.
   */
  subjectScopeMismatch: 'audit.record.subject_scope_mismatch',
  /** Ключ настройки в теле и в субъекте записи разошлись. */
  settingSubjectMismatch: 'audit.setting.subject_mismatch',
  /**
   * Настройка вводится в действие раньше, чем записана. `ROADMAP.md` И16.2:
   * пересчёт задним числом невозможен, а не запрещён правилом.
   */
  settingEffectiveFromBackdated: 'audit.setting.effective_from_backdated',
  /** Прежнее и новое значение настройки совпали: смены не было. */
  settingChangeIsNoop: 'audit.setting.change_is_noop',
  /** Прежняя и новая роль совпали: смены не было. */
  roleChangeIsNoop: 'audit.role_change.is_noop',
  /**
   * Роль выведена из употребления: под ней можно читать прежние записи, но
   * нельзя записать новую (`RETIRED_AUDIT_ROLES`). `approver` не говорит, какой
   * из двух уровней утверждения стоит за записью, и новая запись под ним была
   * бы той же неполнотой, ради устранения которой перечень и расщеплён.
   */
  auditRoleRetired: 'audit.role.retired',
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
