import { ComplianceError, ComplianceErrorCode } from './errors';
import { type ReasonKey, REASON_KEYS } from './keys';
import type { NameMatch, NameObservations } from './names';
import { latinObservation } from './names';
import type { DocumentNumberFingerprint, PersonalNumberFingerprint } from './pii';

/**
 * Идентификация — `CORE.md` Ф2.
 *
 * **Ключ личности — страна, тип и номер документа.** Грузинский личный номер —
 * опциональный атрибут, а не ключ: половина сегмента его не имеет вовсе.
 *
 * Это выражено структурно, а не соглашением: `identityKey` принимает
 * `IdentityDocument`, в котором поля личного номера нет. Собрать ключ из личного
 * номера невозможно — не потому, что так решили, а потому, что нечем.
 */

/** ISO 3166-1 alpha-2. Не перечисление: сегмент — иностранцы из любых стран. */
export type CountryCode = string & { readonly __countryCode: unique symbol };

const COUNTRY_PATTERN = /^[A-Z]{2}$/u;

export function countryCode(value: string): CountryCode {
  if (!COUNTRY_PATTERN.test(value)) {
    throw new ComplianceError(ComplianceErrorCode.countryCodeInvalid, { value });
  }
  return value as CountryCode;
}

export const IDENTITY_DOCUMENT_TYPES = [
  'passport',
  'national_id',
  'residence_permit',
  'travel_document',
] as const;
export type IdentityDocumentType = (typeof IDENTITY_DOCUMENT_TYPES)[number];

export interface IdentityDocument {
  readonly issuingCountry: CountryCode;
  readonly type: IdentityDocumentType;
  /** Отпечаток, а не номер: номер — специальная категория и в пакет не попадает. */
  readonly numberFingerprint: DocumentNumberFingerprint;
  readonly expiresAt: number | null;
}

/** Ключ личности. Строка вида `страна:тип:отпечаток`, сравнивается только целиком. */
export type IdentityKey = string & { readonly __identityKey: unique symbol };

export function identityKey(document: IdentityDocument): IdentityKey {
  return `${document.issuingCountry}:${document.type}:${document.numberFingerprint}` as IdentityKey;
}

export function sameIdentity(left: IdentityDocument, right: IdentityDocument): boolean {
  return identityKey(left) === identityKey(right);
}

export const KYC_STATUSES = ['none', 'started', 'basic', 'complete'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const PARTY_KINDS = ['natural_person', 'legal_entity'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export interface PartyProfile {
  readonly partyId: string;
  readonly kind: PartyKind;
  readonly document: IdentityDocument;
  /**
   * Грузинский личный номер. `null` — нормальное, а не исключительное состояние:
   * профиль без него полноценен, потому что ключ личности его не использует.
   */
  readonly georgianPersonalNumber: PersonalNumberFingerprint | null;
  readonly names: NameObservations;
  readonly residenceCountry: CountryCode;
  readonly nationalities: readonly CountryCode[];
  readonly kyc: KycStatus;
  /**
   * Биометрия — отдельное согласие и уведомление надзорной службы до начала
   * обработки. Отказ от селфи не основание для отказа в обслуживании, поэтому
   * `declined` не влияет на полноту профиля.
   */
  readonly biometrics: BiometricConsent;
}

export const BIOMETRIC_CONSENTS = ['granted', 'declined', 'not_requested'] as const;
export type BiometricConsent = (typeof BIOMETRIC_CONSENTS)[number];

export interface IdentityCompleteness {
  readonly complete: boolean;
  readonly missing: readonly ReasonKey[];
  readonly notes: readonly ReasonKey[];
}

/**
 * Полнота идентификации. Проверяется ровно три вещи: действующий документ,
 * латинская форма имени (без неё платёж невозможен физически — стандарт
 * платёжных сообщений поддерживает только латиницу) и завершённый KYC.
 *
 * Грузинского личного номера в списке нет. Его отсутствие возвращается как
 * заметка, а не как недостающее: это и есть «профиль без него полноценен».
 */
export function identityCompleteness(profile: PartyProfile, now: number): IdentityCompleteness {
  const missing: ReasonKey[] = [];
  const notes: ReasonKey[] = [];
  const expiresAt = profile.document.expiresAt;
  if (expiresAt !== null && expiresAt <= now) {
    missing.push(REASON_KEYS.identityDocumentExpired);
  }
  if (latinObservation(profile.names) === null) {
    missing.push(REASON_KEYS.identityLatinNameMissing);
  }
  if (profile.kyc !== 'complete') {
    missing.push(REASON_KEYS.payerKycIncomplete);
  }
  if (profile.georgianPersonalNumber === null) {
    notes.push(REASON_KEYS.identityGeorgianPersonalNumberAbsent);
  }
  return Object.freeze({
    complete: missing.length === 0,
    missing: Object.freeze(missing),
    notes: Object.freeze(notes),
  });
}

/* ------------------------------------------------------------------------- */
/* Сверка собственника                                                       */
/* ------------------------------------------------------------------------- */

export const DOCUMENT_NUMBER_MATCHES = ['matched', 'mismatched', 'absent'] as const;
/**
 * Результат сверки по номеру документа. `absent` — выписка не отдала номер;
 * это открытый вопрос `CORE.md` §6.3, и до ответа он обязан читаться как
 * «оснований нет», а не как «наверное совпало».
 */
export type DocumentNumberMatch = (typeof DOCUMENT_NUMBER_MATCHES)[number];

export const OWNER_RECONCILIATION_OUTCOMES = ['established', 'refuted', 'insufficient'] as const;
export type OwnerReconciliationOutcome = (typeof OWNER_RECONCILIATION_OUTCOMES)[number];

export interface OwnerReconciliation {
  readonly outcome: OwnerReconciliationOutcome;
  readonly documentNumber: DocumentNumberMatch;
  readonly name: NameMatch;
  readonly reasons: readonly ReasonKey[];
}

/**
 * Сверка собственника: **по номеру документа, а не по имени** (`CORE.md` Ф7).
 *
 * Имя обязательный аргумент, но оно не может ни установить, ни опровергнуть
 * личность в одиночку: при `documentNumber === 'absent'` исход `insufficient`
 * при любом совпадении имени, включая точное. Это и есть тест на правило
 * «сверка по имени не является достаточным основанием ни для чего».
 */
export function reconcileOwner(
  documentNumber: DocumentNumberMatch,
  name: NameMatch,
): OwnerReconciliation {
  const reasons: ReasonKey[] = [REASON_KEYS.ownerNameSecondarySignalOnly, ...name.reasons];
  switch (documentNumber) {
    case 'matched':
      return Object.freeze({
        outcome: 'established',
        documentNumber,
        name,
        reasons: Object.freeze([REASON_KEYS.ownerDocumentNumberMatched, ...reasons]),
      });
    case 'mismatched':
      return Object.freeze({
        outcome: 'refuted',
        documentNumber,
        name,
        reasons: Object.freeze([REASON_KEYS.ownerDocumentNumberMismatch, ...reasons]),
      });
    case 'absent':
      return Object.freeze({
        outcome: 'insufficient',
        documentNumber,
        name,
        reasons: Object.freeze([REASON_KEYS.ownerDocumentNumberMissing, ...reasons]),
      });
  }
}
