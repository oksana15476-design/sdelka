import { describe, expect, it } from 'vitest';
import {
  type NonTerminalTrancheStatus,
  type TrancheEvent,
  type TrancheState,
  BENEFICIARY_PRE_RELEASE_BLACKOUT_MS,
  DAY,
  DEAL_TRANSITIONS,
  PAYOUT_TRANSITIONS,
  RejectionCode,
  TERMINAL_TRANCHE_STATUSES,
  THAWED_TRANCHE_STATUSES,
  TRANCHE_STATUSES,
  TRANCHE_TRANSITIONS,
  createPayout,
  dealState,
  instant,
  isTerminalTrancheStatus,
  reduceDeal,
  reducePayout,
} from '../src/index';
import { AMOUNT, CONDITION_ACT, NOW, context, dealFacts } from './support/facts';
import { accept, frozenStateAt, reject, stateAt } from './support/drive';

const fundsReceived: TrancheEvent = {
  type: 'funds_received',
  amount: AMOUNT,
  sender: 'buyer-1',
  reference: 'ref-1',
};

/**
 * Представитель статуса — состояние, которое в этом статусе действительно
 * собирается. Ветка на каждый вид часов, и `never` в конце: нетерминальный
 * статус, для которого состояния собрать нечем, не даст этому файлу собраться.
 */
function representativeState(status: NonTerminalTrancheStatus): TrancheState {
  if (status === 'frozen') {
    // У замороженного дедлайна нет по типу — есть остаток (CORE.md Ф17).
    return frozenStateAt('collected', DAY);
  }
  return stateAt(status);
}

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
    // `frozen` в списке входов — не ослабление правила, а его следствие: из
    // заморозки транш возвращается в тот статус, из которого его заморозили, а
    // заморозить `reserved` можно было только после `collected`. Денег без
    // `collected` в `reserved` по-прежнему не появляется: заморозка их не
    // приносит, она останавливает часы (CORE.md Ф17).
    expect(incoming.map((item) => item.from).sort()).toEqual(['collected', 'frozen']);
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
    const unknown = {
      status: 'unknown',
      idempotencyKey: 'k',
      trancheId: 't1',
      leg: 'release',
    } as const;
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
    expect(24 * 60 * 60 * 1000).toBeLessThan(BENEFICIARY_PRE_RELEASE_BLACKOUT_MS);
    const error = reject(
      stateAt('release_pending'),
      { type: 'release_authorized' },
      context({ beneficiary: { status: 'verified', locked: true, lastChangedAt: yesterday } }),
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

  it('нетерминальный транш всегда несёт часы: дедлайн либо остаток приостановки', () => {
    // @ts-expect-error нетерминальное состояние обязано нести дедлайн
    const broken: TrancheState = { status: 'collecting' };
    expect(broken.status).toBe('collecting');

    // Формулировка инварианта 7 здесь изменена, а не подогнана. Раньше она
    // звучала «нетерминальное состояние обязано нести дедлайн» и перечисляла
    // статусы литералом. После E9-10 у `frozen` дедлайна нет по типу: он
    // **приостановлен**, а не отменён, и неистёкшая часть лежит в `remaining`
    // (CORE.md Ф17). Правильное утверждение: нетерминальное состояние несёт
    // **дедлайн либо остаток приостановленного**, и пустого не бывает ни у
    // одного.
    //
    // Промежуточная редакция свела перебор к `expect(TRANCHE_STATUSES)
    // .toContain(edge.to)` — тавтологии: `edge.to` имеет тип `TrancheStatus` и
    // упасть не может ни при какой правке. Ценность прежнего литерального
    // списка была ровно в том, что новый нетерминальный статус без часов его
    // ронял, — что и произошло с `frozen`. Перебор восстановлен по
    // **рантайм-списку** статусов.
    const nonTerminal = TRANCHE_STATUSES.filter(
      (status): status is NonTerminalTrancheStatus => !isTerminalTrancheStatus(status),
    );
    expect(nonTerminal).toHaveLength(
      TRANCHE_STATUSES.length - TERMINAL_TRANCHE_STATUSES.length,
    );

    // Видов часов ровно два, и разбиение исчерпывающее: остывшие несут дедлайн
    // по типу, замороженный — остаток. Третьего вида нет, поэтому новый
    // нетерминальный статус обязан попасть в один из двух — иначе это
    // равенство падает. Это и есть то, что делал литеральный список, но по
    // рантайм-спискам, а не по копии от руки.
    expect([...THAWED_TRANCHE_STATUSES, 'frozen'].sort()).toEqual([...nonTerminal].sort());

    for (const status of nonTerminal) {
      const state = representativeState(status);
      expect(state.status).toBe(status);
      expect('deadline' in state || 'remaining' in state).toBe(true);
    }

    // Те же часы — на состояниях, которые вернул сам редьюсер, а не собрал
    // помощник: приём денег оставляет идущий дедлайн, заморозка — остаток.
    const collected = accept(stateAt('collecting'), fundsReceived, context()).state;
    expect('deadline' in collected).toBe(true);

    const frozen = accept(
      stateAt('collecting'),
      { type: 'compliance_hold', reason: 'sanctions', frozenBy: 'compliance-1' },
      context(),
    ).state;
    expect('deadline' in frozen).toBe(false);
    expect('remaining' in frozen).toBe(true);
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
        facts: dealFacts({
          trancheStatuses: ['paid_out', 'paying_out'],
          preparedBy: null,
          conditionAct: CONDITION_ACT,
        }),
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
      facts: dealFacts({ trancheStatuses: ['collected'], preparedBy: null, conditionAct: CONDITION_ACT }),
    });
    expect(result.ok).toBe(false);
  });

  it('ключ выплаты не зависит от попытки и времени', () => {
    const first = createPayout('tranche-1');
    const second = createPayout('tranche-1');
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });
});
