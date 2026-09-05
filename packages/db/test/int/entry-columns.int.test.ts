import { expect, it } from 'vitest';
import { MIRRORED_ENTRY_COLUMNS } from '../../src/store/entry-shape.ts';
import { dbSuite, withRollback } from './support/pg.ts';

/**
 * Третья часть сверки дрейфа: **в таблице нет колонки, о которой не знает код**.
 *
 * Первые две части (`test/entry-shape.test.ts`) держат сторону кода: поле
 * значения без места не соберётся, место без запроса не совпадёт со списком. Ни
 * одна из них не видит обратного случая — колонки, заведённой миграцией и
 * никем не читаемой. А это и есть та форма расхождения, которая породила
 * `db.entry.declaration_not_storable`, только с другого конца: там домен ушёл
 * вперёд схемы, здесь схема уходит вперёд домена, и оба раза расхождение
 * молчит.
 *
 * Сверяется **множество**, а не вхождение: «все наши колонки есть в таблице»
 * прошло бы и на таблице с десятком лишних.
 */
const { run, title, pool } = await dbSuite('форма записи журнала: колонки и код');

run(title, () => {
  it('колонки sdelka.ledger_entry и карта записи совпадают', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'sdelka' AND table_name = 'ledger_entry'`,
      );
      const inSchema = columns.rows.map((row) => row.column_name).sort();
      expect(inSchema.length).toBeGreaterThan(20);
      expect(inSchema).toEqual([...MIRRORED_ENTRY_COLUMNS].sort());
    });
  });

  it('денежные колонки и доли объявлены целыми', async () => {
    if (pool === null) return;
    // Красная линия №4 на живой схеме, а не в тексте миграции: сумма, курс и
    // доля обязаны быть `numeric` без дробной части. `numeric(38, 0)` —
    // `numeric_scale = 0`; любое другое значение означает, что в колонке
    // помещается дробь, и разборщики драйвера этого уже не спасут.
    await withRollback(pool, async (client) => {
      const columns = await client.query<{
        column_name: string;
        data_type: string;
        numeric_scale: number | null;
      }>(
        `SELECT column_name, data_type, numeric_scale
           FROM information_schema.columns
          WHERE table_schema = 'sdelka' AND table_name = 'ledger_entry'
            AND (column_name LIKE '%_amount_minor'
                 OR column_name LIKE '%_numerator'
                 OR column_name LIKE '%_denominator')
          ORDER BY column_name`,
      );
      expect(columns.rows.length).toBeGreaterThan(10);
      for (const row of columns.rows) {
        expect(row.data_type, row.column_name).toBe('numeric');
        expect(row.numeric_scale, row.column_name).toBe(0);
      }
    });
  });

  it('дата курса хранится текстом, а не моментом времени', async () => {
    if (pool === null) return;
    // `IsoDate` — строка формы `YYYY-MM-DD`. Тип `date` драйвер отдал бы
    // `Date`, то есть моментом в часовом поясе процесса, и круг «запись → база
    // → запись» сдвигался бы на сутки в зависимости от `TZ`.
    await withRollback(pool, async (client) => {
      const column = await client.query<{ data_type: string }>(
        `SELECT data_type
           FROM information_schema.columns
          WHERE table_schema = 'sdelka' AND table_name = 'ledger_entry'
            AND column_name = 'converts_as_of'`,
      );
      expect(column.rows[0]?.data_type).toBe('text');
    });
  });
});
