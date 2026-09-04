import {
  type ObservationLevel,
  type ReleaseObservation,
  type ReleaseObservationInput,
  DEFAULT_OBSERVATION_POLICY,
  RELEASE_CONDITIONS,
  instant,
  reachableFrom,
  releaseObservation,
  statusesWithoutTerminalPath,
  unreachableStatuses,
} from '@sdelka/domain';
import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type ObservationContext,
  type ObservationEvent,
  type ObservationState,
  type ObservationStatus,
  type ObservationTransitionResult,
  OBSERVATION_CONDITION_IDS,
  OBSERVATION_STATUSES,
  OBSERVATION_TRANSITIONS,
  ObservationRejectionCode,
  extractVerdict,
  initialObservationState,
  isTerminalObservationStatus,
  reduceObservation,
} from '../src/index';

const NOW = instant(Date.UTC(2026, 8, 4, 10, 0, 0));
const CADASTRAL_CODE = '01.10.14.005.041';

const CONTEXT: ObservationContext = {
  dealId: 'deal-1',
  conditionType: 'registration_transfer',
  expectedCadastralCode: CADASTRAL_CODE,
  now: NOW,
  policy: DEFAULT_OBSERVATION_POLICY,
};

const MATCHING_FIELDS = {
  cadastralCode: true,
  ownerDocumentNumber: true,
  share: true,
  basis: true,
  noUnexpectedEncumbrances: true,
} as const;

function observation(overrides: Partial<ReleaseObservationInput> = {}): ReleaseObservation {
  return releaseObservation({
    level: 'L3',
    conditionType: 'registration_transfer',
    sourceKey: RELEASE_CONDITIONS.registration_transfer.sourceKey,
    cadastralCode: CADASTRAL_CODE,
    fields: MATCHING_FIELDS,
    ownerCheck: 'established',
    observedAt: NOW,
    rawSourceDigest: 'b'.repeat(64),
    ...overrides,
  });
}

function stateAt(status: ObservationStatus): ObservationState {
  return { ...initialObservationState, status };
}

function accept(
  state: ObservationState,
  event: ObservationEvent,
  context: ObservationContext = CONTEXT,
): ObservationTransitionResult {
  const result = reduceObservation(state, event, context);
  if (!result.ok) {
    throw new Error(`unexpected rejection: ${result.error.code}`);
  }
  return result.value;
}

const cardObserved: ObservationEvent = {
  type: 'filing_card_observed',
  applicationId: 'app-1',
  cadastralCode: CADASTRAL_CODE,
  applicationStatus: 'in_progress',
};

describe('машина наблюдения: путь до выписки', () => {
  it('walks not_started → awaiting_filing → filing_claimed → filing_confirmed → extract_due → extract_ordered → matched', () => {
    let state = initialObservationState;
    state = accept(state, { type: 'observation_started' }).state;
    expect(state.status).toBe('awaiting_filing');

    const claimed = accept(state, {
      type: 'filing_claimed',
      applicationId: 'app-1',
      byParty: 'party-seller-1',
    });
    expect(claimed.state.status).toBe('filing_claimed');
    // Источник — атрибут факта: непроверенный номер не запрещает автооткат.
    expect(claimed.intents).toEqual([
      { type: 'register_filing', applicationId: 'app-1', source: 'party_claim' },
    ]);

    const confirmed = accept(claimed.state, cardObserved);
    expect(confirmed.state.status).toBe('filing_confirmed');
    expect(confirmed.intents).toEqual([
      { type: 'register_filing', applicationId: 'app-1', source: 'application_card' },
      { type: 'start_statutory_clock' },
    ]);

    const due = accept(confirmed.state, { type: 'statutory_term_elapsed' });
    expect(due.state.status).toBe('extract_due');
    expect(due.intents).toEqual([{ type: 'order_paid_extract', cadastralCode: CADASTRAL_CODE }]);

    const ordered = accept(due.state, { type: 'extract_ordered', cost: money('GEL', 5_200n) });
    expect(ordered.state.status).toBe('extract_ordered');
    // Стоимость — целые тетри (красная линия №4). Проводка — E14.
    expect(ordered.intents).toEqual([
      { type: 'recognise_oracle_cost', amount: money('GEL', 5_200n) },
    ]);

    const received = accept(ordered.state, { type: 'extract_received', observation: observation() });
    expect(received.state.status).toBe('matched');
    expect(received.intents).toEqual([
      {
        type: 'emit_tranche_event',
        event: 'condition_established',
        conditionType: 'registration_transfer',
        observation: received.state.observation,
      },
    ]);
  });

  it('confirms the filing without a party claim at all', () => {
    const state = accept(stateAt('awaiting_filing'), cardObserved);
    expect(state.state.status).toBe('filing_confirmed');
  });
});

describe('машина наблюдения: три правила, выраженные структурой', () => {
  it('reads the application status in no transition at all', () => {
    /**
     * `CORE.md` Ф7: статус «завершено» не значит ничего — заявление может быть
     * закрыто отказом. Проверка перебором, а не глазами: результат перехода
     * (статус и намерения) обязан совпасть при **любом** значении статуса
     * карточки, включая тот, ради которого правило и написано.
     *
     * Сам статус при этом в состояние попадает — он нужен журналу (Ф11), — и
     * поэтому сравниваются исход и намерения, а не всё состояние целиком.
     */
    const statuses = ['in_progress', 'completed', 'rejected', 'suspended', ''];
    for (const from of OBSERVATION_STATUSES) {
      const outcomes = statuses.map((applicationStatus) => {
        const result = reduceObservation(
          stateAt(from),
          { ...cardObserved, applicationStatus },
          CONTEXT,
        );
        return result.ok
          ? { ok: true, status: result.value.state.status, intents: result.value.intents }
          : { ok: false, code: result.error.code };
      });
      for (const outcome of outcomes) {
        expect(outcome).toEqual(outcomes[0]);
      }
    }
    // И ни одно условие таблицы не про статус: перечень условий закрыт и
    // состоит из одного значения, которое про кадастровый код.
    expect(OBSERVATION_CONDITION_IDS).toEqual(['cadastral_code_matches']);
  });

  it('keeps the status for the journal even though nothing reads it', () => {
    const confirmed = accept(stateAt('awaiting_filing'), {
      ...cardObserved,
      applicationStatus: 'completed',
    });
    expect(confirmed.state.applicationStatus).toBe('completed');
    // «Завершено» не сделало ничего: следующий шаг всё равно платная выписка.
    expect(confirmed.state.status).toBe('filing_confirmed');
  });

  it('has no way into matched except a received extract', () => {
    // Обход графа без рёбер `extract_received`: если `matched` при этом
    // достижим хоть откуда-нибудь, значит дешёвый сигнал двигает деньги.
    const withoutExtract = OBSERVATION_TRANSITIONS.filter(
      (item) => item.event !== 'extract_received',
    ).map((item) => ({ from: item.from, to: item.to }));
    for (const status of OBSERVATION_STATUSES) {
      expect([...reachableFrom(withoutExtract, status)]).not.toContain('matched');
    }
    // И прямого ребра из подтверждённой подачи в «сошлось» нет.
    const direct = OBSERVATION_TRANSITIONS.filter(
      (item) => item.from === 'filing_confirmed' && item.to === 'matched',
    );
    expect(direct).toEqual([]);
    for (const edge of OBSERVATION_TRANSITIONS.filter((item) => item.to === 'matched')) {
      expect(edge.event).toBe('extract_received');
    }
  });

  it('leaves unavailable exactly one exit, and it is not a verdict', () => {
    const exits = OBSERVATION_TRANSITIONS.filter((item) => item.from === 'unavailable');
    // `observation_abandoned` ведёт отсюда в «оснований нет» — это не вердикт о
    // регистрации, а конец наблюдения по брошенной сделке.
    expect(exits.map((item) => `${item.event}→${item.to}`).sort()).toEqual([
      'observation_abandoned→insufficient',
      'registry_recovered→extract_due',
    ]);
    for (const exit of exits) {
      expect(exit.to).not.toBe('matched');
      expect(exit.to).not.toBe('mismatched');
    }
  });

  it('does not let the statutory clock run from a party’s word', () => {
    // И3.2, критерий 1: сторона не управляет нашим дедлайном. Отсчёт запускает
    // карточка, а не слово стороны — и это отсутствие строки в таблице.
    const result = reduceObservation(
      stateAt('filing_claimed'),
      { type: 'statutory_term_elapsed' },
      CONTEXT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ObservationRejectionCode.transitionNotAllowed);
    }
  });

  it('suspends and resumes the deal clock around an unavailable registry', () => {
    const down = accept(stateAt('extract_due'), {
      type: 'registry_unavailable',
      reasonKey: 'registry.timeout',
    });
    expect(down.state.status).toBe('unavailable');
    expect(down.intents).toEqual([
      { type: 'suspend_deal_clock', reasonKey: 'registry.timeout' },
    ]);
    const up = accept(down.state, { type: 'registry_recovered' });
    expect(up.state.status).toBe('extract_due');
    expect(up.intents).toEqual([
      { type: 'order_paid_extract', cadastralCode: CADASTRAL_CODE },
      { type: 'resume_deal_clock' },
    ]);
  });
});

describe('машина наблюдения: вердикт по выписке', () => {
  function verdictOf(overrides: Partial<ReleaseObservationInput>): string {
    return extractVerdict(observation(overrides), CONTEXT);
  }

  it('matches only when the document is usable, the owner established and all five fields agree', () => {
    expect(verdictOf({})).toBe('matched');
  });

  it('answers insufficient when the extract gave no document number of the owner', () => {
    // ⚠ [открыто] CORE.md Ф7 по иностранцам. Это и есть fail-closed: «мы не
    // смогли установить» не превращается в «наверное совпало».
    expect(verdictOf({ ownerCheck: 'insufficient' })).toBe('insufficient');
  });

  it('answers mismatched when the owner is someone else', () => {
    expect(verdictOf({ ownerCheck: 'refuted' })).toBe('mismatched');
  });

  it('answers mismatched on any single field, at any amount', () => {
    for (const field of Object.keys(MATCHING_FIELDS) as (keyof typeof MATCHING_FIELDS)[]) {
      expect(verdictOf({ fields: { ...MATCHING_FIELDS, [field]: false } })).toBe('mismatched');
    }
  });

  it('answers insufficient for a cheap signal, a foreign object and a stale extract', () => {
    for (const level of ['L0', 'L1', 'L2'] as ObservationLevel[]) {
      expect(verdictOf({ level })).toBe('insufficient');
    }
    expect(verdictOf({ cadastralCode: '77.77.77.777.777' })).toBe('insufficient');
    expect(
      verdictOf({ observedAt: instant(NOW - DEFAULT_OBSERVATION_POLICY.maxAge - 1) }),
    ).toBe('insufficient');
    // Наблюдение о другом условии: акт получателя говорит о регистрации.
    expect(
      verdictOf({
        conditionType: 'calendar_date',
        sourceKey: RELEASE_CONDITIONS.calendar_date.sourceKey,
      }),
    ).toBe('insufficient');
  });

  it('names the first field that diverged, and the owner among them', () => {
    const mismatch = accept(stateAt('extract_ordered'), {
      type: 'extract_received',
      observation: observation({ fields: { ...MATCHING_FIELDS, share: false } }),
    });
    expect(mismatch.state.status).toBe('mismatched');
    expect(mismatch.intents).toEqual([
      { type: 'emit_tranche_event', event: 'mismatch_detected', field: 'share' },
      { type: 'enqueue_operator_task', kind: 'field_mismatch' },
    ]);

    const owner = accept(stateAt('extract_ordered'), {
      type: 'extract_received',
      observation: observation({ ownerCheck: 'refuted' }),
    });
    expect(owner.intents[0]).toEqual({
      type: 'emit_tranche_event',
      event: 'mismatch_detected',
      field: 'owner',
    });
  });

  it('sends the unestablished owner to a different desk than a plain mismatch', () => {
    const insufficient = accept(stateAt('extract_ordered'), {
      type: 'extract_received',
      observation: observation({ ownerCheck: 'insufficient' }),
    });
    expect(insufficient.state.status).toBe('insufficient');
    expect(insufficient.intents).toEqual([
      { type: 'enqueue_operator_task', kind: 'owner_reconciliation' },
    ]);

    const weak = accept(stateAt('extract_ordered'), {
      type: 'extract_received',
      observation: observation({ level: 'L1' }),
    });
    expect(weak.intents).toEqual([
      { type: 'enqueue_operator_task', kind: 'observation_insufficient' },
    ]);
  });
});

describe('машина наблюдения: подтверждение подачи', () => {
  it('refuses a card about another object', () => {
    // И3.2, крайний случай: «сторона называет чужой номер». Сверка
    // кадастрового кода — обязательная часть подтверждения, и отказ виден.
    const result = reduceObservation(
      stateAt('awaiting_filing'),
      { ...cardObserved, cadastralCode: '77.77.77.777.777' },
      CONTEXT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ObservationRejectionCode.cadastralCodeMismatch);
    }
  });

  it('refuses everything once the observation is terminal', () => {
    for (const status of ['matched', 'mismatched', 'insufficient'] as const) {
      const result = reduceObservation(stateAt(status), { type: 'registry_recovered' }, CONTEXT);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ObservationRejectionCode.terminalState);
      }
    }
  });
});

describe('машина наблюдения: тупиков нет и лишних состояний нет', () => {
  const edges = OBSERVATION_TRANSITIONS.map((item) => ({ from: item.from, to: item.to }));

  it('gives every non-terminal state a way to a terminal one', () => {
    expect(
      statusesWithoutTerminalPath(edges, [...OBSERVATION_STATUSES], (status) =>
        isTerminalObservationStatus(status as ObservationStatus),
      ),
    ).toEqual([]);
  });

  it('reaches every state from the start', () => {
    expect(unreachableStatuses(edges, [...OBSERVATION_STATUSES], 'not_started')).toEqual([]);
  });

  it('never returns to not_started', () => {
    // Стартовое состояние не переоткрывается (§5): наблюдение, которое уже
    // началось, не может снова называться неначатым.
    expect([...reachableFrom(edges, 'not_started')]).not.toContain('not_started');
  });
});
