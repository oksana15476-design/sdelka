import {
  type CodeDeliveryPort,
  type DeliveryMode,
  assertCodeKey,
  isDeliveryMode,
  resolveCodeDelivery,
} from '@sdelka/auth';

/**
 * Настройка входа: **единственное место, где читается окружение**, и оно
 * намеренно не знает про базу.
 *
 * ## Почему это отдельный файл, а не часть `auth-runtime.ts`
 *
 * Настройку читает проверка готовности (`health/probe.ts`), а она обязана
 * обходиться без драйвера базы: файл, из которого достижим `pg`, тянет за собой
 * `dns`, `net` и `fs`, и сборка среды `edge` от этого падает целиком — ровно так
 * упала первая попытка поставить ворота в `instrumentation.ts` (Next собирает
 * его для обеих сред). Проверка имени среды внутри файла от этого не спасает:
 * она решает, что **выполнится**, а собирается всё равно всё.
 *
 * Спасает граница: здесь проверяется то, что проверяется без сети, — режим,
 * ключ и наличие боевого адаптера канала, — а хранилище собирается там, где оно
 * и нужно (`auth-runtime.ts`).
 *
 * ## Секретов здесь нет
 *
 * Ни одно значение не печатается ни в отказ, ни в журнал: наружу уходят только
 * имена переменных (красная линия №12). Ключ вывода кода живёт в замыкании
 * `CodeDerivation` и процесс не покидает.
 */

/**
 * Режим канала доставки одноразового кода: `development` | `production`.
 *
 * Обязательная и без умолчания. Умолчание означало бы, что забывший её
 * развернуть получает **работающий с виду вход**, в котором код печатается в
 * журнал процесса. Тот же признак решает, ставится ли у куки сессии `Secure`:
 * локальный сервер работает по `http`, и кука с `Secure` там не ставится вовсе.
 */
export const AUTH_MODE_ENV = 'SDELKA_AUTH_MODE';

/**
 * Ключ вывода одноразового кода. Секрет: кода нет ни в базе, ни в журнале — он
 * выводится из вызова этим ключом (`auth/src/code.ts`).
 */
export const AUTH_CODE_KEY_ENV = 'SDELKA_AUTH_CODE_KEY';

/** Технические ключи отказов сборки. Не пользовательский текст: три языка. */
export const RUNTIME_FAULT = {
  modeMissing: 'web.auth.mode_missing',
  modeInvalid: 'web.auth.mode_invalid',
  codeKeyMissing: 'web.auth.code_key_missing',
} as const;

function requiredEnv(name: string, fault: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    // В отказе — имя переменной и только оно.
    throw new Error(`${fault} variable=${name}`);
  }
  return value;
}

export function deliveryMode(): DeliveryMode {
  const raw = requiredEnv(AUTH_MODE_ENV, RUNTIME_FAULT.modeMissing);
  if (!isDeliveryMode(raw)) {
    // Значение переменной не секрет, но печатать его незачем: перечень
    // допустимого известен, а неизвестное значение — опечатка в развёртке.
    throw new Error(`${RUNTIME_FAULT.modeInvalid} variable=${AUTH_MODE_ENV}`);
  }
  return raw;
}

/**
 * Ключ вывода кода. Годность проверяется здесь же и **без крипты**:
 * `assertCodeKey` живёт в общем входе пакета, а сам вывод — в
 * `@sdelka/auth/code`, куда среде `edge` дороги нет.
 */
export function codeKey(): string {
  const key = requiredEnv(AUTH_CODE_KEY_ENV, RUNTIME_FAULT.codeKeyMissing);
  assertCodeKey(key);
  return key;
}

/**
 * Боевой адаптер канала доставки. **Его нет ни одного.**
 *
 * Это не заглушка и не «пока так»: канал — отдельная интеграция, и по правилам
 * проекта у неё сначала дизайн-док и груминг, потом код (`CLAUDE.md`,
 * «Интеграции — отдельная проработка логики до кода»). Пока его нет, боевой
 * режим не поднимается, и это единственное честное поведение: печатать код в
 * журнал процесса в бою — дыра, которой не видно ни по экрану, ни по тестам.
 */
function productionAdapter(): CodeDeliveryPort | null {
  return null;
}

export function codeDelivery(): CodeDeliveryPort {
  return resolveCodeDelivery({
    mode: deliveryMode(),
    adapter: productionAdapter(),
    // Отладочный канал печатает код в журнал процесса. Собрать его в боевом
    // режиме нельзя — `resolveCodeDelivery` до этой строки не дойдёт.
    sink: (line: string) => {
      console.warn(line);
    },
  });
}

/**
 * Ворота старта. Ничего не чинят и ничего не подставляют: либо вход настроен,
 * либо процесс не поднимается.
 *
 * Что проверяется: режим назван и назван допустимо, ключ вывода кода есть и не
 * короче допустимого, канал в боевом режиме имеет боевой адаптер. Чего **не**
 * проверяется: доступность базы — это состояние, а не настройка, и о нём
 * отвечает `/health`.
 */
export function assertAuthConfig(): void {
  codeDelivery();
  codeKey();
}
