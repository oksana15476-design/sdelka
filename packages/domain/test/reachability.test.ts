import { describe, expect, it } from 'vitest';
import {
  DEAL_STATUSES,
  DEAL_TRANSITIONS,
  PAYOUT_STATUSES,
  PAYOUT_TRANSITIONS,
  TRANCHE_STATUSES,
  TRANCHE_TRANSITIONS,
  isTerminalDealStatus,
  isTerminalPayoutStatus,
  isTerminalTrancheStatus,
  reachableFrom,
  statusesWithoutTerminalPath,
  unreachableStatuses,
} from '../src/index';

/**
 * STATE-MACHINES.md §5: у каждого состояния есть выход. Проверяется обходом
 * графа, а не списком — список устареет в день добавления состояния.
 */
describe('отсутствие тупиков', () => {
  it('tranche: every non-terminal status reaches a terminal one', () => {
    expect(
      statusesWithoutTerminalPath(TRANCHE_TRANSITIONS, TRANCHE_STATUSES, (status) =>
        isTerminalTrancheStatus(status as (typeof TRANCHE_STATUSES)[number]),
      ),
    ).toEqual([]);
  });

  it('payout: every non-terminal status reaches a terminal one', () => {
    expect(
      statusesWithoutTerminalPath(PAYOUT_TRANSITIONS, PAYOUT_STATUSES, (status) =>
        isTerminalPayoutStatus(status as (typeof PAYOUT_STATUSES)[number]),
      ),
    ).toEqual([]);
  });

  it('deal: every non-terminal status reaches a terminal one', () => {
    expect(
      statusesWithoutTerminalPath(DEAL_TRANSITIONS, DEAL_STATUSES, (status) =>
        isTerminalDealStatus(status as (typeof DEAL_STATUSES)[number]),
      ),
    ).toEqual([]);
  });
});

describe('все состояния достижимы из стартового', () => {
  it('tranche from pending', () => {
    expect(unreachableStatuses(TRANCHE_TRANSITIONS, TRANCHE_STATUSES, 'pending')).toEqual([]);
    expect(reachableFrom(TRANCHE_TRANSITIONS, 'pending').size).toBe(TRANCHE_STATUSES.length - 1);
  });

  it('payout from created', () => {
    expect(unreachableStatuses(PAYOUT_TRANSITIONS, PAYOUT_STATUSES, 'created')).toEqual([]);
  });

  it('deal from draft', () => {
    expect(unreachableStatuses(DEAL_TRANSITIONS, DEAL_STATUSES, 'draft')).toEqual([]);
  });
});

describe('release_blocked — единственное состояние с выходом только через человека', () => {
  it('has no event-free exit other than operator decisions', () => {
    const exits = TRANCHE_TRANSITIONS.filter((item) => item.from === 'release_blocked');
    // Ожидание расширено, а не ослаблено: `compliance_hold` и `dispute_raised`
    // — тоже действия человека, и смысл теста («ни одного автоматического
    // выхода») от них не страдает. Ни `deadline_reached`, ни `payout_result` в
    // списке по-прежнему нет.
    expect([...new Set(exits.map((item) => item.event))].sort()).toEqual([
      'approval_added',
      'compliance_hold',
      'dispute_raised',
      'refund_requested',
      'reserve_expired',
      'write_off_approved',
    ]);
  });
});

describe('заморозка не открывает автоматических выходов (CORE.md Ф17, E9-9)', () => {
  it('leaves frozen with no automatic exit at all', () => {
    const exits = TRANCHE_TRANSITIONS.filter((item) => item.from === 'frozen');
    // Единственное событие выхода — разморозка, то есть решение двух людей.
    // Приоритет заморозки над возвратом по умолчанию (красная линия №7 против
    // Ф17) реализован **отсутствием строк** в таблице, а не проверкой в
    // редьюсере: проверку можно обойти новой веткой, таблицу — нет.
    expect([...new Set(exits.map((item) => item.event))]).toEqual(['unfreeze']);
    expect(exits.some((item) => item.to === 'pending')).toBe(false);
  });
});
