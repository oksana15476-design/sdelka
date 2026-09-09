import { ConfigErrorCode } from './errors.ts';
import { Presence, presenceOf } from './presence.ts';
import { findEnvVariable } from './registry.ts';

/**
 * Печать строки подключения без пароля.
 *
 * Строку подключения печатать иногда надо: «к какой базе я подключился» —
 * законный вопрос дежурного, и хост с именем базы на него отвечают. Пароль на
 * него не отвечает никогда, а попадает при этом в журнал, в сборщик логов и в
 * скриншот в переписке (красная линия №12).
 *
 * Пароль в строке подключения лежит в двух местах, и оба закрываются здесь:
 * в части пользователя (`user:pass@host`) и в параметрах запроса
 * (`?password=...`) — второе забывают чаще, потому что первое видно глазом.
 */

/** Чем заменяется пароль. Постоянная длина: длина пароля — тоже сведение о нём. */
export const REDACTED = '***';

/** Параметры запроса, значение которых не печатается никогда. */
const SECRET_PARAMS: readonly string[] = Object.freeze([
  'password',
  'passfile',
  'sslpassword',
  'sslkey',
]);

/**
 * Строка, которую нельзя разобрать, **не печатается вовсе**.
 *
 * Соблазн вернуть её как есть («всё равно не понял, что это») — это ровно
 * способ напечатать пароль: формат `host=… password=…` (keyword/value) —
 * законная строка подключения Postgres, и `URL` её не разбирает.
 */
export const UNPARSABLE = ConfigErrorCode.redactUnparsable;

export function redactConnectionString(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return UNPARSABLE;
  }

  const password = url.password;
  if (password.length > 0) url.password = REDACTED;
  for (const param of SECRET_PARAMS) {
    if (url.searchParams.has(param)) url.searchParams.set(param, REDACTED);
  }

  const printed = url.toString();

  /*
   * Проверка после сборки, а не вместо неё. Замена идёт через `URL`, но печатает
   * строку тоже `URL`, и если он когда-нибудь вернёт исходное значение обратно
   * (иная нормализация, иная версия), молчаливая утечка пароля станет
   * незаметной. Дешевле не печатать ничего.
   */
  if (password.length > 0 && printed.includes(password)) return UNPARSABLE;
  return printed;
}

/**
 * Строка подключения из окружения, готовая к печати. `null`, если переменной
 * нет или она пуста, — печатать нечего, и придумывать нечего.
 */
export function redactedDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = findEnvVariable('SDELKA_DATABASE_URL').name;
  if (presenceOf(env, name) !== Presence.present) return null;
  return redactConnectionString(env[name] as string);
}
