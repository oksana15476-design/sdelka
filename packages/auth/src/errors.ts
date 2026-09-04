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
