import { type Instant, instant } from '@sdelka/domain';
import { describe, expect, it } from 'vitest';
import {
  type BeneficiaryChangeRequest,
  type BeneficiaryRequisites,
  type BeneficiaryState,
  APPROVER_ROLE,
  OPERATOR_ROLE,
  actor,
  advanceBeneficiaryChange,
  applyBeneficiaryChange,
  authorize,
  lockOnFunding,
  openBeneficiaryChange,
  readBeneficiary,
  toBeneficiaryLock,
  verifyBeneficiaryHolder,
} from '../src/index';
import {
  ACCOUNT_OTHER,
  ACCOUNT_SOURCE,
  BUYER_NAMES,
  evidence,
  latinName,
  NOW,
  OTHER_NAMES,
  POLICY,
  profile,
} from './support/fixtures';

const HOUR_MS = 60 * 60 * 1000;
const writer = authorize(actor('operator-1', OPERATOR_ROLE), 'write_beneficiary');
const reader = authorize(actor('operator-1', OPERATOR_ROLE), 'read_beneficiary');
const approver = authorize(actor('approver-1', APPROVER_ROLE), 'approve_beneficiary_change');
const sameApprover = authorize(actor('operator-1', APPROVER_ROLE), 'approve_beneficiary_change');

function requisites(overrides: Partial<BeneficiaryRequisites> = {}): BeneficiaryRequisites {
  return {
    account: ACCOUNT_SOURCE,
    holderNames: BUYER_NAMES,
    holderDocument: null,
    ownershipEvidence: null,
    ...overrides,
  };
}

function state(overrides: Partial<BeneficiaryState> = {}): BeneficiaryState {
  return {
    requisites: requisites(),
    status: 'name_consistent',
    locked: false,
    lastChangedAt: null,
    ...overrides,
  };
}

describe('сверка владельца счёта', () => {
  it('расхождение имени — блокировка, а не предупреждение', () => {
    const result = verifyBeneficiaryHolder(
      requisites({ holderNames: OTHER_NAMES }),
      profile(),
      POLICY,
      NOW,
    );
    expect(result.outcome).toBe('blocked');
    expect(result.reasons).toContain('compliance.beneficiary.holder_name_mismatch');
  });

  it('совпадение имени даёт «согласовано», но не «проверено»', () => {
    const result = verifyBeneficiaryHolder(requisites(), profile(), POLICY, NOW);
    expect(result.outcome).toBe('name_consistent');
    expect(result.reasons).toContain('compliance.beneficiary.ownership_evidence_missing');
  });

  it('доказательство владения счётом даёт «проверено»', () => {
    const result = verifyBeneficiaryHolder(
      requisites({ ownershipEvidence: evidence(5, 'test_transfer') }),
      profile(),
      POLICY,
      NOW,
    );
    expect(result.outcome).toBe('verified');
    expect(result.evidence.some((item) => item.kind === 'test_transfer')).toBe(true);
  });

  it('без латинской формы имени реквизиты не принимаются', () => {
    const georgianOnly = [
      {
        alphabet: 'georgian' as const,
        given: 'საბო',
        family: 'თითი',
        source: 'bank_account_holder' as const,
        evidenceWeightBp: 10_000,
      },
    ];
    const result = verifyBeneficiaryHolder(
      requisites({ holderNames: georgianOnly }),
      profile(),
      POLICY,
      NOW,
    );
    expect(result.outcome).toBe('blocked');
    expect(result.reasons).toContain('compliance.beneficiary.latin_name_required');
  });
});

describe('форма факта согласована с guard-ом домена', () => {
  it('блокировка при финансировании', () => {
    const locked = lockOnFunding(state());
    // Статус в факте обязателен и не теряется по дороге: домен стоит на нём
    // guard'ом `g_beneficiary_verified`, и `name_consistent` выплату не
    // открывает (E13-2, ROADMAP.md И13.1). Точное сравнение здесь и держит
    // форму факта: появление поля обязано ломать этот тест.
    expect(toBeneficiaryLock(locked)).toEqual({
      status: 'name_consistent',
      locked: true,
      lastChangedAt: null,
    });
  });

  it('статус реквизитов переносится в факт без потери', () => {
    for (const status of ['draft', 'name_consistent', 'verified', 'blocked'] as const) {
      expect(toBeneficiaryLock(state({ status })).status).toBe(status);
    }
  });

  it('момент последнего изменения переносится в факт', () => {
    const changed = state({ locked: true, lastChangedAt: instant(NOW - HOUR_MS) as Instant });
    expect(toBeneficiaryLock(changed).lastChangedAt).toBe(NOW - HOUR_MS);
  });
});

describe('изменение реквизитов', () => {
  const proposed = requisites({ account: ACCOUNT_OTHER, holderNames: [latinName('Sabo', 'Tikato')] });

  it('в последние 72 часа перед релизом — автоматический блок', () => {
    const result = openBeneficiaryChange(
      lockOnFunding(state()),
      {
        requestId: 'change-1',
        proposed,
        releaseAt: instant(NOW + 71 * HOUR_MS) as Instant,
        dealFunded: true,
      },
      writer,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.request.status).toBe('auto_blocked');
    expect(result.error.effects).toHaveLength(0);
  });

  it('ровно на границе 72 часов блокируется: отказ закрытый', () => {
    const result = openBeneficiaryChange(
      lockOnFunding(state()),
      {
        requestId: 'change-1',
        proposed,
        releaseAt: instant(NOW + 72 * HOUR_MS) as Instant,
        dealFunded: true,
      },
      writer,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it('профинансированная сделка без известного окна релиза — автоблок', () => {
    const result = openBeneficiaryChange(
      lockOnFunding(state()),
      { requestId: 'change-1', proposed, releaseAt: null, dealFunded: true },
      writer,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it('вне окна: охлаждение, уведомление всем сторонам, второе утверждение', () => {
    const result = openBeneficiaryChange(
      lockOnFunding(state()),
      {
        requestId: 'change-1',
        proposed,
        releaseAt: instant(NOW + 200 * HOUR_MS) as Instant,
        dealFunded: true,
      },
      writer,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.request.status).toBe('cooling_off');
    expect(result.value.effects.map((item) => item.type)).toEqual([
      'require_reverification',
      'notify_all_parties_all_channels',
      'require_second_approval',
    ]);
  });

  it('до финансирования требуется только повторная верификация', () => {
    const result = openBeneficiaryChange(
      state(),
      { requestId: 'change-1', proposed, releaseAt: null, dealFunded: false },
      writer,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effects.map((item) => item.type)).toEqual(['require_reverification']);
  });
});

describe('применение изменения', () => {
  const proposed = requisites({ account: ACCOUNT_OTHER });

  function request(overrides: Partial<BeneficiaryChangeRequest> = {}): BeneficiaryChangeRequest {
    return {
      requestId: 'change-1',
      requestedBy: 'operator-1',
      requestedAt: instant(NOW - 25 * HOUR_MS) as Instant,
      proposed,
      status: 'awaiting_second_approval',
      reverifiedAt: instant(NOW - 20 * HOUR_MS) as Instant,
      notifiedAt: instant(NOW - 20 * HOUR_MS) as Instant,
      approvals: ['approver-1'],
      policyVersionId: POLICY.version,
      ...overrides,
    };
  }

  const applyInput = {
    releaseAt: instant(NOW + 200 * HOUR_MS) as Instant,
    dealFunded: true,
    locked: true,
  };

  it('все четыре условия выполнены — изменение применяется', () => {
    const result = applyBeneficiaryChange(
      lockOnFunding(state()),
      request(),
      applyInput,
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requisites.account).toBe(ACCOUNT_OTHER);
    expect(result.value.lastChangedAt).toBe(NOW);
    // Новые реквизиты не наследуют «проверено» от старых.
    expect(result.value.status).toBe('name_consistent');
  });

  it('охлаждение ровно в срок истекло: граница на стороне заявителя', () => {
    // Охлаждение объявлено как 24 часа. На двадцать четвёртом часу оно
    // закончилось, а не «ещё идёт»: иначе объявленный срок на деле длиннее.
    const result = applyBeneficiaryChange(
      lockOnFunding(state()),
      request({ requestedAt: instant(NOW - POLICY.beneficiary.cooldown) as Instant }),
      applyInput,
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it('за миллисекунду до конца охлаждения — отказ', () => {
    const result = applyBeneficiaryChange(
      lockOnFunding(state()),
      request({ requestedAt: instant(NOW - POLICY.beneficiary.cooldown + 1) as Instant }),
      applyInput,
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('compliance.beneficiary.change_cooling_off');
  });

  it('уже применённая заявка второй раз не применяется', () => {
    // Иначе одно утверждение меняет реквизиты дважды: заявка терминальна, и
    // повторный проход по ней — это изменение без собственного основания.
    const result = applyBeneficiaryChange(
      lockOnFunding(state()),
      request({ status: 'applied' }),
      applyInput,
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('compliance.beneficiary.change_in_release_window');
  });

  it('автоблокированная заявка не применяется', () => {
    const result = applyBeneficiaryChange(
      lockOnFunding(state()),
      request({ status: 'auto_blocked' }),
      applyInput,
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('compliance.beneficiary.change_in_release_window');
  });

  it('охлаждение не истекло — отказ', () => {
    const result = applyBeneficiaryChange(
      lockOnFunding(state()),
      request({ requestedAt: instant(NOW - 1 * HOUR_MS) as Instant }),
      applyInput,
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('compliance.beneficiary.change_cooling_off');
  });

  it('повторная верификация не пройдена — отказ', () => {
    const result = applyBeneficiaryChange(
      lockOnFunding(state()),
      request({ reverifiedAt: null }),
      applyInput,
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('compliance.beneficiary.change_reverification_missing');
  });

  it('стороны не уведомлены — отказ', () => {
    const result = applyBeneficiaryChange(
      lockOnFunding(state()),
      request({ notifiedAt: null }),
      applyInput,
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it('утверждает тот же, кто заявил, — отказ', () => {
    const result = applyBeneficiaryChange(
      lockOnFunding(state()),
      request({ approvals: [] }),
      applyInput,
      sameApprover,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('compliance.beneficiary.change_approver_not_distinct');
  });

  it('окно релиза наступило, пока заявка лежала в охлаждении, — отказ', () => {
    const result = applyBeneficiaryChange(
      lockOnFunding(state()),
      request(),
      { ...applyInput, releaseAt: instant(NOW + 10 * HOUR_MS) as Instant },
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('compliance.beneficiary.change_in_release_window');
  });

  it('заявка после автоблока не движется', () => {
    const result = advanceBeneficiaryChange(
      request({ status: 'auto_blocked' }),
      { type: 'reverification_passed' },
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it('второе утверждение — второй человек', () => {
    const denied = advanceBeneficiaryChange(
      request({ approvals: [] }),
      { type: 'approval_added', userId: 'operator-1' },
      NOW,
    );
    expect(denied.ok).toBe(false);
    const allowed = advanceBeneficiaryChange(
      request({ approvals: [] }),
      { type: 'approval_added', userId: 'approver-2' },
      NOW,
    );
    expect(allowed.ok).toBe(true);
  });
});

describe('чтение реквизитов требует полномочия', () => {
  it('оператор с полномочием читает', () => {
    expect(readBeneficiary(state(), reader).account).toBe(ACCOUNT_SOURCE);
  });
});
