import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { DbError, DbErrorCode } from '../src/errors.ts';
import {
  CONNECT_TIMEOUT_MS,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  QUERY_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  createPool,
  isDatabaseUnreachable,
  probeConnection,
} from '../src/pool.ts';
import intConfig from '../vitest.int.config.ts';

/**
 * Таймауты пула и разбор «база недоступна» — без базы.
 *
 * До правки таймаутов не было вовсе, и недоступный адрес не пропускал набор, а
 * вешал прогон: замер на этом дереве — 2 м 10 с до первого сообщения, прогон
 * убит на 200-й секунде. Проверять это можно только тем, что значения заданы
 * явно и связаны между собой: пул не соединяется, пока его не спросили, так что
 * смотрим на конфигурацию, а не на поведение сокета.
 */
const URL = 'postgresql://nobody@127.0.0.1:5432/nothing';

describe('таймауты пула заданы явно', () => {
  it('пул создаётся со всеми четырьмя сроками', async () => {
    const pool = createPool(URL);
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(CONNECT_TIMEOUT_MS);
      expect(pool.options.statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
      expect(pool.options.query_timeout).toBe(QUERY_TIMEOUT_MS);
      expect(pool.options.idle_in_transaction_session_timeout).toBe(
        IDLE_IN_TRANSACTION_TIMEOUT_MS,
      );
    } finally {
      await pool.end();
    }
  });

  it('серверный срок строго меньше клиентского', () => {
    // Иначе клиент убил бы соединение раньше, чем сервер назвал причину
    // (`SQLSTATE 57014`), и вместо имени отказа осталось бы «connection
    // terminated».
    expect(STATEMENT_TIMEOUT_MS).toBeLessThan(QUERY_TIMEOUT_MS);
  });

  it('срок пробы строго меньше срока соединения', () => {
    // Проба обязана срабатывать первой: её отказ опознаётся по коду
    // (`db.connect.timeout`), а отказ пула — только по тексту сообщения
    // драйвера, который не наш контракт.
    expect(PROBE_TIMEOUT_MS).toBeLessThan(CONNECT_TIMEOUT_MS);
  });

  it('все сроки срабатывают раньше, чем vitest снимет тест', () => {
    // Таймаут vitest безымянен: «test timed out» не говорит, что именно
    // молчало. Наши сроки обязаны сработать раньше и назвать причину.
    const testTimeout = intConfig.test?.testTimeout;
    const hookTimeout = intConfig.test?.hookTimeout;
    expect(testTimeout).toBeDefined();
    expect(hookTimeout).toBeDefined();
    expect(QUERY_TIMEOUT_MS).toBeLessThan(testTimeout ?? 0);
    expect(CONNECT_TIMEOUT_MS).toBeLessThan(testTimeout ?? 0);
    expect(IDLE_IN_TRANSACTION_TIMEOUT_MS).toBeLessThanOrEqual(testTimeout ?? 0);
    expect(IDLE_IN_TRANSACTION_TIMEOUT_MS).toBeLessThan(hookTimeout ?? 0);
  });
});

describe('проба соединения', () => {
  it('живая база — проба проходит', async () => {
    await expect(probeConnection({ query: async () => ({ rows: [] }) })).resolves.toBeUndefined();
  });

  it('молчание — отказ по своему сроку, а не ожидание навсегда', async () => {
    const started = Date.now();
    await expect(
      probeConnection({ query: () => new Promise<never>(() => undefined) }, 50),
    ).rejects.toMatchObject({ code: DbErrorCode.connectTimeout });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('ошибка драйвера отдаётся как есть', async () => {
    await expect(
      probeConnection({
        query: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        },
      }),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

describe('недоступность отличается от отказа', () => {
  it('наш таймаут пробы — недоступность', () => {
    expect(isDatabaseUnreachable(new DbError(DbErrorCode.connectTimeout))).toBe(true);
  });

  it('ошибки сокета — недоступность', () => {
    for (const code of [
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ETIMEDOUT',
    ]) {
      expect(isDatabaseUnreachable(Object.assign(new Error(code), { code })), code).toBe(true);
    }
  });

  it('ответ сервера — не недоступность', () => {
    // Сервер жив: пароль не подошёл (`28P01`), базы нет (`3D000`), `pg_hba`
    // запрещает (`28000`). Это настройка, и она обязана ронять прогон.
    for (const code of ['28P01', '3D000', '28000', '57014']) {
      const error = Object.assign(new DatabaseError('отказ', 100, 'error'), { code });
      expect(isDatabaseUnreachable(error), code).toBe(false);
    }
  });

  it('прочие ошибки базы — не недоступность', () => {
    expect(isDatabaseUnreachable(new DbError(DbErrorCode.migrationChecksumMismatch))).toBe(false);
  });

  it('ошибка неизвестного рода — не недоступность', () => {
    // Пропуск набора требует доказательства недоступности, а не отсутствия
    // возражений: неизвестная ошибка обязана быть громкой.
    expect(isDatabaseUnreachable(new Error('ECONNREFUSED'))).toBe(false);
    expect(isDatabaseUnreachable(Object.assign(new Error('x'), { code: 42 }))).toBe(false);
    expect(isDatabaseUnreachable('ECONNREFUSED')).toBe(false);
    expect(isDatabaseUnreachable(null)).toBe(false);
  });
});
