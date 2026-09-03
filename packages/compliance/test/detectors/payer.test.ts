import { describe, expect, it } from 'vitest';
import {
  type PayerFacts,
  type PayerRelationship,
  assessPayer,
  compareNames,
  CONTROLLING_OWNERSHIP_BP,
  EXCEPTIONS_ARE_EXACTLY_AS_DOCUMENTED,
  identityKey,
  PAYER_EXCEPTION_KINDS,
  payerKeyForDomain,
} from '../../src/index';
import {
  BUYER_DOCUMENT,
  BUYER_NAMES,
  document,
  evidence,
  latinName,
  NOW,
  OTHER_DOCUMENT,
  OTHER_NAMES,
  POLICY,
  POLICY_VERSION,
} from '../support/fixtures';

const strong = { strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp };
const sameName = compareNames(BUYER_NAMES, BUYER_NAMES, strong);
const otherName = compareNames(BUYER_NAMES, OTHER_NAMES, strong);

function facts(overrides: Partial<PayerFacts> = {}): PayerFacts {
  return {
    buyerDocument: BUYER_DOCUMENT,
    payerDocument: BUYER_DOCUMENT,
    relationship: { kind: 'self' },
    senderNameMatch: sameName,
    evidence: [evidence(1)],
    ...overrides,
  };
}

function assess(overrides: Partial<PayerFacts> = {}) {
  return assessPayer(facts(overrides), POLICY_VERSION, NOW);
}

const verifiedKinship = { document: evidence(2, 'kinship_document'), verified: true } as const;
const unverifiedKinship = { document: evidence(2, 'kinship_document'), verified: false } as const;

describe('перечень исключений закрыт', () => {
  it('перечень ровно тот, что записан в документе', () => {
    expect([...PAYER_EXCEPTION_KINDS]).toEqual([
      'spouse',
      'parent',
      'child',
      'controlled_legal_entity',
    ]);
    // Утверждение компилятора: расширение перечня ломает сборку в этом месте.
    expect(EXCEPTIONS_ARE_EXACTLY_AS_DOCUMENTED).toBe(true);
  });
});

describe('плательщик — сам покупатель', () => {
  it('совпадение ключа личности пропускает платёж', () => {
    const result = assess();
    expect(result.outcome).toBe('clear');
    expect(result.reasons).toContain('compliance.payer.self');
    expect(result.exceptionApplied).toBeNull();
  });

  it('ключ плательщика для guard-а домена — ключ личности, а не имя', () => {
    expect(payerKeyForDomain(BUYER_DOCUMENT)).toBe(identityKey(BUYER_DOCUMENT));
  });

  it('та же личность при расходящемся имени уходит в разбор, а не проходит молча', () => {
    const noName = compareNames([latinName('Aaa', 'Bbb')], [latinName('Xxx', 'Yyy')], strong);
    const result = assess({ senderNameMatch: { ...noName, degree: 'none' } });
    expect(result.outcome).toBe('review');
  });

  it('заявлено «сам», но документ другой — удержание', () => {
    const result = assess({ payerDocument: OTHER_DOCUMENT, relationship: { kind: 'self' } });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.identity.keys_differ');
  });
});

describe('третье лицо: удержание при любой сумме', () => {
  it('неопознанный отправитель — удержание', () => {
    const result = assess({ payerDocument: null, relationship: { kind: 'unknown' } });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.payer.third_party_hold');
  });

  it('постороннее третье лицо — удержание', () => {
    const result = assess({
      payerDocument: OTHER_DOCUMENT,
      relationship: { kind: 'unrelated_third_party' },
      senderNameMatch: otherName,
    });
    expect(result.outcome).toBe('hold');
  });

  it('совпадение имени при другом документе правило не смягчает', () => {
    const result = assess({
      payerDocument: OTHER_DOCUMENT,
      relationship: { kind: 'unrelated_third_party' },
      senderNameMatch: sameName,
    });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.payer.name_match_is_not_identity');
  });
});

describe('исключение: супруг', () => {
  const relationship = (over: Partial<Extract<PayerRelationship, { kind: 'spouse' }>> = {}) =>
    ({ kind: 'spouse', proof: verifiedKinship, payerKyc: 'complete', ...over }) as PayerRelationship;

  it('срабатывает: документы о родстве и полный KYC', () => {
    const result = assess({ payerDocument: OTHER_DOCUMENT, relationship: relationship() });
    expect(result.outcome).toBe('review');
    expect(result.exceptionApplied).toBe('spouse');
    expect(result.reasons).toContain('compliance.payer.exception_applied');
  });

  it('не срабатывает: документы не проверены', () => {
    const result = assess({
      payerDocument: OTHER_DOCUMENT,
      relationship: relationship({ proof: unverifiedKinship }),
    });
    expect(result.outcome).toBe('hold');
    expect(result.exceptionApplied).toBeNull();
    expect(result.reasons).toContain('compliance.payer.kinship_proof_missing');
  });

  it('не срабатывает: KYC на плательщика не полный', () => {
    const result = assess({
      payerDocument: OTHER_DOCUMENT,
      relationship: relationship({ payerKyc: 'basic' }),
    });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.payer.kyc_incomplete');
  });
});

describe('исключение: родитель', () => {
  it('срабатывает', () => {
    const result = assess({
      payerDocument: OTHER_DOCUMENT,
      relationship: { kind: 'parent', proof: verifiedKinship, payerKyc: 'complete' },
    });
    expect(result.outcome).toBe('review');
    expect(result.exceptionApplied).toBe('parent');
  });

  it('не срабатывает без полного KYC', () => {
    const result = assess({
      payerDocument: OTHER_DOCUMENT,
      relationship: { kind: 'parent', proof: verifiedKinship, payerKyc: 'none' },
    });
    expect(result.outcome).toBe('hold');
  });
});

describe('исключение: ребёнок', () => {
  it('срабатывает', () => {
    const result = assess({
      payerDocument: OTHER_DOCUMENT,
      relationship: { kind: 'child', proof: verifiedKinship, payerKyc: 'complete' },
    });
    expect(result.outcome).toBe('review');
    expect(result.exceptionApplied).toBe('child');
  });

  it('не срабатывает без документов о родстве', () => {
    const result = assess({
      payerDocument: OTHER_DOCUMENT,
      relationship: { kind: 'child', proof: unverifiedKinship, payerKyc: 'complete' },
    });
    expect(result.outcome).toBe('hold');
  });
});

describe('исключение: юрлицо, где покупатель владелец от 50%', () => {
  const ownership = (bp: number, verified = true) =>
    ({
      kind: 'controlled_legal_entity',
      proof: { document: evidence(3, 'ownership_document'), ownershipBp: bp, verified },
      payerKyc: 'complete',
    }) as PayerRelationship;

  it('срабатывает ровно на пороге 50%', () => {
    const result = assess({
      payerDocument: document(5),
      relationship: ownership(CONTROLLING_OWNERSHIP_BP),
    });
    expect(result.outcome).toBe('review');
    expect(result.exceptionApplied).toBe('controlled_legal_entity');
  });

  it('не срабатывает при 49,99%', () => {
    const result = assess({
      payerDocument: document(5),
      relationship: ownership(CONTROLLING_OWNERSHIP_BP - 1),
    });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.payer.ownership_below_threshold');
  });

  it('не срабатывает при непроверенном документе о владении', () => {
    const result = assess({
      payerDocument: document(5),
      relationship: ownership(10_000, false),
    });
    expect(result.outcome).toBe('hold');
  });
});

describe('блок без исключений', () => {
  it('посредник', () => {
    const result = assess({ payerDocument: document(6), relationship: { kind: 'intermediary' } });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.payer.intermediary_blocked');
  });

  it('обменник', () => {
    const result = assess({
      payerDocument: document(7),
      relationship: { kind: 'currency_exchange' },
    });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.payer.exchange_blocked');
  });

  it('юрфирма', () => {
    const result = assess({ payerDocument: document(8), relationship: { kind: 'law_firm' } });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.payer.law_firm_blocked');
  });

  it('блок не смягчается никакими документами и полным KYC', () => {
    // У блокирующих видов отношений нет полей доказательств вовсе — передать их
    // некуда, и это ровно то, чего мы хотели: ослабление невозможно данными.
    const result = assess({ payerDocument: document(6), relationship: { kind: 'intermediary' } });
    expect(result.exceptionApplied).toBeNull();
  });
});

describe('решение хранит версию политики', () => {
  it('версия политики есть в каждом исходе', () => {
    expect(assess().policyVersionId).toBe(POLICY_VERSION);
    expect(assess({ relationship: { kind: 'intermediary' }, payerDocument: document(9) }).policyVersionId).toBe(
      POLICY_VERSION,
    );
  });
});
