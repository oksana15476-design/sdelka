import { describe, expect, it } from 'vitest';
import {
  type PayerFacts,
  type PayerOrigin,
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
  georgianName,
  latinName,
  NOW,
  OTHER_DOCUMENT,
  OTHER_NAMES,
  POLICY,
  POLICY_VERSION,
  SAME_PERSON_DOCUMENT,
} from '../support/fixtures';

const strong = { strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp };
const sameName = compareNames(BUYER_NAMES, BUYER_NAMES, strong);
const otherName = compareNames(BUYER_NAMES, OTHER_NAMES, strong);

/** Внешний перевод — источник по умолчанию: только у него есть имя отправителя. */
function external(
  payerDocument: PayerFacts['buyerDocument'] | null = BUYER_DOCUMENT,
  senderNameMatch = sameName,
): PayerOrigin {
  return { kind: 'external_transfer', payerDocument, senderNameMatch };
}

function facts(overrides: Partial<PayerFacts> = {}): PayerFacts {
  return {
    buyerDocument: BUYER_DOCUMENT,
    origin: external(),
    relationship: { kind: 'self' },
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
    const result = assess({ origin: external(BUYER_DOCUMENT, { ...noName, degree: 'none' }) });
    expect(result.outcome).toBe('review');
  });

  it('заявлено «сам», но документ другой — удержание', () => {
    const result = assess({ origin: external(OTHER_DOCUMENT), relationship: { kind: 'self' } });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.identity.keys_differ');
  });
});

describe('движение внутри сервиса со своего же остатка', () => {
  // `ROADMAP.md` И12.4 критерий 4, `FUNCTIONAL.md` §2.1: сторона, продавшая одну
  // квартиру и покупающая другую, направляет свои деньги на свою сделку.
  const internal = (accountHolder = SAME_PERSON_DOCUMENT): PayerOrigin => ({
    kind: 'internal_balance',
    accountHolder,
  });

  it('срабатывает: свой остаток на свою сделку — пропуск без задачи в очередь', () => {
    const result = assess({ origin: internal() });
    expect(result.outcome).toBe('clear');
    expect(result.reasons).toContain('compliance.payer.self');
    expect(result.reasons).toContain('compliance.payer.internal_own_balance');
    expect(result.exceptionApplied).toBeNull();
  });

  it('исход не зависит от имени: у внутреннего движения имени нет вовсе', () => {
    // Тип не даёт передать `senderNameMatch` во внутреннюю ветку — проверяем,
    // что и причина «имена расходятся» в решении не появляется.
    const result = assess({ origin: internal() });
    expect(result.reasons).not.toContain('compliance.name.evidence_insufficient_alone');
    expect(result.reasons).not.toContain('compliance.payer.name_match_is_not_identity');
  });

  it('не срабатывает: остаток другого лица — то же третье лицо, удержание', () => {
    const result = assess({
      origin: internal(OTHER_DOCUMENT),
      relationship: { kind: 'unrelated_third_party' },
    });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.payer.third_party_hold');
    expect(result.reasons).toContain('compliance.identity.keys_differ');
    expect(result.reasons).not.toContain('compliance.payer.internal_own_balance');
  });

  it('не срабатывает: остаток другого лица не смягчается перечнем исключений', () => {
    const result = assess({
      origin: internal(OTHER_DOCUMENT),
      relationship: { kind: 'intermediary' },
    });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.payer.intermediary_blocked');
  });
});

describe('третье лицо: удержание при любой сумме', () => {
  it('неопознанный отправитель — удержание', () => {
    const result = assess({ origin: external(null), relationship: { kind: 'unknown' } });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.payer.third_party_hold');
  });

  it('постороннее третье лицо — удержание', () => {
    const result = assess({
      origin: external(OTHER_DOCUMENT, otherName),
      relationship: { kind: 'unrelated_third_party' },
    });
    expect(result.outcome).toBe('hold');
  });

  it('совпадение имени при другом документе правило не смягчает', () => {
    const result = assess({
      origin: external(OTHER_DOCUMENT, sameName),
      relationship: { kind: 'unrelated_third_party' },
    });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.payer.name_match_is_not_identity');
  });

  /**
   * Оговорка «имя совпало, документ — нет» ставится при **любой** сильной
   * степени, а не только при буквальном совпадении форм. Проверялась одна
   * степень из трёх: две другие можно было выбросить из условия, и самый
   * частый случай сегмента — грузинский реестр против латиницы банка — перестал
   * бы попадать оператору на глаза.
   */
  it('оговорка о совпадении имени ставится при любой сильной степени', () => {
    const afterLatinization = compareNames(BUYER_NAMES, [georgianName('საბო', 'ტიკატო')], strong);
    const strongOnly = compareNames(BUYER_NAMES, [latinName('Sabo', 'Tikaton')], {
      strongThresholdBp: 1_000,
    });
    expect(afterLatinization.degree).toBe('identical_after_latinization');
    expect(strongOnly.degree).toBe('strong');

    for (const nameMatch of [afterLatinization, strongOnly]) {
      const result = assess({
        origin: external(OTHER_DOCUMENT, nameMatch),
        relationship: { kind: 'unrelated_third_party' },
      });
      expect(result.outcome).toBe('hold');
      expect(result.reasons).toContain('compliance.payer.name_match_is_not_identity');
    }
  });
});

describe('исключение: супруг', () => {
  const relationship = (over: Partial<Extract<PayerRelationship, { kind: 'spouse' }>> = {}) =>
    ({ kind: 'spouse', proof: verifiedKinship, payerKyc: 'complete', ...over }) as PayerRelationship;

  it('срабатывает: документы о родстве и полный KYC', () => {
    const result = assess({ origin: external(OTHER_DOCUMENT), relationship: relationship() });
    expect(result.outcome).toBe('review');
    expect(result.exceptionApplied).toBe('spouse');
    expect(result.reasons).toContain('compliance.payer.exception_applied');
  });

  it('не срабатывает: документы не проверены', () => {
    const result = assess({
      origin: external(OTHER_DOCUMENT),
      relationship: relationship({ proof: unverifiedKinship }),
    });
    expect(result.outcome).toBe('hold');
    expect(result.exceptionApplied).toBeNull();
    expect(result.reasons).toContain('compliance.payer.kinship_proof_missing');
  });

  it('не срабатывает: KYC на плательщика не полный', () => {
    const result = assess({
      origin: external(OTHER_DOCUMENT),
      relationship: relationship({ payerKyc: 'basic' }),
    });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.payer.kyc_incomplete');
  });
});

describe('исключение: родитель', () => {
  it('срабатывает', () => {
    const result = assess({
      origin: external(OTHER_DOCUMENT),
      relationship: { kind: 'parent', proof: verifiedKinship, payerKyc: 'complete' },
    });
    expect(result.outcome).toBe('review');
    expect(result.exceptionApplied).toBe('parent');
  });

  it('не срабатывает без полного KYC', () => {
    const result = assess({
      origin: external(OTHER_DOCUMENT),
      relationship: { kind: 'parent', proof: verifiedKinship, payerKyc: 'none' },
    });
    expect(result.outcome).toBe('hold');
  });
});

describe('исключение: ребёнок', () => {
  it('срабатывает', () => {
    const result = assess({
      origin: external(OTHER_DOCUMENT),
      relationship: { kind: 'child', proof: verifiedKinship, payerKyc: 'complete' },
    });
    expect(result.outcome).toBe('review');
    expect(result.exceptionApplied).toBe('child');
  });

  it('не срабатывает без документов о родстве', () => {
    const result = assess({
      origin: external(OTHER_DOCUMENT),
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

  /**
   * Порог назван числом, а не через саму константу: проверки выше сравнивают
   * поведение с `CONTROLLING_OWNERSHIP_BP` и потому переживают любой её сдвиг.
   * «От 50%» — цифра из `PRODUCT.md` §10, и сдвинуть её молча нельзя.
   */
  it('порог владения — ровно половина', () => {
    expect(CONTROLLING_OWNERSHIP_BP).toBe(5_000);
  });

  it('доля в 49,99% исключения не даёт, а в 50% даёт', () => {
    expect(assess({ origin: external(document(5)), relationship: ownership(4_999) }).outcome).toBe(
      'hold',
    );
    expect(assess({ origin: external(document(5)), relationship: ownership(5_000) }).outcome).toBe(
      'review',
    );
  });

  it('срабатывает ровно на пороге 50%', () => {
    const result = assess({
      origin: external(document(5)),
      relationship: ownership(CONTROLLING_OWNERSHIP_BP),
    });
    expect(result.outcome).toBe('review');
    expect(result.exceptionApplied).toBe('controlled_legal_entity');
  });

  it('не срабатывает при 49,99%', () => {
    const result = assess({
      origin: external(document(5)),
      relationship: ownership(CONTROLLING_OWNERSHIP_BP - 1),
    });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.payer.ownership_below_threshold');
  });

  it('не срабатывает при непроверенном документе о владении', () => {
    const result = assess({
      origin: external(document(5)),
      relationship: ownership(10_000, false),
    });
    expect(result.outcome).toBe('hold');
  });
});

describe('блок без исключений', () => {
  it('посредник', () => {
    const result = assess({ origin: external(document(6)), relationship: { kind: 'intermediary' } });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.payer.intermediary_blocked');
  });

  it('обменник', () => {
    const result = assess({
      origin: external(document(7)),
      relationship: { kind: 'currency_exchange' },
    });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.payer.exchange_blocked');
  });

  it('юрфирма', () => {
    const result = assess({ origin: external(document(8)), relationship: { kind: 'law_firm' } });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.payer.law_firm_blocked');
  });

  it('блок не смягчается никакими документами и полным KYC', () => {
    // У блокирующих видов отношений нет полей доказательств вовсе — передать их
    // некуда, и это ровно то, чего мы хотели: ослабление невозможно данными.
    const result = assess({ origin: external(document(6)), relationship: { kind: 'intermediary' } });
    expect(result.exceptionApplied).toBeNull();
  });
});

describe('решение хранит версию политики', () => {
  it('версия политики есть в каждом исходе', () => {
    expect(assess().policyVersionId).toBe(POLICY_VERSION);
    expect(assess({ relationship: { kind: 'intermediary' }, origin: external(document(9)) }).policyVersionId).toBe(
      POLICY_VERSION,
    );
  });
});
