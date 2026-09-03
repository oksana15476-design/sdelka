import { type Instant, instant } from '@sdelka/domain';
import {
  type CountryCode,
  type EvidenceRef,
  type IdentityDocument,
  type NameObservation,
  type PartyProfile,
  type PolicyVersionId,
  POLICY_2026_09_03,
  countryCode,
  documentNumberFingerprint,
  accountFingerprint,
  deviceFingerprint,
  networkAddressFingerprint,
  personalNumberFingerprint,
  phoneFingerprint,
} from '../../src/index';

/**
 * Фикстуры.
 *
 * Ни одна строка здесь не изображает настоящие персональные данные. Номера
 * документов и счетов заменены отпечатками — синтетическими шестнадцатеричными
 * последовательностями вида `0000…07`; имена — **сконструированные
 * последовательности букв**, подобранные так, чтобы проходить через
 * схлопывающиеся пары грузинской латинизации, а не чтобы походить на фамилии.
 */
export const NOW: Instant = instant(Date.UTC(2026, 8, 3, 10, 0, 0));

export const POLICY = POLICY_2026_09_03;
export const POLICY_VERSION: PolicyVersionId = POLICY.version;

/** Синтетический отпечаток: номер по порядку, дополненный нулями до 64 знаков. */
export function fp(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

export const GE: CountryCode = countryCode('GE');
export const RU: CountryCode = countryCode('RU');
export const BY: CountryCode = countryCode('BY');
export const DE: CountryCode = countryCode('DE');
export const IL: CountryCode = countryCode('IL');

export function document(seed: number, issuer: CountryCode = IL): IdentityDocument {
  return {
    issuingCountry: issuer,
    type: 'passport',
    numberFingerprint: documentNumberFingerprint(fp(seed)),
    expiresAt: Date.UTC(2030, 0, 1),
  };
}

export const BUYER_DOCUMENT = document(1);
export const OTHER_DOCUMENT = document(2);

export function latinName(given: string, family: string): NameObservation {
  return {
    alphabet: 'latin',
    given,
    family,
    source: 'identity_document',
    evidenceWeightBp: 10_000,
  };
}

export function georgianName(given: string, family: string): NameObservation {
  return {
    alphabet: 'georgian',
    given,
    family,
    source: 'registry_extract',
    evidenceWeightBp: 8_000,
  };
}

export function cyrillicName(given: string, family: string): NameObservation {
  return {
    alphabet: 'cyrillic',
    given,
    family,
    source: 'client_declared',
    evidenceWeightBp: 5_000,
  };
}

/** Сконструированные последовательности, не имена: обе дают паспортное `titi`. */
export const GEORGIAN_SOFT = 'თითი';
export const GEORGIAN_HARD = 'ტიტი';

export const BUYER_NAMES = Object.freeze([latinName('Sabo', 'Tikato')]);
export const OTHER_NAMES = Object.freeze([latinName('Nuvo', 'Zerlan')]);

export function profile(overrides: Partial<PartyProfile> = {}): PartyProfile {
  return {
    partyId: 'party-1',
    kind: 'natural_person',
    document: BUYER_DOCUMENT,
    georgianPersonalNumber: null,
    names: BUYER_NAMES,
    residenceCountry: DE,
    nationalities: Object.freeze([IL]),
    kyc: 'complete',
    biometrics: 'not_requested',
    ...overrides,
  };
}

export const WITH_PERSONAL_NUMBER = personalNumberFingerprint(fp(900));

export function evidence(seed: number, kind: EvidenceRef['kind'] = 'operator_note'): EvidenceRef {
  return { kind, ref: `evidence-${seed}`, observedAt: NOW };
}

export const ACCOUNT_SOURCE = accountFingerprint(fp(10));
export const ACCOUNT_OTHER = accountFingerprint(fp(11));
export const DEVICE_SHARED = deviceFingerprint(fp(20));
export const ADDRESS_SHARED = networkAddressFingerprint(fp(21));
export const PHONE_SHARED = phoneFingerprint(fp(22));
