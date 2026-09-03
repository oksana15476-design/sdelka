import { describe, expect, it } from 'vitest';
import {
  type BeneficiaryStatus,
  type TrancheEvent,
  BENEFICIARY_STATUSES,
  RejectionCode,
  TRANCHE_TRANSITIONS,
} from '../src/index';
import { context } from './support/facts';
import { accept, reject, stateAt } from './support/drive';

const conditionEstablished: TrancheEvent = {
  type: 'condition_established',
  evidenceBundleId: 'evidence-1',
  conditionType: 'registration_transfer',
};

/**
 * E13-2 — ROADMAP.md И13.1: «дано: доказательства владения нет. Когда транш идёт
 * в `paying_out`. Тогда переход отвергается».
 *
 * До этого батча статус реквизитов выбрасывался на границе пакетов:
 * `toBeneficiaryLock` в `packages/compliance` отдавал домену `{locked,
 * lastChangedAt}` без статуса, и различение `name_consistent` / `verified`, ради
 * которого написан `verifyBeneficiaryHolder`, до автомата не доходило.
 */
describe('«имя сошлось» и «проверено» — разные вещи', () => {
  it('keeps a name-only match out of release_pending', () => {
    const error = reject(
      stateAt('reserved'),
      conditionEstablished,
      context({ beneficiary: { status: 'name_consistent', locked: true, lastChangedAt: null } }),
    );
    expect(error.code).toBe(RejectionCode.guardFailed);
    expect(error.failedGuards).toContain('g_beneficiary_verified');
  });

  it('keeps a name-only match out of paying_out even through release_blocked', () => {
    // Путь `release_blocked → release_pending → paying_out` обходит guard'ы,
    // стоящие только на одном входе. Поэтому проверка владения стоит на обоих
    // рёбрах, как и остальные guard'ы доказательств (§1.4, §4).
    const ctx = context({
      beneficiary: { status: 'name_consistent', locked: true, lastChangedAt: null },
      mismatchResolved: true,
    });
    const blocked = accept(
      stateAt('collecting'),
      { type: 'funds_received', amount: ctx.facts.requiredAmount, sender: 'not-the-buyer', reference: 'r' },
      ctx,
    );
    expect(blocked.state.status).toBe('release_blocked');
    const releasePending = accept(
      blocked.state,
      { type: 'approval_added', userId: 'operator-2' },
      ctx,
    );
    const error = reject(releasePending.state, { type: 'release_authorized' }, ctx);
    expect(error.failedGuards).toContain('g_beneficiary_verified');
  });

  it('lets only the verified status through', () => {
    for (const status of BENEFICIARY_STATUSES) {
      const ctx = context({ beneficiary: { status, locked: true, lastChangedAt: null } });
      if (status === 'verified') {
        expect(accept(stateAt('reserved'), conditionEstablished, ctx).state.status).toBe(
          'release_pending',
        );
      } else {
        expect(reject(stateAt('reserved'), conditionEstablished, ctx).failedGuards).toContain(
          'g_beneficiary_verified',
        );
      }
    }
  });

  it('keeps the two beneficiary guards separate, not merged into one', () => {
    // Реквизиты заперты и не менялись, но владение не доказано — проходит
    // ровно один из двух guard'ов. Если однажды их склеят в один, этот тест
    // покажет, что отказ перестал называть причину поимённо (§7).
    const nameOnly: BeneficiaryStatus = 'name_consistent';
    const error = reject(
      stateAt('reserved'),
      conditionEstablished,
      context({ beneficiary: { status: nameOnly, locked: true, lastChangedAt: null } }),
    );
    expect(error.failedGuards).toEqual(['g_beneficiary_verified']);

    // И наоборот: владение доказано, но реквизиты не заперты.
    const notLocked = reject(
      stateAt('reserved'),
      conditionEstablished,
      context({ beneficiary: { status: 'verified', locked: false, lastChangedAt: null } }),
    );
    expect(notLocked.failedGuards).toEqual(['g_beneficiary_locked']);
  });

  it('carries the ownership guard on both edges of the payout path', () => {
    const edges = TRANCHE_TRANSITIONS.filter(
      (item) =>
        (item.from === 'reserved' && item.to === 'release_pending') ||
        (item.from === 'release_pending' && item.to === 'paying_out'),
    );
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.guards).toContain('g_beneficiary_verified');
      expect(edge.guards).toContain('g_beneficiary_locked');
    }
  });
});
