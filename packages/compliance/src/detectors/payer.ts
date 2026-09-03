import type { Instant } from '@sdelka/domain';
import {
  type Decision,
  type DetectorOutcome,
  type EvidenceRef,
  type PolicyVersionId,
  decision,
} from '../decision';
import { type IdentityDocument, type KycStatus, identityKey, sameIdentity } from '../identity';
import { type ReasonKey, REASON_KEYS } from '../keys';
import type { NameMatch } from '../names';

/**
 * Правило плательщика — типология номер один в недвижимости.
 *
 * `PRODUCT.md` §10, `FUNCTIONAL.md` инвариант 19, `CCO-compliance.md`:
 * **имя отправителя не совпадает с покупателем — автоматическое удержание при
 * любой сумме.** Деньги не зачисляются на сделку.
 *
 * Исключения ровно четыре: супруг, родитель, ребёнок — с документами о родстве и
 * полным KYC на плательщика — и юрлицо, где покупатель владелец от 50%.
 * Посредник, обменник, юрфирма — блок без исключений.
 *
 * Ослабление правила обязано быть видно в диффе. Здесь это обеспечено трижды:
 *  1. `DOCUMENTED_PAYER_EXCEPTIONS` — литеральный тип, переписанный из документа;
 *  2. `EXCEPTIONS_ARE_EXACTLY_AS_DOCUMENTED` — взаимная присваиваемость перечня и
 *     литерала: добавление вида в перечень ломает сборку, удаление тоже;
 *  3. `BASE_OUTCOME` — тотальная таблица по видам родства: новый вид отношений
 *     не соберётся, пока для него явно не назван исход.
 */

/** Переписано из `PRODUCT.md` §10 буквой. Правка этой строки — предмет ревью. */
type DocumentedPayerExceptions = 'spouse' | 'parent' | 'child' | 'controlled_legal_entity';

export const PAYER_EXCEPTION_KINDS = [
  'spouse',
  'parent',
  'child',
  'controlled_legal_entity',
] as const;
export type PayerExceptionKind = (typeof PAYER_EXCEPTION_KINDS)[number];

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Не значение, а утверждение компилятору: перечень исключений закрыт. */
export const EXCEPTIONS_ARE_EXACTLY_AS_DOCUMENTED: MutuallyAssignable<
  PayerExceptionKind,
  DocumentedPayerExceptions
> = true;

/** Порог владения для исключения по юрлицу: от 50%. */
export const CONTROLLING_OWNERSHIP_BP = 5_000;

export interface KinshipProof {
  readonly document: EvidenceRef;
  /** Документ проверен оператором, а не просто загружен стороной. */
  readonly verified: boolean;
}

export interface OwnershipProof {
  readonly document: EvidenceRef;
  readonly ownershipBp: number;
  readonly verified: boolean;
}

export type PayerRelationship =
  | { readonly kind: 'self' }
  | { readonly kind: 'spouse'; readonly proof: KinshipProof; readonly payerKyc: KycStatus }
  | { readonly kind: 'parent'; readonly proof: KinshipProof; readonly payerKyc: KycStatus }
  | { readonly kind: 'child'; readonly proof: KinshipProof; readonly payerKyc: KycStatus }
  | {
      readonly kind: 'controlled_legal_entity';
      readonly proof: OwnershipProof;
      readonly payerKyc: KycStatus;
    }
  | { readonly kind: 'intermediary' }
  | { readonly kind: 'currency_exchange' }
  | { readonly kind: 'law_firm' }
  | { readonly kind: 'unrelated_third_party' }
  | { readonly kind: 'unknown' };

export type PayerRelationshipKind = PayerRelationship['kind'];

/**
 * Базовый исход по виду отношений, до проверки документов. Таблица тотальная:
 * `Record` по объединению видов не соберётся с пропущенным ключом.
 */
const BASE_OUTCOME: Readonly<Record<PayerRelationshipKind, DetectorOutcome>> = Object.freeze({
  self: 'clear',
  spouse: 'review',
  parent: 'review',
  child: 'review',
  controlled_legal_entity: 'review',
  intermediary: 'block',
  currency_exchange: 'block',
  law_firm: 'block',
  unrelated_third_party: 'hold',
  unknown: 'hold',
});

export interface PayerFacts {
  readonly buyerDocument: IdentityDocument;
  /** `null` — отправитель не идентифицирован. Не «наверное покупатель», а удержание. */
  readonly payerDocument: IdentityDocument | null;
  readonly relationship: PayerRelationship;
  /**
   * Совпадение имени отправителя. В решении **не участвует**: сходство имени не
   * является достаточным основанием ни для чего. Присутствует, чтобы оператор
   * видел причину, и чтобы «имена похожи» нельзя было выдать за «это тот же человек».
   */
  readonly senderNameMatch: NameMatch;
  readonly evidence: readonly EvidenceRef[];
}

export interface PayerAssessment extends Decision<DetectorOutcome> {
  /** Какое именно исключение применено. `null` — ни одно. */
  readonly exceptionApplied: PayerExceptionKind | null;
}

function kinshipExceptionHolds(proof: KinshipProof, kyc: KycStatus): readonly ReasonKey[] {
  const failures: ReasonKey[] = [];
  if (!proof.verified) failures.push(REASON_KEYS.payerKinshipProofMissing);
  if (kyc !== 'complete') failures.push(REASON_KEYS.payerKycIncomplete);
  return failures;
}

function assertNever(value: never): never {
  throw new Error(`unhandled payer relationship: ${JSON.stringify(value)}`);
}

/**
 * Ключ плательщика для guard'а `g_payer_matches` в `@sdelka/domain`.
 * Домен сравнивает строки; строка — ключ личности, а не имя.
 */
export function payerKeyForDomain(document: IdentityDocument): string {
  return identityKey(document);
}

export function assessPayer(
  facts: PayerFacts,
  policy: PolicyVersionId,
  now: Instant,
): PayerAssessment {
  const reasons: ReasonKey[] = [];
  const identityMatches =
    facts.payerDocument !== null && sameIdentity(facts.payerDocument, facts.buyerDocument);

  // Совпадение личности устанавливается по ключу документа. Имя, даже точное,
  // сюда не входит: латинизация необратима, у одной латинской формы четыре
  // грузинских прообраза.
  if (identityMatches) {
    reasons.push(REASON_KEYS.payerSelf);
    if (facts.senderNameMatch.degree === 'none') {
      // Личность та же, а имена расходятся — это не отказ, но повод для разбора.
      reasons.push(REASON_KEYS.nameEvidenceInsufficientAlone);
      return Object.freeze({
        ...decision<DetectorOutcome>('review', policy, now, reasons, facts.evidence),
        exceptionApplied: null,
      });
    }
    return Object.freeze({
      ...decision<DetectorOutcome>('clear', policy, now, reasons, facts.evidence),
      exceptionApplied: null,
    });
  }

  reasons.push(REASON_KEYS.payerThirdPartyHold);
  if (facts.payerDocument !== null) reasons.push(REASON_KEYS.identityKeysDiffer);
  if (
    facts.senderNameMatch.degree === 'identical_in_source_alphabet' ||
    facts.senderNameMatch.degree === 'identical_after_latinization' ||
    facts.senderNameMatch.degree === 'strong'
  ) {
    // Имя совпало, документ — нет. Правило не смягчается: это ровно тот случай,
    // ради которого сверка ведётся по документу.
    reasons.push(REASON_KEYS.payerNameMatchIsNotIdentity);
  }

  const relationship = facts.relationship;
  switch (relationship.kind) {
    case 'self': {
      // Заявлено «плательщик и есть покупатель», но ключи документов разные.
      reasons.push(REASON_KEYS.identityKeysDiffer);
      return Object.freeze({
        ...decision<DetectorOutcome>('hold', policy, now, reasons, facts.evidence),
        exceptionApplied: null,
      });
    }
    case 'spouse':
    case 'parent':
    case 'child': {
      const failures = kinshipExceptionHolds(relationship.proof, relationship.payerKyc);
      if (failures.length > 0) {
        return Object.freeze({
          ...decision<DetectorOutcome>('hold', policy, now, [...reasons, ...failures], facts.evidence),
          exceptionApplied: null,
        });
      }
      return Object.freeze({
        ...decision<DetectorOutcome>(
          BASE_OUTCOME[relationship.kind],
          policy,
          now,
          [...reasons, REASON_KEYS.payerExceptionApplied],
          [...facts.evidence, relationship.proof.document],
        ),
        exceptionApplied: relationship.kind,
      });
    }
    case 'controlled_legal_entity': {
      const failures: ReasonKey[] = [];
      if (!relationship.proof.verified) failures.push(REASON_KEYS.payerKinshipProofMissing);
      if (relationship.proof.ownershipBp < CONTROLLING_OWNERSHIP_BP) {
        failures.push(REASON_KEYS.payerOwnershipBelowThreshold);
      }
      if (relationship.payerKyc !== 'complete') failures.push(REASON_KEYS.payerKycIncomplete);
      if (failures.length > 0) {
        return Object.freeze({
          ...decision<DetectorOutcome>('hold', policy, now, [...reasons, ...failures], facts.evidence),
          exceptionApplied: null,
        });
      }
      return Object.freeze({
        ...decision<DetectorOutcome>(
          BASE_OUTCOME.controlled_legal_entity,
          policy,
          now,
          [...reasons, REASON_KEYS.payerExceptionApplied],
          [...facts.evidence, relationship.proof.document],
        ),
        exceptionApplied: 'controlled_legal_entity',
      });
    }
    case 'intermediary':
      return Object.freeze({
        ...decision<DetectorOutcome>(
          BASE_OUTCOME.intermediary,
          policy,
          now,
          [...reasons, REASON_KEYS.payerIntermediaryBlocked],
          facts.evidence,
        ),
        exceptionApplied: null,
      });
    case 'currency_exchange':
      return Object.freeze({
        ...decision<DetectorOutcome>(
          BASE_OUTCOME.currency_exchange,
          policy,
          now,
          [...reasons, REASON_KEYS.payerExchangeBlocked],
          facts.evidence,
        ),
        exceptionApplied: null,
      });
    case 'law_firm':
      return Object.freeze({
        ...decision<DetectorOutcome>(
          BASE_OUTCOME.law_firm,
          policy,
          now,
          [...reasons, REASON_KEYS.payerLawFirmBlocked],
          facts.evidence,
        ),
        exceptionApplied: null,
      });
    case 'unrelated_third_party':
      return Object.freeze({
        ...decision<DetectorOutcome>(
          BASE_OUTCOME.unrelated_third_party,
          policy,
          now,
          reasons,
          facts.evidence,
        ),
        exceptionApplied: null,
      });
    case 'unknown':
      return Object.freeze({
        ...decision<DetectorOutcome>(
          BASE_OUTCOME.unknown,
          policy,
          now,
          [...reasons, REASON_KEYS.payerRelationshipUnknown],
          facts.evidence,
        ),
        exceptionApplied: null,
      });
    default:
      return assertNever(relationship);
  }
}
