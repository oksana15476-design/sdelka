import { type CapturedRawSource, captureRawSource, auditInstant, auditRef } from '@sdelka/audit';
import {
  type BeneficiaryRequisites,
  type BeneficiaryState,
  type CompliancePolicy,
  type CounterpartyFacts,
  type CountryCode,
  type IdentityDocument,
  type NameObservation,
  type PartyProfile,
  POLICY_2026_09_03,
  accountFingerprint,
  assessCounterparty,
  beneficiaryStateOf,
  countryCode,
  documentNumberFingerprint,
  nameObservation,
  payerKeyForDomain,
  verifyBeneficiaryHolder,
} from '@sdelka/compliance';
import {
  type ConditionAct,
  type DealEvent,
  type DealState,
  type Instant,
  type PartyRef,
  type TrancheEvent,
  type TrancheState,
  instant,
  participationKey,
} from '@sdelka/domain';
import type { RoleId, SecondFactorAssertion } from '@sdelka/auth';
import { accountId, actorRef, challengeId, personId } from '@sdelka/auth';
import { duration } from '@sdelka/domain';
import type { ClientKey } from '@sdelka/ledger';
import { type CurrencyCode, type IsoDate, type Money, isoDate, money } from '@sdelka/money';
import { type TariffSeries, tariffPlan, tariffSeriesFromStore } from '@sdelka/pricing';
import { settingsReasonKey, settingsVersion, settingsVersionId } from '@sdelka/settings';
import {
  type ActionSubject,
  type Authority,
  AuthorityError,
  PLATFORM_SUBJECT,
  dealSubject,
  openSession,
  requireAuthority,
  trancheSubject,
} from './authority';
import type { RegistryExtract } from './ports';
import {
  type TrancheEventOptions,
  applyDealEvent,
  applyObservationEvent,
  approve,
  createDeal,
  createTranche,
  emptyWorld,
  feeForTranche,
  receiveExternalPayment,
  receivePaidExtract,
  receiveTrancheFee,
  recordConditionAct,
  recordDecision,
  applyTrancheEvent,
  trancheOptions,
} from './flow';
import { toClientKey } from './keys';
import {
  type StoreOption,
  type UnmappedPart,
  type WriteOutcome,
  EMPTY_WRITE,
  WITHOUT_STORE,
  addWrites,
  openWorld,
  stepWorld,
} from './store';
import { type World, dealOf, trancheOf } from './world';

/**
 * Засев базы теми же сценариями, по которым нарисован интерфейс.
 *
 * **Что чинится.** Сценарии живут в `apps/web/src/fixtures`: экран читает их
 * напрямую, и до базы они не доходили никогда. Это вторая правда рядом с
 * настоящей — положение денег, собранное слоем, которого нет в продукте. Здесь
 * те же сценарии кладутся в базу **боевым путём**: шаги `flow.ts`, полномочия
 * `authority.ts`, запечатывание мира `world.ts` и запись шага `store.ts`. Ни
 * одного `INSERT` мимо инвариантов: засев, пишущий в базу напрямую, кладёт туда
 * состояние, которого в жизни быть не может, и все последующие проверки
 * становятся ложью.
 *
 * **Почему в `@sdelka/app`, а не в `@sdelka/db`.** Собрать мир можно только
 * отсюда: тариф, комплаенс, сессии, автоматы и запечатывание живут в этом слое,
 * и «через тот же путь» означает буквально эти функции. Хранилище приезжает
 * сюда **портом** (`StoreOption`) — ни строки `pg`, ни знания о схеме тут нет;
 * подключение к базе, отказ работать на настоящих данных и проверка инвариантов
 * после засева живут в `@sdelka/db`, потому что для них нужна схема.
 *
 * **Чего здесь нет.**
 *
 * - Персональных данных. Имена — сконструированные последовательности букв,
 *   номера документов и счетов — синтетические отпечатки. Та же дисциплина, что
 *   в фикстурах сквозного контура.
 * - Пользовательского текста. Наружу выходят технические ключи и идентификаторы
 *   (`CLAUDE.md`, «Три языка»): всё, что видит клиент, живёт в локализации.
 * - Случайности и системных часов. Идентификаторы выводятся из цепочки и
 *   счётчика мира, момент засева задаётся значением, — повтор даёт те же строки,
 *   и хранилище отличает повтор от второй записи (`ids.ts`).
 */

/* ------------------------------------------------------------------------- */
/* Пространство имён засева                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Признак засеянной строки — **начало идентификатора**, а не количество строк и
 * не отдельная таблица-флажок.
 *
 * Признак обязан быть у каждой строки, которую засев кладёт, и проверяться
 * запросом: «в базе мало строк» настоящие данные от засеянных не отличает
 * (первая же неделя продакшена начинается с одной сделки), а флажок в отдельной
 * таблице отвечает за всю базу сразу и врёт, как только рядом с засевом появится
 * хоть одна живая запись.
 *
 * Отсюда именуются: цепочка журнала аудита (значит и записи журнала учёта — их
 * идентификатор несёт цепочку), сделка, транш и стороны. Поручение на выплату
 * своего имени не имеет — его ключ идемпотентности считает домен из
 * идентификатора транша, — поэтому в базе оно опознаётся по сделке.
 */
export const SEED_PREFIX = 'seed-';

/** Цепочка журнала аудита сценария: у каждого сценария своя. */
export function seedChainId(scenarioId: string): string {
  return `${SEED_PREFIX}${scenarioId}`;
}

export function seedDealId(scenarioId: string): string {
  return `${SEED_PREFIX}${scenarioId}-deal`;
}

export function seedTrancheId(scenarioId: string): string {
  return `${SEED_PREFIX}${scenarioId}-tranche`;
}

/* ------------------------------------------------------------------------- */
/* Величины засева                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Момент, в котором стоит засеянный мир.
 *
 * Значение, а не `Date.now()`: идентификаторы записей выводятся из счётчика
 * мира, но дедлайны, сроки сессий и возраст наблюдения — из момента, и засев,
 * зависящий от часов машины, давал бы разные строки при каждом прогоне. Тот же
 * момент, что у фикстур интерфейса (`apps/web/src/fixtures/engine.ts`,
 * `FIXTURE_NOW`), — чтобы одно и то же положение денег на экране и в базе не
 * разъезжалось по времени.
 */
export const SEED_NOW: Instant = instant(Date.UTC(2026, 8, 3, 10, 0, 0));

const GEL: CurrencyCode = 'GEL';

/** Политика комплаенса, действовавшая в момент засева. */
export const SEED_POLICY: CompliancePolicy = POLICY_2026_09_03;

const SEED_CREATED_ON: IsoDate = isoDate('2026-09-03');

/** Кадастровый код объекта: один на все сценарии засева, как у сквозного контура. */
const SEED_CADASTRAL_CODE = '01.14.05.021.041';

const SEED_APPLICATION_ID = 'seed-registration-1';

/**
 * Тариф засеянного мира — 1,5 %, версия от 1 сентября.
 *
 * ⚠ **Фикстура, а не норма.** Само число принадлежит владельцу
 * (`DECISIONS-REVIEW.md` §J1 **[открыто]**); здесь оно взято затем, чтобы
 * засеянный транш вообще имел тариф: мир без журнала версий транша не заводит
 * вовсе, и подставить «ноль по умолчанию» значило бы взять в деньги число,
 * которого никто не выбирал.
 */
export function seedTariffs(): TariffSeries {
  const built = tariffSeriesFromStore([
    settingsVersion({
      versionId: settingsVersionId('tariff/2026-09-01.1'),
      value: tariffPlan({ rateBp: 150, currency: GEL }),
      introducedBy: actorRef(accountId('seed-principal'), personId('seed-person-principal')),
      introducedByRole: 'principal',
      reasonKey: settingsReasonKey('settings.reason.owner_decision'),
      recordedAt: instant(Date.UTC(2026, 8, 1, 9, 0, 0)),
      effectiveFrom: instant(Date.UTC(2026, 8, 1, 9, 0, 0)),
      supersedes: null,
    }),
  ]);
  if (!built.ok) {
    throw new Error(`app.seed.tariff_series:${built.error}`);
  }
  return built.value;
}

/* ------------------------------------------------------------------------- */
/* Стороны                                                                   */
/* ------------------------------------------------------------------------- */

const GE: CountryCode = countryCode('GE');

/** Синтетический отпечаток: 64 hex из порядкового номера, и ничего больше. */
function fingerprint(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

function seedDocument(seed: number): IdentityDocument {
  return {
    issuingCountry: GE,
    type: 'passport',
    numberFingerprint: documentNumberFingerprint(fingerprint(seed)),
    expiresAt: Date.UTC(2032, 0, 1),
  };
}

function seedName(given: string, family: string): NameObservation {
  return nameObservation({
    alphabet: 'latin',
    given,
    family,
    source: 'identity_document',
    evidenceWeightBp: 10_000,
  });
}

/**
 * Стороны засева.
 *
 * Ключи повторяют фикстуры интерфейса (`data.json`), чтобы сценарий на экране и
 * сценарий в базе назывались одинаково. Имена — **не** оттуда: в фикстурах
 * стоят похожие на настоящие имена и адреса, и переносить их в базу незачем.
 */
const SEED_PARTIES = Object.freeze({
  weiss: seedParty('weiss', 11, 'Sabo', 'Tikato'),
  beridze: seedParty('beridze', 12, 'Nuvo', 'Zerlan'),
  kikvadze: seedParty('kikvadze', 13, 'Rimo', 'Valdek'),
  kobalia: seedParty('kobalia', 14, 'Teli', 'Marsun'),
  orbeliani: seedParty('orbeliani', 15, 'Vardo', 'Ketani'),
});

export type SeedPartyKey = keyof typeof SEED_PARTIES;

function seedParty(key: string, seed: number, given: string, family: string): PartyProfile {
  return {
    partyId: `${SEED_PREFIX}party-${key}`,
    kind: 'natural_person',
    document: seedDocument(seed),
    georgianPersonalNumber: null,
    names: Object.freeze([seedName(given, family)]),
    residenceCountry: GE,
    nationalities: Object.freeze([GE]),
    kyc: 'complete',
    biometrics: 'not_requested',
  };
}

function partyRefOf(profile: PartyProfile): PartyRef {
  return { partyId: profile.partyId, accountKey: toClientKey(profile.document) };
}

function conditionActOf(recipient: PartyRef): ConditionAct {
  return {
    recipient,
    agreedAt: instant(Date.UTC(2026, 8, 3, 9, 0, 0)),
    conditionTextVersion: 'condition.registration_transfer.v1',
    conditionType: 'registration_transfer',
  };
}

function beneficiaryOf(dealId: string, profile: PartyProfile, seed: number): BeneficiaryState {
  const requisites: BeneficiaryRequisites = {
    account: accountFingerprint(fingerprint(seed)),
    holderNames: profile.names,
    holderDocument: profile.document,
    ownershipEvidence: { kind: 'test_transfer', ref: `${SEED_PREFIX}evidence-${seed}`, observedAt: SEED_NOW },
  };
  return beneficiaryStateOf(
    verifyBeneficiaryHolder(
      participationKey(dealId, partyRefOf(profile), 'recipient'),
      requisites,
      profile,
      SEED_POLICY,
      SEED_NOW,
    ),
    requisites,
  );
}

/* ------------------------------------------------------------------------- */
/* Сырые ответы источников                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Сырой ответ источника: байты настоящие, пусть и синтетические.
 *
 * Отпечаток считается **из них**, а не подставляется: наблюдение с отпечатком,
 * за которым не стоит ни одного записанного ответа, до выплаты доходить не
 * должно (красная линия №5, `CORE.md` Ф11), и засев, подставляющий отпечаток
 * мимо байтов, положил бы в базу ровно такое наблюдение.
 */
function seedRawSource(
  seed: number,
  sourceKind: CapturedRawSource['sourceKind'],
  provider: string,
): CapturedRawSource {
  const bytes = new Uint8Array(512 + seed);
  bytes.fill(seed % 256);
  return captureRawSource({
    sourceKind,
    storageRef: `${SEED_PREFIX}documents/${sourceKind}/${seed}`,
    mediaType: 'application/json',
    receivedAt: auditInstant(SEED_NOW),
    provider,
    bytes,
  });
}

const CONDITION_ACT_SOURCE = seedRawSource(1, 'condition_act', 'sdelka.cabinet');
const REGISTRY_EXTRACT_SOURCE = seedRawSource(2, 'registry_extract', 'registry.ge');
const BANK_RESPONSE_SOURCE = seedRawSource(3, 'payment_provider_response', 'bank.partner');

function seedExtract(ownerNames: readonly NameObservation[]): RegistryExtract {
  return {
    fields: {
      cadastralCode: true,
      ownerDocumentNumber: true,
      share: true,
      basis: true,
      noUnexpectedEncumbrances: true,
    },
    ownerDocumentNumber: 'matched',
    ownerNames,
    cadastralCode: SEED_CADASTRAL_CODE,
    rawSource: REGISTRY_EXTRACT_SOURCE,
    observedAt: SEED_NOW,
  };
}

/* ------------------------------------------------------------------------- */
/* Штат засева                                                               */
/* ------------------------------------------------------------------------- */

interface SeedActor {
  readonly roleId: RoleId;
  readonly accountId: string;
  readonly personId: string;
}

function staff(roleId: RoleId, account: string): SeedActor {
  return Object.freeze({ roleId, accountId: account, personId: `person-${account}` });
}

/**
 * Штат засева — **сессии, а не строки**.
 *
 * Каждый шаг ниже сначала входит в систему и получает разрешение, и только
 * потом делает шаг: `requireAuthority` — то же решение, что в продукте, и его
 * отказ роняет засев. Разведён штат ровно по несовместимостям, ради которых
 * `@sdelka/auth` и построен: оператор готовит, оператор оракула наблюдает,
 * финансовый контролёр даёт первый уровень утверждения, руководитель
 * операций — второй.
 */
const SEED_STAFF = Object.freeze({
  operator: staff('operator', 'seed-operator-1'),
  oracle: staff('oracle_operator', 'seed-oracle-1'),
  analyst: staff('compliance_analyst', 'seed-analyst-1'),
  controller: staff('financial_controller', 'seed-approver-1'),
  head: staff('head_of_operations', 'seed-approver-2'),
});

/** Сторона сделки как действующее лицо: учётная запись — идентификатор участия. */
function partyActor(partyId: string): SeedActor {
  return Object.freeze({ roleId: 'party', accountId: partyId, personId: `person-${partyId}` });
}

function assertionOf(actor: SeedActor, at: Instant): SecondFactorAssertion {
  return {
    kind: 'webauthn',
    challengeId: challengeId(`${SEED_PREFIX}challenge-${actor.accountId}`),
    verifiedAt: at,
    device: null,
  };
}

/** Час: меньше абсолютного срока и консоли, и кабинета. */
const SEED_SESSION_TTL = duration(60 * 60 * 1000);

function login(world: World, actor: SeedActor): { readonly world: World; readonly sessionId: string } {
  const sessionId = `${SEED_PREFIX}session-${actor.accountId}`;
  const opened = openSession(world, {
    sessionId,
    accountId: actor.accountId,
    personId: actor.personId,
    roleId: actor.roleId,
    onDuty: false,
    primary: { method: 'passkey', at: world.now, device: null, network: null },
    factors: [assertionOf(actor, world.now)],
    requestedTtl: SEED_SESSION_TTL,
  });
  if (!opened.ok) {
    throw new AuthorityError(`app.seed.session_denied:${actor.accountId}:${opened.error}`);
  }
  return { world: opened.value.world, sessionId };
}

function acting<C extends Parameters<typeof requireAuthority>[2]>(
  world: World,
  capability: C,
  subject: ActionSubject,
  actor: SeedActor,
): { readonly world: World; readonly authority: Authority<C> } {
  const session = login(world, actor);
  return {
    world: session.world,
    authority: requireAuthority(session.world, session.sessionId, capability, subject),
  };
}

/* ------------------------------------------------------------------------- */
/* Каталог сценариев                                                         */
/* ------------------------------------------------------------------------- */

/**
 * До какого положения доводится сценарий.
 *
 * Ступени названы состояниями **автомата**, а не экранами: в базе лежит
 * состояние, а положение денег на экране — его прочтение вместе с фактами
 * приложения, которых у схемы нет вовсе (`store.ts`, `UNMAPPED_REASONS`).
 * Поэтому восемнадцать положений `SCREENS.md` §2.2 не дают восемнадцати разных
 * строк: «перевод заявлен», «платёж не опознан», «часы остановлены» — это факты
 * интерфейса поверх одного и того же `collecting`.
 */
export const SEED_STAGES = ['instructed', 'collected', 'reserved', 'settled'] as const;

export type SeedStage = (typeof SEED_STAGES)[number];

export interface SeedScenario {
  /** Идентификатор фикстуры интерфейса: `m01`, `r03`. Тот же, что на экране. */
  readonly id: string;
  /** Внешний номер сделки. Данные, а не текст: не переводится. */
  readonly ref: string;
  readonly stage: SeedStage;
  /** Получатель по сделке. Плательщик у всех один — владелец кабинета. */
  readonly counterparty: SeedPartyKey;
  /** Сумма сделки в минорных единицах. Плавающей точки нет нигде (№4). */
  readonly principalMinor: bigint;
}

/** Сумма сделки в роли плательщика: 217 000 ₾ в тетри — как у фикстур. */
const PAYING_AMOUNT = 21_700_000n;

/** Сумма сделки в роли получателя: 189 000 ₾ в тетри — как у фикстур. */
const RECEIVING_AMOUNT = 18_900_000n;

/**
 * Каталог засева.
 *
 * ⚠ **Второй список рядом с `apps/web/src/fixtures/scenarios.ts`, и это
 * названное расхождение.** Фикстуры интерфейса живут в приложении и написаны на
 * своём словаре шагов (`fixtures/engine.ts` зовёт редьюсеры домена напрямую);
 * пакет приложения импортировать их не может и не должен. Здесь перечислены те
 * же сценарии — тем же идентификатором и тем же внешним номером, — но доводятся
 * они боевыми шагами. Расхождение каталогов ловится проверкой
 * (`packages/db/test/seed-catalogue.test.ts`), а не обещанием.
 *
 * Правильный выход — один каталог, из которого читают оба: вынести его в
 * отдельный пакет либо перевести фикстуры интерфейса на шаги `@sdelka/app`. Это
 * решение владельца (`DECISIONS-REVIEW.md` §Y1 **[открыто]**), а не наше.
 */
export const SEED_SCENARIOS: readonly SeedScenario[] = Object.freeze([
  scenario('m01', 'SD-7K42', 'instructed', 'beridze', PAYING_AMOUNT),
  scenario('m02', 'SD-7K43', 'instructed', 'kikvadze', PAYING_AMOUNT),
  scenario('m03', 'SD-7K44', 'instructed', 'kikvadze', PAYING_AMOUNT),
  scenario('m06', 'SD-7K47', 'collected', 'kobalia', PAYING_AMOUNT),
  scenario('m09', 'SD-7K50', 'reserved', 'beridze', PAYING_AMOUNT),
  scenario('m12', 'SD-7K53', 'settled', 'kikvadze', PAYING_AMOUNT),
  scenario('r01', 'SD-8A10', 'instructed', 'orbeliani', RECEIVING_AMOUNT),
  scenario('r02', 'SD-8A11', 'collected', 'orbeliani', RECEIVING_AMOUNT),
  scenario('r03', 'SD-8A12', 'reserved', 'kobalia', RECEIVING_AMOUNT),
  scenario('r04', 'SD-8A13', 'settled', 'orbeliani', RECEIVING_AMOUNT),
]);

function scenario(
  id: string,
  ref: string,
  stage: SeedStage,
  counterparty: SeedPartyKey,
  principalMinor: bigint,
): SeedScenario {
  return Object.freeze({ id, ref, stage, counterparty, principalMinor });
}

/* ------------------------------------------------------------------------- */
/* Прогон сценария боевыми шагами                                            */
/* ------------------------------------------------------------------------- */

/**
 * Шаг засева: имя и то, что за ним записалось.
 *
 * Имя — технический ключ, по которому отказ ищется в отчёте команды; текстом
 * для клиента оно не является и в локализацию не идёт.
 */
export interface SeedStepOutcome {
  readonly key: string;
  readonly outcome: WriteOutcome;
  readonly unmapped: readonly UnmappedPart[];
}

export interface SeededScenario {
  readonly id: string;
  readonly dealId: string;
  readonly trancheId: string;
  readonly stage: SeedStage;
  readonly dealStatus: DealState['status'];
  readonly trancheStatus: TrancheState['status'];
  /**
   * Сумма, которую обязан перевести покупатель, — в минорных единицах.
   *
   * Лежит здесь ради сверки при повторе: положение автомата совпадает и у
   * сценария, у которого поменяли сумму, а транш с другой суммой — это другой
   * транш, и молча оставить в базе старый было бы ровно тем расхождением,
   * ради которого засев и делался.
   */
  readonly requiredMinor: bigint;
  readonly steps: readonly SeedStepOutcome[];
  readonly outcome: WriteOutcome;
  readonly unmapped: readonly UnmappedPart[];
}

interface Run {
  world: World;
  readonly steps: SeedStepOutcome[];
  outcome: WriteOutcome;
  readonly unmapped: UnmappedPart[];
}

/**
 * Один шаг мира вместе с записью.
 *
 * Порядок здесь тот же, что у продукта, и он не случайный: шаг выполняется,
 * запечатывается (то есть проходит инварианты) и только потом открывается
 * транзакция. Если запись не прошла, нового мира у засева не остаётся вовсе —
 * ошибка летит наверх, и следующий шаг не делается.
 */
async function step(run: Run, store: StoreOption, key: string, body: (world: World) => World): Promise<void> {
  const written = await stepWorld(store, run.world, body);
  run.world = written.world;
  run.outcome = addWrites(run.outcome, written.outcome);
  run.steps.push({ key, outcome: written.outcome, unmapped: written.unmapped });
  for (const part of written.unmapped) run.unmapped.push(part);
}

function options(): TrancheEventOptions {
  return trancheOptions(SEED_POLICY.version);
}

/** Деньги уже на свободной части счёта клиента: зачислял их отдельный шаг. */
function creditedOptions(): TrancheEventOptions {
  return trancheOptions(SEED_POLICY.version, { creditRoute: 'already_on_client_account' });
}

/**
 * Заведение сделки и транша, акт получателя об условии и проверка сторон.
 *
 * Комплаенс настоящий: исход считает `assessCounterparty`, а не засев. Скрининга
 * по санкционным спискам здесь нет — он требует внешнего источника, а сети у
 * засева быть не должно; в журнал ложится решение по связанности сторон, за
 * которым стоит вызов, а не строка.
 */
async function openScenario(
  run: Run,
  store: StoreOption,
  item: SeedScenario,
  buyer: PartyProfile,
  seller: PartyProfile,
): Promise<void> {
  const dealId = seedDealId(item.id);
  const trancheId = seedTrancheId(item.id);
  const act = conditionActOf(partyRefOf(seller));

  await step(run, store, 'deal.create', (world) => {
    const acted = acting(world, 'create_deal', dealSubject(dealId), SEED_STAFF.operator);
    return createDeal(acted.world, { dealId, conditionAct: act, objectCadastralCode: SEED_CADASTRAL_CODE }, acted.authority);
  });

  const facts: CounterpartyFacts = {
    participations: [
      { partyId: buyer.partyId, role: 'payer', document: buyer.document },
      { partyId: seller.partyId, role: 'recipient', document: seller.document },
    ],
    relation: { kind: 'unrelated' },
    nameMatch: null,
    evidence: [{ kind: 'contract', ref: `${SEED_PREFIX}evidence-contract-${item.id}`, observedAt: SEED_NOW }],
  };
  const assessed = assessCounterparty(facts, SEED_POLICY.version, SEED_NOW);
  if (assessed.outcome === 'block') {
    // Сюда не дойти на синтетических сторонах, и именно поэтому проверка стоит:
    // засев, тихо продолжающий после блокирующего исхода, положил бы в базу
    // сделку, которую продукт завести не дал бы.
    throw new Error(`app.seed.counterparty_blocked:${item.id}`);
  }

  await step(run, store, 'deal.decision', (world) => {
    const acted = acting(world, 'adjudicate_screening', dealSubject(dealId), SEED_STAFF.analyst);
    return recordDecision(
      acted.world,
      {
        subject: auditRef('deal', dealId),
        related: [auditRef('party', buyer.partyId), auditRef('party', seller.partyId)],
        outcome: assessed.outcome,
        policy: SEED_POLICY.version,
        reasonKeys: assessed.reasons,
        evidence: [CONDITION_ACT_SOURCE],
      },
      acted.authority,
    );
  });

  await step(run, store, 'tranche.create', (world) => {
    const acted = acting(world, 'create_deal', dealSubject(dealId), SEED_STAFF.operator);
    return createTranche(
      acted.world,
      {
        dealId,
        trancheId,
        buyer: partyRefOf(buyer),
        buyerPayerKey: payerKeyForDomain(buyer.document),
        buyerNames: buyer.names,
        principal: money(GEL, item.principalMinor),
        conditionAct: act,
        createdOn: SEED_CREATED_ON,
        beneficiary: beneficiaryOf(dealId, seller, 500),
        sourceAccountKnown: true,
      },
      acted.authority,
    );
  });

  await step(run, store, 'tranche.condition_act', (world) => {
    const acted = acting(
      world,
      'record_condition_act',
      trancheSubject(world, trancheId),
      partyActor(seller.partyId),
    );
    return recordConditionAct(
      acted.world,
      dealId,
      trancheId,
      act,
      CONDITION_ACT_SOURCE,
      SEED_POLICY.version,
      acted.authority,
    );
  });

  await dealStep(run, store, dealId, { type: 'parties_check_started' });
  await dealStep(run, store, dealId, { type: 'parties_verified' });
  await dealStep(run, store, dealId, { type: 'property_verified' });
}

async function dealStep(run: Run, store: StoreOption, dealId: string, event: DealEvent): Promise<void> {
  await step(run, store, `deal.${event.type}`, (world) => {
    const capability = capabilityOfDeal(event);
    const acted = acting(world, capability, dealSubject(dealId), actorOfDeal(capability));
    return applyDealEvent(
      acted.world,
      dealId,
      event,
      acted.authority as Parameters<typeof applyDealEvent<typeof event>>[3],
      options(),
    );
  });
}

async function trancheStep(
  run: Run,
  store: StoreOption,
  trancheId: string,
  event: TrancheEvent,
  actor: SeedActor = SEED_STAFF.operator,
  opts: TrancheEventOptions = options(),
): Promise<void> {
  await step(run, store, `tranche.${event.type}`, (world) => {
    const acted = acting(world, capabilityOfTranche(event), trancheSubject(world, trancheId), actor);
    return applyTrancheEvent(
      acted.world,
      trancheId,
      event,
      acted.authority as Parameters<typeof applyTrancheEvent<typeof event>>[3],
      opts,
    ).world;
  });
}

/**
 * Полномочие, которым засев разрешает событие.
 *
 * Перечень происхождений — общий с продуктом (`origins.ts`); машинные
 * происхождения (`clock`, `oracle_source`) засеву недоступны, и это выражено
 * тем, что взять их здесь неоткуда: событие часов приходится доводить временем,
 * а не подавать рукой.
 */
type DealCapability = 'run_screening' | 'verify_property' | 'prepare_settlement' | 'create_deal';

function capabilityOfDeal(event: DealEvent): DealCapability {
  switch (event.type) {
    case 'parties_check_started':
    case 'parties_verified':
      return 'run_screening';
    case 'property_verified':
      return 'verify_property';
    case 'funds_received':
    case 'tranches_reserved':
    case 'tranches_settled':
      return 'prepare_settlement';
    case 'condition_established':
      return 'create_deal';
    default:
      throw new Error(`app.seed.deal_event_not_seedable:${event.type}`);
  }
}

type TrancheCapability = 'prepare_settlement' | 'approve_payout' | 'record_bank_outcome';

function capabilityOfTranche(event: TrancheEvent): TrancheCapability {
  switch (event.type) {
    case 'instructions_issued':
    case 'funds_received':
    case 'reserve_requested':
      return 'prepare_settlement';
    case 'release_authorized':
      return 'approve_payout';
    case 'payout_result':
      return 'record_bank_outcome';
    default:
      throw new Error(`app.seed.tranche_event_not_seedable:${event.type}`);
  }
}

/** Кто делает шаг сделки: у проверки сторон и у объекта носители разные. */
function actorOfDeal(capability: DealCapability): SeedActor {
  return capability === 'run_screening' ? SEED_STAFF.analyst : SEED_STAFF.operator;
}

/**
 * Заказ платной выписки — расход, и полномочие у него своё (`origins.ts`).
 * Остальное наблюдение вносит оператор оракула.
 */
function capabilityOfObservation(
  event: Parameters<typeof applyObservationEvent>[2],
): 'record_observation' | 'order_extract' {
  return event.type === 'extract_ordered' ? 'order_extract' : 'record_observation';
}

/**
 * Прогон сценария до его ступени.
 *
 * Ступени накапливаются: `settled` проходит через `reserved`, тот через
 * `collected`. Иначе каждое положение денег собиралось бы своим путём, и
 * совпадение состояний ничего бы не значило.
 */
async function runScenario(store: StoreOption, item: SeedScenario): Promise<SeededScenario> {
  const buyer = SEED_PARTIES.weiss;
  const seller = SEED_PARTIES[item.counterparty];
  const dealId = seedDealId(item.id);
  const trancheId = seedTrancheId(item.id);
  const buyerKey: ClientKey = toClientKey(buyer.document);
  const amount: Money<CurrencyCode> = money(GEL, item.principalMinor);

  const world = emptyWorld({ now: SEED_NOW, chainId: seedChainId(item.id), tariffs: seedTariffs() });
  const opened = await openWorld(store, world);
  const run: Run = {
    world: opened.world,
    steps: [{ key: 'world.open', outcome: opened.outcome, unmapped: opened.unmapped }],
    outcome: opened.outcome,
    unmapped: [...opened.unmapped],
  };

  await openScenario(run, store, item, buyer, seller);
  await trancheStep(run, store, trancheId, { type: 'instructions_issued' });

  if (item.stage !== 'instructed') {
    await step(run, store, 'ledger.top_up', (current) => {
      const acted = acting(current, 'record_bank_outcome', PLATFORM_SUBJECT, SEED_STAFF.operator);
      return receiveExternalPayment(acted.world, buyerKey, requiredOf(acted.world, trancheId), acted.authority);
    });
    await trancheStep(
      run,
      store,
      trancheId,
      {
        type: 'funds_received',
        amount: requiredOf(run.world, trancheId),
        sender: payerKeyForDomain(buyer.document),
        reference: `${SEED_PREFIX}payment-${item.id}`,
      },
      SEED_STAFF.operator,
      creditedOptions(),
    );
    await dealStep(run, store, dealId, { type: 'funds_received' });
  }

  if (item.stage === 'reserved' || item.stage === 'settled') {
    await trancheStep(run, store, trancheId, { type: 'reserve_requested' });
    await dealStep(run, store, dealId, { type: 'tranches_reserved' });
  }

  if (item.stage === 'settled') {
    await settleScenario(run, store, dealId, trancheId, amount);
  }

  return {
    id: item.id,
    dealId,
    trancheId,
    stage: item.stage,
    dealStatus: dealOf(run.world, dealId).state.status,
    trancheStatus: trancheOf(run.world, trancheId).state.status,
    requiredMinor: requiredOf(run.world, trancheId).minor,
    steps: Object.freeze(run.steps),
    outcome: run.outcome,
    unmapped: Object.freeze(run.unmapped),
  };
}

/** Сумма, которую обязан перевести покупатель: её вывел тариф, а не засев. */
function requiredOf(world: World, trancheId: string): Money<CurrencyCode> {
  return trancheOf(world, trancheId).facts.requiredAmount;
}

/**
 * Подача заявления, платная выписка, два утверждения, поручение и ответ банка.
 *
 * Ни одной двери здесь не открывается автоматически: условие расчёта
 * устанавливает **выписка** (внешний факт, красная линия №6), поручение
 * выпускают **два разных человека разных уровней**, а комиссия уходит на
 * операционный счёт той же записью расчёта (красная линия №2).
 */
async function settleScenario(
  run: Run,
  store: StoreOption,
  dealId: string,
  trancheId: string,
  amount: Money<CurrencyCode>,
): Promise<void> {
  const buyerNames = SEED_PARTIES.weiss.names;

  await observationStep(run, store, trancheId, 'observation_started', { type: 'observation_started' });
  await observationStep(run, store, trancheId, 'filing_claimed', {
    type: 'filing_claimed',
    applicationId: SEED_APPLICATION_ID,
    byParty: SEED_PARTIES.weiss.partyId,
  });
  await observationStep(run, store, trancheId, 'filing_card_observed', {
    type: 'filing_card_observed',
    applicationId: SEED_APPLICATION_ID,
    cadastralCode: SEED_CADASTRAL_CODE,
    applicationStatus: 'in_progress',
  });
  await observationStep(run, store, trancheId, 'statutory_term_elapsed', { type: 'statutory_term_elapsed' });
  await observationStep(run, store, trancheId, 'extract_ordered', {
    type: 'extract_ordered',
    cost: money(GEL, 1_000n),
  });

  await step(run, store, 'observation.extract_received', (world) => {
    const acted = acting(world, 'record_observation', trancheSubject(world, trancheId), SEED_STAFF.oracle);
    return receivePaidExtract(
      acted.world,
      trancheId,
      seedExtract(buyerNames),
      `${SEED_PREFIX}evidence-bundle-${trancheId}`,
      SEED_POLICY,
      acted.authority,
      options(),
    ).world;
  });

  await dealStep(run, store, dealId, {
    type: 'condition_established',
    conditionType: 'registration_transfer',
  });

  for (const approver of [SEED_STAFF.controller, SEED_STAFF.head]) {
    await step(run, store, `tranche.approval:${approver.accountId}`, (world) => {
      const acted = acting(world, 'approve_payout', trancheSubject(world, trancheId), approver);
      return approve(acted.world, trancheId, acted.authority);
    });
  }

  await trancheStep(run, store, trancheId, { type: 'release_authorized' }, SEED_STAFF.controller);
  await trancheStep(
    run,
    store,
    trancheId,
    { type: 'payout_result', outcome: 'settled' },
    SEED_STAFF.operator,
    trancheOptions(SEED_POLICY.version, { payoutResponse: BANK_RESPONSE_SOURCE }),
  );

  await step(run, store, 'ledger.fee_received', (world) => {
    const acted = acting(world, 'operate_treasury', PLATFORM_SUBJECT, SEED_STAFF.controller);
    return receiveTrancheFee(
      acted.world,
      dealId,
      trancheId,
      feeForTranche(acted.world, trancheId, amount),
      acted.authority,
    );
  });

  await dealStep(run, store, dealId, { type: 'tranches_settled' });
}

async function observationStep(
  run: Run,
  store: StoreOption,
  trancheId: string,
  key: string,
  event: Parameters<typeof applyObservationEvent>[2],
): Promise<void> {
  await step(run, store, `observation.${key}`, (world) => {
    const acted = acting(
      world,
      capabilityOfObservation(event),
      trancheSubject(world, trancheId),
      SEED_STAFF.oracle,
    );
    return applyObservationEvent(
      acted.world,
      trancheId,
      event,
      acted.authority as Parameters<typeof applyObservationEvent>[3],
      options(),
    ).world;
  });
}

/* ------------------------------------------------------------------------- */
/* Засев целиком                                                             */
/* ------------------------------------------------------------------------- */

export type ScenarioState =
  /** Сценария в базе нет вовсе. */
  | { readonly kind: 'absent' }
  /** Сценарий лежит целиком и ровно в том положении, до которого его доводят. */
  | { readonly kind: 'complete' }
  /**
   * Сделка есть, но она **не** там, где её оставил бы засев. Это либо оборванный
   * прогон, либо кто-то двигал засеянную сделку дальше. Дописывать сюда нечего:
   * шаг мира идёт «из состояния в состояние», и повтор с начала встретил бы
   * конфликт хранилища.
   */
  | { readonly kind: 'diverged'; readonly found: string; readonly expected: string };

export interface SeedResult {
  readonly seeded: readonly SeededScenario[];
  /** Сценарии, которые уже лежали в базе тем же самым. */
  readonly repeated: readonly string[];
  readonly diverged: readonly { readonly id: string; readonly found: string; readonly expected: string }[];
  readonly outcome: WriteOutcome;
}

export interface SeedOptions {
  readonly scenarios?: readonly SeedScenario[];
}

/**
 * Засев базы.
 *
 * **Идемпотентность — по сценарию, а не по строке.** Прежде чем писать, засев
 * спрашивает хранилище, есть ли уже сделка сценария, и сверяет её состояние с
 * тем, до которого доводит. Совпало — сценарий пропускается целиком (повтор не
 * создаёт вторых копий и не падает). Не совпало — засев **не** трогает эту
 * сделку и называет расхождение: молча дописать «поверх» означало бы
 * перезаписать чужой шаг.
 *
 * Отказ работать на настоящих данных здесь **не** проверяется: для этого нужен
 * запрос по всей схеме, а схемы этот слой не знает. Ворота стоят в
 * `@sdelka/db` (`seed-guard.ts`) и зовутся до этой функции.
 */
export async function seedWorlds(store: StoreOption, opts: SeedOptions = {}): Promise<SeedResult> {
  const scenarios = opts.scenarios ?? SEED_SCENARIOS;
  const seeded: SeededScenario[] = [];
  const repeated: string[] = [];
  const diverged: { id: string; found: string; expected: string }[] = [];
  let outcome = EMPTY_WRITE;

  for (const item of scenarios) {
    // Ожидаемое положение считается **тем же прогоном**, только без хранилища:
    // второго описания «где сценарий заканчивается» не заводится, иначе список
    // ожиданий разъедется с прогоном на первой же правке шага.
    const expected = await runScenario(WITHOUT_STORE, item);
    const state = await scenarioState(store, item, expected);
    if (state.kind === 'complete') {
      repeated.push(item.id);
      continue;
    }
    if (state.kind === 'diverged') {
      diverged.push({ id: item.id, found: state.found, expected: state.expected });
      continue;
    }
    const written = await runScenario(store, item);
    seeded.push(written);
    outcome = addWrites(outcome, written.outcome);
  }

  return Object.freeze({
    seeded: Object.freeze(seeded),
    repeated: Object.freeze(repeated),
    diverged: Object.freeze(diverged),
    outcome,
  });
}

/**
 * Что лежит в базе по этому сценарию — спрашивается **портом**, а не запросом.
 *
 * Сверяются оба состояния, и сделки, и транша, **и сумма транша**: сделка
 * доходит до `settled` раньше, чем транш, и по одной только сделке оборванный
 * прогон был бы неотличим от завершённого, а по одним состояниям — сценарий с
 * изменённой суммой от прежнего.
 */
export async function scenarioState(
  store: StoreOption,
  item: SeedScenario,
  expected: SeededScenario,
): Promise<ScenarioState> {
  if (!('transact' in store)) return { kind: 'absent' };
  const dealId = seedDealId(item.id);
  const trancheId = seedTrancheId(item.id);
  return store.transact(async (tx) => {
    const deal = await tx.loadDeal(dealId);
    if (deal === null) return { kind: 'absent' as const };
    const tranche = await tx.loadTranche(dealId, trancheId);
    const found =
      `${deal.state.status}/${tranche?.state.status ?? 'none'}` +
      `/${tranche?.required?.minor ?? 'none'}`;
    const want = `${expected.dealStatus}/${expected.trancheStatus}/${expected.requiredMinor}`;
    return found === want
      ? { kind: 'complete' as const }
      : { kind: 'diverged' as const, found, expected: want };
  });
}

