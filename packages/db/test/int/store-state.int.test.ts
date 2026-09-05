import type { ConditionAct, PartyRef } from '@sdelka/domain';
import {
  DomainError,
  RejectionCode,
  dealState,
  deadline,
  duration,
  frozenTrancheState,
  instant,
  nonTerminalTrancheState,
  terminalTrancheState,
} from '@sdelka/domain';
import { money } from '@sdelka/money';
import { expect, it } from 'vitest';
import { DbError, DbErrorCode } from '../../src/errors.ts';
import type { DealSnapshot, PayoutSnapshot, TrancheSnapshot } from '../../src/store/port.ts';
import {
  loadDeal,
  loadPayouts,
  loadTranche,
  saveDeal,
  savePayout,
  saveTranche,
} from '../../src/store/state.ts';
import { dbSuite, withRollback } from './support/pg.ts';

/**
 * Круг «мир → база → мир» по состоянию: сделка, транш, поручение.
 *
 * Здесь же проверяется идемпотентность изменяемого. У журналов её держит
 * естественный ключ и сравнение содержимого; у состояния — сверка с
 * предыдущим состоянием, потому что колонки версии в схеме нет. Ровно два
 * исхода: повтор (в базе уже лежит цель шага) и конфликт (лежит что-то другое).
 */
const { run, title, pool } = await dbSuite('хранилище: состояние');

const GEL = 'GEL' as const;
const DEAL = 'deal-state';
const TRANCHE = 'tranche-state';

const BUYER: PartyRef = { partyId: 'party-buyer-state', accountKey: 'buyer.state' };
const SELLER: PartyRef = { partyId: 'party-seller-state', accountKey: 'seller.state' };

const ACT: ConditionAct = Object.freeze({
  recipient: SELLER,
  agreedAt: instant(Date.UTC(2026, 2, 1, 9, 0, 0)),
  conditionTextVersion: 'condition/2026-01-01.1',
  conditionType: 'registration_transfer',
});

const DEAL_SNAPSHOT: DealSnapshot = Object.freeze({
  dealId: DEAL,
  state: dealState('funding'),
  buyer: BUYER,
  seller: SELLER,
});

function collecting(): TrancheSnapshot {
  return Object.freeze({
    dealId: DEAL,
    trancheId: TRANCHE,
    state: nonTerminalTrancheState(
      'collecting',
      deadline(instant(Date.UTC(2026, 2, 4, 9, 0, 0))),
      instant(Date.UTC(2026, 2, 1, 9, 0, 0)),
      ACT,
    ),
    required: money(GEL, 20_000_000n),
  });
}

function reserved(): TrancheSnapshot {
  return Object.freeze({
    ...collecting(),
    state: nonTerminalTrancheState(
      'reserved',
      deadline(instant(Date.UTC(2026, 2, 5, 9, 0, 0))),
      instant(Date.UTC(2026, 2, 2, 9, 0, 0)),
      ACT,
    ),
  });
}

function payout(status: 'created' | 'settled'): PayoutSnapshot {
  return Object.freeze({
    payoutId: 'payout-state-1',
    dealId: DEAL,
    state: Object.freeze({
      status,
      // Ключ идемпотентности — uuid, функция транша и ноги (`payoutIdempotencyKey`).
      idempotencyKey: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      trancheId: TRANCHE,
      leg: 'release' as const,
    }),
    amount: money(GEL, 19_700_000n),
    beneficiary: SELLER,
    evidenceBundleId: 'evidence-bundle-state',
    providerReference: status === 'settled' ? 'psp/2026/03/01/1' : null,
  });
}

run(title, () => {
  it('сделка возвращается той же, вместе с обеими сторонами', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      expect(await saveDeal(client, DEAL_SNAPSHOT)).toEqual({ written: 1, repeated: 0 });
      expect(await loadDeal(client, DEAL)).toEqual(DEAL_SNAPSHOT);
    });
  });

  it('повторное сохранение сделки — повтор, а смена статуса — шаг', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await saveDeal(client, DEAL_SNAPSHOT);
      expect(await saveDeal(client, DEAL_SNAPSHOT)).toEqual({ written: 0, repeated: 1 });
      const settled = { ...DEAL_SNAPSHOT, state: dealState('settled') };
      expect(await saveDeal(client, settled)).toEqual({ written: 1, repeated: 0 });
      expect((await loadDeal(client, DEAL))?.state.status).toBe('settled');
    });
  });

  it('подмена стороны у заведённой сделки — конфликт, а не шаг', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await saveDeal(client, DEAL_SNAPSHOT);
      const swapped: DealSnapshot = {
        ...DEAL_SNAPSHOT,
        seller: { partyId: 'party-stranger', accountKey: 'stranger.state' },
      };
      const error = await saveDeal(client, swapped).catch((item: unknown) => item);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe(DbErrorCode.stepConflict);
    });
  });

  it('транш возвращается тем же: состояние, акт получателя, требуемая сумма', async () => {
    if (pool === null) return;
    const snapshot = collecting();
    await withRollback(pool, async (client) => {
      await saveDeal(client, DEAL_SNAPSHOT);
      expect(await saveTranche(client, snapshot, null)).toEqual({ written: 1, repeated: 0 });
      expect(await loadTranche(client, DEAL, TRANCHE)).toEqual(snapshot);
    });
  });

  it('замороженный транш возвращается со всеми пятью полями заморозки', async () => {
    if (pool === null) return;
    const frozen: TrancheSnapshot = {
      ...collecting(),
      state: frozenTrancheState(
        'reserved',
        duration(3 * 60 * 60 * 1000),
        instant(Date.UTC(2026, 2, 2, 9, 0, 0)),
        ACT,
        'sanctions',
        'officer-1',
      ),
    };
    await withRollback(pool, async (client) => {
      await saveDeal(client, DEAL_SNAPSHOT);
      await saveTranche(client, collecting(), null);
      await saveTranche(client, frozen, collecting());
      // Отсутствие дедлайна вместе с наличием остатка — и есть приостановка
      // (`CORE.md` Ф17). Круг обязан вернуть именно эту форму союза.
      expect(await loadTranche(client, DEAL, TRANCHE)).toEqual(frozen);
    });
  });

  it('терминальный транш теряет часы и возвращается без них', async () => {
    if (pool === null) return;
    const done: TrancheSnapshot = {
      ...collecting(),
      state: terminalTrancheState('refunded'),
    };
    await withRollback(pool, async (client) => {
      await saveDeal(client, DEAL_SNAPSHOT);
      await saveTranche(client, collecting(), null);
      await saveTranche(client, done, collecting());
      const read = await loadTranche(client, DEAL, TRANCHE);
      expect(read?.state).toEqual(terminalTrancheState('refunded'));
      expect('deadline' in (read?.state ?? {})).toBe(false);
    });
  });

  it('повтор шага транша не двигает состояние и виден числом', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await saveDeal(client, DEAL_SNAPSHOT);
      await saveTranche(client, collecting(), null);
      expect(await saveTranche(client, reserved(), collecting())).toEqual({
        written: 1,
        repeated: 0,
      });
      // Тот же шаг ещё раз: в базе уже лежит его цель.
      expect(await saveTranche(client, reserved(), collecting())).toEqual({
        written: 0,
        repeated: 1,
      });
      expect(await loadTranche(client, DEAL, TRANCHE)).toEqual(reserved());
    });
  });

  it('шаг из состояния, которого в базе нет, — конфликт с именем', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await saveDeal(client, DEAL_SNAPSHOT);
      await saveTranche(client, collecting(), null);
      await saveTranche(client, reserved(), collecting());
      // Второй шаг из `collecting`: так выглядит потерянный шаг или гонка.
      // Слепой `UPDATE` затёр бы чужой резерв молча.
      const other: TrancheSnapshot = {
        ...collecting(),
        state: nonTerminalTrancheState(
          'release_pending',
          deadline(instant(Date.UTC(2026, 2, 6, 9, 0, 0))),
          instant(Date.UTC(2026, 2, 3, 9, 0, 0)),
          ACT,
        ),
      };
      const error = await saveTranche(client, other, collecting()).catch(
        (item: unknown) => item,
      );
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe(DbErrorCode.stepStateConflict);
      expect(await loadTranche(client, DEAL, TRANCHE)).toEqual(reserved());
    });
  });

  it('состояние после pending без акта получателя не сохраняется', async () => {
    if (pool === null) return;
    // `CORE.md` Ф13: приём средств открывается только актом. В коде это
    // `assertConditionAct`, в схеме — `tranche_condition_act_required`, и
    // отказ обязан приезжать одним и тем же ключом.
    const noAct = { ...collecting(), state: { ...collecting().state, conditionAct: null } };
    await withRollback(pool, async (client) => {
      await saveDeal(client, DEAL_SNAPSHOT);
      const error = await saveTranche(
        client,
        noAct as TrancheSnapshot,
        null,
      ).catch((item: unknown) => item);
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe(RejectionCode.conditionActMissing);
    });
  });

  it('поручение возвращается тем же и переходит по статусу', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await saveDeal(client, DEAL_SNAPSHOT);
      await saveTranche(client, collecting(), null);
      expect(await savePayout(client, payout('created'), null)).toEqual({
        written: 1,
        repeated: 0,
      });
      expect(await loadPayouts(client, DEAL, TRANCHE)).toEqual([payout('created')]);
      await savePayout(client, payout('settled'), payout('created'));
      expect(await loadPayouts(client, DEAL, TRANCHE)).toEqual([payout('settled')]);
      // Повтор того же перехода: цель уже лежит.
      expect(await savePayout(client, payout('settled'), payout('created'))).toEqual({
        written: 0,
        repeated: 1,
      });
    });
  });

  it('вторая активная выплата по траншу отвергается правилом домена', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await saveDeal(client, DEAL_SNAPSHOT);
      await saveTranche(client, collecting(), null);
      await savePayout(client, payout('created'), null);
      const second: PayoutSnapshot = {
        ...payout('created'),
        payoutId: 'payout-state-2',
        state: { ...payout('created').state, idempotencyKey: '3f333df6-90a4-4fda-8dd3-9485d27cee36' },
      };
      // Инвариант 9 держит частичный уникальный индекс; в коде то же правило —
      // guard `g_no_active_payout`. Отказ приезжает с кодом отказа автомата и
      // именем guard'а, а не текстом драйвера.
      const error = await savePayout(client, second, null).catch((item: unknown) => item);
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe(RejectionCode.guardFailed);
      expect((error as DomainError).message).toBe('g_no_active_payout');
    });
  });
});
