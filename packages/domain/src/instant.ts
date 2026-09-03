import { DomainError, RejectionCode } from './result';

/** Момент времени в миллисекундах эпохи. Целое: время в домене не дробное. */
export type Instant = number & { readonly __instant: unique symbol };

export function instant(epochMilliseconds: number): Instant {
  if (!Number.isSafeInteger(epochMilliseconds)) {
    throw new DomainError(RejectionCode.invalidInstant);
  }
  return epochMilliseconds as Instant;
}

export type DurationMs = number & { readonly __duration: unique symbol };

export function duration(milliseconds: number): DurationMs {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new DomainError(RejectionCode.invalidInstant);
  }
  return milliseconds as DurationMs;
}

export const HOUR = duration(60 * 60 * 1000);
export const DAY = duration(24 * 60 * 60 * 1000);

export function plus(at: Instant, span: DurationMs): Instant {
  return instant(at + span);
}

/**
 * Дедлайн — часть состояния, а не поле рядом с ним: нетерминальное состояние
 * без дедлайна не должно собираться (FUNCTIONAL.md инвариант 7).
 */
export interface Deadline {
  readonly at: Instant;
}

export function deadline(at: Instant): Deadline {
  return Object.freeze({ at });
}

export function isPast(value: Deadline, now: Instant): boolean {
  return value.at <= now;
}
