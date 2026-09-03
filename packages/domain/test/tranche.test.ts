import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type TrancheEvent,
  DEFAULT_DEADLINE_POLICY,
  RejectionCode,
  initialTrancheState,
  isTerminalTrancheStatus,
  payoutIdempotencyKey,
  reduceTranche,
} from '../src/index';
import { AMOUNT, NOW, TRANCHE_ID, context } from './support/facts';
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
    expect(reserved.intents.map((intent) => intent.type)).toEqual([
      'set_deadline',
      'lock_beneficiary',
      'notify',
    ]);

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

  it('accepts calendar_date and registration_transfer', () => {
    const ctx = context();
    for (const conditionType of ['registration_transfer', 'calendar_date'] as const) {
      expect(
        accept(stateAt('reserved'), { type: 'condition_established', evidenceBundleId: 'e1', conditionType }, ctx)
          .state.status,
      ).toBe('release_pending');
    }
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
