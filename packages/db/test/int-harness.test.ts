import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { type Pool, probeConnection } from '../src/pool.ts';
import { type EnvironmentDeps, resolveEnvironment } from './int/support/pg.ts';

/**
 * Каркас интеграционного набора — проверенный **без базы**.
 *
 * Проба: заведомо неверная строка подключения давала «79 пропущено, код выхода
 * 0» с текстом ошибки внутри. Упавшая миграция и отсутствующая база были
 * неразличимы, и обе зелёные — то есть весь интеграционный набор мог не
 * проверить ни одного инварианта и отчитаться успехом.
 *
 * Тест живёт в офлайн-наборе намеренно: каркас, который сам себя проверяет
 * только при поднятом кластере, ровно у того, у кого кластера нет, и
 * превращает всё в «пропущено».
 *
 * Проба берётся настоящая (`probeConnection`), подделан только пул: иначе
 * проверялся бы не тот разбор ошибок, который работает на живой машине.
 */
const CONNECTED: Pick<Pool, 'query' | 'end'> = {
  query: async () => ({ rows: [] }) as never,
  end: async () => undefined,
};

function deps(
  pool: Partial<Pick<Pool, 'query' | 'end'>>,
  migrateBehaviour: () => Promise<unknown>,
  probeTimeoutMs?: number,
): EnvironmentDeps {
  return {
    connect: () => ({ ...CONNECTED, ...pool }) as Pool,
    probe: (created) => probeConnection(created, probeTimeoutMs),
    migrate: migrateBehaviour,
  };
}

/** Ошибка сокета в том виде, в каком её отдаёт Node: род опознаётся по `code`. */
function socketError(code: string): Error {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:1`), { code });
}

/** Ответ сервера: `28P01` — «пароль не подошёл». Сервер жив, настроено неверно. */
function serverError(code: string): DatabaseError {
  const error = new DatabaseError('password authentication failed', 100, 'error');
  return Object.assign(error, { code });
}

const ok = async (): Promise<undefined> => undefined;

describe('пропуск интеграционного набора узкий', () => {
  it('переменная не задана — пропуск с причиной', async () => {
    const env = await resolveEnvironment(null, deps({}, ok));
    expect(env.available).toBe(false);
    expect(env.reason).toContain('SDELKA_DATABASE_URL');
  });

  it('порт закрыт — пропуск с причиной, а не падение', async () => {
    const env = await resolveEnvironment(
      'postgresql://nobody@127.0.0.1:1/nothing',
      deps(
        {
          query: async () => {
            throw socketError('ECONNREFUSED');
          },
        },
        ok,
      ),
    );
    expect(env.available).toBe(false);
    expect(env.reason).toContain('ECONNREFUSED');
  });

  it('пропуск закрывает пул: брошенный сокет не держит прогон', async () => {
    let ended = 0;
    const env = await resolveEnvironment(
      'postgresql://nobody@127.0.0.1:1/nothing',
      deps(
        {
          query: async () => {
            throw socketError('ECONNREFUSED');
          },
          end: async () => {
            ended += 1;
          },
        },
        ok,
      ),
    );
    expect(env.available).toBe(false);
    expect(ended).toBe(1);
  });

  it('база не отвечает — пропуск по своему сроку, а не ожидание навсегда', async () => {
    // Без собственного срока проба ждала бы ядро: на адресе, который молча
    // роняет пакеты, это около двух минут на каждый файл набора.
    const started = Date.now();
    const env = await resolveEnvironment(
      'postgresql://nobody@10.255.255.1:5432/nothing',
      deps({ query: () => new Promise<never>(() => undefined) }, ok, 50),
    );
    expect(env.available).toBe(false);
    expect(env.reason).toContain('db.connect.timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('сервер ответил отказом — падение, а не «пропущено»', async () => {
    // Неверный пароль, отсутствующая база, запрещающий `pg_hba` — сервер жив,
    // неверна настройка. Пропуск здесь отчитался бы зелёным о непроверенной
    // схеме: ровно та ложь, ради которой каркас переписан.
    await expect(
      resolveEnvironment(
        'postgresql://sdelka@127.0.0.1:5432/sdelka',
        deps(
          {
            query: async () => {
              throw serverError('28P01');
            },
          },
          ok,
        ),
      ),
    ).rejects.toThrow('password authentication failed');
  });

  it('ошибка неизвестного рода — падение, а не «пропущено»', async () => {
    // Пропуск требует доказательства недоступности. Ошибка без опознанного
    // рода такого доказательства не даёт.
    await expect(
      resolveEnvironment(
        'postgresql://sdelka@127.0.0.1:5432/sdelka',
        deps(
          {
            query: async () => {
              throw new Error('что-то пошло не так');
            },
          },
          ok,
        ),
      ),
    ).rejects.toThrow('что-то пошло не так');
  });

  it('база есть, миграция упала — падение, а не «пропущено»', async () => {
    // Ровно тот случай, ради которого каркас переписан: дефект схемы обязан
    // быть виден там же, где случился, а не превратиться в зелёный прогон.
    await expect(
      resolveEnvironment(
        'postgresql://sdelka@127.0.0.1:5432/sdelka',
        deps({}, async () => {
          throw new Error('db.migration.checksum_mismatch');
        }),
      ),
    ).rejects.toThrow('db.migration.checksum_mismatch');
  });

  it('упавшая миграция закрывает пул: прогон падает, а не виснет', async () => {
    let ended = 0;
    await expect(
      resolveEnvironment(
        'postgresql://sdelka@127.0.0.1:5432/sdelka',
        deps(
          {
            end: async () => {
              ended += 1;
            },
          },
          async () => {
            throw new Error('boom');
          },
        ),
      ),
    ).rejects.toThrow('boom');
    expect(ended).toBe(1);
  });

  it('база есть и миграции применились — набор выполняется', async () => {
    const env = await resolveEnvironment(
      'postgresql://sdelka@127.0.0.1:5432/sdelka',
      deps({}, ok),
    );
    expect(env.available).toBe(true);
    expect(env.pool).not.toBeNull();
  });
});
