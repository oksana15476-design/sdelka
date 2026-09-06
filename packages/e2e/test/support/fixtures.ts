import {
  type RawSourceRef,
  auditInstant,
  type CapturedRawSource,
  captureRawSource,
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
  beneficiaryStateOf,
  countryCode,
  documentNumberFingerprint,
  nameObservation,
  verifyBeneficiaryHolder,
} from '@sdelka/compliance';
import {
  type ConditionAct,
  type Instant,
  type ParticipationKey,
  type PartyRef,
  type PayoutOutcome,
  type ReconciliationOutcome,
  type StatementFields,
  instant,
  participationKey,
} from '@sdelka/domain';
import {
  type CurrencyCode,
  type IsoDate,
  type Money,
  fxRates,
  isoDate,
  money,
  rational,
} from '@sdelka/money';
import {
  type ActorRef,
  type RoleId,
  accountId,
  actorRef,
  personId,
} from '@sdelka/auth';
import {
  type TariffPlan,
  type TariffSeries,
  tariffPlan,
  tariffSeriesFromStore,
} from '@sdelka/pricing';
import {
  type SettingsVersion,
  type SettingsVersionId,
  settingsReasonKey,
  settingsVersion,
  settingsVersionId,
} from '@sdelka/settings';
import {
  type BankOutcome,
  type BankPort,
  type RegistryAnswer,
  type RegistryApplicationCard,
  type RegistryExtract,
  type RegistryPort,
  PROVISIONAL_WITHDRAWAL_CLOCK_VALUE,
  toClientKey,
} from '@sdelka/app';
import type { WithdrawalClockPolicy } from '@sdelka/domain';

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

/**
 * Часы заявки на вывод в сквозных сценариях.
 *
 * ⚠ **Временное значение владельца, а не число сценария** (`DECISIONS-REVIEW.md`
 * §H4 **[открыто]**). Сценарий, придумавший себе норматив, проверяет
 * придуманное; как эта величина берётся из журнала версий настроек, показывает
 * `withdrawal-stall.test.ts`.
 */
export const WITHDRAWAL_CLOCK: WithdrawalClockPolicy = PROVISIONAL_WITHDRAWAL_CLOCK_VALUE;

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
 * Участие получателя в сделке. Реквизиты выплаты висят на нём, а не на лице
 * (`@sdelka/domain`, `participation.ts`; ROADMAP.md И13.1).
 */
export function recipientParticipation(dealId: string, party: PartyProfile): ParticipationKey {
  return participationKey(dealId, partyRef(party), 'recipient');
}

/**
 * Реквизиты выплаты со статусом, посчитанным настоящим `verifyBeneficiaryHolder`.
 * Статус не выставляется руками: `verified` открывает выплату, и подставить его
 * означало бы обойти ровно тот guard, ради которого он существует (И13.1).
 *
 * Сделка — первым аргументом: подтверждение принадлежит участию, и фикстуры,
 * которая делала бы «реквизиты этого лица вообще», больше не существует.
 */
export function beneficiaryFor(
  dealId: string,
  party: PartyProfile,
  seed: number,
): BeneficiaryState {
  const requisites: BeneficiaryRequisites = {
    account: accountFingerprint(fp(seed)),
    holderNames: party.names,
    holderDocument: party.document,
    ownershipEvidence: evidenceRef(seed, 'test_transfer'),
  };
  return beneficiaryStateOf(
    verifyBeneficiaryHolder(recipientParticipation(dealId, party), requisites, party, POLICY, NOW),
    requisites,
  );
}

/** Реквизиты, у которых сошлось только имя: доказательства владения нет. */
export function nameConsistentBeneficiary(
  dealId: string,
  party: PartyProfile,
  seed: number,
): BeneficiaryState {
  const requisites: BeneficiaryRequisites = {
    account: accountFingerprint(fp(seed)),
    holderNames: party.names,
    holderDocument: party.document,
    ownershipEvidence: null,
  };
  return beneficiaryStateOf(
    verifyBeneficiaryHolder(recipientParticipation(dealId, party), requisites, party, POLICY, NOW),
    requisites,
  );
}

/* ------------------------------------------------------------------------- */
/* Сырые ответы источников                                                   */
/* ------------------------------------------------------------------------- */

export function rawSource(
  seed: number,
  sourceKind: RawSourceRef['sourceKind'],
  provider: string,
): CapturedRawSource {
  // Байты настоящие, пусть и синтетические: отпечаток считается из них, а не
  // выдумывается. Фикстура, подставляющая отпечаток мимо байтов, проверяла бы
  // форму строки, а не доказуемость источника.
  const bytes = new Uint8Array(1024 + seed);
  bytes.fill(seed % 256);
  return captureRawSource({
    sourceKind,
    storageRef: `documents/${sourceKind}/${seed}`,
    mediaType: 'application/json',
    receivedAt: auditInstant(NOW),
    provider,
    bytes,
  });
}

export const CONDITION_ACT_SOURCE = rawSource(1, 'condition_act', 'sdelka.cabinet');
export const REGISTRY_EXTRACT_SOURCE = rawSource(2, 'registry_extract', 'registry.ge');
export const BANK_RESPONSE_SOURCE = rawSource(3, 'payment_provider_response', 'bank.partner');
export const BANK_REFUND_SOURCE = rawSource(4, 'payment_provider_response', 'bank.partner');
export const STATEMENT_SOURCE = rawSource(5, 'bank_statement', 'bank.partner');
export const SCREENING_SOURCE = rawSource(6, 'screening_response', 'screening.provider');
/**
 * Служебная записка оператора — основание исправления записи журнала.
 *
 * Вид `operator_note` заведён в `RAW_SOURCE_KINDS` ровно под такой случай:
 * основание у исправления обязательно типом, и «основания не бывает» — не
 * случай, а пропуск (`packages/audit/src/record.ts`, `CorrectionBody`).
 */
export const OPERATOR_NOTE_SOURCE = rawSource(7, 'operator_note', 'sdelka.console');

/* ------------------------------------------------------------------------- */
/* Акт получателя об условии                                                 */
/* ------------------------------------------------------------------------- */

export const CREATED_ON: IsoDate = isoDate('2026-09-03');

/**
 * Сторона сделки одним значением: ключ участия и ключ её счёта в учёте.
 *
 * Порознь их взять неоткуда — в этом и смысл `PartyRef` (`FUNCTIONAL.md` §2.1).
 * Фикстура собирает обе половины из одного профиля, поэтому «назвать стороной
 * одного, а счёт взять у другого» здесь невыразимо так же, как в домене.
 */
export function partyRef(party: PartyProfile): PartyRef {
  return { partyId: party.partyId, accountKey: toClientKey(party.document) };
}

export function conditionAct(recipient: PartyRef = partyRef(SELLER)): ConditionAct {
  return {
    recipient,
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

/**
 * Тариф сквозных сценариев: 150 базисных пунктов, то есть 1,5 % — арифметика
 * потока P2 (`FUNCTIONAL.md` §3.4), на которой стоят все ожидаемые числа
 * ниже по тестам (300 000 из 20 000 000, нетто 19 700 000).
 *
 * ⚠ **Это фикстура, а не норма.** Само число — вопрос владельца
 * (`DECISIONS-REVIEW.md` §J1 **[открыто]**); здесь оно взято затем, чтобы
 * ожидания сквозных сценариев не поменялись при подключении журнала версий, и
 * расхождение осталось видно ровно там, где оно и было.
 */
export const TARIFF_PLAN: TariffPlan = tariffPlan({ rateBp: 150, currency: GEL });

/** Кто двигает настройку: полномочие `manage_settings` выдано одной роли. */
const TARIFF_AUTHOR: ActorRef = actorRef(accountId('acc-principal'), personId('person-principal'));
const TARIFF_AUTHOR_ROLE: RoleId = 'principal';

/**
 * Версия тарифа, действующая **до** момента сквозных сценариев.
 *
 * Прежде здесь лежала строка `'tariff-2026-09-01'` — метка, которую никто ни с
 * чем не сверял. Теперь это идентификатор версии в журнале настроек
 * (`<домен>/<ГГГГ-ММ-ДД>.<n>`), и он же уходит в запись начисления: посчитано и
 * записано — по одной и той же версии, потому что взяты они из одного значения.
 */
export const TARIFF_VERSION_ID = settingsVersionId('tariff/2026-09-01.1');

/** Момент вступления версии в силу: раньше `NOW`, иначе тарифа на транше нет. */
export const TARIFF_EFFECTIVE_FROM: Instant = instant(Date.UTC(2026, 8, 1, 9, 0, 0));

export function tariffVersionFor(
  plan: TariffPlan,
  versionId: SettingsVersionId = TARIFF_VERSION_ID,
  effectiveFrom: Instant = TARIFF_EFFECTIVE_FROM,
  supersedes: SettingsVersionId | null = null,
  /**
   * Момент записи. По умолчанию совпадает с моментом вступления в силу; у
   * **отложенной** версии он раньше — иначе получилась бы версия, записанная в
   * будущем, чего в журнале не бывает.
   */
  recordedAt: Instant = effectiveFrom,
): SettingsVersion<TariffPlan> {
  return settingsVersion<TariffPlan>({
    versionId,
    value: plan,
    introducedBy: TARIFF_AUTHOR,
    introducedByRole: TARIFF_AUTHOR_ROLE,
    reasonKey: settingsReasonKey('settings.reason.owner_decision'),
    recordedAt,
    effectiveFrom,
    supersedes,
  });
}

/** Журнал версий тарифа, которым засеивается мир сквозного сценария. */
export function tariffJournal(...versions: readonly SettingsVersion<TariffPlan>[]): TariffSeries {
  const built = tariffSeriesFromStore(
    versions.length === 0 ? [tariffVersionFor(TARIFF_PLAN)] : versions,
  );
  if (!built.ok) throw new Error(`fixtures.tariff_series:${built.error}`);
  return built.value;
}

/** Журнал по умолчанию: одна версия, 1,5 %, действует с 1 сентября. */
export const TARIFF_SERIES: TariffSeries = tariffJournal();

/**
 * Три курса на пару USD→GEL. Пара объявлена **в самой величине**, а не в
 * аргументах вызова: направление — часть курса, и подставить эти множители под
 * обратное направление больше нечем (`@sdelka/money`, `fxRates`).
 */
export const FX_RATES = fxRates(USD, GEL, {
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

/**
 * Кадастровый код объекта сделки. Один на все фикстуры: `g_observation_sufficient`
 * сверяет код наблюдения с кодом объекта, и «выписка по чужому объекту»
 * выражается подстановкой другого кода, а не флагом.
 */
export const CADASTRAL_CODE = '01.10.14.001.123';
/** Объект соседней сделки: тот же реестр, другая вещь. */
export const OTHER_CADASTRAL_CODE = '01.10.14.001.777';

export const APPLICATION_ID = 'app-registration-1';

function found<T>(value: T): RegistryAnswer<T> {
  return { kind: 'found', value };
}

function extract(overrides: Partial<RegistryExtract> = {}): RegistryExtract {
  return {
    fields: ALL_FIELDS_MATCH,
    ownerDocumentNumber: 'matched',
    // Имя собственника из выписки — вторичный сигнал: вердикт даёт номер
    // документа. Совпадающее имя при отсутствующем номере обязано давать
    // `insufficient`, и фикстура «без номера» это и проверяет.
    ownerNames: BUYER_NAMES,
    cadastralCode: CADASTRAL_CODE,
    rawSource: REGISTRY_EXTRACT_SOURCE,
    observedAt: NOW,
    ...overrides,
  };
}

function card(overrides: Partial<RegistryApplicationCard> = {}): RegistryApplicationCard {
  return {
    applicationId: APPLICATION_ID,
    cadastralCode: CADASTRAL_CODE,
    // Статус — непрозрачная строка: ни одно решение его не читает (`CORE.md` Ф7).
    applicationStatus: 'in_progress',
    digest: fp(3001),
    observedAt: NOW,
    ...overrides,
  };
}

/**
 * Реестр, у которого нет ничего. Ответ, а не молчание: `absent` — это «реестр
 * посмотрел и не нашёл», и от `unavailable` он отличается тем, что на нём можно
 * принимать решения.
 */
function emptyRegistry(): RegistryPort {
  return {
    paidExtract: () => ({ kind: 'absent' }),
    applicationCard: () => ({ kind: 'absent' }),
    openApplication: () => ({ kind: 'absent' }),
  };
}

/** Реестр отдал платную выписку: переход права зарегистрирован на покупателя. */
export function registryWithTransfer(): RegistryPort {
  return { ...emptyRegistry(), paidExtract: () => found(extract()) };
}

/** Реестр отдал выписку, из которой видно, что перехода права не было. */
export function registryWithoutTransfer(): RegistryPort {
  return emptyRegistry();
}

/**
 * Выписка есть, все пять полей сошлись — но номер документа собственника в ней
 * **другой**. Это не «данных нет»: это доказательство, что переход права не
 * состоялся, и `reconcileOwner` даёт `refuted`, на котором стоит
 * `g_owner_is_buyer` (§1.3).
 *
 * Отдельная фикстура, а не флаг у `registryWithTransfer`: случай, в котором
 * пакет доказательств собран и поля совпали, а собственник не тот, — ровно тот,
 * где ошибка стоит всей суммы сделки.
 */
export function registryWithoutOwnerChange(): RegistryPort {
  return {
    ...emptyRegistry(),
    paidExtract: () =>
      found(extract({ ownerDocumentNumber: 'mismatched', ownerNames: SELLER_NAMES })),
  };
}

/**
 * Выписка пришла, все поля сошлись, имя собственника совпало **точно** — но
 * номера документа в выписке нет (`CORE.md` Ф7, открытый вопрос по
 * иностранцам). Вердикт `insufficient`, и он роняет `g_owner_is_buyer` ровно
 * так же, как `refuted`: «наверное совпало» основанием для денег не является.
 */
export function registryWithoutOwnerDocumentNumber(): RegistryPort {
  return {
    ...emptyRegistry(),
    paidExtract: () => found(extract({ ownerDocumentNumber: 'absent' })),
  };
}

/**
 * Выписка пришла, собственник — покупатель, но в реестре обнаружено
 * обременение, которого стороны не объявляли.
 *
 * Самый неприятный из отказов по выписке: четыре поля из пяти сошлись, переход
 * права состоялся, а вещь оказалась обременённой. `g_fields_match` проверяет
 * все пять **поимённо**, а не счётчиком совпадений, ровно ради этого случая.
 */
export function registryWithEncumbrance(): RegistryPort {
  return {
    ...emptyRegistry(),
    paidExtract: () =>
      found(extract({ fields: { ...ALL_FIELDS_MATCH, noUnexpectedEncumbrances: false } })),
  };
}

/** Выписка по **чужому объекту**: всё в ней сошлось, но она не про нашу вещь. */
export function registryWithForeignObject(): RegistryPort {
  return {
    ...emptyRegistry(),
    paidExtract: () => found(extract({ cadastralCode: OTHER_CADASTRAL_CODE })),
  };
}

/**
 * Карточка заявления есть, выписки ещё нет: бесплатный сигнал уровня L1.
 * Тайминг он запускает, деньги — нет.
 */
export function registryWithApplicationCard(): RegistryPort {
  return {
    ...emptyRegistry(),
    applicationCard: () => found(card()),
    openApplication: () => found(card()),
  };
}

/**
 * Реестр не отвечает. Отдельный исход, а не `absent`: отсутствие сигнала — не
 * «всё хорошо», и приравнивать одно к другому значит запускать возврат по
 * техническому инциденту (`ORACLE.md` §10).
 */
export function registryUnavailable(): RegistryPort {
  const down = <T>(): RegistryAnswer<T> => ({
    kind: 'unavailable',
    reasonKey: 'oracle.registry.unavailable',
  });
  return { paidExtract: down, applicationCard: down, openApplication: down };
}

/** Выписка из порта или отказ сборки: не-`found` здесь — дефект фикстуры, не сценарий. */
export function extractOf(port: RegistryPort, cadastralRef: string): RegistryExtract {
  const answer = port.paidExtract(cadastralRef);
  if (answer.kind !== 'found') {
    throw new Error(`e2e.fixture.extract_missing:${answer.kind}`);
  }
  return answer.value;
}

/** Карточка заявления из порта. Та же дисциплина, что у выписки. */
export function cardOf(port: RegistryPort, applicationId: string): RegistryApplicationCard {
  const answer = port.applicationCard(applicationId);
  if (answer.kind !== 'found') {
    throw new Error(`e2e.fixture.card_missing:${answer.kind}`);
  }
  return answer.value;
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
