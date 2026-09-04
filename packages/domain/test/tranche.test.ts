import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type TrancheEvent,
  DEFAULT_DEADLINE_POLICY,
  RejectionCode,
  RELEASE_CONDITIONS,
  RELEASE_CONDITION_TYPES,
  initialTrancheState,
  isUsableReleaseCondition,
  isTerminalTrancheStatus,
  payoutIdempotencyKey,
  reduceTranche,
} from '../src/index';
import { AMOUNT, CONDITION_ACT, NOW, TRANCHE_ID, context, observation } from './support/facts';
import { accept, reject, stateAt, walk } from './support/drive';

const fundsReceived: TrancheEvent = {
  type: 'funds_received',
  amount: AMOUNT,
  sender: 'buyer-1',
  reference: 'ref-1',
};

const conditionEstablished: TrancheEvent = {
  type: 'condition_established',
  evidenceBundleId: 'evidence-1',
  conditionType: 'registration_transfer',
};

describe('транш: основной путь', () => {
  it('runs pending → collecting → collected → reserved → release_pending → paying_out → paid_out', () => {
    const ctx = context();
    const state = walk(
      initialTrancheState(NOW, DEFAULT_DEADLINE_POLICY),
      [
        { type: 'instructions_issued' },
        fundsReceived,
        { type: 'reserve_requested' },
        conditionEstablished,
        { type: 'release_authorized' },
        { type: 'payout_result', outcome: 'settled' },
      ],
      ctx,
    );
    expect(state.status).toBe('paid_out');
    expect(isTerminalTrancheStatus(state.status)).toBe(true);
    expect('deadline' in state).toBe(false);
  });

  it('emits the documented entry actions as intents, not as calls', () => {
    const ctx = context();
    const collected = accept(stateAt('collecting'), fundsReceived, ctx);
    expect(collected.intents.map((intent) => intent.type)).toEqual([
      'set_deadline',
      'post_journal_entry',
      'notify',
    ]);

    const reserved = accept(stateAt('collected'), { type: 'reserve_requested' }, ctx);
    // Список **расширился**, а не ослаб: запирание средств под транш стало
    // намерением автомата (`lock_funds`). Раньше его не было вовсе, и три
    // проекции запирали деньги в трёх разных моментах — в `collected`, отдельным
    // вызовом приложения и на входе в `reserved`. FUNCTIONAL.md §3.1 описывает
    // проводку привязки, но перехода не называет; STATE-MACHINES.md §6 и
    // `ROADMAP.md` И12.2 говорят про `collected` «можете забрать», то есть
    // запирать там нельзя.
    expect(reserved.intents.map((intent) => intent.type)).toEqual([
      'set_deadline',
      'post_journal_entry',
      'lock_beneficiary',
      'notify',
    ]);
    expect(reserved.intents).toContainEqual(
      expect.objectContaining({ type: 'post_journal_entry', template: 'lock_funds' }),
    );

    // И симметричная половина: снятие резерва расфиксирует средства. Её не было
    // ни у одной проекции — деньги оставались запертыми под траншем, который в
    // интерфейсе уже считался свободным (`CABINETS.md` §3.2 блок 6).
    const rolledBack = accept(stateAt('reserved'), { type: 'reserve_expired' }, ctx);
    expect(rolledBack.intents).toContainEqual(
      expect.objectContaining({ type: 'post_journal_entry', template: 'unlock_funds' }),
    );
    // То же правило закрывает и второе ребро в `collected`: ключ по событию, а
    // не по статусу.
    const fromBlocked = accept(stateAt('release_blocked'), { type: 'reserve_expired' }, ctx);
    expect(fromBlocked.intents).toContainEqual(
      expect.objectContaining({ type: 'post_journal_entry', template: 'unlock_funds' }),
    );
    // А приход денег в `collected` расфиксации не порождает: запирать ещё нечего.
    expect(collected.intents).not.toContainEqual(
      expect.objectContaining({ type: 'post_journal_entry', template: 'unlock_funds' }),
    );

    const releasePending = accept(stateAt('reserved'), conditionEstablished, ctx);
    expect(releasePending.intents).toContainEqual({
      type: 'build_payout_instruction',
      idempotencyKey: payoutIdempotencyKey(TRANCHE_ID),
    });

    const payingOut = accept(stateAt('release_pending'), { type: 'release_authorized' }, ctx);
    expect(payingOut.intents).toContainEqual({
      type: 'enqueue_outbound_payout',
      idempotencyKey: payoutIdempotencyKey(TRANCHE_ID),
      // Красная линия №5: поручение несёт ссылку на пакет доказательств.
      evidenceBundleId: 'evidence-1',
    });

    const paidOut = accept(stateAt('paying_out'), { type: 'payout_result', outcome: 'settled' }, ctx);
    // Расчёт — **своё** намерение, а не шаблон общей проводки: только у него
    // есть получатель и подтверждение сторон, и только он переносит
    // обязательство от одного лица к другому (красная линия №1).
    expect(paidOut.intents.map((intent) => intent.type)).toEqual([
      'post_settlement_entry',
      'notify',
      'close_tranche',
    ]);
  });

  it('releases the beneficiary lock only when leaving the payout path', () => {
    const ctx = context();
    const expired = accept(stateAt('reserved'), { type: 'reserve_expired' }, ctx);
    expect(expired.intents.map((intent) => intent.type)).toContain('unlock_beneficiary');

    const toPayout = accept(stateAt('reserved'), conditionEstablished, ctx);
    expect(toPayout.intents.map((intent) => intent.type)).not.toContain('unlock_beneficiary');
  });
});

describe('транш: дедлайн — часть состояния', () => {
  it('sets a deadline on every non-terminal state', () => {
    const ctx = context();
    const state = accept(stateAt('collecting'), fundsReceived, ctx).state;
    expect(state.status).toBe('collected');
    if ('deadline' in state) {
      expect(state.deadline.at).toBe(NOW + DEFAULT_DEADLINE_POLICY.collected);
    } else {
      expect.unreachable();
    }
  });

  it('has no deadline field on terminal states', () => {
    const terminal = accept(
      stateAt('paying_out'),
      { type: 'payout_result', outcome: 'settled' },
      context(),
    ).state;
    expect(terminal).toEqual({ status: 'paid_out' });
  });
});

describe('транш: приём средств', () => {
  it('sends a third-party payment to release_blocked instead of the deal', () => {
    const result = accept(
      stateAt('collecting'),
      { ...fundsReceived, sender: 'someone-else' },
      context(),
    );
    expect(result.state.status).toBe('release_blocked');
    expect(result.intents.map((intent) => intent.type)).toContain('enqueue_operator_task');
  });

  it('keeps an underpayment in collecting: недоплата ждёт добора, а не проваливается', () => {
    const error = reject(
      stateAt('collecting'),
      { ...fundsReceived, amount: money('GEL', 1n) },
      context(),
    );
    expect(error.code).toBe(RejectionCode.guardFailed);
    expect(error.failedGuards).toContain('g_amount_sufficient');
  });
});

describe('транш: отзыв покупателем', () => {
  it('accepts revocation from collecting, collected and reserved', () => {
    const ctx = context();
    const event: TrancheEvent = { type: 'revocation_requested', actor: 'buyer', reason: 'changed_mind' };
    for (const status of ['collecting', 'collected', 'reserved'] as const) {
      expect(accept(stateAt(status), event, ctx).state.status).toBe('refund_pending');
    }
  });

  it('refuses revocation after the condition is established', () => {
    const ctx = context();
    const event: TrancheEvent = { type: 'revocation_requested', actor: 'buyer', reason: 'changed_mind' };
    for (const status of ['release_pending', 'release_blocked', 'paying_out'] as const) {
      expect(reject(stateAt(status), event, ctx).code).toBe(RejectionCode.transitionNotAllowed);
    }
  });

  it('tells the other side from the cabinet, not by the money failing to arrive', () => {
    // ROADMAP.md И12.3: «карточка подтверждения средств у второй стороны
    // немедленно меняет состояние — она узнаёт об этом из кабинета, а не по
    // факту неполучения денег». Ветки `refund_pending` в намерениях входа не
    // было вовсе, то есть отзыв не порождал ни одного уведомления, хотя §6
    // задаёт представление этого состояния для обеих сторон.
    const result = accept(
      stateAt('reserved'),
      { type: 'revocation_requested', actor: 'buyer', reason: 'changed_mind' },
      context(),
    );
    expect(result.state.status).toBe('refund_pending');
    expect(result.intents).toContainEqual({
      type: 'notify',
      audience: 'both',
      // Ключ локализации: формулировка идёт через копирайтера и главреда.
      messageKey: 'tranche.refund_pending.both',
    });
  });

  it('notifies both sides on every path into refund_pending, not only on revocation', () => {
    const ctx = context();
    const paths: readonly [Parameters<typeof stateAt>[0], TrancheEvent][] = [
      ['collecting', { type: 'deadline_reached' }],
      ['collected', { type: 'refund_requested', reason: 'r' }],
      ['reserved', { type: 'condition_failed' }],
      ['release_blocked', { type: 'refund_requested', reason: 'r' }],
    ];
    for (const [status, event] of paths) {
      const result = accept(stateAt(status), event, ctx);
      expect(result.state.status).toBe('refund_pending');
      expect(result.intents.map((intent) => intent.type)).toContain('notify');
    }
  });
});

describe('транш: возврат и списание', () => {
  it('routes a refund with an unknown source account to release_blocked', () => {
    expect(
      accept(stateAt('refund_pending'), { type: 'refund_initiated' }, context()).state.status,
    ).toBe('refunding');
    expect(
      accept(stateAt('refund_pending'), { type: 'refund_initiated' }, context({ sourceAccountKnown: false }))
        .state.status,
    ).toBe('release_blocked');
  });

  it('requires two distinct approvers for a write-off', () => {
    const ctx = context();
    expect(
      accept(stateAt('release_blocked'), { type: 'write_off_approved', userIds: ['a', 'b'] }, ctx).state
        .status,
    ).toBe('written_off');
    expect(
      reject(stateAt('release_blocked'), { type: 'write_off_approved', userIds: ['a', 'a'] }, ctx)
        .failedGuards,
    ).toContain('g_write_off_approvers_distinct');
  });

  it('keeps an unknown payout result in place instead of retrying', () => {
    const first = accept(stateAt('release_pending'), { type: 'release_authorized' }, context());
    expect(first.state.status).toBe('paying_out');
    // Первый вход в `paying_out` — поручение выпускается.
    expect(first.intents.map((intent) => intent.type)).toContain('enqueue_outbound_payout');

    const result = accept(first.state, { type: 'payout_result', outcome: 'unknown' }, context());
    expect(result.state.status).toBe('paying_out');
    // ...а неответ банка его НЕ выпускает заново (красная линия №8, §2.2).
    // Самопереход — внутренний переход: состояние то же, значит, ни выхода из
    // него, ни входа в него не было. Раньше намерения входа возвращались
    // безусловно, и каждый неответ велел отправить поручение второй раз; от
    // второй выплаты спасал только детерминированный ключ идемпотентности на
    // стороне адаптера, то есть чужая дисциплина.
    expect(result.intents.map((intent) => intent.type)).toEqual(['set_deadline']);
    expect(result.intents.map((intent) => intent.type)).not.toContain('enqueue_outbound_payout');
  });

  it('resolves paying_out through reconciliation', () => {
    const ctx = context();
    expect(
      accept(stateAt('paying_out'), { type: 'reconciliation_resolved', outcome: 'settled' }, ctx).state
        .status,
    ).toBe('paid_out');
    expect(
      accept(stateAt('refunding'), { type: 'reconciliation_resolved', outcome: 'rejected' }, ctx).state
        .status,
    ).toBe('release_blocked');
  });
});

describe('транш: тип условия релиза', () => {
  it('refuses the unconfirmed registration_preliminary condition', () => {
    const error = reject(
      stateAt('reserved'),
      { type: 'condition_established', evidenceBundleId: 'e1', conditionType: 'registration_preliminary' },
      context(),
    );
    expect(error.code).toBe(RejectionCode.releaseConditionRequiresConfirmation);
  });

  /**
   * Раньше этот тест утверждал, что из `reserved` принимаются **оба**
   * подтверждённых типа условия при одном и том же акте, — и это была не
   * проверка, а закрепление дыры: акт транша говорит
   * `registration_transfer`, а событие `calendar_date` проходило, потому что у
   * него `requiresConfirmation: false`. Прикрыто это было случайностью — пять
   * полей выписки в базовых фактах сквозного потока лежали в `false`, — а не
   * правилом (E3-1, `ORACLE.md` §6.5).
   *
   * Теперь тип условия события сверяется с актом получателя: условие определяет
   * получатель (ст. 27(2), Ф13), и подменить его тип событием нельзя.
   */
  it('accepts each usable condition type against its own act, and refuses a substituted one', () => {
    // Годные типы берутся из перечня, а не перечисляются здесь: список,
    // переписанный в тест руками, разойдётся с правилом молча. Сегодня годен
    // ровно один — см. следующий тест про `calendar_date`.
    const usable = RELEASE_CONDITION_TYPES.filter(isUsableReleaseCondition);
    expect(usable).toEqual(['registration_transfer']);
    for (const conditionType of usable) {
      const act = { ...CONDITION_ACT, conditionType };
      const ctx = context({
        conditionAct: act,
        observation: observation({
          conditionType,
          sourceKey: RELEASE_CONDITIONS[conditionType].sourceKey,
        }),
      });
      expect(
        accept(
          stateAt('reserved', NOW, act),
          { type: 'condition_established', evidenceBundleId: 'evidence-1', conditionType },
          ctx,
        ).state.status,
      ).toBe('release_pending');
    }
  });

  /**
   * `calendar_date` — тип, который стоял в перечне и работать не мог.
   *
   * Требование к наблюдению у него то же, что у регистрации: `L3` от
   * `time.independent_timestamp` (`OBSERVATION_REQUIREMENTS`). Такого
   * наблюдения не собирает ни одна строка кода; сверх того `g_fields_match`
   * ждёт пяти сошедшихся полей **выписки**, а `g_observation_sufficient` —
   * непустого кадастрового кода, которых у календарной даты нет вовсе.
   *
   * Этот тест раньше проходил в паре с регистрацией — и проходил только
   * потому, что фикстура собирала наблюдение, которого в природе не бывает:
   * пять `true` без единого документа за ними. Теперь отказ называет причину.
   */
  it('refuses calendar_date by name: its source is not produced by anything', () => {
    const act = { ...CONDITION_ACT, conditionType: 'calendar_date' } as const;
    const error = reject(
      stateAt('reserved', NOW, act),
      { type: 'condition_established', evidenceBundleId: 'evidence-1', conditionType: 'calendar_date' },
      context({ conditionAct: act }),
    );
    expect(error.code).toBe(RejectionCode.releaseConditionSourceUnavailable);
    expect(error.details.sourceKey).toBe('time.independent_timestamp');
    // И приём средств по такому акту не открывается вовсе: акт невалиден, а
    // `g_condition_agreed` стоит на входе в `collecting`.
    const closed = reject(
      stateAt('pending', NOW, null),
      { type: 'instructions_issued' },
      context({ conditionAct: act }),
    );
    expect([...closed.failedGuards]).toContain('g_condition_agreed');
  });

  it('refuses a condition type that is not the one in the act', () => {
    // Направление пробы развёрнуто вместе с `calendar_date`: раньше акт ждал
    // регистрацию, а событие объявляло календарную дату. Теперь календарная
    // дата отвергается раньше — по недостающему источнику, — и подмена типа
    // проверяется обратной парой: акт транша говорит о календарной дате, а
    // событие объявляет наступившей регистрацию.
    //
    // Проверяемое правило то же и стоит там же: условие определяет получатель
    // (ст. 27(2), Ф13), подменить его тип событием нельзя (красная линия №6).
    const act = { ...CONDITION_ACT, conditionType: 'calendar_date' } as const;
    const error = reject(
      stateAt('reserved', NOW, act),
      {
        type: 'condition_established',
        evidenceBundleId: 'evidence-1',
        conditionType: 'registration_transfer',
      },
      context({ conditionAct: act }),
    );
    expect(error.code).toBe(RejectionCode.conditionTypeSubstituted);
  });

  it('refuses an evidence bundle other than the one in the facts', () => {
    // Намерения выпуска поручения берут ссылку **из фактов**: расхождение
    // означало бы, что журнал аудита и guard говорят о разных пакетах
    // (красная линия №5).
    const error = reject(
      stateAt('reserved'),
      {
        type: 'condition_established',
        evidenceBundleId: 'evidence-other',
        conditionType: 'registration_transfer',
      },
      context(),
    );
    expect(error.code).toBe(RejectionCode.evidenceBundleSubstituted);
  });
});

describe('транш: терминальные состояния закрыты', () => {
  it('refuses any event on a terminal state', () => {
    const terminal = accept(
      stateAt('paying_out'),
      { type: 'payout_result', outcome: 'settled' },
      context(),
    ).state;
    const result = reduceTranche(terminal, { type: 'refund_requested', reason: 'r' }, context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RejectionCode.terminalState);
    }
  });
});
