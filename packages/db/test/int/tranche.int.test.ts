import { TERMINAL_TRANCHE_STATUSES, THAWED_TRANCHE_STATUSES } from '@sdelka/domain';
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

  it('акт с неподтверждённым типом условия не заводится', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seed(client);
      let failed = false;
      try {
        await client.query(
          `INSERT INTO sdelka.condition_act
             (deal_id, tranche_id, recipient_party_id, agreed_at,
              condition_text_version, condition_type)
           VALUES ('d1', 't2', 'p-seller', $1, 'condition/2026-01-01.1',
                   'registration_preliminary')`,
          [ENTERED],
        );
      } catch (error) {
        failed = true;
        expect(String(error)).toContain('condition_act_usable_type');
      }
      // `STATE-MACHINES.md` §8: значение помечено **[открыто]** и до
      // подтверждения не используется.
      expect(failed).toBe(true);
    });
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
