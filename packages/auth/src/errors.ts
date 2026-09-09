/** Технические ключи ошибок для разработчика. Не пользовательский текст. */
export const AuthErrorCode = {
  accountIdInvalid: 'auth.account_id.invalid',
  personIdInvalid: 'auth.person_id.invalid',
  sessionIdInvalid: 'auth.session_id.invalid',
  challengeIdInvalid: 'auth.challenge_id.invalid',
  fingerprintInvalid: 'auth.fingerprint.invalid',
  capabilityNotGranted: 'auth.capability.not_granted',
  durationInvalid: 'auth.duration.invalid',
  /**
   * Число подписей ступени вне {1, 2}. Ноль — первый и главный случай:
   * «ноль утверждений» это не порог, а его отсутствие (`ACTORS.md` §6.10, И16.5).
   */
  approvalRequirementInvalid: 'auth.approval_requirement.invalid',
  /** Сверка перечней ролей запрошена по пустому перечню — сверять нечего. */
  legacyRoleListEmpty: 'auth.legacy.role_list_empty',
  /**
   * Роли доступа нет соответствия в перечне ролей журнала (`AUDIT_ROLES`,
   * восемь значений против двенадцати плюс двух здесь — `ACTORS.md` §13).
   * Запись журнала без актора невозможна, поэтому это отказ, а не подстановка
   * похожей роли: `principal`, записанный как `operator`, — ложь в журнале,
   * который не редактируется (красная линия №11).
   */
  auditRoleUnmapped: 'auth.audit.role_unmapped',
  /** Смена роли на ту же самую: сменой не является и в журнал не пишется. */
  roleChangeIsNoop: 'auth.role_change.is_noop',
  /**
   * Боевой режим без боевого адаптера канала доставки кода. Отказ на старте, а
   * не откат к печати кода в журнал процесса: заглушка в бою — дыра, которую не
   * видно ни по экрану, ни по тестам (`delivery.ts`).
   */
  codeDeliveryAdapterMissing: 'auth.code_delivery.adapter_missing',
  /** Отладочный канал собран в боевом режиме. Собираться он там не имеет права. */
  codeDeliveryNotForProduction: 'auth.code_delivery.not_for_production',
  /** Ключ вывода кода короче допустимого. Значение ключа в детали не попадает. */
  codeKeyTooShort: 'auth.code_key.too_short',
  /** Длина кода вне допустимого: слишком короткий подбирается, длинный не вводится. */
  codeLengthInvalid: 'auth.code.length_invalid',
  /** Отпечаток HMAC оказался короче, чем требует усечение. Недостижимо у SHA-256. */
  codeDerivationFailed: 'auth.code.derivation_failed',
  /**
   * Единственный способ дойти сюда — расширить перечень значением и не разобрать
   * его в месте разбора. Компилятор ловит это раньше; исключение остаётся на
   * случай, когда значение пришло из-за границы процесса (база, HTTP).
   */
  unreachable: 'auth.unreachable',
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: AuthErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Разбор, обязанный быть полным. Значение типа `never` в аргументе означает, что
 * компилятор доказал: сюда не приходит ничего. Расширение перечня ломает вызов —
 * это и есть требование «добавление права ломает компиляцию в местах разбора».
 */
export function assertExhausted(value: never): never {
  throw new AuthError(AuthErrorCode.unreachable, { value: String(value) });
}
