import {
  type RawSourceRef,
  auditInstant,
  rawSourceRef,
} from '@sdelka/audit';
import {
  type BeneficiaryRequisites,
  type BeneficiaryState,
  type CountryCode,
  type EvidenceRef,
  type IdentityDocument,
  type NameObservation,
  type PartyProfile,
  type SanctionsCandidate,
  type SanctionsProviderResponse,
  type SanctionsScreeningPort,
  type SanctionsScreeningRequest,
  POLICY_2026_09_03,
  accountFingerprint,
  countryCode,
  documentNumberFingerprint,
  nameObservation,
  verifyBeneficiaryHolder,
} from '@sdelka/compliance';
import {
  type ConditionAct,
  type Instant,
  type PayoutOutcome,
  type ReconciliationOutcome,
  type StatementFields,
  instant,
} from '@sdelka/domain';
import { type CurrencyCode, type Deduction, type IsoDate, type Money, isoDate, money, rational } from '@sdelka/money';
import type { BankOutcome, BankPort, RegistryExtract, RegistryPort } from '../../src/index';

/**
 * Фикстуры сквозного контура.
 *
 * Ни одна строка здесь не изображает настоящие персональные данные: номера
 * документов и счетов — синтетические отпечатки, имена — сконструированные
 * последовательности букв. Та же дисциплина, что в `packages/compliance/test`.
 *
 * Сети нет ни в одной фикстуре: все три порта — константы и таблицы.
 */

export const NOW: Instant = instant(Date.UTC(2026, 8, 3, 10, 0, 0));
export const POLICY = POLICY_2026_09_03;
export const POLICY_VERSION = POLICY.version;

export const GEL: CurrencyCode = 'GEL';
export const USD: CurrencyCode = 'USD';

export function fp(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

export const GE: CountryCode = countryCode('GE');
export const IL: CountryCode = countryCode('IL');
export const DE: CountryCode = countryCode('DE');

export function document(seed: number, issuer: CountryCode = GE): IdentityDocument {
  return {
    issuingCountry: issuer,
    type: 'passport',
    numberFingerprint: documentNumberFingerprint(fp(seed)),
    expiresAt: Date.UTC(2032, 0, 1),
  };
}

export function latinName(given: string, family: string): NameObservation {
  return nameObservation({
    alphabet: 'latin',
    given,
    family,
    source: 'identity_document',
    evidenceWeightBp: 10_000,
  });
}

export const BUYER_DOCUMENT = document(11);
export const SELLER_DOCUMENT = document(12);
export const THIRD_PARTY_DOCUMENT = document(13);
/** Тот же документ, что у покупателя: то же лицо по обе стороны сделки. */
export const BUYER_DOCUMENT_AGAIN = document(11);

export const BUYER_NAMES = Object.freeze([latinName('Sabo', 'Tikato')]);
export const SELLER_NAMES = Object.freeze([latinName('Nuvo', 'Zerlan')]);
export const THIRD_PARTY_NAMES = Object.freeze([latinName('Rimo', 'Valdek')]);

export function profile(
  partyId: string,
  doc: IdentityDocument,
  names: readonly NameObservation[],
): PartyProfile {
  return {
    partyId,
    kind: 'natural_person',
    document: doc,
    georgianPersonalNumber: null,
    names,
    residenceCountry: GE,
    nationalities: Object.freeze([GE]),
    kyc: 'complete',
    biometrics: 'not_requested',
  };
}

export const BUYER = profile('party-buyer', BUYER_DOCUMENT, BUYER_NAMES);
export const SELLER = profile('party-seller', SELLER_DOCUMENT, SELLER_NAMES);
export const THIRD_PARTY = profile('party-third', THIRD_PARTY_DOCUMENT, THIRD_PARTY_NAMES);

export function evidenceRef(seed: number, kind: EvidenceRef['kind'] = 'test_transfer'): EvidenceRef {
  return { kind, ref: `evidence-${seed}`, observedAt: NOW };
}

/**
 * Реквизиты выплаты со статусом, посчитанным настоящим `verifyBeneficiaryHolder`.
 * Статус не выставляется руками: `verified` открывает выплату, и подставить его
 * означало бы обойти ровно тот guard, ради которого он существует (И13.1).
 */
export function beneficiaryFor(party: PartyProfile, seed: number): BeneficiaryState {
  const requisites: BeneficiaryRequisites = {
    account: accountFingerprint(fp(seed)),
    holderNames: party.names,
    holderDocument: party.document,
    ownershipEvidence: evidenceRef(seed, 'test_transfer'),
  };
  const verification = verifyBeneficiaryHolder(requisites, party, POLICY, NOW);
  return { requisites, status: verification.outcome, locked: false, lastChangedAt: null };
}

/** Реквизиты, у которых сошлось только имя: доказательства владения нет. */
export function nameConsistentBeneficiary(party: PartyProfile, seed: number): BeneficiaryState {
  const requisites: BeneficiaryRequisites = {
    account: accountFingerprint(fp(seed)),
    holderNames: party.names,
    holderDocument: party.document,
    ownershipEvidence: null,
  };
  const verification = verifyBeneficiaryHolder(requisites, party, POLICY, NOW);
  return { requisites, status: verification.outcome, locked: false, lastChangedAt: null };
}

/* ------------------------------------------------------------------------- */
/* Сырые ответы источников                                                   */
/* ------------------------------------------------------------------------- */

export function rawSource(
  seed: number,
  sourceKind: RawSourceRef['sourceKind'],
  provider: string,
): RawSourceRef {
  return rawSourceRef({
    sourceKind,
    storageRef: `documents/${sourceKind}/${seed}`,
    mediaType: 'application/json',
    byteLength: 1024 + seed,
    digest: fp(1000 + seed),
    receivedAt: auditInstant(NOW),
    provider,
  });
}

export const CONDITION_ACT_SOURCE = rawSource(1, 'condition_act', 'sdelka.cabinet');
export const REGISTRY_EXTRACT_SOURCE = rawSource(2, 'registry_extract', 'registry.ge');
export const BANK_RESPONSE_SOURCE = rawSource(3, 'payment_provider_response', 'bank.partner');
export const BANK_REFUND_SOURCE = rawSource(4, 'payment_provider_response', 'bank.partner');
export const STATEMENT_SOURCE = rawSource(5, 'bank_statement', 'bank.partner');
export const SCREENING_SOURCE = rawSource(6, 'screening_response', 'screening.provider');

/* ------------------------------------------------------------------------- */
/* Акт получателя об условии                                                 */
/* ------------------------------------------------------------------------- */

export const CREATED_ON: IsoDate = isoDate('2026-09-03');

export function conditionAct(recipientPartyId: string = SELLER.partyId): ConditionAct {
  return {
    recipientPartyId,
    agreedAt: instant(Date.UTC(2026, 8, 3, 9, 0, 0)),
    conditionTextVersion: 'condition.registration_transfer.v1',
    conditionType: 'registration_transfer',
  };
}

/* ------------------------------------------------------------------------- */
/* Суммы                                                                     */
/* ------------------------------------------------------------------------- */

/** 200 000 ₾ в тетри. Ступень утверждений — две подписи (`FUNCTIONAL.md` §3.5). */
export const DEAL_AMOUNT: Money<CurrencyCode> = money(GEL, 20_000_000n);
/** Та же сумма в долларах по клиентскому курсу 2,50. */
export const DEAL_AMOUNT_USD: Money<CurrencyCode> = money(USD, 8_000_000n);

/** Комиссия платформы 1,5%. Ставка — рациональное число, не float. */
export const PLATFORM_FEE: readonly Deduction[] = Object.freeze([
  Object.freeze({ key: 'platform_fee', rate: rational(150n, 10_000n) }),
]);

export const FX_RATES = Object.freeze({
  client: rational(250n, 100n),
  reference: rational(255n, 100n),
  official: rational(252n, 100n),
});

/* ------------------------------------------------------------------------- */
/* Порты                                                                     */
/* ------------------------------------------------------------------------- */

export const ALL_FIELDS_MATCH: StatementFields = Object.freeze({
  cadastralCode: true,
  ownerDocumentNumber: true,
  share: true,
  basis: true,
  noUnexpectedEncumbrances: true,
});

/** Реестр отдал платную выписку: переход права зарегистрирован на покупателя. */
export function registryWithTransfer(): RegistryPort {
  return {
    paidExtract: () => ({
      statementFields: ALL_FIELDS_MATCH,
      ownerIsBuyer: true,
      ownerDocumentNumber: 'matched',
      rawSource: REGISTRY_EXTRACT_SOURCE,
      observedAt: NOW,
    }),
  };
}

/** Реестр отдал выписку, из которой видно, что перехода права не было. */
export function registryWithoutTransfer(): RegistryPort {
  return { paidExtract: (): RegistryExtract | null => null };
}

/**
 * Выписка есть, все пять полей сошлись — но новым собственником в ней значится
 * **продавец**, а не покупатель. Это не «данных нет»: это доказательство, что
 * переход права не состоялся, и на нём стоит `g_owner_is_buyer` (§1.3).
 *
 * Отдельная фикстура, а не флаг у `registryWithTransfer`: случай, в котором
 * пакет доказательств собран и поля совпали, а собственник не тот, — ровно тот,
 * где ошибка стоит всей суммы сделки.
 */
export function registryWithoutOwnerChange(): RegistryPort {
  return {
    paidExtract: () => ({
      statementFields: ALL_FIELDS_MATCH,
      ownerIsBuyer: false,
      ownerDocumentNumber: 'matched',
      rawSource: REGISTRY_EXTRACT_SOURCE,
      observedAt: NOW,
    }),
  };
}

export interface BankScript {
  readonly outcomes: readonly BankOutcome[];
  readonly reconciliation: ReconciliationOutcome | null;
}

/**
 * Банк как источник событий, а не мок провайдера: у него нет ожиданий, нет
 * проверки вызовов и нет поведения. Он отдаёт заранее записанные исходы по
 * порядку — ровно то, что приложение подаёт событием `payout_result`.
 */
export function bankPort(script: BankScript): BankPort {
  let index = 0;
  return {
    outcomeFor: (): BankOutcome => {
      const outcome = script.outcomes[Math.min(index, script.outcomes.length - 1)];
      if (outcome === undefined) {
        throw new Error('e2e.bank.no_scripted_outcome');
      }
      index += 1;
      return outcome;
    },
    reconcile: () => script.reconciliation,
  };
}

export function settledOutcome(response: RawSourceRef = BANK_RESPONSE_SOURCE): BankOutcome {
  return { outcome: 'settled' as Exclude<PayoutOutcome, 'unknown'>, response, reasonKey: null };
}

export function unknownOutcome(): BankOutcome {
  return { outcome: 'unknown', response: null, reasonKey: 'payout.timeout' };
}

/* --- Скрининг --- */

export function cleanScreening(): SanctionsScreeningPort {
  return {
    screen: (_request: SanctionsScreeningRequest): Promise<SanctionsProviderResponse> =>
      Promise.resolve({
        kind: 'completed',
        candidates: Object.freeze([]),
        providerReference: 'screening-run-1',
        rawResponseRef: fp(2001),
        screenedAt: NOW,
      }),
  };
}

/**
 * Совпадение по **сильному идентификатору** — номеру документа. Только оно даёт
 * `confirmed_match`: совпадение по имени сильным не считается, латинизация
 * грузинского необратима.
 */
export function sanctionedScreening(): SanctionsScreeningPort {
  const candidate: SanctionsCandidate = {
    listSource: 'us_ofac',
    listEntryId: 'OFAC-000001',
    listEntryVersion: '2026-08-01',
    entryType: 'person',
    matchedFields: Object.freeze(['name', 'document_number'] as const),
    providerScoreBp: 9_800,
    programmes: Object.freeze(['SDN']),
    listNames: null,
  };
  return {
    screen: (): Promise<SanctionsProviderResponse> =>
      Promise.resolve({
        kind: 'completed',
        candidates: Object.freeze([candidate]),
        providerReference: 'screening-run-2',
        rawResponseRef: fp(2002),
        screenedAt: NOW,
      }),
  };
}

/** Сутки в миллисекундах: `DAY` домена — брендированная длительность, не число. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Клиент в двух ролях: получатель по одной сделке и плательщик по другой.
 * Счёт у него один — ключом счёта служит ключ личности, а не пара «сделка+роль».
 */
export const TWO_ROLE_DOCUMENT = document(14);
export const TWO_ROLE_NAMES = Object.freeze([latinName('Kelo', 'Marven')]);
export const TWO_ROLE = profile('party-two-role', TWO_ROLE_DOCUMENT, TWO_ROLE_NAMES);

/** 100 000 ₾: ступень утверждений — одна подпись. */
export const SMALL_AMOUNT: Money<CurrencyCode> = money(GEL, 10_000_000n);
