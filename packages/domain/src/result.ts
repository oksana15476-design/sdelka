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
  /**
   * Тип условия подтверждён владельцем, но наблюдения требуемого уровня от его
   * источника не производит никто (`release-condition.ts`, `calendar_date`).
   *
   * Отдельный код, а не `releaseConditionRequiresConfirmation`: там ждут
   * решения владельца, здесь — кода. Один отказ на две причины оставил бы
   * оператора без ответа на вопрос «чего ждать».
   */
  releaseConditionSourceUnavailable: 'domain.release_condition.source_unavailable',
  /** Акт получателя об условии подменён у транша, где деньги уже приняты (Ф13). */
  conditionActSubstituted: 'domain.condition_act.substituted',
  /** Нетерминальное состояние после `pending` собрано без акта (Ф13). */
  conditionActMissing: 'domain.condition_act.missing',
  /**
   * Пакет доказательств у события `condition_established` не тот, что в фактах
   * транша (красная линия №5, `ORACLE.md` §6.5).
   *
   * Отдельный код, а не отказ guard'а: guard отвечает «доказательств нет», а
   * здесь они есть — просто их два разных, и это расхождение данных, которое
   * обязано быть видно оператору отдельной строкой. Намерения выпуска поручения
   * берут ссылку **из фактов**, поэтому молчаливое расхождение означало бы, что
   * журнал аудита и guard говорят о разных пакетах.
   */
  evidenceBundleSubstituted: 'domain.evidence_bundle.substituted',
  /**
   * Тип условия у события не совпадает с типом в акте получателя (красная линия
   * №6, `CORE.md` Ф13, `ORACLE.md` §6.5). Условие определяет получатель;
   * подменить его тип событием нельзя.
   */
  conditionTypeSubstituted: 'domain.condition_type.substituted',
  /** Наблюдение оракула собрано без обязательной части (Ф11, `ORACLE.md` §4). */
  observationInvalid: 'domain.observation.invalid',
  /**
   * Факты счёта не называют владельца свободного остатка, поэтому разрешение на
   * внутреннее движение (`ROADMAP.md` И12.4) не выдаётся.
   *
   * Отдельный код, а не отказ guard'а: guard отвечает «остатка не хватает», а
   * здесь неизвестно, **чей** это остаток, — то есть проверять было нечего.
   * Разница между «мало денег» и «непонятно, чьи деньги» — это разница между
   * ответом клиенту и ошибкой вызывающего.
   */
  allocationOwnerUnknown: 'domain.allocation.owner_unknown',
  /**
   * Разрешение на внутреннее движение предъявлено не тому траншу, не тому
   * плательщику или не на ту сумму (`ROADMAP.md` И12.4).
   *
   * Тот же приём, что у `settlementAttestationMismatch` в учёте: одно выданное
   * разрешение не открывает движение по чему угодно. Без сверки разрешение,
   * полученное на сделку Б, годилось бы для сделки В — а вместе с ним и
   * пропуск зачисления, то есть транш В принял бы деньги, которых на счёте
   * клиента для него нет.
   */
  allocationNotAuthorized: 'domain.allocation.not_authorized',
  /**
   * Целевое состояние разморозки недопустимо для того статуса, из которого
   * заморозили (CORE.md Ф17). Отдельный код, а не «переход запрещён»: разница
   * между «так нельзя вообще» и «так нельзя из этой заморозки» — это разница
   * между ошибкой вызывающего и решением, которое оператору надо переиграть.
   */
  unfreezeTargetNotAllowed: 'domain.unfreeze.target_not_allowed',
  /**
   * Удержание превышает потолок ставки (`tariff.ts`, эпик E16). Отдельный код,
   * а не «сумма неверна»: «удержали больше, чем сумма» ловит `@sdelka/money`, а
   * здесь величина арифметически законна и всё равно недопустима.
   */
  feeExceedsCeiling: 'domain.fee.exceeds_ceiling',
  /** Сам потолок задан величиной, которой не существует: отрицательной или больше единицы. */
  feeCeilingInvalid: 'domain.fee_ceiling.invalid',
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
