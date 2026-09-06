import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type BeneficiaryChangeRequest,
  type CompliancePolicy,
  type PayerFacts,
  type PayerOrigin,
  type SanctionsCandidate,
  type SanctionsDecisionInput,
  type SanctionsPossibleMatch,
  type WhitelistEntry,
  ANALYST_ROLE,
  APPROVER_ROLE,
  OPERATOR_ROLE,
  actor,
  adjudicateSanctions,
  advanceBeneficiaryChange,
  applyBeneficiaryChange,
  assessFlipping,
  assessPayer,
  assessPrice,
  assessStructuring,
  authorize,
  compareNames,
  CONTROLLING_OWNERSHIP_BP,
  decideSanctions,
  identityCompleteness,
  latinObservation,
  reconcileOwner,
  verifyBeneficiaryHolder,
} from '../src/index';
import {
  ACCOUNT_SOURCE,
  BUYER_DOCUMENT,
  BUYER_NAMES,
  evidence,
  latinName,
  NOW,
  OTHER_DOCUMENT,
  PARTICIPATION,
  POLICY,
  POLICY_VERSION,
  profile,
} from './support/fixtures';

/**
 * Причина отказа — то, что человек прочитает и по чему примет решение.
 *
 * Здесь проверяется не «причина среди прочих», а **точный перечень**: `toContain`
 * не отличает соседнюю причину от нужной и не замечает, что причины не стало
 * вовсе. Отказ без объяснения и отказ с чужим объяснением одинаково приводят
 * оператора к неверному действию, а в отличие от исхода их не видно ни в одном
 * другом поле решения.
 *
 * Каждый набор ниже соответствует одной ветке кода: если ветка перестанет
 * добавлять свою причину или добавит соседнюю, разойдётся ровно этот перечень.
 */

const strong = { strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp };
const noNameMatch = compareNames([latinName('Abc', '')], [latinName('Xyz', '')], strong);
const sameNameMatch = compareNames(BUYER_NAMES, BUYER_NAMES, strong);

/* ------------------------------------------------------------------ плательщик */

function external(
  payerDocument: PayerFacts['buyerDocument'] | null = BUYER_DOCUMENT,
  senderNameMatch = sameNameMatch,
): PayerOrigin {
  return { kind: 'external_transfer', payerDocument, senderNameMatch };
}

function payer(overrides: Partial<PayerFacts> = {}) {
  return assessPayer(
    {
      buyerDocument: BUYER_DOCUMENT,
      origin: external(),
      relationship: { kind: 'self' },
      evidence: [evidence(1)],
      ...overrides,
    },
    POLICY_VERSION,
    NOW,
  );
}

const verifiedKinship = { document: evidence(2, 'kinship_document'), verified: true } as const;

describe('плательщик: перечень причин точен', () => {
  it('тот же ключ личности, разошедшиеся имена — «сам» плюс оговорка про имя', () => {
    const result = payer({ origin: external(BUYER_DOCUMENT, noNameMatch) });
    expect(result.outcome).toBe('review');
    expect([...result.reasons]).toEqual([
      'compliance.payer.self',
      'compliance.name.evidence_insufficient_alone',
    ]);
  });

  it('заявлено «сам», а ключи разные — расхождение ключей названо', () => {
    const result = payer({
      origin: external(OTHER_DOCUMENT, noNameMatch),
      relationship: { kind: 'self' },
    });
    expect(result.outcome).toBe('hold');
    expect([...result.reasons]).toEqual([
      'compliance.payer.third_party_hold',
      'compliance.identity.keys_differ',
      // Второй раз — от ветки «заявлено „сам“»: факты разные (ключ плательщика
      // не совпал с покупателем; заявление стороны не совпало с фактом).
      'compliance.identity.keys_differ',
    ]);
  });

  it('юрлицо без подтверждённого документа владения — названа именно нехватка документа', () => {
    const result = payer({
      origin: external(OTHER_DOCUMENT, noNameMatch),
      relationship: {
        kind: 'controlled_legal_entity',
        proof: {
          document: evidence(3, 'ownership_document'),
          ownershipBp: CONTROLLING_OWNERSHIP_BP,
          verified: false,
        },
        payerKyc: 'complete',
      },
    });
    expect(result.outcome).toBe('hold');
    expect([...result.reasons]).toEqual([
      'compliance.payer.third_party_hold',
      'compliance.identity.keys_differ',
      'compliance.payer.kinship_proof_missing',
    ]);
  });

  it('юрлицо с неполным KYC плательщика — названа именно неполнота KYC', () => {
    const result = payer({
      origin: external(OTHER_DOCUMENT, noNameMatch),
      relationship: {
        kind: 'controlled_legal_entity',
        proof: {
          document: evidence(3, 'ownership_document'),
          ownershipBp: CONTROLLING_OWNERSHIP_BP,
          verified: true,
        },
        payerKyc: 'basic',
      },
    });
    expect([...result.reasons]).toEqual([
      'compliance.payer.third_party_hold',
      'compliance.identity.keys_differ',
      'compliance.payer.kyc_incomplete',
    ]);
  });

  it('юрлицо с долей ниже порога — названа именно доля', () => {
    const result = payer({
      origin: external(OTHER_DOCUMENT, noNameMatch),
      relationship: {
        kind: 'controlled_legal_entity',
        proof: {
          document: evidence(3, 'ownership_document'),
          ownershipBp: CONTROLLING_OWNERSHIP_BP - 1,
          verified: true,
        },
        payerKyc: 'complete',
      },
    });
    expect([...result.reasons]).toEqual([
      'compliance.payer.third_party_hold',
      'compliance.identity.keys_differ',
      'compliance.payer.ownership_below_threshold',
    ]);
  });

  it('исключение по юрлицу применено — это названо, а не подразумевается', () => {
    const result = payer({
      origin: external(OTHER_DOCUMENT, noNameMatch),
      relationship: {
        kind: 'controlled_legal_entity',
        proof: {
          document: evidence(3, 'ownership_document'),
          ownershipBp: CONTROLLING_OWNERSHIP_BP,
          verified: true,
        },
        payerKyc: 'complete',
      },
    });
    expect(result.outcome).toBe('review');
    expect(result.exceptionApplied).toBe('controlled_legal_entity');
    expect([...result.reasons]).toEqual([
      'compliance.payer.third_party_hold',
      'compliance.identity.keys_differ',
      'compliance.payer.exception_applied',
    ]);
  });

  it('родство с документом и полным KYC — исключение названо ровно один раз', () => {
    const result = payer({
      origin: external(OTHER_DOCUMENT, noNameMatch),
      relationship: { kind: 'spouse', proof: verifiedKinship, payerKyc: 'complete' },
    });
    expect([...result.reasons]).toEqual([
      'compliance.payer.third_party_hold',
      'compliance.identity.keys_differ',
      'compliance.payer.exception_applied',
    ]);
  });

  it('отношения не заявлены — это отдельная причина, а не молчание', () => {
    const result = payer({
      origin: external(null, noNameMatch),
      relationship: { kind: 'unknown' },
    });
    expect(result.outcome).toBe('hold');
    expect([...result.reasons]).toEqual([
      'compliance.payer.third_party_hold',
      'compliance.payer.relationship_unknown',
    ]);
  });

  it('имя совпало, документ — нет: сказано, что имя личность не устанавливает', () => {
    const result = payer({
      origin: external(OTHER_DOCUMENT, sameNameMatch),
      relationship: { kind: 'unrelated_third_party' },
    });
    expect([...result.reasons]).toEqual([
      'compliance.payer.third_party_hold',
      'compliance.identity.keys_differ',
      'compliance.payer.name_match_is_not_identity',
    ]);
  });
});

/* ------------------------------------------------------------------------ цена */

const priceFacts = {
  contractPrice: money('GEL', 24_000_000n),
  platformAmount: money('GEL', 24_000_000n),
  differentAmountRequested: false,
  evidence: [evidence(1, 'contract')],
};

describe('цена: перечень причин точен', () => {
  it('сумма совпала с договором', () => {
    const result = assessPrice(priceFacts, POLICY_VERSION, POLICY.price, NOW);
    expect(result.outcome).toBe('clear');
    expect([...result.reasons]).toEqual(['compliance.price.matches_contract']);
  });

  it('просьба указать другую сумму — отказ с оценкой на подозрение', () => {
    const result = assessPrice(
      { ...priceFacts, differentAmountRequested: true },
      POLICY_VERSION,
      POLICY.price,
      NOW,
    );
    expect(result.outcome).toBe('block');
    expect([...result.reasons]).toEqual([
      'compliance.price.second_amount_requested',
      'compliance.price.suspicion_assessment_required',
    ]);
  });

  it('сумма выше договора — названо направление расхождения', () => {
    const result = assessPrice(
      { ...priceFacts, platformAmount: money('GEL', 25_000_000n) },
      POLICY_VERSION,
      POLICY.price,
      NOW,
    );
    expect([...result.reasons]).toEqual([
      'compliance.price.above_contract',
      'compliance.price.suspicion_assessment_required',
    ]);
  });

  it('сумма ниже договора — направление другое, и оно названо', () => {
    const result = assessPrice(
      { ...priceFacts, platformAmount: money('GEL', 23_000_000n) },
      POLICY_VERSION,
      POLICY.price,
      NOW,
    );
    expect([...result.reasons]).toEqual([
      'compliance.price.below_contract',
      'compliance.price.suspicion_assessment_required',
    ]);
  });
});

/* --------------------------------------------------------------- перепродажа */

const DAY_MS = 24 * 60 * 60 * 1000;

describe('быстрая перепродажа: перечень причин точен', () => {
  const transfer = (daysAgo: number, minor: bigint | null) => ({
    transferId: `t-${daysAgo}`,
    cadastralCode: 'code-1',
    registeredAt: (NOW - daysAgo * DAY_MS) as typeof NOW,
    price: minor === null ? null : money('GEL', minor),
  });

  const flip = (priorTransfers: readonly ReturnType<typeof transfer>[], current: bigint) =>
    assessFlipping(
      {
        cadastralCode: 'code-1',
        currentPrice: money('GEL', current),
        priorTransfers,
        evidence: [],
      },
      POLICY_VERSION,
      POLICY.flipping,
      NOW,
    );

  it('переходов в окне нет', () => {
    const result = flip([], 20_000_000n);
    expect(result.outcome).toBe('clear');
    expect([...result.reasons]).toEqual(['compliance.flipping.none']);
  });

  it('переход в окне без скачка цены — только сам переход', () => {
    const result = flip([transfer(10, 20_000_000n)], 20_000_000n);
    expect(result.outcome).toBe('review');
    expect([...result.reasons]).toEqual(['compliance.flipping.recent_transfer']);
  });

  it('переход со скачком цены — обе причины, и переход назван первым', () => {
    const result = flip([transfer(10, 10_000_000n)], 20_000_000n);
    expect(result.outcome).toBe('stop');
    expect([...result.reasons]).toEqual([
      'compliance.flipping.recent_transfer',
      'compliance.flipping.price_jump',
    ]);
  });
});

/* ------------------------------------------------------------ дробление платежа */

describe('дробление платежа: перечень причин точен', () => {
  const payment = (id: string, minor: bigint, daysAgo: number) => ({
    paymentId: id,
    payerKey: 'payer-1',
    amount: money('GEL', minor),
    receivedAt: (NOW - daysAgo * DAY_MS) as typeof NOW,
  });

  const assess = (payments: readonly ReturnType<typeof payment>[]) =>
    assessStructuring({ payments, evidence: [] }, POLICY_VERSION, POLICY.structuring, NOW);

  it('признака дробления нет — сказано именно это', () => {
    const result = assess([payment('p1', 1_000_000n, 1)]);
    expect(result.outcome).toBe('clear');
    expect([...result.reasons]).toEqual(['compliance.structuring.no_pattern']);
  });

  it('признак дробления есть — сказано именно это', () => {
    const result = assess([
      payment('p1', 1_200_000n, 3),
      payment('p2', 1_200_000n, 2),
      payment('p3', 1_200_000n, 1),
    ]);
    expect(result.outcome).toBe('review');
    expect([...result.reasons]).toEqual(['compliance.structuring.pattern_detected']);
  });
});

/* ------------------------------------------------------------------ личность */

describe('полнота профиля и сверка собственника: перечень причин точен', () => {
  it('незавершённый KYC назван, и он единственный недостающий', () => {
    const result = identityCompleteness(profile({ kyc: 'basic' }), NOW);
    expect(result.complete).toBe(false);
    expect([...result.missing]).toEqual(['compliance.payer.kyc_incomplete']);
    expect([...result.notes]).toEqual([
      'compliance.identity.georgian_personal_number_absent',
    ]);
  });

  it('полный профиль не оставляет недостающего', () => {
    const withLatin = profile();
    expect(latinObservation(withLatin.names)).not.toBeNull();
    const result = identityCompleteness(withLatin, NOW);
    expect(result.complete).toBe(true);
    expect([...result.missing]).toEqual([]);
  });

  it('номер документа совпал — названо совпадение и вторичность имени', () => {
    const result = reconcileOwner('matched', noNameMatch);
    expect(result.outcome).toBe('established');
    expect([...result.reasons]).toEqual([
      'compliance.owner.document_number_matched',
      'compliance.owner.name_secondary_signal_only',
      'compliance.name.evidence_insufficient_alone',
    ]);
  });

  it('номер документа разошёлся — названо расхождение, а не отсутствие', () => {
    const result = reconcileOwner('mismatched', noNameMatch);
    expect(result.outcome).toBe('refuted');
    expect([...result.reasons]).toEqual([
      'compliance.owner.document_number_mismatch',
      'compliance.owner.name_secondary_signal_only',
      'compliance.name.evidence_insufficient_alone',
    ]);
  });

  it('номера документа нет — названо отсутствие, а не расхождение', () => {
    const result = reconcileOwner('absent', noNameMatch);
    expect(result.outcome).toBe('insufficient');
    expect([...result.reasons]).toEqual([
      'compliance.owner.document_number_missing',
      'compliance.owner.name_secondary_signal_only',
      'compliance.name.evidence_insufficient_alone',
    ]);
  });
});

/* ------------------------------------------------------------------ санкции */

function candidate(overrides: Partial<SanctionsCandidate> = {}): SanctionsCandidate {
  return {
    listSource: 'us_ofac',
    listEntryId: 'entry-1',
    listEntryVersion: 'v1',
    entryType: 'person',
    matchedFields: ['name'],
    providerScoreBp: 9_000,
    programmes: ['PROGRAMME-1'],
    listNames: null,
    ...overrides,
  };
}

function decide(overrides: Partial<SanctionsDecisionInput> = {}, policy: CompliancePolicy = POLICY) {
  return decideSanctions(
    {
      subjectRef: 'party-1',
      subjectNames: BUYER_NAMES,
      subjectNationalities: [],
      response: {
        kind: 'completed',
        candidates: [],
        providerReference: 'provider-ref-1',
        rawResponseRef: 'raw-1',
        screenedAt: NOW,
      },
      whitelist: [],
      evidence: [evidence(1)],
      ...overrides,
    },
    policy,
    NOW,
  );
}

const completed = (candidates: readonly SanctionsCandidate[]) =>
  ({
    kind: 'completed',
    candidates,
    providerReference: 'provider-ref-1',
    rawResponseRef: 'raw-1',
    screenedAt: NOW,
  }) as const;

describe('санкции: перечень причин точен', () => {
  it('кандидатов нет', () => {
    expect([...decide().reasons]).toEqual(['compliance.sanctions.no_candidates']);
  });

  it('провайдер недоступен — «не смогли посмотреть», а не «ничего не нашли»', () => {
    const result = decide({ response: { kind: 'unavailable', providerReference: null } });
    expect(result.outcome).toBe('unavailable');
    expect([...result.reasons]).toEqual(['compliance.sanctions.provider_unavailable']);
  });

  it('перечень вне политики — сказано, что перечень не покрыт', () => {
    const narrow: CompliancePolicy = {
      ...POLICY,
      sanctions: { ...POLICY.sanctions, lists: ['us_ofac'] },
    };
    const result = decide({ response: completed([candidate({ listSource: 'uk_ofsi' })]) }, narrow);
    expect(result.outcome).toBe('clear');
    expect([...result.reasons]).toEqual([
      'compliance.sanctions.list_not_covered',
      'compliance.sanctions.no_candidates',
    ]);
  });

  it('балл ниже порога — сказано именно про порог', () => {
    const result = decide({
      response: completed([
        candidate({ providerScoreBp: POLICY.sanctions.candidateThreshold.valueBp - 1 }),
      ]),
    });
    expect(result.outcome).toBe('clear');
    expect([...result.reasons]).toEqual([
      'compliance.sanctions.below_threshold',
      'compliance.sanctions.no_candidates',
    ]);
  });

  it('возможное совпадение', () => {
    const result = decide({ response: completed([candidate()]) });
    expect(result.outcome).toBe('possible_match');
    expect([...result.reasons]).toEqual(['compliance.sanctions.possible_match']);
  });

  it('совпадение по сильному идентификатору — подтверждённое, а не возможное', () => {
    const result = decide({
      response: completed([candidate({ matchedFields: ['name', 'document_number'] })]),
    });
    expect(result.outcome).toBe('confirmed_match');
    expect([...result.reasons]).toEqual(['compliance.sanctions.confirmed_match']);
  });

  it('запись белого списка гасит кандидата — сказано, чем именно погашено', () => {
    const entry: WhitelistEntry = {
      subjectRef: 'party-1',
      listSource: 'us_ofac',
      listEntryId: 'entry-1',
      listEntryVersion: 'v1',
      adjudicatedBy: 'analyst-1',
      adjudicatedAt: NOW,
      expiresAt: (NOW + POLICY.sanctions.whitelistTtl) as typeof NOW,
      rationaleRef: 'rationale-1',
      policyVersionId: POLICY.version,
    };
    const result = decide({ response: completed([candidate()]), whitelist: [entry] });
    expect(result.outcome).toBe('clear');
    expect([...result.reasons]).toEqual([
      'compliance.sanctions.whitelist_suppressed',
      'compliance.sanctions.no_candidates',
    ]);
  });

  it('разбор аналитика: ложное срабатывание оставляет след разбора', () => {
    const possible = decide({ response: completed([candidate()]) }) as SanctionsPossibleMatch;
    const analyst = authorize(actor('analyst-1', ANALYST_ROLE), 'adjudicate_screening');
    const adjudication = adjudicateSanctions(
      possible,
      'false_positive',
      analyst,
      'rationale-1',
      POLICY,
      NOW,
    );
    expect(adjudication.decision.outcome).toBe('clear');
    expect([...adjudication.decision.reasons]).toEqual([
      'compliance.sanctions.possible_match',
      'compliance.sanctions.whitelist_suppressed',
    ]);
  });

  it('разбор аналитика: установленное совпадение названо установленным', () => {
    const possible = decide({ response: completed([candidate()]) }) as SanctionsPossibleMatch;
    const analyst = authorize(actor('analyst-1', ANALYST_ROLE), 'adjudicate_screening');
    const adjudication = adjudicateSanctions(
      possible,
      'true_match',
      analyst,
      'rationale-1',
      POLICY,
      NOW,
    );
    expect(adjudication.decision.outcome).toBe('confirmed_match');
    expect([...adjudication.decision.reasons]).toEqual([
      'compliance.sanctions.possible_match',
      'compliance.sanctions.confirmed_match',
    ]);
    expect([...adjudication.whitelistEntries]).toEqual([]);
  });
});

/* --------------------------------------------------------- реквизиты выплаты */

const HOUR_MS = 60 * 60 * 1000;
const writer = authorize(actor('operator-1', OPERATOR_ROLE), 'write_beneficiary');
const approver = authorize(actor('approver-1', APPROVER_ROLE), 'approve_beneficiary_change');

const requisites = {
  account: ACCOUNT_SOURCE,
  holderNames: BUYER_NAMES,
  holderDocument: null,
  ownershipEvidence: null,
};

function changeRequest(
  overrides: Partial<BeneficiaryChangeRequest> = {},
): BeneficiaryChangeRequest {
  return {
    requestId: 'change-1',
    requestedBy: 'operator-1',
    requestedAt: NOW,
    proposed: requisites,
    status: 'cooling_off',
    reverifiedAt: NOW,
    notifiedAt: NOW,
    approvals: [],
    policyVersionId: POLICY.version,
    ...overrides,
  };
}

describe('реквизиты выплаты: перечень причин точен', () => {
  it('имя владельца сошлось, доказательства владения нет — названы оба факта', () => {
    const result = verifyBeneficiaryHolder(PARTICIPATION, requisites, profile(), POLICY, NOW);
    expect(result.outcome).toBe('name_consistent');
    expect([...result.reasons]).toEqual([
      'compliance.beneficiary.holder_name_consistent',
      'compliance.beneficiary.ownership_evidence_missing',
    ]);
  });

  it('доказательство владения есть — остаётся только согласованность имени', () => {
    const result = verifyBeneficiaryHolder(
      PARTICIPATION,
      { ...requisites, ownershipEvidence: evidence(5, 'test_transfer') },
      profile(),
      POLICY,
      NOW,
    );
    expect(result.outcome).toBe('verified');
    expect([...result.reasons]).toEqual(['compliance.beneficiary.holder_name_consistent']);
  });

  it('заявка автоматически заблокирована — движение по ней объясняется окном релиза', () => {
    const result = advanceBeneficiaryChange(
      changeRequest({ status: 'auto_blocked' }),
      { type: 'parties_notified' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('compliance.beneficiary.change_in_release_window');
  });

  it('утверждает тот же, кто готовил, — названо именно это', () => {
    const result = advanceBeneficiaryChange(
      changeRequest(),
      { type: 'approval_added', userId: 'operator-1' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('compliance.beneficiary.change_approver_not_distinct');
  });

  it('стороны не уведомлены — названо уведомление, а не второе утверждение', () => {
    const result = applyBeneficiaryChange(
      { requisites, participation: PARTICIPATION, status: 'name_consistent', locked: true, lastChangedAt: null },
      changeRequest({
        requestedAt: (NOW - 48 * HOUR_MS) as typeof NOW,
        notifiedAt: null,
        approvals: ['approver-1'],
      }),
      { releaseAt: (NOW + 30 * 24 * HOUR_MS) as typeof NOW, dealFunded: true, locked: true },
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.error]).toEqual(['compliance.beneficiary.change_notification_missing']);
  });

  it('охлаждение не выдержано — названо охлаждение', () => {
    const result = applyBeneficiaryChange(
      { requisites, participation: PARTICIPATION, status: 'name_consistent', locked: true, lastChangedAt: null },
      changeRequest({ approvals: ['approver-1'] }),
      { releaseAt: (NOW + 30 * 24 * HOUR_MS) as typeof NOW, dealFunded: true, locked: true },
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.error]).toEqual(['compliance.beneficiary.change_cooling_off']);
  });

  it('повторной верификации нет — названа именно она', () => {
    const result = applyBeneficiaryChange(
      { requisites, participation: PARTICIPATION, status: 'name_consistent', locked: false, lastChangedAt: null },
      changeRequest({ reverifiedAt: null }),
      { releaseAt: (NOW + 30 * 24 * HOUR_MS) as typeof NOW, dealFunded: true, locked: false },
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.error]).toEqual([
      'compliance.beneficiary.change_reverification_missing',
    ]);
  });

  it('второго утверждающего нет — названо ожидание второго утверждения', () => {
    const result = applyBeneficiaryChange(
      { requisites, participation: PARTICIPATION, status: 'name_consistent', locked: true, lastChangedAt: null },
      changeRequest({
        requestedAt: (NOW - 48 * HOUR_MS) as typeof NOW,
        requestedBy: 'approver-1',
        approvals: [],
      }),
      { releaseAt: (NOW + 30 * 24 * HOUR_MS) as typeof NOW, dealFunded: true, locked: true },
      approver,
      POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.error]).toEqual([
      'compliance.beneficiary.change_approver_not_distinct',
      'compliance.beneficiary.change_awaits_second_approval',
    ]);
  });
});
