/** Редьюсер не бросает исключений: отказ — это значение, которое обязан разобрать вызывающий. */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function failure<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Технические коды отказа. Пользовательские формулировки — в словарях локализации. */
export const RejectionCode = {
  transitionNotAllowed: 'domain.transition.not_allowed',
  guardFailed: 'domain.guard.failed',
  terminalState: 'domain.state.terminal',
  releaseConditionRequiresConfirmation: 'domain.release_condition.requires_confirmation',
  releaseConditionUnknown: 'domain.release_condition.unknown',
  /** Акт получателя об условии подменён у транша, где деньги уже приняты (Ф13). */
  conditionActSubstituted: 'domain.condition_act.substituted',
  /** Нетерминальное состояние после `pending` собрано без акта (Ф13). */
  conditionActMissing: 'domain.condition_act.missing',
  /**
   * Целевое состояние разморозки недопустимо для того статуса, из которого
   * заморозили (CORE.md Ф17). Отдельный код, а не «переход запрещён»: разница
   * между «так нельзя вообще» и «так нельзя из этой заморозки» — это разница
   * между ошибкой вызывающего и решением, которое оператору надо переиграть.
   */
  unfreezeTargetNotAllowed: 'domain.unfreeze.target_not_allowed',
  invalidInstant: 'domain.instant.invalid',
  invalidUuid: 'domain.uuid.invalid',
} as const;

export type RejectionCode = (typeof RejectionCode)[keyof typeof RejectionCode];

export interface Rejection {
  readonly code: RejectionCode;
  readonly failedGuards: readonly string[];
  readonly details: Readonly<Record<string, string>>;
}

export function rejection(
  code: RejectionCode,
  failedGuards: readonly string[] = [],
  details: Readonly<Record<string, string>> = {},
): Rejection {
  return Object.freeze({ code, failedGuards: Object.freeze([...failedGuards]), details });
}

export class DomainError extends Error {
  readonly code: RejectionCode;

  constructor(code: RejectionCode, message: string = code) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
