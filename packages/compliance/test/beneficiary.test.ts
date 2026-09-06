import { type Instant, instant } from '@sdelka/domain';
import { describe, expect, it } from 'vitest';
import {
  type BeneficiaryChangeRequest,
  type BeneficiaryRequisites,
  type BeneficiaryState,
  type CompliancePolicy,
  APPROVER_ROLE,
  OPERATOR_ROLE,
  actor,
  advanceBeneficiaryChange,
  applyBeneficiaryChange,
  authorize,
  beneficiaryStateOf,
  lockOnFunding,
  openBeneficiaryChange,
  readBeneficiary,
  toBeneficiaryConfirmation,
  verifyBeneficiaryHolder,
} from '../src/index';
import {
  ACCOUNT_OTHER,
  ACCOUNT_SOURCE,
  BUYER_NAMES,
  evidence,
  georgianName,
  latinName,
  NOW,
  OTHER_NAMES,
  PARTICIPATION,
  POLICY,
  participationFor,
  profile,
} from './support/fixtures';

/**
 * Грузинская запись той же последовательности, что и `BUYER_NAMES`: паспортная
 * латинизация обеих даёт `sabotikato`. Профиль по реестру и выписка банка в
 * латинице — обычная пара источников в сегменте, а не расхождение имён.
 */
const BUYER_NAMES_GEORGIAN = Object.freeze([georgianName('საბო', 'ტიკატო')]);

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
    // Реквизиты одного участия: сделка названа так же обязательно, как лицо
    // (`@sdelka/domain`, `participation.ts`; И13.1).
    participation: PARTICIPATION,
    status: 'name_consistent',
    locked: false,
    lastChangedAt: null,
    ...overrides,
  };
}

describe('сверка владельца счёта', () => {
  it('расхождение имени — блокировка, а не предупреждение', () => {
    const result = verifyBeneficiaryHolder(
      PARTICIPATION,
      requisites({ holderNames: OTHER_NAMES }),
      profile(),
      POLICY,
      NOW,
    );
    expect(result.outcome).toBe('blocked');
    expect(result.reasons).toContain('compliance.beneficiary.holder_name_mismatch');
  });

  it('совпадение имени даёт «согласовано», но не «проверено»', () => {
    const result = verifyBeneficiaryHolder(PARTICIPATION, requisites(), profile(), POLICY, NOW);
    expect(result.outcome).toBe('name_consistent');
    expect(result.reasons).toContain('compliance.beneficiary.ownership_evidence_missing');
  });

  it('доказательство владения счётом даёт «проверено»', () => {
    const result = verifyBeneficiaryHolder(
      PARTICIPATION,
      requisites({ ownershipEvidence: evidence(5, 'test_transfer') }),
      profile(),
      POLICY,
      NOW,
    );
    expect(result.outcome).toBe('verified');
    expect(result.evidence.some((item) => item.kind === 'test_transfer')).toBe(true);
  });

  /**
   * Сверка принимает три степени совпадения, а не одну. Проверялась до сих пор
   * только точная — а значит, две другие можно было выбросить из условия, и ни
   * один тест бы не заметил: у всех местных собственников, чей профиль ведётся
   * по грузинскому реестру, выплата стала бы невозможна.
   */
  it('имя, совпавшее только после латинизации, реквизиты не блокирует', () => {
    const result = verifyBeneficiaryHolder(
      PARTICIPATION,
      requisites({ ownershipEvidence: evidence(6, 'test_transfer') }),
      profile({ names: BUYER_NAMES_GEORGIAN }),
      POLICY,
      NOW,
    );
    expect(result.nameMatch.degree).toBe('identical_after_latinization');
    expect(result.outcome).toBe('verified');
    expect(result.reasons).toContain('compliance.beneficiary.holder_name_consistent');
  });

  it('сильное, но не точное совпадение имени реквизиты не блокирует', () => {
    // Порог берётся из политики; здесь он снижен, чтобы степень решалась
    // именно порогом, а не совпадением форм. Проверяется сторона условия, а не
    // конкретное число: числа политики пинуются в `policy.test.ts`.
    const lenient: CompliancePolicy = {
      ...POLICY,
      nameThresholds: {
        ...POLICY.nameThresholds,
        ownerReconciliation: {
          valueBp: 1_000,
          rationaleDocRef: POLICY.nameThresholds.ownerReconciliation.rationaleDocRef,
        },
      },
    };
    const result = verifyBeneficiaryHolder(
      PARTICIPATION,
      requisites({ holderNames: [latinName('Sabo', 'Tikaton')] }),
      profile(),
      lenient,
      NOW,
    );
    expect(result.nameMatch.degree).toBe('strong');
    expect(result.outcome).toBe('name_consistent');
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
      PARTICIPATION,
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
    // открывает (E13-2, ROADMAP.md И13.1).
    //
    // Сравнение по полям, а не с литералом целиком: подтверждение теперь
    // номинальный тип домена, и литерала такого типа не существует — именно
    // это и запрещает надеть подтверждение одного участия на другое.
    const confirmation = toBeneficiaryConfirmation(locked);
    expect(confirmation.status).toBe('name_consistent');
    expect(confirmation.locked).toBe(true);
    expect(confirmation.lastChangedAt).toBeNull();
    // Участие едет в домен вместе со статусом: без него guard не отличил бы
    // подтверждение по этой сделке от подтверждения по любой другой.
    expect(confirmation.participation).toBe(PARTICIPATION);
  });

  it('статус реквизитов переносится в факт без потери', () => {
    for (const status of ['draft', 'name_consistent', 'verified', 'blocked'] as const) {
      expect(toBeneficiaryConfirmation(state({ status })).status).toBe(status);
    }
  });

  it('момент последнего изменения переносится в факт', () => {
    const changed = state({ locked: true, lastChangedAt: instant(NOW - HOUR_MS) as Instant });
    expect(toBeneficiaryConfirmation(changed).lastChangedAt).toBe(NOW - HOUR_MS);
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

  it('применённая заявка не движется', () => {
    // Оба терминальных статуса закрывают заявку одинаково. Повторная
    // верификация или ещё одно утверждение поверх уже применённого изменения —
    // это движение по заявке, у которой не осталось собственного основания.
    const result = advanceBeneficiaryChange(
      request({ status: 'applied' }),
      { type: 'reverification_passed' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('compliance.beneficiary.change_in_release_window');
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
    if (!allowed.ok) return;
    // Утверждение переводит заявку в ожидание второго, а не применяет её:
    // применение — отдельный шаг с собственными четырьмя условиями.
    expect(allowed.value.status).toBe('awaiting_second_approval');
    expect([...allowed.value.approvals]).toEqual(['approver-2']);
  });
});

describe('чтение реквизитов требует полномочия', () => {
  it('оператор с полномочием читает', () => {
    expect(readBeneficiary(state(), reader).account).toBe(ACCOUNT_SOURCE);
  });
});

/**
 * E13-2, вторая половина — `ROADMAP.md` И13.1: «реквизиты висят на **участии**,
 * а не на личности: подтверждение по одной сделке не переносится на другую».
 *
 * Здесь проверяется сторона комплаенса: решение о проверке принадлежит участию,
 * состояние реквизитов собирается **из решения**, а изменение реквизитов
 * участия не меняет. Сторона домена — `packages/domain/test/participation.test.ts`.
 */
describe('решение о реквизитах принадлежит участию', () => {
  const OTHER_DEAL = participationFor('deal-2');

  it('называет участие, по которому принято, и не годится для другого', () => {
    const verification = verifyBeneficiaryHolder(
      PARTICIPATION,
      requisites({ ownershipEvidence: evidence(5, 'test_transfer') }),
      profile(),
      POLICY,
      NOW,
    );
    expect(verification.outcome).toBe('verified');
    expect(verification.participation).toBe(PARTICIPATION);
    // Состояние собирается из решения, а не из параметра: подставить сюда
    // другое участие нечем — второго места, где оно называется, нет.
    const built = beneficiaryStateOf(
      verification,
      requisites({ ownershipEvidence: evidence(5, 'test_transfer') }),
    );
    expect(built.participation).toBe(PARTICIPATION);
    expect(toBeneficiaryConfirmation(built).participation).toBe(PARTICIPATION);
  });

  it('второе участие того же лица требует своей проверки', () => {
    // Те же реквизиты, то же лицо, другая сделка — и это **другое** решение с
    // другим ключом. Переносить нечего: подтверждения по второй сделке до этой
    // проверки не существовало.
    const proof = requisites({ ownershipEvidence: evidence(5, 'test_transfer') });
    const first = verifyBeneficiaryHolder(PARTICIPATION, proof, profile(), POLICY, NOW);
    const second = verifyBeneficiaryHolder(OTHER_DEAL, proof, profile(), POLICY, NOW);
    expect(second.participation).not.toBe(first.participation);
    expect(second.participation.dealId).toBe('deal-2');
    expect(beneficiaryStateOf(second, proof).participation.dealId).toBe('deal-2');
  });

  /**
   * Асимметрия, ради которой всё это и разведено, — и её обоснование.
   *
   * `verified` **не** переносится: доказательство владения приложено к участию,
   * и без нового решения по новому участию его нет. `blocked` переносить не
   * нужно — он **воспроизводится сам**: расхождение имени владельца счёта с
   * профилем стороны это факт о личности и счёте, а не о сделке, и проверка по
   * любому участию вернёт тот же отказ. Положительный вывод не переносится,
   * отрицательный воспроизводится — безопасная сторона у обеих ошибок.
   */
  it('отказ по имени воспроизводится на каждом участии, а «проверено» — нет', () => {
    const mismatched = requisites({
      holderNames: OTHER_NAMES,
      ownershipEvidence: evidence(6, 'test_transfer'),
    });
    for (const participation of [PARTICIPATION, OTHER_DEAL]) {
      const result = verifyBeneficiaryHolder(participation, mismatched, profile(), POLICY, NOW);
      expect(result.outcome).toBe('blocked');
      expect(result.participation).toBe(participation);
    }
  });

  it('изменение реквизитов остаётся внутри участия', () => {
    // И13.2: «процедура применяется к участию, где он получает; на вторую
    // сделку изменение не распространяется». Участие берётся из состояния, а не
    // из заявки: иначе смена реквизитов стала бы способом переехать в другую
    // сделку с готовым подтверждением.
    const current = state({ locked: true });
    const opened = openBeneficiaryChange(
      current,
      {
        requestId: 'change-participation',
        proposed: requisites({ account: ACCOUNT_OTHER }),
        releaseAt: null,
        dealFunded: false,
      },
      writer,
      POLICY,
      NOW,
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    let request = opened.value.request;
    for (const event of [
      { type: 'reverification_passed' as const },
      { type: 'parties_notified' as const },
      { type: 'approval_added' as const, userId: 'approver-1' },
    ]) {
      const moved = advanceBeneficiaryChange(request, event, (NOW + 25 * HOUR_MS) as Instant);
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      request = moved.value;
    }
    const applied = applyBeneficiaryChange(
      current,
      request,
      { releaseAt: null, dealFunded: false, locked: true },
      approver,
      POLICY,
      (NOW + 49 * HOUR_MS) as Instant,
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.participation).toBe(current.participation);
    // И статус новых реквизитов не наследуется: доказательство владения
    // относилось к другому счёту (И13.2).
    expect(applied.value.status).toBe('name_consistent');
  });
});
