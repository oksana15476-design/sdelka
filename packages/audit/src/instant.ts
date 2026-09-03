import { AuditError, AuditErrorCode } from './errors';

/**
 * Момент времени в миллисекундах эпохи. Целое: время в журнале не дробное.
 *
 * Дубль `packages/domain/src/instant.ts` — вынужденный. Пакет аудита не зависит
 * ни от `domain`, ни от `compliance` намеренно: журнал обязан пережить любую
 * переделку домена, а зависимость в обратную сторону (домен пишет в журнал)
 * появится позже и не должна замкнуться в цикл. Источник истины по типу времени
 * — `@sdelka/domain`; при расхождении правится этот файл.
 */
export type AuditInstant = number & { readonly __auditInstant: unique symbol };

export function auditInstant(epochMilliseconds: number): AuditInstant {
  // Отрицательное время в журнале — это дата до 1970 года, то есть заведомо
  // подделанная запись «задним числом», а не значение из жизни.
  if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 0) {
    throw new AuditError(AuditErrorCode.instantInvalid);
  }
  return epochMilliseconds as AuditInstant;
}
