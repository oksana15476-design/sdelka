import type { Instant } from '@sdelka/domain';
import {
  type Decision,
  type DetectorOutcome,
  type EvidenceRef,
  type PolicyVersionId,
  decision,
} from '../decision';
import { type IdentityDocument, identityKey } from '../identity';
import { type ReasonKey, REASON_KEYS } from '../keys';
import type { NameMatch, NameMatchDegree } from '../names';

/**
 * Одна и та же личность на **обеих сторонах одной сделки** — отказ.
 *
 * `FUNCTIONAL.md` §2.1 «Что запрещено жёстко», `ROADMAP.md` И6.4: продажа самому
 * себе — известная схема перемещения денег с видимостью основания, и платформа
 * расчётов для неё идеальный инструмент. Поэтому исход `block`, а не `review`:
 * это отказ, а не предупреждение и не задача оператору.
 *
 * Проверка идёт по **ключу личности** (страна, тип, отпечаток номера документа),
 * а не по имени: имя по правилу пакета не является достаточным основанием ни для
 * чего, а латинизация необратима.
 *
 * Связанные лица (супруги, родитель и ребёнок, лицо и его юрлицо) на обеих
 * сторонах — **не отказ, а усиленная проверка** (`FUNCTIONAL.md` §2.1, `ROADMAP.md`
 * И6.4 критерий 3 и крайний случай про юрлицо): такие сделки бывают настоящими,
 * запрещать их нет оснований, но комплаенс обязан их видеть до расчёта.
 */

export const COUNTERPARTY_ROLES = ['payer', 'recipient'] as const;
/**
 * Роль — свойство **участия** в сделке, а не человека (`FUNCTIONAL.md` §2.1).
 * Отсюда и форма фактов ниже: список участий, а не пара «покупатель/получатель».
 * Это же снимает вопрос о нескольких траншах и нескольких получателях — их
 * участия просто попадают в тот же список.
 */
export type CounterpartyRole = (typeof COUNTERPARTY_ROLES)[number];

export interface Participation {
  readonly partyId: string;
  readonly role: CounterpartyRole;
  readonly document: IdentityDocument;
}

/**
 * Виды связи, при которых сделка заводится с усиленной проверкой. Перечень
 * закрыт и **намеренно не переиспользует** `PayerExceptionKind`: там перечень
 * отвечает на вопрос «чей платёж мы готовы зачесть на чужую сделку» и защищён
 * от расширения тремя способами; здесь — на вопрос «кого мы готовы видеть по обе
 * стороны одной сделки». Слить их означало бы, что расширение одного молча
 * ослабляет другое, а правило плательщика — типология номер один в недвижимости.
 */
export const COUNTERPARTY_RELATION_KINDS = [
  'spouse',
  'parent',
  'child',
  'legal_entity_of_party',
] as const;
export type CounterpartyRelationKind = (typeof COUNTERPARTY_RELATION_KINDS)[number];

export type CounterpartyRelation =
  | { readonly kind: 'unrelated' }
  | {
      readonly kind: 'related';
      readonly relation: CounterpartyRelationKind;
      /** `null` — связь заявлена, но документом не подтверждена. Исход тот же: разбор. */
      readonly proof: EvidenceRef | null;
    };

export interface CounterpartyFacts {
  readonly participations: readonly Participation[];
  readonly relation: CounterpartyRelation;
  /**
   * Совпадение имён сторон. В решении **не участвует** — идиома
   * `PayerFacts.senderNameMatch`: наблюдение для оператора, чтобы «имена похожи»
   * нельзя было выдать ни за отказ, ни за его отсутствие. `null` — не сравнивали.
   */
  readonly nameMatch: NameMatch | null;
  readonly evidence: readonly EvidenceRef[];
}

export interface CounterpartyAssessment extends Decision<DetectorOutcome> {
  /**
   * Пары участий, где один и тот же ключ личности стоит по обе стороны. В отчёте
   * идентификаторы сторон, а не ключи: ключ несёт отпечаток номера документа.
   */
  readonly conflictingPartyIds: readonly (readonly [string, string])[];
}

/** Степени, при которых совпадение имён стоит показать оператору. Типизировано:
 *  опечатка в степени не соберётся, а «сильное совпадение» не расползётся по коду. */
const STRONG_DEGREES: readonly NameMatchDegree[] = Object.freeze([
  'identical_in_source_alphabet',
  'identical_after_latinization',
  'strong',
]);

/**
 * Пары «плательщик — получатель» с совпавшим ключом личности.
 *
 * Одно лицо дважды **в одной роли** (два созаёмщика с одним ключом) сюда не
 * попадает: это дефект данных, а не продажа самому себе, и И6.4 его не разбирает.
 */
export function selfDealingPairs(
  participations: readonly Participation[],
): readonly (readonly [string, string])[] {
  const pairs: (readonly [string, string])[] = [];
  const seen = new Set<string>();
  for (const payer of participations) {
    if (payer.role !== 'payer') continue;
    const key = identityKey(payer.document);
    for (const recipient of participations) {
      if (recipient.role !== 'recipient') continue;
      if (identityKey(recipient.document) !== key) continue;
      const pairKey = `${payer.partyId}|${recipient.partyId}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      pairs.push(Object.freeze([payer.partyId, recipient.partyId]) as readonly [string, string]);
    }
  }
  return Object.freeze(pairs);
}

export function assessCounterparty(
  facts: CounterpartyFacts,
  policy: PolicyVersionId,
  now: Instant,
): CounterpartyAssessment {
  const conflicting = selfDealingPairs(facts.participations);

  if (conflicting.length > 0) {
    return Object.freeze({
      ...decision<DetectorOutcome>(
        'block',
        policy,
        now,
        [REASON_KEYS.counterpartySameIdentity],
        facts.evidence,
      ),
      conflictingPartyIds: conflicting,
    });
  }

  if (facts.relation.kind === 'related') {
    const evidence =
      facts.relation.proof === null ? facts.evidence : [...facts.evidence, facts.relation.proof];
    return Object.freeze({
      ...decision<DetectorOutcome>(
        'review',
        policy,
        now,
        [REASON_KEYS.counterpartyRelatedParties],
        evidence,
      ),
      conflictingPartyIds: conflicting,
    });
  }

  const reasons: ReasonKey[] = [REASON_KEYS.counterpartyDistinct];
  if (facts.nameMatch !== null && STRONG_DEGREES.includes(facts.nameMatch.degree)) {
    // Имена сторон совпали, ключи — нет. Отказа нет: И6.4 критерий 2 прямо
    // говорит, что имя — недостаточное основание. Причина попадает в решение,
    // чтобы совпадение было видно оператору и не выглядело незамеченным.
    reasons.push(REASON_KEYS.counterpartyNameMatchIsNotIdentity);
  }
  return Object.freeze({
    ...decision<DetectorOutcome>('clear', policy, now, reasons, facts.evidence),
    conflictingPartyIds: conflicting,
  });
}
