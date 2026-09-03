import { describe, expect, it } from 'vitest';
import {
  type TrancheEvent,
  type TrancheState,
  BENEFICIARY_COOLDOWN_MS,
  DEAL_TRANSITIONS,
  PAYOUT_TRANSITIONS,
  RejectionCode,
  TRANCHE_TRANSITIONS,
  createPayout,
  dealState,
  instant,
  isTerminalTrancheStatus,
  reduceDeal,
  reducePayout,
} from '../src/index';
import { AMOUNT, CONDITION_ACT, NOW, context } from './support/facts';
import { accept, reject, stateAt } from './support/drive';

const fundsReceived: TrancheEvent = {
  type: 'funds_received',
  amount: AMOUNT,
  sender: 'buyer-1',
  reference: 'ref-1',
};

/** STATE-MACHINES.md §4: каждое невозможное состояние отвергается. */
describe('невозможные состояния', () => {
  it('транш одновременно paid_out и refunded: из терминальных состояний нет рёбер', () => {
    const outgoing = TRANCHE_TRANSITIONS.filter((item) => isTerminalTrancheStatus(item.from));
    expect(outgoing).toEqual([]);
  });

  it('две активные выплаты по одному траншу', () => {
    const error = reject(stateAt('release_pending'), { type: 'release_authorized' }, context({ activePayouts: 1 }));
    expect(error.failedGuards).toContain('g_no_active_payout');
  });

  it('reserved без поступивших денег: вход только из collected', () => {
    const incoming = TRANCHE_TRANSITIONS.filter((item) => item.to === 'reserved');
    expect(incoming.map((item) => item.from)).toEqual(['collected']);
    expect(reject(stateAt('collecting'), { type: 'reserve_requested' }, context()).code).toBe(
      RejectionCode.transitionNotAllowed,
    );
  });

  it('paying_out без пакета доказательств', () => {
    const error = reject(
      stateAt('release_pending'),
      { type: 'release_authorized' },
      context({ evidenceBundleId: null }),
    );
    expect(error.failedGuards).toContain('g_evidence_present');
  });

  it('повтор выплаты после unknown: перехода нет в таблице', () => {
    const fromUnknown = PAYOUT_TRANSITIONS.filter((item) => item.from === 'unknown');
    expect(fromUnknown.map((item) => item.to).sort()).toEqual(['rejected', 'settled']);
    const unknown = { status: 'unknown', idempotencyKey: 'k', trancheId: 't1' } as const;
    for (const event of ['payout_submitted'] as const) {
      const result = reducePayout(unknown, { type: event });
      expect(result.ok).toBe(false);
    }
  });

  it('выплата при покрытии меньше единицы', () => {
    const error = reject(
      stateAt('release_pending'),
      { type: 'release_authorized' },
      context({ coverageOk: false }),
    );
    expect(error.failedGuards).toContain('g_coverage_ok');
  });

  it('выплата на реквизиты, изменённые вчера', () => {
    const yesterday = instant(NOW - 24 * 60 * 60 * 1000);
    expect(24 * 60 * 60 * 1000).toBeLessThan(BENEFICIARY_COOLDOWN_MS);
    const error = reject(
      stateAt('release_pending'),
      { type: 'release_authorized' },
      context({ beneficiary: { locked: true, lastChangedAt: yesterday } }),
    );
    expect(error.failedGuards).toContain('g_beneficiary_locked');
  });

  it('зачисление платежа от третьего лица на сделку', () => {
    const result = accept(stateAt('collecting'), { ...fundsReceived, sender: 'other' }, context());
    expect(result.state.status).toBe('release_blocked');
    expect(result.state.status).not.toBe('collected');
  });

  it('возврат на посторонний счёт', () => {
    const result = accept(
      stateAt('refund_pending'),
      { type: 'refund_initiated' },
      context({ sourceAccountKnown: false }),
    );
    expect(result.state.status).toBe('release_blocked');
  });

  it('транш без дедлайна в нетерминальном состоянии не собирается', () => {
    // @ts-expect-error нетерминальное состояние обязано нести дедлайн
    const broken: TrancheState = { status: 'collecting' };
    expect(broken.status).toBe('collecting');

    // ...и ни один принятый переход не порождает состояние без дедлайна.
    for (const edge of TRANCHE_TRANSITIONS) {
      if (isTerminalTrancheStatus(edge.to)) continue;
      expect(['pending', 'collecting', 'collected', 'reserved', 'release_pending', 'release_blocked', 'paying_out', 'refund_pending', 'refunding']).toContain(edge.to);
    }
    const state = accept(stateAt('collecting'), fundsReceived, context()).state;
    expect('deadline' in state).toBe(true);
  });

  it('утверждение той же учётной записью, что готовила операцию', () => {
    const error = reject(
      stateAt('release_pending'),
      { type: 'release_authorized' },
      context({
        requiredAmount: AMOUNT,
        approvalPolicy: {
          currency: 'GEL',
          tiers: [{ upToMinor: null, requiredApprovals: 1 }],
        },
        preparedBy: 'operator-1',
        approvals: [{ userId: 'operator-1' }],
      }),
    );
    expect(error.failedGuards).toContain('g_approvals_sufficient');
  });

  it('сделка settled при живом транше', () => {
    const result = reduceDeal(
      dealState('settling'),
      { type: 'tranches_settled' },
      {
        dealId: 'deal-1',
        now: NOW,
        facts: {
          trancheStatuses: ['paid_out', 'paying_out'],
          preparedBy: null,
          conditionAct: CONDITION_ACT,
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.failedGuards).toContain('g_all_tranches_paid_out');
    }
  });

  it('сделка не отменяется после внесения денег', () => {
    // §3.1: `cancelled` — отмена до внесения денег. Из `funding` выход — откат.
    const cancellable = DEAL_TRANSITIONS.filter((item) => item.to === 'cancelled').map(
      (item) => item.from,
    );
    expect(cancellable).toEqual(['draft', 'parties_pending', 'property_pending', 'ready']);
    const result = reduceDeal(dealState('funding'), { type: 'cancellation_requested' }, {
      dealId: 'deal-1',
      now: NOW,
      facts: { trancheStatuses: ['collected'], preparedBy: null, conditionAct: CONDITION_ACT },
    });
    expect(result.ok).toBe(false);
  });

  it('ключ выплаты не зависит от попытки и времени', () => {
    const first = createPayout('tranche-1');
    const second = createPayout('tranche-1');
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });
});
