import { SEED_SCENARIOS } from '@sdelka/app';
import { expect, it } from 'vitest';
import { SeedError, SeedErrorCode } from '../../src/seed/errors.ts';
import { foreignRelations } from '../../src/seed/guard.ts';
import { seedDatabase } from '../../src/seed/run.ts';
import { dbSuite, withRollback } from './support/pg.ts';

/**
 * Засев на живой базе.
 *
 * Проверяется то, что нельзя проверить без базы: что сценарии **ложатся**, что
 * повтор ничего не создаёт, что ворота не пускают засев на базу с настоящими
 * данными и что после засева сходятся инварианты — сумма проводок, покрытие
 * клиентских средств, цепочка вечного журнала.
 *
 * ⚠ Всё внутри одной откатываемой транзакции: журнал учёта и журнал аудита
 * только дополняются (`DELETE` запрещён и грантами, и триггером), и убрать за
 * собой иначе нечем. Границу сценария при этом держит точка сохранения — та же,
 * что у команды, — поэтому откат снаружи ничего в проверке не смягчает.
 *
 * ⚠ **Набор требует базы, на которой засев не зафиксирован.** Убрать
 * зафиксированный засев нечем по той же причине — журналы не редактируются, — и
 * притвориться, что «повтор это тоже успех», значило бы перестать проверять сам
 * засев. Поэтому чистота базы проверяется первой строкой и **называется**, а не
 * выясняется потом из непонятного расхождения списков. Демонстрационная база,
 * засеянная командой, для этого набора не годится: под него поднимается своя.
 */
const suite = await dbSuite('засев базы сценариями интерфейса');

suite.run(suite.title, () => {
  const pool = suite.pool;
  if (pool === null) return;

  it('кладёт каждый сценарий и проходит проверку инвариантов', async () => {
    await withRollback(pool, async (client) => {
      await expectCleanBase(client);

      const report = await seedDatabase(client);

      expect(report.diverged).toEqual([]);
      expect(report.seeded.map((item) => item.id)).toEqual(
        SEED_SCENARIOS.map((item) => item.id),
      );
      expect(report.outcome.written).toBeGreaterThan(0);

      // Инварианты после засева: считает их база, а не засев.
      expect(report.verification.findings).toEqual([]);
      expect(report.verification.entries).toBeGreaterThan(0);
      expect(report.verification.records).toBeGreaterThan(0);
      expect(report.verification.coverage.length).toBeGreaterThan(0);
      for (const row of report.verification.coverage) {
        // Покрытие ровно единица: сравниваются целые минорные единицы.
        expect(`${row.currency}:${row.custodyMinor}`).toBe(`${row.currency}:${row.obligationsMinor}`);
      }

      // Ступени доехали до базы, а не только до мира.
      const states = await client.query<{ deal_id: string; deal: string; tranche: string }>(
        `SELECT d.deal_id, d.status AS deal, t.status AS tranche
           FROM sdelka.deal d JOIN sdelka.tranche t USING (deal_id)
          ORDER BY d.deal_id`,
      );
      expect(states.rows).toHaveLength(SEED_SCENARIOS.length);
      const settled = states.rows.filter((row) => row.tranche === 'paid_out');
      // Ступень «расчёт проведён» обязана быть достигнута хотя бы одним
      // сценарием: без неё в базе нет ни одного поручения, и половина схемы
      // остаётся непроверенной.
      expect(settled.length).toBeGreaterThan(0);

      const payouts = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sdelka.payout`,
      );
      expect(Number(payouts.rows[0]?.n ?? '0')).toBe(settled.length);
    });
  });

  it('повтор не создаёт вторых копий и не падает', async () => {
    await withRollback(pool, async (client) => {
      await expectCleanBase(client);
      const first = await seedDatabase(client);
      expect(first.seeded).toHaveLength(SEED_SCENARIOS.length);
      const countsBefore = await counts(client);

      const second = await seedDatabase(client);

      expect(second.seeded).toEqual([]);
      expect(second.diverged).toEqual([]);
      expect(second.repeated).toEqual(SEED_SCENARIOS.map((item) => item.id));
      expect(second.outcome.written).toBe(0);
      expect(await counts(client)).toEqual(countsBefore);
      expect(second.verification.findings).toEqual([]);
    });
  });

  it('отказывается работать на базе, где есть настоящие данные', async () => {
    await withRollback(pool, async (client) => {
      await expectCleanBase(client);
      // Признак «настоящих» — идентификатор без начала засева. Одна строка, а
      // не тысяча: ворота стоят на признаке, а не на количестве.
      await client.query(
        `INSERT INTO sdelka.party (party_id, account_key) VALUES ('party-real-1','real-key-1')`,
      );

      const refusal = await seedDatabase(client).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(SeedError);
      expect((refusal as SeedError).code).toBe(SeedErrorCode.foreignData);
      expect((refusal as SeedError).details.relations).toContain('party=1');
      // Отказ — до единой записи засева.
      const deals = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sdelka.deal`,
      );
      expect(deals.rows[0]?.n).toBe('0');
    });
  });

  it('называет расхождением сделку, которая ушла дальше засева', async () => {
    await withRollback(pool, async (client) => {
      await expectCleanBase(client);
      const first = SEED_SCENARIOS[0];
      if (first === undefined) throw new Error('каталог засева пуст');
      await seedDatabase(client, { scenarios: [first] });

      // Тот же сценарий, доведённый до другой ступени: в базе он лежит в
      // прежнем положении, и дописывать туда нечего.
      const moved = await seedDatabase(client, {
        scenarios: [{ ...first, stage: 'reserved' }],
      });

      expect(moved.seeded).toEqual([]);
      expect(moved.repeated).toEqual([]);
      expect(moved.diverged.map((item) => item.id)).toEqual([first.id]);
    });
  });
});

/**
 * Чистота базы — **условие набора**, названное словами.
 *
 * Прочие интеграционные наборы за собой откатывают, поэтому в норме здесь
 * пусто. Если не пусто, дело не в засеве: либо базу засеяли командой, либо на
 * ней работали руками, — и оба случая обязаны читаться сразу, а не через
 * расхождение двух списков идентификаторов.
 */
async function expectCleanBase(client: Parameters<typeof foreignRelations>[0]): Promise<void> {
  expect(await foreignRelations(client)).toEqual([]);
  const deals = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM sdelka.deal`);
  expect(
    deals.rows[0]?.n,
    'набор идёт по базе без зафиксированного засева: снять его нечем — журналы не редактируются',
  ).toBe('0');
}

async function counts(client: Parameters<typeof foreignRelations>[0]): Promise<string> {
  const result = await client.query<{ line: string }>(
    `SELECT (SELECT count(*) FROM sdelka.deal) || '/' ||
            (SELECT count(*) FROM sdelka.tranche) || '/' ||
            (SELECT count(*) FROM sdelka.payout) || '/' ||
            (SELECT count(*) FROM sdelka.ledger_entry) || '/' ||
            (SELECT count(*) FROM sdelka.ledger_posting) || '/' ||
            (SELECT count(*) FROM sdelka.audit_record) AS line`,
  );
  return result.rows[0]?.line ?? '';
}
