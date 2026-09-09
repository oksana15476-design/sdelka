import { randomUUID } from 'node:crypto';
import type { SignInDeps } from '@sdelka/app';
import { type ChallengeId, type SessionId, challengeId, sessionId } from '@sdelka/auth';
import { hmacCodeDerivation } from '@sdelka/auth/code';
import { type Pool, createPool, pgAuthStore, requireDatabaseUrl } from '@sdelka/db';
import { type Instant, instant } from '@sdelka/domain';
import { codeDelivery, codeKey } from './auth-config';

/**
 * Сборка входа: хранилище, канал, вывод кода, часы и источник случайности.
 *
 * Решений о входе здесь нет ни одного — они в `@sdelka/app` (`sign-in.ts`).
 * Чтение окружения — в `auth-config.ts`, и оно отделено намеренно: этот файл
 * тянет за собой драйвер Postgres, а ворота старта собираются и для среды
 * `edge`, где драйвера нет (см. шапку `auth-config.ts`).
 */

/** Пул один на процесс: у него таймауты, разборщики типов и запрет float. */
let pool: Pool | null = null;

function authPool(): Pool {
  pool ??= createPool(requireDatabaseUrl());
  return pool;
}

let cached: SignInDeps | null = null;

/**
 * Зависимости входа. Собираются один раз и лениво: сборка образа окружения не
 * требует, подъём процесса — требует.
 *
 * Идентификаторы — `randomUUID`: 122 бита от системного источника. Ссылка на
 * вызов попадает в адрес страницы, поэтому предсказуемый идентификатор означал
 * бы, что чужой вызов можно назвать, не подбирая код.
 */
export function signInRuntime(): SignInDeps {
  if (cached !== null) return cached;
  cached = {
    store: pgAuthStore(authPool()),
    delivery: codeDelivery(),
    derivation: hmacCodeDerivation(codeKey()),
    ids: {
      session: (): SessionId => sessionId(randomUUID()),
      challenge: (): ChallengeId => challengeId(randomUUID()),
    },
    now: (): Instant => instant(Date.now()),
  };
  return cached;
}
