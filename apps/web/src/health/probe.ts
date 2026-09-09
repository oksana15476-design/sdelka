import {
  DbError,
  type Pool,
  createPool,
  databaseUrl,
  isDatabaseUnreachable,
  probeConnection,
  readAppliedMigrations,
} from '@sdelka/db';
import { assertAuthConfig } from '@/server/auth-config';
import { type AuthConfigState, type DbState, safeCode } from './state';

/**
 * Проба базы для проверки здоровья.
 *
 * Пул — один на процесс и **свой у драйвера тот же, что у остального
 * приложения** (`createPool`): у него заданы таймауты, разборщики типов и
 * запрет на плавающую точку (красная линия №4). Второй, «лёгкий» клиент для
 * проверки здоровья означал бы, что проверка ходит в базу не так, как ходит
 * приложение, — и молчит, когда приложению уже плохо.
 *
 * Проба спрашивает ровно два вопроса и оба дешёвые: `SELECT 1` со сроком
 * (`probeConnection`) и содержимое таблицы учёта миграций. Ни одного запроса к
 * денежным таблицам: проверка здоровья не имеет права нагружать базу и не
 * имеет права ничего менять.
 */

let pool: Pool | null = null;

/** Пул создаётся один раз и лениво: до первого обращения соединений нет. */
function healthPool(url: string): Pool {
  pool ??= createPool(url);
  return pool;
}

/**
 * Состояние базы. Исключений не бросает: у проверки здоровья ответ есть всегда,
 * иначе она сама становится источником пятисотых.
 */
export async function probeDatabase(): Promise<DbState> {
  const url = databaseUrl();
  if (url === null) return { kind: 'unconfigured' };
  try {
    const active = healthPool(url);
    await probeConnection(active);
    const applied = await readAppliedMigrations(active);
    if (applied === null) return { kind: 'unmigrated' };
    const version = applied.at(-1)?.version;
    return version === undefined ? { kind: 'unmigrated' } : { kind: 'ready', schema: version };
  } catch (error: unknown) {
    if (isDatabaseUnreachable(error)) return { kind: 'unreachable' };
    if (error instanceof DbError) return { kind: 'error', code: safeCode(error.code) };
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code: unknown }).code
      : undefined;
    return { kind: 'error', code: safeCode(code) };
  }
}

/**
 * Проба настройки входа.
 *
 * Сети здесь нет: проверяется настройка, а не состояние. Режим канала доставки
 * кода назван и назван допустимо, ключ вывода кода есть и не короче
 * допустимого, боевой режим имеет боевой адаптер (сегодня его нет ни одного —
 * `server/auth-config.ts`).
 *
 * ⚠ **Почему проверка здесь, а не в `instrumentation.ts`.** Первая редакция
 * ставила ворота в `register()` — то есть буквально на старте процесса, — и
 * сборка от этого падала целиком: `instrumentation.ts` Next собирает и для
 * среды `edge`, а туда по цепочке импортов приезжает `node:crypto`
 * (`@sdelka/domain/src/ids.ts`) и драйвер Postgres. Разрезать цепочку до
 * пакета, который не знает Node, значит переписать `@sdelka/domain` — чужой
 * пакет и чужая работа.
 *
 * Поэтому ворота стоят там, где их читает оркестратор: неверно настроенный
 * вход даёт `503`, и контейнер не становится готовым. Обязательность самих
 * переменных при этом закрыта раньше — `pnpm env:check` (`packages/config`) не
 * даёт запустить процесс без них вовсе.
 *
 * Значение переменной в ответ не попадает: наружу уходит только ключ отказа
 * (красная линия №12), и он же пропущен через `safeCode`.
 */
export function probeAuthConfig(): AuthConfigState {
  try {
    assertAuthConfig();
    return { kind: 'ready' };
  } catch (error: unknown) {
    // Сообщение наших отказов — «ключ variable=ИМЯ»: наружу отдаётся только
    // ключ. Всё, что не наш ключ, сворачивается в `unknown` фильтром.
    const message = error instanceof Error ? error.message : '';
    return { kind: 'misconfigured', code: safeCode(message.split(' ')[0]) };
  }
}
