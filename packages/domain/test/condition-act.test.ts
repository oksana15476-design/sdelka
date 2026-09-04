import { describe, expect, it } from 'vitest';
import {
  type ConditionAct,
  type DealContext,
  type TrancheEvent,
  type TrancheState,
  DEFAULT_DEADLINE_POLICY,
  RejectionCode,
  boundConditionAct,
  dealState,
  deadline,
  initialTrancheState,
  instant,
  nonTerminalTrancheState,
  plus,
  reduceDeal,
} from '../src/index';
import {
  AMOUNT,
  BUYER_PARTY_ID,
  CONDITION_ACT,
  NOW,
  RECIPIENT_PARTY_ID,
  context,
  dealFacts,
} from './support/facts';
import { accept, reject, stateAt } from './support/drive';

const instructionsIssued: TrancheEvent = { type: 'instructions_issued' };

const fundsReceived: TrancheEvent = {
  type: 'funds_received',
  amount: AMOUNT,
  sender: 'buyer-1',
  reference: 'ref-1',
};

/** Другая редакция того же условия: то, чем пытались бы подменить акт. */
const otherAct: ConditionAct = {
  ...CONDITION_ACT,
  conditionTextVersion: 'condition.registration_transfer.v2',
};

function dealContext(conditionAct: ConditionAct | null): DealContext {
  return {
    dealId: 'deal-1',
    now: NOW,
    facts: dealFacts({ trancheStatuses: [], preparedBy: null, conditionAct }),
  };
}

describe('приём средств невозможен до акта получателя (CORE.md Ф13)', () => {
  it('refuses to issue payment instructions without the act', () => {
    const error = reject(
      initialTrancheState(NOW, DEFAULT_DEADLINE_POLICY),
      instructionsIssued,
      context({ conditionAct: null }),
    );
    expect(error.code).toBe(RejectionCode.guardFailed);
    expect(error.failedGuards).toContain('g_condition_agreed');
  });

  it('refuses the deal to open funding without the act', () => {
    const result = reduceDeal(dealState('ready'), { type: 'funds_received' }, dealContext(null));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.failedGuards).toContain('g_condition_agreed');
    }
  });

  it('opens funding on both machines once the act is there', () => {
    const tranche = accept(
      initialTrancheState(NOW, DEFAULT_DEADLINE_POLICY),
      instructionsIssued,
      context(),
    ).state;
    expect(tranche.status).toBe('collecting');
    const deal = reduceDeal(
      dealState('ready'),
      { type: 'funds_received' },
      dealContext(CONDITION_ACT),
    );
    expect(deal.ok && deal.value.state.status).toBe('funding');
  });

  it('refuses an act of a condition type that is still open in §8', () => {
    // `registration_preliminary` не подтверждён как основание расчёта. Акт с ним
    // не принимается — иначе непроверенное условие растворяется в конфигурации.
    const act: ConditionAct = { ...CONDITION_ACT, conditionType: 'registration_preliminary' };
    expect(
      reject(
        initialTrancheState(NOW, DEFAULT_DEADLINE_POLICY),
        instructionsIssued,
        context({ conditionAct: act }),
      ).failedGuards,
    ).toContain('g_condition_agreed');
    const deal = reduceDeal(dealState('ready'), { type: 'funds_received' }, dealContext(act));
    expect(deal.ok).toBe(false);
  });

  it('binds the act to the tranche state, not only to the facts', () => {
    const state = accept(
      initialTrancheState(NOW, DEFAULT_DEADLINE_POLICY),
      instructionsIssued,
      context(),
    ).state;
    expect(boundConditionAct(state)).toEqual(CONDITION_ACT);
    // До акта привязывать нечего: в `pending` денег нет.
    expect(boundConditionAct(initialTrancheState(NOW, DEFAULT_DEADLINE_POLICY))).toBeNull();
  });

  it('cannot even build a post-pending state without an act', () => {
    expect(() =>
      nonTerminalTrancheState(
        'collecting',
        deadline(plus(NOW, DEFAULT_DEADLINE_POLICY.collecting)),
        NOW,
        null,
      ),
    ).toThrow();
  });
});

describe('условие не подменяется у транша, где уже есть деньги (E11-4)', () => {
  /** Транш с деньгами: `collected` достигается только через приём средств. */
  function collected(): TrancheState {
    return accept(stateAt('collecting'), fundsReceived, context()).state;
  }

  it('rejects any event carrying a different act', () => {
    const state = collected();
    expect(state.status).toBe('collected');
    const error = reject(state, { type: 'reserve_requested' }, context({ conditionAct: otherAct }));
    expect(error.code).toBe(RejectionCode.conditionActSubstituted);
  });

  it('rejects an event that drops the act altogether', () => {
    expect(
      reject(collected(), { type: 'reserve_requested' }, context({ conditionAct: null })).code,
    ).toBe(RejectionCode.conditionActSubstituted);
  });

  it('rejects even the deadline event, rather than moving money on inconsistent data', () => {
    // Красная линия №7 говорит, что бездействие ведёт к возврату покупателю, но
    // возврат по подменённому акту — это движение денег по несогласованным
    // данным. Отказ виден: фоновая задача по дедлайну падает, а не удерживает
    // средства тихо.
    expect(
      reject(collected(), { type: 'deadline_reached' }, context({ conditionAct: otherAct })).code,
    ).toBe(RejectionCode.conditionActSubstituted);
  });

  it('accepts a new act only when both parties took the new wording', () => {
    const state = collected();
    const amended: TrancheEvent = {
      type: 'condition_act_amended',
      act: otherAct,
      acceptedBy: [BUYER_PARTY_ID, RECIPIENT_PARTY_ID],
    };
    const result = accept(state, amended, context());
    // Состояние, дедлайн и время входа те же: это перепривязка акта, не переход.
    expect(result.state.status).toBe('collected');
    expect(result.state).toMatchObject({
      deadline: 'deadline' in state ? state.deadline : undefined,
      enteredAt: 'enteredAt' in state ? state.enteredAt : undefined,
    });
    expect(boundConditionAct(result.state)).toEqual(otherAct);
    expect(result.intents).toEqual([]);

    // После амендмента дальше идут события уже с новой редакцией.
    const reserved = accept(
      result.state,
      { type: 'reserve_requested' },
      context({ conditionAct: otherAct }),
    );
    expect(reserved.state.status).toBe('reserved');
  });

  it('refuses an amendment signed by one side only', () => {
    const error = reject(
      collected(),
      {
        type: 'condition_act_amended',
        act: otherAct,
        acceptedBy: [RECIPIENT_PARTY_ID],
      },
      context(),
    );
    expect(error.failedGuards).toContain('g_amendment_accepted_by_both');
  });

  it('refuses an amendment whose new act is not valid on its own', () => {
    const error = reject(
      collected(),
      {
        type: 'condition_act_amended',
        act: { ...otherAct, agreedAt: instant(NOW + 1) },
        acceptedBy: [BUYER_PARTY_ID, RECIPIENT_PARTY_ID],
      },
      context(),
    );
    expect(error.failedGuards).toContain('g_condition_agreed');
  });

  it('keeps the act across the whole path to payout', () => {
    let state = collected();
    for (const event of [
      { type: 'reserve_requested' } as const,
      {
        type: 'condition_established',
        evidenceBundleId: 'evidence-1',
        conditionType: 'registration_transfer',
      } as const,
    ]) {
      state = accept(state, event, context()).state;
    }
    expect(boundConditionAct(state)).toEqual(CONDITION_ACT);
  });
});
