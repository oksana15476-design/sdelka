import { describe, expect, it } from 'vitest';
import {
  type CounterpartyFacts,
  type Participation,
  assessCounterparty,
  compareNames,
  COUNTERPARTY_RELATION_KINDS,
  selfDealingPairs,
} from '../../src/index';
import {
  BUYER_DOCUMENT,
  BUYER_NAMES,
  document,
  evidence,
  LEGAL_ENTITY_DOCUMENT,
  NOW,
  OTHER_DOCUMENT,
  POLICY,
  POLICY_VERSION,
  SAME_NAMES_OTHER_DOCUMENT,
  SAME_PERSON_DOCUMENT,
} from '../support/fixtures';

const strong = { strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp };
const sameName = compareNames(BUYER_NAMES, BUYER_NAMES, strong);

function participation(
  partyId: string,
  role: Participation['role'],
  doc: Participation['document'],
): Participation {
  return { partyId, role, document: doc };
}

const assess = (facts: Partial<CounterpartyFacts>) =>
  assessCounterparty(
    {
      participations: [],
      relation: { kind: 'unrelated' },
      nameMatch: null,
      evidence: [evidence(1)],
      ...facts,
    },
    POLICY_VERSION,
    NOW,
  );

describe('одна личность на обеих сторонах одной сделки', () => {
  it('срабатывает: один ключ у плательщика и получателя — отказ, а не разбор', () => {
    const result = assess({
      participations: [
        participation('p', 'payer', BUYER_DOCUMENT),
        participation('r', 'recipient', SAME_PERSON_DOCUMENT),
      ],
    });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.counterparty.same_identity');
    expect(result.conflictingPartyIds).toEqual([['p', 'r']]);
  });

  it('срабатывает при нескольких получателях, если ключ совпал хотя бы с одним', () => {
    const result = assess({
      participations: [
        participation('p', 'payer', BUYER_DOCUMENT),
        participation('r1', 'recipient', OTHER_DOCUMENT),
        participation('r2', 'recipient', SAME_PERSON_DOCUMENT),
      ],
    });
    expect(result.outcome).toBe('block');
    expect(result.conflictingPartyIds).toEqual([['p', 'r2']]);
  });

  it('отказ не смягчается заявленным родством: сначала личность, потом связь', () => {
    const result = assess({
      participations: [
        participation('p', 'payer', BUYER_DOCUMENT),
        participation('r', 'recipient', SAME_PERSON_DOCUMENT),
      ],
      relation: { kind: 'related', relation: 'spouse', proof: evidence(2, 'kinship_document') },
    });
    expect(result.outcome).toBe('block');
  });

  it('не срабатывает: имена совпали, ключи личности разные', () => {
    // `ROADMAP.md` И6.4 критерий 2: имя по правилу пакета — недостаточное
    // основание ни для чего, в том числе для отказа.
    const result = assess({
      participations: [
        participation('p', 'payer', BUYER_DOCUMENT),
        participation('r', 'recipient', SAME_NAMES_OTHER_DOCUMENT),
      ],
      nameMatch: sameName,
    });
    expect(result.outcome).toBe('clear');
    expect(result.reasons).toContain('compliance.counterparty.distinct');
    expect(result.reasons).toContain('compliance.counterparty.name_match_is_not_identity');
    expect(result.conflictingPartyIds).toHaveLength(0);
  });

  it('не срабатывает: одно лицо в двух разных сделках — две разные выборки участий', () => {
    // `ROADMAP.md` И6.4, крайний случай: человек продаёт одну квартиру и покупает
    // другую. Детектор смотрит участия одной сделки, и в каждой выборке лицо
    // встречается ровно в одной роли.
    const sale = assess({
      participations: [
        participation('buyer-a', 'payer', OTHER_DOCUMENT),
        participation('client', 'recipient', BUYER_DOCUMENT),
      ],
    });
    const purchase = assess({
      participations: [
        participation('client', 'payer', SAME_PERSON_DOCUMENT),
        participation('seller-b', 'recipient', document(41)),
      ],
    });
    expect(sale.outcome).toBe('clear');
    expect(purchase.outcome).toBe('clear');
  });

  it('не срабатывает: одно лицо дважды в одной роли — это не продажа самому себе', () => {
    // Два созаёмщика с одним ключом — дефект данных, а не схема; И6.4 запрещает
    // одну личность **на обеих сторонах**, а не дважды на одной.
    const participations = [
      participation('p1', 'payer', BUYER_DOCUMENT),
      participation('p2', 'payer', SAME_PERSON_DOCUMENT),
      participation('r', 'recipient', OTHER_DOCUMENT),
    ];
    expect(selfDealingPairs(participations)).toHaveLength(0);
    expect(assess({ participations }).outcome).toBe('clear');
  });

  it('не срабатывает: юрлицо на одной стороне при разных ключах — отказа нет', () => {
    // `ROADMAP.md` И6.4, крайний случай: покупка через своё юрлицо у себя же как
    // у физлица ловится бенефициарным владением, а не этой проверкой. Ключи
    // разные — регистрационного документа юрлица в перечне типов документов нет.
    const result = assess({
      participations: [
        participation('entity', 'payer', LEGAL_ENTITY_DOCUMENT),
        participation('person', 'recipient', BUYER_DOCUMENT),
      ],
    });
    expect(result.outcome).toBe('clear');
  });
});

describe('связанные лица на обеих сторонах — усиленная проверка, не отказ', () => {
  it('сделка заводится, но уходит в разбор', () => {
    const proof = evidence(3, 'kinship_document');
    const result = assess({
      participations: [
        participation('p', 'payer', BUYER_DOCUMENT),
        participation('r', 'recipient', OTHER_DOCUMENT),
      ],
      relation: { kind: 'related', relation: 'spouse', proof },
    });
    expect(result.outcome).toBe('review');
    expect(result.reasons).toContain('compliance.counterparty.related_parties');
    expect(result.evidence).toContain(proof);
  });

  it('лицо и его юрлицо, заявленные как связанные, — тоже разбор', () => {
    const result = assess({
      participations: [
        participation('entity', 'payer', LEGAL_ENTITY_DOCUMENT),
        participation('person', 'recipient', BUYER_DOCUMENT),
      ],
      relation: { kind: 'related', relation: 'legal_entity_of_party', proof: null },
    });
    expect(result.outcome).toBe('review');
  });

  it('перечень видов связи закрыт и не совпадает с перечнем исключений плательщика', () => {
    expect([...COUNTERPARTY_RELATION_KINDS]).toEqual([
      'spouse',
      'parent',
      'child',
      'legal_entity_of_party',
    ]);
  });
});

describe('решение не содержит ключей личности', () => {
  it('в отчёт попадают идентификаторы сторон, а не отпечатки документов', () => {
    const result = assess({
      participations: [
        participation('p', 'payer', BUYER_DOCUMENT),
        participation('r', 'recipient', SAME_PERSON_DOCUMENT),
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(BUYER_DOCUMENT.numberFingerprint);
    expect(result.policyVersionId).toBe(POLICY_VERSION);
  });
});
