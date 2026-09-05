import { expect, it } from 'vitest';
import { TRANSLATED_CONSTRAINTS } from '../../src/store/errors.ts';
import { dbSuite, withRollback } from './support/pg.ts';

/**
 * Вторая половина правила о ключах: названные в переводе ограничения в схеме
 * **есть**.
 *
 * Перевод «имя ограничения → правило кода» — единственное место, где эта связь
 * вообще записана, и держится она на строковом совпадении. Переименованное или
 * удалённое ограничение молча выпадает из перевода: правило продолжает
 * срабатывать, но приезжает безымянной ошибкой драйвера. Заметить это можно
 * только сверкой с живой схемой — имена ограничений вроде
 * `ledger_posting_amount_minor_check` Postgres придумывает сам, и в тексте
 * миграций их нет.
 */
const { run, title, pool } = await dbSuite('хранилище: имена ограничений');

run(title, () => {
  it('каждое переведённое имя существует в схеме', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      const constraints = await client.query<{ conname: string }>(
        `SELECT c.conname
           FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = 'sdelka'`,
      );
      const indexes = await client.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'sdelka' AND c.relkind = 'i'`,
      );
      const known = new Set<string>([
        ...constraints.rows.map((row) => row.conname),
        ...indexes.rows.map((row) => row.relname),
      ]);
      const missing = TRANSLATED_CONSTRAINTS.filter((name) => !known.has(name));
      expect(missing).toEqual([]);
    });
  });
});
