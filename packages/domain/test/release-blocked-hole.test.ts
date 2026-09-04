import { describe, expect, it } from 'vitest';
import { type TrancheEvent, RejectionCode, TRANCHE_TRANSITIONS } from '../src/index';
import { AMOUNT, context } from './support/facts';
import { accept, reject, stateAt } from './support/drive';

/**
 * Регрессия на дыру, найденную рецензией автомата (STATE-MACHINES.md §1.4, §4).
 *
 * Путь `collecting → release_blocked → release_pending → paying_out`: платёж
 * третьего лица уводится в блокировку, а оттуда выходит по утверждению
 * оператора. Если guard'ы доказательств стоят только на входе в
 * `release_pending`, выплата уходит мимо пакета доказательств, совпадения пяти
 * полей выписки и сверки собственника.
 */
describe('дыра release_blocked → release_pending → paying_out', () => {
  const thirdPartyPayment: TrancheEvent = {
    type: 'funds_received',
    amount: AMOUNT,
    sender: 'not-the-buyer',
    reference: 'ref-1',
  };

  it('rejects the payout reached through release_blocked without an evidence bundle', () => {
    const ctx = context({
      evidenceBundleId: null,
      statementFields: {
        cadastralCode: false,
        ownerDocumentNumber: false,
        share: false,
        basis: false,
        noUnexpectedEncumbrances: false,
      },
      registryOwnerIsBuyer: false,
      mismatchResolved: true,
    });

    const blocked = accept(stateAt('collecting'), thirdPartyPayment, ctx);
    expect(blocked.state.status).toBe('release_blocked');

    const releasePending = accept(blocked.state, { type: 'approval_added', userId: 'operator-2' }, ctx);
    expect(releasePending.state.status).toBe('release_pending');

    const error = reject(releasePending.state, { type: 'release_authorized' }, ctx);
    expect(error.code).toBe(RejectionCode.guardFailed);
    expect(error.failedGuards).toContain('g_evidence_present');
    expect(error.failedGuards).toContain('g_fields_match');
    expect(error.failedGuards).toContain('g_owner_is_buyer');
  });

  it('keeps the duplicated evidence guards on the transition into paying_out', () => {
    // Структурная проверка: guard'ы на этом ребре выглядят дублирующими и
    // именно поэтому их однажды удалят. Тест держит их на месте.
    const edge = TRANCHE_TRANSITIONS.find(
      (item) => item.from === 'release_pending' && item.to === 'paying_out',
    );
    expect(edge?.guards).toEqual([
      'g_evidence_present',
      'g_fields_match',
      'g_owner_is_buyer',
      'g_beneficiary_locked',
      // E13-2: доказательство владения счётом — отдельное условие рядом с
      // блокировкой реквизитов, и оно тоже продублировано на этом ребре. Без
      // дубля путь через `release_blocked` выпускал бы выплату на реквизиты, у
      // которых сошлось только имя.
      'g_beneficiary_verified',
      // Под траншем есть собранные средства. Продублирован по той же причине и
      // на тех же рёбрах: путь через `release_blocked` в `collected` не
      // заходит, и транш, за которым нет ни лари, доходил до `paid_out` — а
      // проводки при этом не возникало вовсе, потому что сумма берётся из
      // собранных средств.
      'g_funds_collected',
      // Средства заперты **под этим траншем**. Продублирован на тех же рёбрах и
      // по той же причине: после переноса запирания на вход в `reserved` путь
      // `collected → refund_pending → refunding → release_blocked →
      // release_pending → paying_out` в `reserved` не заходит вовсе, и расчёт
      // дебетовал бы пустой файл транша, то есть средства других сделок.
      'g_funds_locked',
      'g_approvals_sufficient',
      'g_no_active_payout',
      'g_coverage_ok',
    ]);
  });

  it('lets the same path through once the evidence is actually there', () => {
    const ctx = context({ mismatchResolved: true });
    const blocked = accept(stateAt('collecting'), thirdPartyPayment, ctx);
    const releasePending = accept(blocked.state, { type: 'approval_added', userId: 'operator-2' }, ctx);
    const payingOut = accept(releasePending.state, { type: 'release_authorized' }, ctx);
    expect(payingOut.state.status).toBe('paying_out');
  });

  it('stops the same path when the third-party payment never funded the tranche', () => {
    // Фикстура выше несёт `collectedAmount` из базовых фактов, и это делает её
    // мягче жизни: платёж третьего лица на транш **не зачисляется** — он уходит
    // в блокировку. Честные факты этого пути — денег под траншем нет.
    //
    // До `g_funds_collected` такой транш доходил до `paid_out`, и проводки при
    // этом не возникало ни одной: сумма берётся из собранных средств, а без них
    // намерение не порождалось. Выплата уходила в банк, а в учёте не оставалось
    // следа — то есть деньги на неё брались с номинального счёта, из средств
    // других сделок (красная линия №1).
    const ctx = context({ mismatchResolved: true, collectedAmount: null });
    const blocked = accept(stateAt('collecting'), thirdPartyPayment, ctx);
    const releasePending = accept(blocked.state, { type: 'approval_added', userId: 'operator-2' }, ctx);
    const error = reject(releasePending.state, { type: 'release_authorized' }, ctx);
    expect(error.code).toBe(RejectionCode.guardFailed);
    expect(error.failedGuards).toContain('g_funds_collected');

    // И на последней двери тоже: guard, стоящий только на одном входе, не
    // защищает состояние.
    const atPayout = reject(
      stateAt('paying_out'),
      { type: 'payout_result', outcome: 'settled' },
      ctx,
    );
    expect(atPayout.failedGuards).toContain('g_funds_collected');
  });
});
