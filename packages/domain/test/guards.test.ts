import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type GuardId,
  type TrancheEvent,
  BENEFICIARY_COOLDOWN_MS,
  DEFAULT_APPROVAL_POLICY,
  GUARD_IDS,
  evaluateGuard,
  instant,
} from '../src/index';
import {
  AMOUNT,
  BUYER_PARTY_ID,
  CONDITION_ACT,
  MATCHING_STATEMENT,
  NOW,
  RECIPIENT_PARTY_ID,
  facts,
} from './support/facts';

const fundsReceived: TrancheEvent = {
  type: 'funds_received',
  amount: AMOUNT,
  sender: 'buyer-1',
  reference: 'ref-1',
};

function check(
  guard: GuardId,
  overrides: Parameters<typeof facts>[0],
  event: TrancheEvent = fundsReceived,
  now = NOW,
): boolean {
  return evaluateGuard(guard, { facts: facts(overrides), event, now });
}

describe('каждый guard проходит и не проходит', () => {
  it('covers every guard declared by the document', () => {
    // 12 реализованных из §1.3 плюс два по CORE.md Ф13: акт получателя на входе
    // в приём средств и приём новой редакции обеими сторонами. В таблице §1.3
    // строк четырнадцать: `g_seller_is_owner` (сверка собственника на заведении
    // сделки) и `g_no_stale_break` (незакрытые расхождения сверки) не
    // реализованы — они относятся к заведению сделки и к сверке, эпики E4 и E7.
    expect(GUARD_IDS).toHaveLength(14);
    expect(GUARD_IDS).not.toContain('g_seller_is_owner');
    expect(GUARD_IDS).not.toContain('g_no_stale_break');
    expect(GUARD_IDS).toContain('g_condition_agreed');
    expect(GUARD_IDS).toContain('g_amendment_accepted_by_both');
  });

  it('g_condition_agreed', () => {
    expect(check('g_condition_agreed', {})).toBe(true);
    // Акта нет — приём средств не открывается (Ф13).
    expect(check('g_condition_agreed', { conditionAct: null })).toBe(false);
    // Тип из перечня, но помеченный в §8 как [открыто], основанием не является.
    expect(
      check('g_condition_agreed', {
        conditionAct: { ...CONDITION_ACT, conditionType: 'registration_preliminary' },
      }),
    ).toBe(false);
    // Акт без получателя и без редакции текста — не акт.
    expect(
      check('g_condition_agreed', { conditionAct: { ...CONDITION_ACT, recipientPartyId: '' } }),
    ).toBe(false);
    expect(
      check('g_condition_agreed', { conditionAct: { ...CONDITION_ACT, conditionTextVersion: '' } }),
    ).toBe(false);
    // Акт, датированный будущим, не принимается.
    expect(
      check('g_condition_agreed', {
        conditionAct: { ...CONDITION_ACT, agreedAt: instant(NOW + 1) },
      }),
    ).toBe(false);
  });

  it('g_amendment_accepted_by_both', () => {
    const amended: TrancheEvent = {
      type: 'condition_act_amended',
      act: { ...CONDITION_ACT, conditionTextVersion: 'condition.registration_transfer.v2' },
      acceptedBy: [BUYER_PARTY_ID, RECIPIENT_PARTY_ID],
    };
    expect(check('g_amendment_accepted_by_both', {}, amended)).toBe(true);
    // Одна сторона — это не «обе»: условие переопределялось бы односторонне.
    expect(
      check('g_amendment_accepted_by_both', {}, { ...amended, acceptedBy: [RECIPIENT_PARTY_ID] }),
    ).toBe(false);
    expect(
      check(
        'g_amendment_accepted_by_both',
        {},
        { ...amended, acceptedBy: [BUYER_PARTY_ID, BUYER_PARTY_ID] },
      ),
    ).toBe(false);
    // На другом событии guard не выполняется: он про приём новой редакции.
    expect(check('g_amendment_accepted_by_both', {})).toBe(false);
  });

  it('g_amount_sufficient', () => {
    expect(check('g_amount_sufficient', {})).toBe(true);
    expect(
      check('g_amount_sufficient', {}, { ...fundsReceived, amount: money('GEL', 999_999n) }),
    ).toBe(false);
    // Другая валюта — не «достаточно», а «не сравнимо»: fail-closed.
    expect(
      check('g_amount_sufficient', {}, { ...fundsReceived, amount: money('USD', 9_999_999n) }),
    ).toBe(false);
  });

  it('g_payer_matches', () => {
    expect(check('g_payer_matches', {})).toBe(true);
    expect(check('g_payer_matches', {}, { ...fundsReceived, sender: 'someone-else' })).toBe(false);
  });

  it('g_evidence_present', () => {
    expect(check('g_evidence_present', {})).toBe(true);
    expect(check('g_evidence_present', { evidenceBundleId: null })).toBe(false);
    expect(check('g_evidence_present', { evidenceBundleId: '' })).toBe(false);
  });

  it('g_fields_match: все пять полей', () => {
    expect(check('g_fields_match', {})).toBe(true);
    for (const field of Object.keys(MATCHING_STATEMENT) as (keyof typeof MATCHING_STATEMENT)[]) {
      expect(
        check('g_fields_match', {
          statementFields: { ...MATCHING_STATEMENT, [field]: false },
        }),
      ).toBe(false);
    }
  });

  it('g_owner_is_buyer', () => {
    expect(check('g_owner_is_buyer', {})).toBe(true);
    expect(check('g_owner_is_buyer', { registryOwnerIsBuyer: false })).toBe(false);
  });

  it('g_approvals_sufficient: пороги по сумме и запрет утверждения готовившим', () => {
    // До 30 000 ₾ — без утверждений.
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 3_000_000n),
        approvals: [],
      }),
    ).toBe(true);
    // 30 000 – 150 000 ₾ — один утверждающий, и не тот, кто готовил.
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 3_000_001n),
        approvals: [],
      }),
    ).toBe(false);
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 3_000_001n),
        approvals: [{ userId: 'operator-1' }],
      }),
    ).toBe(false);
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 3_000_001n),
        approvals: [{ userId: 'operator-2' }],
      }),
    ).toBe(true);
    // 150 000 – 500 000 ₾ — двое, и обязательно разные.
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 20_000_000n),
        approvals: [{ userId: 'operator-2' }, { userId: 'operator-2' }],
      }),
    ).toBe(false);
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 20_000_000n),
        approvals: [{ userId: 'operator-2' }, { userId: 'operator-3' }],
      }),
    ).toBe(true);
    // Свыше 500 000 ₾ на пилоте не берём — сколько бы ни было утверждений.
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('GEL', 50_000_001n),
        approvals: [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }],
      }),
    ).toBe(false);
    // Валюта, для которой пороги не заданы: fail-closed.
    expect(
      check('g_approvals_sufficient', {
        requiredAmount: money('USD', 1n),
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
      }),
    ).toBe(false);
  });

  it('g_beneficiary_locked: блокировка и 72 часа без изменений', () => {
    expect(check('g_beneficiary_locked', {})).toBe(true);
    expect(check('g_beneficiary_locked', { beneficiary: { locked: false, lastChangedAt: null } })).toBe(
      false,
    );
    const justChanged = instant(NOW - BENEFICIARY_COOLDOWN_MS + 1);
    expect(
      check('g_beneficiary_locked', { beneficiary: { locked: true, lastChangedAt: justChanged } }),
    ).toBe(false);
    const changedLongAgo = instant(NOW - BENEFICIARY_COOLDOWN_MS);
    expect(
      check('g_beneficiary_locked', { beneficiary: { locked: true, lastChangedAt: changedLongAgo } }),
    ).toBe(true);
  });

  it('g_no_active_payout', () => {
    expect(check('g_no_active_payout', {})).toBe(true);
    expect(check('g_no_active_payout', { activePayouts: 1 })).toBe(false);
  });

  it('g_coverage_ok', () => {
    expect(check('g_coverage_ok', {})).toBe(true);
    expect(check('g_coverage_ok', { coverageOk: false })).toBe(false);
  });

  it('g_source_account_known', () => {
    expect(check('g_source_account_known', {})).toBe(true);
    expect(check('g_source_account_known', { sourceAccountKnown: false })).toBe(false);
  });

  it('g_mismatch_resolved', () => {
    expect(check('g_mismatch_resolved', {})).toBe(true);
    expect(check('g_mismatch_resolved', { mismatchResolved: false })).toBe(false);
  });

  it('g_write_off_approvers_distinct', () => {
    const event: TrancheEvent = { type: 'write_off_approved', userIds: ['a', 'b'] };
    expect(check('g_write_off_approvers_distinct', {}, event)).toBe(true);
    expect(
      check('g_write_off_approvers_distinct', {}, { type: 'write_off_approved', userIds: ['a', 'a'] }),
    ).toBe(false);
    expect(
      check(
        'g_write_off_approvers_distinct',
        { preparedBy: 'a' },
        { type: 'write_off_approved', userIds: ['a', 'b'] },
      ),
    ).toBe(false);
    expect(check('g_write_off_approvers_distinct', {}, fundsReceived)).toBe(false);
  });
});
