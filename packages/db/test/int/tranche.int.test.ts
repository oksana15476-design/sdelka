import {
  RELEASE_CONDITION_TYPES,
  TERMINAL_TRANCHE_STATUSES,
  THAWED_TRANCHE_STATUSES,
  isUsableReleaseCondition,
} from '@sdelka/domain';
import { expect, it } from 'vitest';
import { dbSuite, sqlState, withRollback } from './support/pg.ts';
import type { PoolClient } from '../../src/pool.ts';

/**
 * «Транш в нетерминальном состоянии без дедлайна — ошибка» — на живой базе.
 *
 * В TS форму держит союз `TrancheState`. Здесь — ограничение
 * `tranche_state_shape`, и проверяется оно перебором: каждая из форм,
 * невыразимых в союзе, обязана не вставляться.
 */
const suite = await dbSuite('форма состояния транша');

const DEADLINE = '2026-09-10T10:00:00Z';
const ENTERED = '2026-09-03T10:00:00Z';

async function seed(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO sdelka.party (party_id, account_key) VALUES
       ('p-buyer', 'buyer-1'), ('p-seller', 'seller-1')`,
  );
  await client.query(
    `INSERT INTO sdelka.deal (deal_id, status, buyer_party_id, seller_party_id)
     VALUES ('d1', 'funded', 'p-buyer', 'p-seller')`,
  );
  await client.query(
    `INSERT INTO sdelka.condition_act
       (deal_id, tranche_id, recipient_party_id, agreed_at, condition_text_version, condition_type)
     VALUES ('d1', 't1', 'p-seller', $1, 'condition/2026-01-01.1', 'registration_transfer')`,
    [ENTERED],
  );
}

interface TrancheRow {
  readonly status: string;
  readonly deadlineAt?: string | null;
  readonly enteredAt?: string | null;
  readonly suspendedFrom?: string | null;
  readonly remainingMs?: string | null;
  readonly freezeReason?: string | null;
  readonly frozenBy?: string | null;
  readonly act?: string | null;
}

async function insertTranche(client: PoolClient, row: TrancheRow): Promise<void> {
  await client.query(
    `INSERT INTO sdelka.tranche
       (deal_id, tranche_id, status, deadline_at, entered_at, suspended_from,
        remaining_ms, freeze_reason, frozen_by, condition_act_agreed_at)
     VALUES ('d1', 't1', $1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.status,
      row.deadlineAt ?? null,
      row.enteredAt ?? null,
      row.suspendedFrom ?? null,
      row.remainingMs ?? null,
      row.freezeReason ?? null,
      row.frozenBy ?? null,
      row.act === undefined ? ENTERED : row.act,
    ],
  );
}

suite.run(suite.title, () => {
  const pool = suite.pool;

  async function rejects(row: TrancheRow, constraint: string): Promise<void> {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seed(client);
      let failed = false;
      try {
        await insertTranche(client, row);
      } catch (error) {
        failed = true;
        expect(sqlState(error)).toBe('23514');
        expect(String(error)).toContain(constraint);
      }
      expect(failed, `${row.status}: ожидался отказ ${constraint}`).toBe(true);
    });
  }

  it('остывший транш с дедлайном и возрастом вставляется', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seed(client);
      await insertTranche(client, {
        status: 'collecting',
        deadlineAt: DEADLINE,
        enteredAt: ENTERED,
      });
    });
  });

  for (const status of THAWED_TRANCHE_STATUSES) {
    it(`${status} без дедлайна не вставляется`, async () => {
      await rejects({ status, enteredAt: ENTERED }, 'tranche_state_shape');
    });
    it(`${status} с дедлайном, но без возраста не вставляется`, async () => {
      await rejects({ status, deadlineAt: DEADLINE }, 'tranche_state_shape');
    });
  }

  it('замороженный с живым дедлайном не вставляется', async () => {
    // `CORE.md` Ф17: дедлайн не отменён, а **приостановлен**. Флаг «заморожен»
    // рядом с идущим дедлайном можно забыть проверить — отсутствующее поле
    // нельзя.
    await rejects(
      {
        status: 'frozen',
        deadlineAt: DEADLINE,
        enteredAt: ENTERED,
        suspendedFrom: 'reserved',
        remainingMs: '1000',
        freezeReason: 'dispute',
        frozenBy: 'operator-1',
      },
      'tranche_state_shape',
    );
  });

  it('замороженный без остатка дедлайна не вставляется', async () => {
    await rejects(
      {
        status: 'frozen',
        enteredAt: ENTERED,
        suspendedFrom: 'reserved',
        freezeReason: 'dispute',
        frozenBy: 'operator-1',
      },
      'tranche_state_shape',
    );
  });

  it('замороженный из pending не вставляется', async () => {
    // В `pending` денег ещё нет — замораживать нечего, а обратный переход
    // открыл бы вход в стартовое состояние заново (§5).
    await rejects(
      {
        status: 'frozen',
        enteredAt: ENTERED,
        suspendedFrom: 'pending',
        remainingMs: '1000',
        freezeReason: 'dispute',
        frozenBy: 'operator-1',
      },
      'tranche_freezable_origin',
    );
  });

  it('замороженный по всем правилам вставляется', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seed(client);
      await insertTranche(client, {
        status: 'frozen',
        enteredAt: ENTERED,
        suspendedFrom: 'reserved',
        remainingMs: '1000',
        freezeReason: 'dispute',
        frozenBy: 'operator-1',
      });
    });
  });

  for (const status of TERMINAL_TRANCHE_STATUSES) {
    it(`${status} с идущими часами не вставляется`, async () => {
      await rejects({ status, deadlineAt: DEADLINE, enteredAt: ENTERED }, 'tranche_state_shape');
    });
  }

  it('pending без акта вставляется, collecting без акта — нет', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seed(client);
      await insertTranche(client, {
        status: 'pending',
        deadlineAt: DEADLINE,
        enteredAt: ENTERED,
        act: null,
      });
    });
    // `CORE.md` Ф13: приём средств открывается только актом получателя.
    await rejects(
      { status: 'collecting', deadlineAt: DEADLINE, enteredAt: ENTERED, act: null },
      'tranche_condition_act_required',
    );
  });

  async function insertAct(client: PoolClient, trancheId: string, type: string): Promise<void> {
    await client.query(
      `INSERT INTO sdelka.condition_act
         (deal_id, tranche_id, recipient_party_id, agreed_at,
          condition_text_version, condition_type)
       VALUES ('d1', $1, 'p-seller', $2, 'condition/2026-01-01.1', $3)`,
      [trancheId, ENTERED, type],
    );
  }

  /**
   * Перебор по перечню, а не по одному значению.
   *
   * Прежняя редакция подавала единственный `registration_preliminary` — и
   * поэтому молчала, когда домен добавил второй отвергаемый тип: у
   * `calendar_date` `sourceImplemented: false`, а ограничение базы про второе
   * условие `isUsableReleaseCondition` не знало и акт пропускало. Транш законно
   * открывал приём средств под условие, по которому расчёт невозможен никогда.
   * Теперь список берётся у домена, и разойтись молча ему больше нечем.
   */
  for (const type of RELEASE_CONDITION_TYPES.filter((item) => !isUsableReleaseCondition(item))) {
    it(`акт с негодным типом условия (${type}) не заводится`, async () => {
      if (pool === null) return;
      await withRollback(pool, async (client) => {
        await seed(client);
        let failed = false;
        try {
          await insertAct(client, 't2', type);
        } catch (error) {
          failed = true;
          expect(sqlState(error)).toBe('23514');
          expect(String(error)).toContain('condition_act_usable_type');
        }
        expect(failed, `${type}: ожидался отказ ограничения`).toBe(true);
      });
    });
  }

  for (const type of RELEASE_CONDITION_TYPES.filter(isUsableReleaseCondition)) {
    it(`акт с годным типом условия (${type}) заводится`, async () => {
      if (pool === null) return;
      // Обратная сторона того же зеркала: ограничение, отвергающее годный тип,
      // — это база, запрещающая законное состояние, и увидеть это надо здесь, а
      // не на приёме средств.
      await withRollback(pool, async (client) => {
        await seed(client);
        await insertAct(client, 't3', type);
      });
    });
  }

  it('половина суммы транша — не сумма', async () => {
    if (pool === null) return;
    // `tranche_amount_whole`: сумма и валюта в TS — одно значение (`Money`), и
    // здесь тоже. Число без валюты — это величина, о которой нельзя сказать,
    // сколько это; валюта без числа — валюта неизвестно чего.
    for (const [amount, currency] of [
      ['100000', null],
      [null, 'GEL'],
    ] as const) {
      await withRollback(pool, async (client) => {
        await seed(client);
        let failed = false;
        try {
          await client.query(
            `INSERT INTO sdelka.tranche
               (deal_id, tranche_id, status, deadline_at, entered_at, condition_act_agreed_at,
                required_amount_minor, required_currency)
             VALUES ('d1', 't1', 'collecting', $1, $2, $2, $3, $4)`,
            [DEADLINE, ENTERED, amount, currency],
          );
        } catch (error) {
          failed = true;
          expect(sqlState(error)).toBe('23514');
          expect(String(error)).toContain('tranche_amount_whole');
        }
        expect(failed, `${amount}/${currency}: ожидался отказ`).toBe(true);
      });
    }
  });

  it('одна личность по обе стороны сделки — отказ', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`INSERT INTO sdelka.party (party_id, account_key) VALUES ('p1', 'a1')`);
      let failed = false;
      try {
        await client.query(
          `INSERT INTO sdelka.deal (deal_id, status, buyer_party_id, seller_party_id)
           VALUES ('d2', 'draft', 'p1', 'p1')`,
        );
      } catch (error) {
        failed = true;
        expect(String(error)).toContain('deal_parties_distinct');
      }
      expect(failed).toBe(true);
    });
  });
});
