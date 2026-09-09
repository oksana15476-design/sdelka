import { AuthError, AuthErrorCode } from './errors';

/**
 * Требования к ключу и к длине одноразового кода — **без крипты**.
 *
 * Вынесено из `code.ts` не для красоты. `code.ts` импортирует `node:crypto`, и
 * этого достаточно, чтобы весь пакет стал непригоден для сред без Node: сборщик
 * приложения тянет модуль по цепочке из общего входа пакета, а среда `edge`
 * схему `node:` не понимает вовсе — сборка падает целиком (`apps/web`,
 * `instrumentation.ts` собирается для обеих сред).
 *
 * Здесь поэтому лежит то, что нужно **проверке настройки на старте**: длина
 * ключа и допустимая длина кода. Сам вывод кода — в `code.ts`, и его берут
 * отдельным входом `@sdelka/auth/code` там, где Node точно есть.
 */

/**
 * Минимальная длина ключа вывода кода.
 *
 * Не украшение: ключ короче тридцати двух знаков перебирается быстрее, чем окно
 * жизни вызова, и тогда вся схема сводится к «код угадать нельзя, зато можно
 * вычислить».
 */
export const CODE_KEY_MIN_LENGTH = 32;

/**
 * Ключ годен. Значение ключа в отказ не попадает никогда — только длина
 * требования (красная линия №12).
 */
export function assertCodeKey(key: string): void {
  if (key.length < CODE_KEY_MIN_LENGTH) {
    throw new AuthError(AuthErrorCode.codeKeyTooShort, { minimum: String(CODE_KEY_MIN_LENGTH) });
  }
}

/**
 * Длина кода. Снизу — подбор становится дешевле окна жизни вызова; сверху —
 * код перестают вводить и начинают копировать целиком из сообщения, а это уже
 * не второй канал, а первый.
 */
export function assertCodeLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 4 || length > 9) {
    throw new AuthError(AuthErrorCode.codeLengthInvalid, { length: String(length) });
  }
}
