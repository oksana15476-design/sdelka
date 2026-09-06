import { describe, expect, it } from 'vitest';
import { type TrancheEvent, RejectionCode } from '../src/index';
import { beneficiary, context } from './support/facts';
import { accept, reject, stateAt } from './support/drive';

const conditionEstablished: TrancheEvent = {
  type: 'condition_established',
  evidenceBundleId: 'evidence-1',
  conditionType: 'registration_transfer',
};

const mismatch: TrancheEvent = { type: 'mismatch_detected', field: 'registry.encumbrance' };
const approvalAdded: TrancheEvent = { type: 'approval_added', userId: 'approver-2' };

function unlocks(intents: readonly { readonly type: string }[]): boolean {
  return intents.some((intent) => intent.type === 'unlock_beneficiary');
}

/**
 * Периметр резерва — где реквизиты получателя заперты (`CORE.md` Ф15,
 * STATE-MACHINES.md §1.5).
 *
 * Правило проверяется **поимённо по рёбрам**, а не сверкой с тем же перечнем,
 * по которому оно и написано: перечень, сверенный сам с собой, доказывает
 * только собственную неизменность.
 */
describe('блокировка реквизитов держится на периметре резерва', () => {
  it('не снимает блокировку, когда транш уходит в разбор', () => {
    const ctx = context();
    const blocked = accept(stateAt('reserved'), mismatch, ctx);
    expect(blocked.state.status).toBe('release_blocked');
    // Разбор — приостановка резерва, а не уход из него: деньги остаются
    // запертыми в файле транша, транш остаётся на пути выплаты. Снятие
    // блокировки здесь и делало задокументированный выход
    // «расхождение снято → выплата» недостижимым.
    expect(unlocks(blocked.intents)).toBe(false);
    // И расфиксации средств на этом ребре тоже нет — это та же мысль с другой
    // стороны: резерв не кончился.
    expect(blocked.intents).not.toContainEqual(
      expect.objectContaining({ type: 'post_journal_entry', template: 'unlock_funds' }),
    );
  });

  /*
   * ⚠ Прохода `reserved → release_blocked → release_pending → paying_out`
   * здесь нет намеренно, хотя просится. Редьюсер намерений не применяет: факты
   * приходят в него снаружи на каждый вызов, и `beneficiary.locked` в них
   * остаётся тем, что положил вызывающий. Такой проход зеленел и **до**
   * правки — то есть проверял бы не то правило, о котором написан. Весь путь
   * целиком, с применением намерений к миру, проверяет
   * `packages/e2e/test/release-blocked-requisites.test.ts`.
   */

  it('снимает блокировку на каждом выходе из периметра наружу', () => {
    const ctx = context();
    // Из резерва: откат резерва и уход в возврат.
    expect(unlocks(accept(stateAt('reserved'), { type: 'reserve_expired' }, ctx).intents)).toBe(true);
    expect(unlocks(accept(stateAt('reserved'), { type: 'condition_failed' }, ctx).intents)).toBe(true);
    // Из разбора: те же три двери наружу. Прежде ни одна из них блокировку не
    // снимала — снималась она на входе в разбор, то есть на переходе, который
    // резерв не кончает.
    expect(unlocks(accept(stateAt('release_blocked'), { type: 'reserve_expired' }, ctx).intents)).toBe(
      true,
    );
    expect(
      unlocks(accept(stateAt('release_blocked'), { type: 'refund_requested', reason: 'r' }, ctx).intents),
    ).toBe(true);
    expect(
      unlocks(
        accept(
          stateAt('release_blocked'),
          { type: 'write_off_approved', userIds: ['approver-2', 'approver-3'] },
          ctx,
        ).intents,
      ),
    ).toBe(true);
  });

  it('не снимает блокировку ни на одном переходе внутри периметра', () => {
    const ctx = context();
    const inside: readonly (readonly [ReturnType<typeof stateAt>, TrancheEvent])[] = [
      [stateAt('reserved'), conditionEstablished],
      [stateAt('reserved'), { type: 'compliance_hold', reason: 'sanctions', frozenBy: 'officer-1' }],
      [stateAt('release_blocked'), approvalAdded],
      [stateAt('release_pending'), { type: 'release_authorized' }],
      [stateAt('release_pending'), { type: 'operator_blocked', reason: 'r' }],
      [stateAt('paying_out'), { type: 'payout_result', outcome: 'settled' }],
      [stateAt('paying_out'), { type: 'payout_result', outcome: 'rejected' }],
    ];
    for (const [state, event] of inside) {
      expect(unlocks(accept(state, event, ctx).intents)).toBe(false);
    }
  });

  it('оставляет выплату закрытой, если блокировка всё-таки снята', () => {
    // Обратная сторона того же правила: guard на выходном ребре остаётся
    // единственным, что стоит между разбором и банком. Реквизиты, оказавшиеся
    // незапертыми (внешняя правка, смена реквизитов в разборе), выплату не
    // проходят — ни прямой дверью, ни через разбор.
    const ctx = context({
      beneficiary: beneficiary({ status: 'verified', locked: false, lastChangedAt: null }),
    });
    const direct = reject(stateAt('reserved'), conditionEstablished, ctx);
    expect(direct.code).toBe(RejectionCode.guardFailed);
    expect([...direct.failedGuards]).toEqual(['g_beneficiary_locked']);

    const blocked = accept(stateAt('release_blocked'), approvalAdded, ctx);
    const refused = reject(blocked.state, { type: 'release_authorized' }, ctx);
    expect([...refused.failedGuards]).toEqual(['g_beneficiary_locked']);
  });
});
