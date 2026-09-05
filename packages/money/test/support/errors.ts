import { expect } from 'vitest';
import { MoneyError, type MoneyErrorCode } from '../../src/index';

/**
 * Утверждение об **отказе с конкретным кодом**, а не о классе исключения.
 *
 * `toThrow(MoneyError)` в денежном ядре почти всегда истинно по построению:
 * рядом с каждой проверкой стоит соседняя, ловящая тот же вход другим кодом.
 * Снятие проверки «отрицательное удержание» переводит вход на проверку
 * «удержания больше суммы», снятие «пустых весов» — на «индекс остатка вне
 * диапазона», и тест остаётся зелёным, хотя запрет исчез. Поэтому здесь
 * утверждается код, а где проверки различаются только пояснением — ещё и
 * `details`.
 */
export function expectMoneyError(
  run: () => unknown,
  code: MoneyErrorCode,
  details?: Readonly<Record<string, string>>,
): MoneyError {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyError);
    const moneyError = error as MoneyError;
    expect(moneyError.code).toBe(code);
    if (details !== undefined) {
      expect(moneyError.details).toEqual(details);
    }
    return moneyError;
  }
  throw new Error('unreachable');
}
