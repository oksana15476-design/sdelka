import {
  type CountryCode,
  type IdentityDocument,
  type NameMatch,
  type NameObservation,
  type PayerAssessment,
  type PayerFacts,
  assessPayer,
  compareNames,
  countryCode,
  documentNumberFingerprint,
  POLICY_2026_09_03,
} from '@sdelka/compliance';
import { type Instant, instant } from '@sdelka/domain';
import { type CurrencyCode, type Money, money } from '@sdelka/money';
import { type IntakePolicy, PROPOSED_INTAKE_POLICY } from '../../src/index';

/**
 * Фикстуры приёма.
 *
 * Ни одна строка не изображает настоящие персональные данные: номера документов
 * заменены синтетическими отпечатками, имена — сконструированные
 * последовательности букв, как в фикстурах комплаенса.
 */
export const NOW: Instant = instant(Date.UTC(2026, 8, 4, 10, 0, 0));
export const POLICY: IntakePolicy = PROPOSED_INTAKE_POLICY;

export function at(offsetMs: number): Instant {
  return instant(NOW + offsetMs);
}

export function gel(minor: bigint): Money<'GEL'> {
  return money('GEL', minor);
}

export function usd(minor: bigint): Money<'USD'> {
  return money('USD', minor);
}

export function jpy(minor: bigint): Money<'JPY'> {
  return money('JPY', minor);
}

function fp(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

const IL: CountryCode = countryCode('IL');

export function document(seed: number): IdentityDocument {
  return {
    issuingCountry: IL,
    type: 'passport',
    numberFingerprint: documentNumberFingerprint(fp(seed)),
    expiresAt: Date.UTC(2030, 0, 1),
  };
}

export const BUYER_DOCUMENT = document(1);
export const STRANGER_DOCUMENT = document(2);

function latinName(given: string, family: string): NameObservation {
  return {
    alphabet: 'latin',
    given,
    family,
    source: 'identity_document',
    evidenceWeightBp: 10_000,
  };
}

export const BUYER_NAMES = Object.freeze([latinName('Sabo', 'Tikato')]);
export const OTHER_NAMES = Object.freeze([latinName('Nuvo', 'Zerlan')]);

export function nameMatch(
  left: readonly NameObservation[],
  right: readonly NameObservation[],
): NameMatch {
  return compareNames(left, right, { strongThresholdBp: 8_000 });
}

/** Совпадение имени: используется как вторичный сигнал в сопоставлении. */
export const STRONG_NAME_MATCH = nameMatch(BUYER_NAMES, BUYER_NAMES);
export const NO_NAME_MATCH = nameMatch(BUYER_NAMES, OTHER_NAMES);

function payerFacts(overrides: Partial<PayerFacts> = {}): PayerFacts {
  return {
    buyerDocument: BUYER_DOCUMENT,
    origin: {
      kind: 'external_transfer',
      payerDocument: BUYER_DOCUMENT,
      senderNameMatch: STRONG_NAME_MATCH,
    },
    relationship: { kind: 'self' },
    evidence: Object.freeze([]),
    ...overrides,
  };
}

export function assessment(overrides: Partial<PayerFacts> = {}): PayerAssessment {
  return assessPayer(payerFacts(overrides), POLICY_2026_09_03.version, NOW);
}

/** Платёж от супруга с проверенными документами и полным KYC — исключение по родству. */
export function spouseAssessment(): PayerAssessment {
  return assessment({
    origin: {
      kind: 'external_transfer',
      payerDocument: STRANGER_DOCUMENT,
      senderNameMatch: NO_NAME_MATCH,
    },
    relationship: {
      kind: 'spouse',
      proof: {
        document: { kind: 'kinship_document', ref: 'kin-1', observedAt: NOW },
        verified: true,
      },
      payerKyc: 'complete',
    },
  });
}

/** Платёж от постороннего: удержание при любой сумме. */
export function strangerAssessment(): PayerAssessment {
  return assessment({
    origin: {
      kind: 'external_transfer',
      payerDocument: STRANGER_DOCUMENT,
      senderNameMatch: NO_NAME_MATCH,
    },
    relationship: { kind: 'unrelated_third_party' },
  });
}

export type Currency = CurrencyCode;
