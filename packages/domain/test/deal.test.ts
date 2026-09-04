import { describe, expect, it } from 'vitest';
import {
  type ConditionAct,
  type DealContext,
  type DealEvent,
  type DealState,
  type DealStatus,
  type TrancheStatus,
  DEAL_STATUSES,
  DEAL_TRANSITIONS,
  RejectionCode,
  instant,
  dealState,
  initialDealState,
  reduceDeal,
} from '../src/index';
import { CADASTRAL_CODE, CONDITION_ACT, NOW, dealFacts, filing, observation } from './support/facts';

function context(
  trancheStatuses: readonly TrancheStatus[] = [],
  preparedBy: string | null = null,
  conditionAct: ConditionAct | null = CONDITION_ACT,
): DealContext {
  return { dealId: 'deal-1', now: NOW, facts: dealFacts({ trancheStatuses, preparedBy, conditionAct }) };
}

function step(state: DealState, event: DealEvent, ctx: DealContext = context()): DealState {
  const result = reduceDeal(state, event, ctx);
  if (!result.ok) {
    throw new Error(`unexpected rejection: ${result.error.code} ${result.error.failedGuards.join(',')}`);
  }
  return result.value.state;
}

describe('сделка: оркестрация', () => {
  it('runs draft → parties_pending → property_pending → ready → funding → funded → filed → settling → settled', () => {
    let state = initialDealState;
    state = step(state, { type: 'parties_check_started' });
    state = step(state, { type: 'parties_verified' });
    state = step(state, { type: 'property_verified' });
    expect(state.status).toBe('ready');
    state = step(state, { type: 'funds_received' });
    expect(state.status).toBe('funding');
    state = step(state, { type: 'tranches_reserved' }, context(['reserved', 'reserved']));
    expect(state.status).toBe('funded');
    state = step(state, {
      type: 'filing_registered',
      applicationId: 'app-1',
      source: 'application_card',
    });
    state = step(state, { type: 'condition_established', conditionType: 'registration_transfer' });
    expect(state.status).toBe('settling');
    state = step(state, { type: 'tranches_settled' }, context(['paid_out', 'paid_out']));
    expect(state.status).toBe('settled');
  });

  it('keeps funding as a separate state between ready and funded', () => {
    expect(DEAL_STATUSES).toContain('funding');
    const result = reduceDeal(dealState('ready'), { type: 'tranches_reserved' }, context(['reserved']));
    expect(result.ok).toBe(false);
  });

  it('unwinds from funding on deadline or revocation', () => {
    expect(step(dealState('funding'), { type: 'deadline_reached' }).status).toBe('unwinding');
    expect(step(dealState('funding'), { type: 'revocation_requested' }).status).toBe('unwinding');
    expect(
      step(dealState('unwinding'), { type: 'tranches_refunded' }, context(['refunded'])).status,
    ).toBe('unwound');
  });

  it('refuses to settle while a tranche is still alive', () => {
    const result = reduceDeal(
      dealState('settling'),
      { type: 'tranches_settled' },
      context(['paid_out', 'refunding']),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RejectionCode.guardFailed);
    }
  });

  it('refuses to settle a deal without tranches at all', () => {
    const result = reduceDeal(dealState('settling'), { type: 'tranches_settled' }, context([]));
    expect(result.ok).toBe(false);
  });

  it('refuses the unconfirmed release condition at the deal level too', () => {
    const result = reduceDeal(
      dealState('filed'),
      { type: 'condition_established', conditionType: 'registration_preliminary' },
      context(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RejectionCode.releaseConditionRequiresConfirmation);
    }
  });
});

describe('сделка: заморозка', () => {
  const nonTerminal: readonly DealStatus[] = [
    'draft',
    'parties_pending',
    'property_pending',
    'ready',
    'funding',
    'funded',
    'filed',
    'settling',
    'unwinding',
  ];

  it('freezes from any non-terminal state on hold or dispute', () => {
    for (const status of nonTerminal) {
      expect(
        step(dealState(status), {
          type: 'compliance_hold',
          reason: 'sanctions',
          frozenBy: 'compliance-1',
        }).status,
      ).toBe('frozen');
      expect(
        step(dealState(status), { type: 'dispute_raised', frozenBy: 'party-1' }).status,
      ).toBe('frozen');
    }
  });

  it('unfreezes only with two distinct users and only into settling or unwinding', () => {
    const ctx = context([], 'operator-1');
    expect(
      step(dealState('frozen'), { type: 'unfreeze', userIds: ['a', 'b'], resume: 'settling' }, ctx).status,
    ).toBe('settling');
    expect(
      step(dealState('frozen'), { type: 'unfreeze', userIds: ['a', 'b'], resume: 'unwinding' }, ctx).status,
    ).toBe('unwinding');

    const sameUser = reduceDeal(
      dealState('frozen'),
      { type: 'unfreeze', userIds: ['a', 'a'], resume: 'settling' },
      ctx,
    );
    expect(sameUser.ok).toBe(false);

    const preparerApproves = reduceDeal(
      dealState('frozen'),
      { type: 'unfreeze', userIds: ['operator-1', 'b'], resume: 'settling' },
      ctx,
    );
    expect(preparerApproves.ok).toBe(false);
  });

  it('cascades the freeze down to the tranches instead of stopping at the deal', () => {
    // Без каскада комплаенс замораживает сделку, а её транши продолжают идти к
    // автовозврату по дедлайну — то есть заморозка не делает ровно того, ради
    // чего существует (CORE.md Ф17). Раньше `reduceDeal` не возвращал намерений
    // вообще, и это было не «пока не нужно», а дыра.
    const held = reduceDeal(
      dealState('funding'),
      { type: 'compliance_hold', reason: 'sanctions', frozenBy: 'compliance-1' },
      context(),
    );
    expect(held.ok).toBe(true);
    if (held.ok) {
      expect(held.value.intents).toEqual([
        { type: 'freeze_tranches', reason: 'sanctions', frozenBy: 'compliance-1' },
      ]);
    }

    const disputed = reduceDeal(
      dealState('funding'),
      { type: 'dispute_raised', frozenBy: 'party-1' },
      context(),
    );
    expect(disputed.ok).toBe(true);
    if (disputed.ok) {
      expect(disputed.value.intents).toEqual([
        { type: 'freeze_tranches', reason: 'dispute', frozenBy: 'party-1' },
      ]);
    }
  });

  it('maps the deal-level resume onto the tranche-level one explicitly', () => {
    // Целевые состояния у сделки и у транша разные, и отображение записано в
    // коде, а не оставлено приложению: `settling` — «продолжаем как шли»,
    // `unwinding` — «откатываем».
    const ctx = context([], 'operator-1');
    for (const [dealResume, trancheResume] of [
      ['settling', 'suspended_from'],
      ['unwinding', 'refund_pending'],
    ] as const) {
      const result = reduceDeal(
        dealState('frozen'),
        { type: 'unfreeze', userIds: ['a', 'b'], resume: dealResume },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.intents).toEqual([
          { type: 'unfreeze_tranches', userIds: ['a', 'b'], resume: trancheResume },
        ]);
      }
    }
  });

  it('emits no intents on the ordinary orchestration steps', () => {
    const plain = reduceDeal(dealState('draft'), { type: 'parties_check_started' }, context());
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.value.intents).toEqual([]);
    }
  });

  it('refuses events in terminal states', () => {
    for (const status of ['settled', 'unwound', 'cancelled'] as const) {
      const result = reduceDeal(
        dealState(status),
        { type: 'compliance_hold', reason: 'sanctions', frozenBy: 'compliance-1' },
        context(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(RejectionCode.terminalState);
      }
    }
  });
});

/**
 * E3-2 · `CORE.md` Ф9, `ROADMAP.md` И3.2, `ORACLE.md` §9.
 *
 * До этого батча ребро `filed --deadline_reached--> unwinding` стояло **без
 * единого guard'а**: сделка, по которой заявление уже подано и принято
 * реестром, откатывалась по нашей отсечке автоматически. Ф9 называет это
 * сценарием, производящим конфликт: «резерв снят, деньги у покупателя, объект
 * тоже у покупателя».
 */
describe('сделка: автооткат и открытое заявление', () => {
  function withFilings(filings: readonly ReturnType<typeof filing>[]): DealContext {
    return { dealId: 'deal-1', now: NOW, facts: dealFacts({ filings }) };
  }

  it('unwinds on the deadline when no application has been filed', () => {
    expect(step(dealState('filed'), { type: 'deadline_reached' }).status).toBe('unwinding');
  });

  it('still unwinds when the number was merely named by a party', () => {
    // И3.2, критерий 1: номер, сообщённый стороной, помечен непроверенным и сам
    // по себе автооткрата не запрещает — иначе сторона управляет нашим
    // дедлайном одним сообщением.
    const result = reduceDeal(
      dealState('filed'),
      { type: 'deadline_reached' },
      withFilings([filing({ source: 'party_claim' })]),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses to unwind while a card-confirmed application is open', () => {
    const result = reduceDeal(
      dealState('filed'),
      { type: 'deadline_reached' },
      withFilings([filing({ source: 'application_card' })]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RejectionCode.guardFailed);
      expect([...result.error.failedGuards]).toEqual(['g_no_open_filing']);
    }
  });

  it('unwinds again once a paid extract has resolved the application, whatever its verdict', () => {
    // Разрешает заявление только выписка — и любым вердиктом: после
    // расхождения держать деньги дальше не на чем. Статус карточки «завершено»
    // не разрешает ничего (Ф7).
    for (const ownerCheck of ['established', 'refuted', 'insufficient'] as const) {
      const resolved = filing({ resolution: observation({ ownerCheck }) });
      const result = reduceDeal(
        dealState('filed'),
        { type: 'deadline_reached' },
        withFilings([resolved]),
      );
      expect(result.ok).toBe(true);
    }
  });

  it('does not accept a cheap signal as a resolution of the application', () => {
    // Карточка заявления — не выписка: `L1` заявление не закрывает.
    const result = reduceDeal(
      dealState('filed'),
      { type: 'deadline_reached' },
      withFilings([filing({ resolution: observation({ level: 'L1' }) })]),
    );
    expect(result.ok).toBe(false);
  });

  it('does not accept an extract about another object as a resolution', () => {
    // И3.2, крайний случай «сторона называет чужой номер»: сверка кадастрового
    // кода — обязательная часть подтверждения.
    const result = reduceDeal(
      dealState('filed'),
      { type: 'deadline_reached' },
      withFilings([filing({ resolution: observation({ cadastralCode: '77.77.77.777.777' }) })]),
    );
    expect(result.ok).toBe(false);
  });

  it('keeps an old extract as a resolution: “application closed” is a historical fact', () => {
    // Свежесть — требование к основанию для движения денег, а не к тому,
    // разобрана ли регистрация. Иначе закрытое заявление снова открывалось бы
    // по истечении времени, и сделка откатывалась бы после регистрации.
    const stale = observation({ observedAt: instant(NOW - 30 * 24 * 60 * 60 * 1000) });
    const result = reduceDeal(
      dealState('filed'),
      { type: 'deadline_reached' },
      withFilings([filing({ resolution: stale })]),
    );
    expect(result.ok).toBe(true);
  });

  it('guards the other automatic door into unwinding as well', () => {
    // Guard, стоящий на одной двери, состояние не защищает (§1.4, §4).
    const edges = DEAL_TRANSITIONS.filter(
      (item) => item.to === 'unwinding' && item.event === 'deadline_reached',
    );
    expect(edges.length).toBe(2);
    for (const edge of edges) {
      expect([...edge.guards]).toContain('g_no_open_filing');
    }
    // Отзыв покупателя — явное волеизъявление, а не автооткат: Ф9 запрещает
    // именно автоматический откат, и guard'а здесь нет намеренно.
    const revocation = DEAL_TRANSITIONS.find((item) => item.event === 'revocation_requested');
    expect(revocation?.guards).toEqual([]);
  });

  it('records the source of the filing on the event, not as a flag', () => {
    // И3.2, задача `packages/domain`: «источник факта как атрибут события, а не
    // bool». Оба источника — законные значения события, и различает их тип.
    for (const source of ['party_claim', 'application_card'] as const) {
      expect(
        step(dealState('funded'), { type: 'filing_registered', applicationId: 'app-1', source })
          .status,
      ).toBe('filed');
    }
  });
});
