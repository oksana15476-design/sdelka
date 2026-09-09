import { describe, expect, it } from 'vitest';
import { DbError, DbErrorCode } from '../src/errors.ts';
import type { Migration } from '../src/migrations.ts';
import type { Pool } from '../src/pool.ts';
import {
  type AppliedMigration,
  assertSchemaCurrent,
  compareSchema,
  expectedVersion,
  readAppliedMigrations,
} from '../src/schema-version.ts';
import { MIGRATIONS } from './support/sql.ts';

/**
 * Ворота старта приложения — разобранные **без базы**.
 *
 * Сравнение ожидаемого с применённым вынесено в чистую функцию именно ради
 * этого: ворота, проверяемые только на живом кластере, у того, у кого кластера
 * нет, не проверены вовсе, а поднимать процесс на чужой схеме умеет каждый.
 */
function migration(version: string, checksum: string): Migration {
  return Object.freeze({ version, fileName: `${version}_x.sql`, sql: '', checksum });
}

const EXPECTED: readonly Migration[] = Object.freeze([
  migration('0001', 'a'),
  migration('0002', 'b'),
]);

function applied(...rows: readonly (readonly [string, string])[]): readonly AppliedMigration[] {
  return rows.map(([version, checksum]) => Object.freeze({ version, checksum }));
}

describe('сверка схемы с кодом', () => {
  it('всё применено и суммы сошлись — текущая, с номером версии', () => {
    expect(compareSchema(EXPECTED, applied(['0001', 'a'], ['0002', 'b']))).toEqual({
      kind: 'current',
      version: '0002',
    });
  });

  it('таблицы учёта нет — база не инициализирована, а не «отстаёт»', () => {
    // Разные починки: «накат не запускали ни разу» против «накат остановился».
    expect(compareSchema(EXPECTED, null)).toEqual({ kind: 'uninitialized' });
  });

  it('не хватает версий — отстаёт, с перечнем недостающих', () => {
    expect(compareSchema(EXPECTED, applied(['0001', 'a']))).toEqual({
      kind: 'behind',
      versions: ['0002'],
    });
  });

  it('пустая таблица учёта — отстаёт на всё, но инициализирована', () => {
    expect(compareSchema(EXPECTED, [])).toEqual({ kind: 'behind', versions: ['0001', '0002'] });
  });

  it('в базе есть версии, которых нет в коде — впереди', () => {
    // Откат приложения на предыдущую сборку после наката. Работать нельзя: чем
    // отличается чужая схема, этот код не знает.
    expect(compareSchema(EXPECTED, applied(['0001', 'a'], ['0002', 'b'], ['0003', 'c']))).toEqual({
      kind: 'ahead',
      versions: ['0003'],
    });
  });

  it('сумма применённой версии не та — расхождение, а не «текущая»', () => {
    expect(compareSchema(EXPECTED, applied(['0001', 'a'], ['0002', 'ДРУГАЯ']))).toEqual({
      kind: 'changed',
      versions: ['0002'],
    });
  });

  it('расхождение сумм важнее нехватки версий', () => {
    // Номера сходятся, схема — нет: снаружи такая база выглядит накаченной.
    // Сообщить «отстаёт» значило бы отправить чинить накатом то, что накатом не
    // чинится.
    expect(compareSchema(EXPECTED, applied(['0001', 'ДРУГАЯ']))).toEqual({
      kind: 'changed',
      versions: ['0001'],
    });
  });

  it('расхождение сумм важнее лишних версий', () => {
    expect(compareSchema(EXPECTED, applied(['0001', 'x'], ['0002', 'b'], ['0009', 'z']))).toEqual({
      kind: 'changed',
      versions: ['0001'],
    });
  });

  it('лишняя версия важнее недостающей', () => {
    expect(compareSchema(EXPECTED, applied(['0001', 'a'], ['0009', 'z']))).toEqual({
      kind: 'ahead',
      versions: ['0009'],
    });
  });

  it('ожидаемая версия этого дерева — номер последней миграции', () => {
    expect(expectedVersion(MIGRATIONS)).toBe(MIGRATIONS.at(-1)?.version);
  });

  it('пустой каталог — ошибка, а не «версия отсутствует»', () => {
    expect(() => expectedVersion([])).toThrow('db.migration.empty_directory');
  });
});

/**
 * Чтение применённого спрашивает `to_regclass`, а не ловит ошибку «нет такой
 * таблицы». Внутри транзакции ошибка обрывает её целиком: вызывающий, спросивший
 * версию схемы первым делом, получил бы вместо ответа мёртвую транзакцию.
 */
describe('чтение таблицы учёта', () => {
  function reader(rows: readonly unknown[][]): { query: (text: string) => Promise<never> } {
    const queue = [...rows];
    return {
      query: (async () => ({ rows: queue.shift() ?? [] })) as never,
    };
  }

  it('таблицы нет — null, и второго запроса не было', async () => {
    const seen: string[] = [];
    const client = {
      query: async (text: string) => {
        seen.push(text);
        return { rows: [{ oid: null }] } as never;
      },
    };
    expect(await readAppliedMigrations(client)).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('таблица есть — строки читаются', async () => {
    const client = reader([[{ oid: 'sdelka.schema_migration' }], [{ version: '0001', checksum: 'a' }]]);
    expect(await readAppliedMigrations(client)).toEqual([{ version: '0001', checksum: 'a' }]);
  });
});

describe('ворота старта', () => {
  function poolOf(rows: readonly unknown[][]): Pool {
    const queue = [...rows];
    let released = 0;
    const client = {
      query: async () => ({ rows: queue.shift() ?? [] }),
      release: () => {
        released += 1;
      },
      get releases() {
        return released;
      },
    };
    return { connect: async () => client } as unknown as Pool;
  }

  it('схема на ожидаемой версии — возвращает её номер', async () => {
    const rows = MIGRATIONS.map((item) => ({ version: item.version, checksum: item.checksum }));
    const version = await assertSchemaCurrent(
      poolOf([[{ oid: 'sdelka.schema_migration' }], rows]),
    );
    expect(version).toBe(MIGRATIONS.at(-1)?.version);
  });

  it('таблицы учёта нет — отказ с ключом, а не догадка', async () => {
    await expect(assertSchemaCurrent(poolOf([[{ oid: null }]]))).rejects.toThrow(
      DbErrorCode.schemaNotInitialized,
    );
  });

  it('база отстаёт — отказ называет и ожидаемое, и недостающее', async () => {
    const rows = [{ version: MIGRATIONS[0]?.version, checksum: MIGRATIONS[0]?.checksum }];
    const error = await assertSchemaCurrent(poolOf([[{ oid: 'x' }], rows])).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe(DbErrorCode.schemaBehind);
    expect((error as DbError).details.expected).toBe(MIGRATIONS.at(-1)?.version);
    expect((error as DbError).details.versions).toContain(MIGRATIONS[1]?.version ?? '');
  });

  it('база впереди кода — отказ, а не «сойдёт»', async () => {
    const rows = [
      ...MIGRATIONS.map((item) => ({ version: item.version, checksum: item.checksum })),
      { version: '9999', checksum: 'z' },
    ];
    const error = await assertSchemaCurrent(poolOf([[{ oid: 'x' }], rows])).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as DbError).code).toBe(DbErrorCode.schemaAhead);
    expect((error as DbError).details.versions).toBe('9999');
  });

  it('сумма применённой версии не та — отказ своим ключом', async () => {
    const rows = MIGRATIONS.map((item) => ({ version: item.version, checksum: 'ДРУГАЯ' }));
    const error = await assertSchemaCurrent(poolOf([[{ oid: 'x' }], rows])).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as DbError).code).toBe(DbErrorCode.schemaChecksumMismatch);
  });

  it('в отказе нет строки подключения — ни в ключе, ни в подробностях', async () => {
    const error = (await assertSchemaCurrent(poolOf([[{ oid: null }]])).catch(
      (thrown: unknown) => thrown,
    )) as DbError;
    const printed = `${error.message} ${JSON.stringify(error.details)}`;
    expect(printed).not.toMatch(/postgres|@|password/iu);
  });
});
