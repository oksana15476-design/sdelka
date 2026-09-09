/**
 * Технические ключи отказов засева. Не пользовательский текст: формулировки для
 * клиента живут в словарях локализации (`CLAUDE.md`, «Три языка»).
 *
 * Отдельный род ошибки, а не новый `DbErrorCode`: `DbError` называет то, что
 * ответила **база**, и дежурный читает его как отказ схемы. Засев отказывает по
 * своим правилам — на живой базе он работать не должен, — и смешивать эти два
 * рода означало бы, что «в базе есть настоящие данные» выглядит как отказ
 * драйвера.
 */
export const SeedErrorCode = {
  /**
   * В базе есть строки, которых засев не клал. Признак — начало идентификатора
   * (`SEED_PREFIX`), а не количество строк: см. `guard.ts`.
   */
  foreignData: 'seed.refused.foreign_data',
  /**
   * Сделка сценария лежит **не** в том положении, до которого её доводит засев:
   * оборванный прогон либо кто-то двигал засеянную сделку дальше. Дописывать
   * сюда нечего — шаг мира идёт из состояния в состояние.
   */
  diverged: 'seed.refused.diverged',
  /** После засева не сошлась проверка: журнал, покрытие или цепочка. */
  verificationFailed: 'seed.verify.failed',
} as const;

export type SeedErrorCode = (typeof SeedErrorCode)[keyof typeof SeedErrorCode];

export class SeedError extends Error {
  readonly code: SeedErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: SeedErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'SeedError';
    this.code = code;
    this.details = details;
  }
}
