import { describe, expect, it } from 'vitest';
import type { Pool } from '../src/pool.ts';
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
 */
const CONNECTED: Pick<Pool, 'query' | 'end'> = {
  query: async () => ({ rows: [] }) as never,
  end: async () => undefined,
};

function deps(
  pool: Partial<Pick<Pool, 'query' | 'end'>>,
  migrateBehaviour: () => Promise<unknown>,
): EnvironmentDeps {
  return {
    connect: () => ({ ...CONNECTED, ...pool }) as Pool,
    migrate: migrateBehaviour,
  };
}

describe('пропуск интеграционного набора узкий', () => {
  it('переменная не задана — пропуск с причиной', async () => {
    const env = await resolveEnvironment(
      null,
      deps({}, async () => undefined),
    );
    expect(env.available).toBe(false);
    expect(env.reason).toContain('SDELKA_DATABASE_URL');
  });

  it('базы нет — пропуск с причиной, а не падение', async () => {
    const env = await resolveEnvironment(
      'postgresql://nobody@127.0.0.1:1/nothing',
      deps(
        {
          query: async () => {
            throw new Error('ECONNREFUSED');
          },
        },
        async () => undefined,
      ),
    );
    expect(env.available).toBe(false);
    expect(env.reason).toContain('ECONNREFUSED');
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
      deps({}, async () => undefined),
    );
    expect(env.available).toBe(true);
    expect(env.pool).not.toBeNull();
  });
});
