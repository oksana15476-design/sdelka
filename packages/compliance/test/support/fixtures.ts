import {
  type Instant,
  type ParticipationKey,
  type PartyRef,
  instant,
  participationKey,
} from '@sdelka/domain';
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

/**
 * Тот же документ, что у покупателя, — то есть **то же лицо**. Отдельная
 * константа, а не повтор `document(1)` в тестах: смысл кейса «это один человек в
 * двух ролях», и он должен читаться из имени, а не из совпадения зерна.
 */
export const SAME_PERSON_DOCUMENT = document(1);

/**
 * Другой документ той же страны и типа: ключ личности другой. Пара к
 * `OTHER_NAMES_SAME_FORM` в кейсах «имена совпали, личности разные».
 */
export const SAME_NAMES_OTHER_DOCUMENT = document(3);

/** Регистрационная страна юрлица отличается — ключ отличается заведомо. */
export const LEGAL_ENTITY_DOCUMENT = document(4, DE);

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

/**
 * Ссылка на сторону и её участие в сделке. Реквизиты выплаты висят на участии, а
 * не на лице (`@sdelka/domain`, `participation.ts`; `ROADMAP.md` И13.1), поэтому
 * фикстуре недостаточно назвать человека — она обязана назвать сделку.
 */
export function partyRef(partyId = 'party-1'): PartyRef {
  return Object.freeze({ partyId, accountKey: `ge.passport.${partyId}` });
}

export function participationFor(dealId: string, partyId = 'party-1'): ParticipationKey {
  return participationKey(dealId, partyRef(partyId), 'recipient');
}

/** Участие получателя в сделке по умолчанию — на нём стоят тесты реквизитов. */
export const PARTICIPATION = participationFor('deal-1');

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

/** Третий набор сигналов: для кейса «одно лицо не глушит связанность третьей стороны». */
export const ACCOUNT_THIRD = accountFingerprint(fp(12));

export const ACCOUNT_SOURCE = accountFingerprint(fp(10));
export const ACCOUNT_OTHER = accountFingerprint(fp(11));
export const DEVICE_SHARED = deviceFingerprint(fp(20));
export const ADDRESS_SHARED = networkAddressFingerprint(fp(21));
export const PHONE_SHARED = phoneFingerprint(fp(22));
