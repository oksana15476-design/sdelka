import {
  type Anchor,
  type AuditActor,
  type AuditChain,
  type AuditRecordInput,
  type AuditRef,
  type NonEmpty,
  type PolicyRef,
  type RawSourceRef,
  appendRecord,
  auditAmount,
  auditFingerprint,
  auditInstant,
  auditRef,
  genesisChain,
  policyRef,
} from '@sdelka/audit';
import {
  type BeneficiaryState,
  type CompliancePolicy,
  type DetectorOutcome,
  type NameObservation,
  type PolicyVersionId,
  type ReviewTask,
  type ReviewTaskKind,
  compareNames,
  lockOnFunding,
  reconcileOwner,
  toBeneficiaryLock,
} from '@sdelka/compliance';
import {
  type ConditionAct,
  type DealEvent,
  type DealFacts,
  type DealFiling,
  type DealState,
  type FeeCeilingPolicy,
  type FilingSource,
  type Instant,
  type Intent,
  type ObservationLevel,
  type PartyRef,
  type PayoutEvent,
  type PayoutState,
  type Rejection,
  type ReleaseObservation,
  type TrancheContext,
  type TrancheEvent,
  type TrancheFacts,
  type TrancheState,
  type TrancheTransitionResult,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_DEADLINE_POLICY,
  DEFAULT_OBSERVATION_POLICY,
  RELEASE_CONDITIONS,
  activePayoutsForTranche,
  createPayout,
  createRefundPayout,
  dealState,
  initialTrancheState,
  instant,
  reduceDeal,
  reducePayout,
  reduceTranche,
  releaseObservation,
  requiredApprovals,
} from '@sdelka/domain';
import {
  type ActorRef,
  UNKNOWN_FACT,
  evaluateQuorum,
  recordApproval,
} from '@sdelka/auth';
import {
  type ClientKey,
  type EntryMeta,
  type FxExecution,
  type Journal,
  type JournalEntry,
  type RecognisedShortfall,
  accountBalance,
  appendEntry,
  absorbShortfall,
  clientLockedAccount,
  emptyJournal,
  executeConversion,
  fundShortfall,
  fxExecution,
  receiveConversion,
  receiveFee,
  sendForConversion,
  writeOffTransitArrived,
} from '@sdelka/ledger';
import type { ConvertedAmount, CurrencyCode, Deduction, FxRates, IsoDate, Money, PlatformSpread } from '@sdelka/money';
import { accountingFxDifference, convert, isPositive, platformSpread } from '@sdelka/money';
import {
  type CreditRoute,
  creditIncomingPayment,
  feeOf,
  holdUnidentifiedPayment,
  projectLedgerIntent,
  projectSettlementIntent,
  returnUnidentifiedPayment,
} from './ledger-app';
import {
  type ObservationEvent,
  type ObservationIntent,
  type ObservationState,
  initialObservationState,
  isTerminalObservationStatus,
  reduceObservation,
  sourcedObservation,
} from '@sdelka/oracle';
import {
  type Authority,
  type StepOrigin,
  AuthorityError,
  actionContextFor,
  ORACLE_ACTOR,
  SYSTEM_ACTOR,
  actingAccount,
  actingPerson,
  actingRole,
  assertOrigin,
  dealSubject,
  journalActor,
  oracleAuthority,
  recordFact,
  requireSamePerson,
  trancheSubject,
} from './authority';
import {
  type DealOrigin,
  type ObservationOrigin,
  type TrancheOrigin,
  dealOriginsOf,
  observationOriginsOf,
  trancheOriginsOf,
} from './origins';
import type { RegistryApplicationCard, RegistryExtract } from './ports';
import {
  type DealRuntime,
  type InvariantViolation,
  type Notification,
  type ObservationTask,
  type SuppressedEntry,
  type TrancheRuntime,
  type World,
  coverageOk,
  dealOf,
  payerOf,
  recorded,
  sealed,
  seedWorld,
  trancheOf,
  withDeal,
  withTranche,
} from './world';

/* ------------------------------------------------------------------------- */
/* Акторы журнала аудита                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Свободных акторов у шагов мира **больше нет**.
 *
 * Здесь стояли три константы — `OPERATOR_ACTOR`, `ANALYST_ACTOR`,
 * `APPROVER_ACTOR`, — и каждый шаг принимал одну из них полем `options.actor`.
 * Это значило ровно то, что написано: кто записан в вечный журнал, решал
 * вызывающий, и `trancheOptions(policy, { actor: APPROVER_ACTOR })` подписывал
 * утверждающим действие, которое совершал кто угодно. Полномочие в записи
 * (`AuditActor.capability`) при этом было свободной строкой и не сверялось ни с
 * чем (`packages/e2e/test/cross-package.test.ts`, тест-надгробие).
 *
 * Сегодня актор **выводится** из разрешения (`journalActor` в `authority.ts`):
 * учётная запись — из сессии, роль — через `requireAuditRole`, полномочие — из
 * выписанного гранта. Разойтись «кто это сделал» и «кто записан» больше нечему.
 *
 * Два нечеловеческих актора остались и переехали в `authority.ts`, где у них
 * появилось происхождение: `SYSTEM_ACTOR` — часы, `ORACLE_ACTOR` — источник
 * наблюдения. Оттуда же они и вывозятся наружу — для отчётности и сверок, а не
 * для подстановки в шаг: подставить их некуда, поле исчезло.
 */

/* ------------------------------------------------------------------------- */
/* Мир                                                                       */
/* ------------------------------------------------------------------------- */

export interface WorldSeed {
  readonly now: Instant;
  readonly chainId: string;
}

export function emptyWorld(seed: WorldSeed): World {
  const chain: AuditChain = genesisChain(seed.chainId, auditInstant(seed.now), SYSTEM_ACTOR);
  return sealed(
    seedWorld({
      now: seed.now,
      journal: emptyJournal,
      chain,
      anchors: Object.freeze<Anchor[]>([]),
      deals: new Map<string, DealRuntime>(),
      tranches: new Map<string, TrancheRuntime>(),
      tasks: Object.freeze<ReviewTask[]>([]),
      observationTasks: Object.freeze<ObservationTask[]>([]),
      notifications: Object.freeze<Notification[]>([]),
      suppressed: Object.freeze<SuppressedEntry[]>([]),
      reissuedPayouts: Object.freeze<string[]>([]),
      // Ни одной сессии и ни одного факта о прошлом: мир, в котором ещё никто
      // не входил, обязан отказывать всему, что требует полномочия.
      sessions: new Map(),
      facts: Object.freeze([]),
      checks: 0,
      seq: 0,
    }),
  );
}

function nextMeta(world: World, label: string): { readonly meta: EntryMeta; readonly seq: number } {
  const seq = world.seq + 1;
  return {
    meta: { id: `entry-${seq}-${label}`, occurredAt: new Date(world.now).toISOString() },
    seq,
  };
}

function nonEmpty<T>(items: readonly T[]): NonEmpty<T> {
  const [head, ...rest] = items;
  if (head === undefined) {
    // Красная линия №5: поручение без пакета доказательств не существует как
    // операция. Пустой пакет — ошибка сборки, а не пустой массив в записи.
    throw new Error('app.evidence.empty');
  }
  return [head, ...rest];
}

function record(world: World, input: AuditRecordInput): AuditChain {
  return appendRecord(world.chain, input);
}

function auditId(world: World, seq: number): string {
  return `${world.chain.chainId}:r${seq}`;
}

export function advance(world: World, milliseconds: number): World {
  return sealed({ ...world, now: instant(world.now + milliseconds), checks: world.checks });
}

/* ------------------------------------------------------------------------- */
/* Заведение сделки и транша                                                 */
/* ------------------------------------------------------------------------- */

export interface DealSpec {
  readonly dealId: string;
  readonly conditionAct: ConditionAct | null;
  /**
   * Кадастровый код объекта. Обязателен и непустой: пустой код у
   * `observationSatisfies` и у `g_no_open_filing` читается как «сверяться не с
   * чем», то есть отказ закрытый, — и сделка, заведённая без объекта, молча
   * не смогла бы дойти до выплаты вовсе.
   */
  readonly objectCadastralCode: string;
}

/**
 * Заведение сделки.
 *
 * `preparedBy` полем спецификации **больше нет**: готовивший — это тот, кто
 * завёл, и брать его имя из аргумента значило разрешить оператору назвать
 * готовившим кого угодно. А от готовившего зависит Н1 («готовил ≠ утверждает»),
 * то есть свободное поле здесь отменяло разделение обязанностей на выплате.
 * Теперь имя берётся из разрешения и в тот же момент ложится фактом мира.
 */
export function createDeal(
  world: World,
  spec: DealSpec,
  authority: Authority<'create_deal'>,
): World {
  assertOrigin(['create_deal'], authority, 'deal.create');
  if (spec.objectCadastralCode.length === 0) {
    throw new Error('app.deal.object_cadastral_code_required');
  }
  const runtime: DealRuntime = {
    dealId: spec.dealId,
    state: dealState('draft'),
    conditionAct: spec.conditionAct,
    preparedBy: actingAccount(authority),
    trancheIds: Object.freeze([]),
    objectCadastralCode: spec.objectCadastralCode,
    filings: Object.freeze<DealFiling[]>([]),
    // Разбор отката никто не поднимал. `null`, а не пустая заявка: «заявки нет»
    // и «заявка есть, подписей ноль» — разные состояния, и второе означает, что
    // человек уже принял решение возвращать деньги.
    unwindReview: null,
  };
  const created = sealed({ ...world, deals: withDeal(world, runtime), checks: world.checks });
  return recordFact(created, 'prepared', dealSubject(spec.dealId), authority);
}

export interface TrancheSpec {
  readonly dealId: string;
  readonly trancheId: string;
  /**
   * Покупатель — он же плательщик, чья запертая часть дебетуется расчётом.
   * Обе половины личности в одном значении: сторона сделки и ключ её счёта
   * (`FUNCTIONAL.md` §2.1). Раньше здесь было три поля — `payer`,
   * `buyerPartyId` и `buyerPayerKey`, — и первые два никто не сверял между
   * собой: приложение могло назвать стороной одного, а деньги взять со счёта
   * другого.
   */
  readonly buyer: PartyRef;
  /**
   * Ключ личности покупателя в форме, которой подписан банковский платёж: с ним
   * сверяется имя отправителя (`g_payer_matches`). Это наблюдение из выписки, а
   * не сторона сделки, поэтому поле отдельное и алфавит у него свой.
   */
  readonly buyerPayerKey: string;
  /**
   * Имена покупателя как наблюдения (`@sdelka/compliance`). Нужны сверке
   * собственника из выписки: имя — **вторичный** сигнал и само по себе ничего
   * не устанавливает (`CORE.md` Ф7), но сверка без него невозможна.
   *
   * Лежат на транше, а не приезжают параметром в `attachObservation`: параметр
   * позволял бы сверить выписку с именами постороннего лица и получить
   * «сошлось».
   */
  readonly buyerNames: readonly NameObservation[];
  readonly requiredAmount: Money<CurrencyCode>;
  readonly conditionAct: ConditionAct;
  readonly createdOn: IsoDate;
  readonly deductions: readonly Deduction[];
  /**
   * Версия тарифного плана, по которой считается комиссия (`CORE.md` Ф16,
   * И14.3: «на сделке хранится идентификатор версии плана, пересчёт задним
   * числом невозможен»). Уходит фактом в журнал вместе с начислением.
   *
   * ⚠ Её место — на сделке, в `packages/domain`. Пока его там нет, держит
   * приложение; названо в отчёте, а не спрятано.
   */
  readonly tariffVersionId: string;
  readonly beneficiary: BeneficiaryState;
  readonly sourceAccountKnown: boolean;
  /**
   * Потолок удержания этого транша (`@sdelka/domain`, `tariff.ts`, эпик E16).
   *
   * Лежит рядом с `tariffVersionId` и по той же причине: ставка и её предел —
   * одно решение о деньгах клиента, и хранится оно вместе с версией политики,
   * действовавшей в момент принятия (`CORE.md` Ф11).
   *
   * Поле **необязательное**, и это безопасно ровно потому, что умолчание —
   * жёсткий предел учёта (`DEFAULT_FEE_CEILING_POLICY`, два процента): пропуск
   * не может ослабить правило, а объявление — только ужесточить его. Отсюда
   * величина доезжает фактом транша до намерения расчёта, а из намерения — до
   * записи (`ledger-app.ts`, `projectSettlementIntent`).
   */
  readonly feeCeilingPolicy?: FeeCeilingPolicy;
}

/**
 * Заведение транша.
 *
 * Кладёт **два** факта о прошлом, а не один: «готовил» (Н1) и «заявил реквизиты
 * выплаты» (Н4). Второй именно здесь потому, что реквизиты приезжают в
 * спецификации транша: тот, кто их внёс, не может утверждать их изменение, и
 * узнать это позже будет неоткуда — журнал не редактируется.
 */
export function createTranche(
  world: World,
  spec: TrancheSpec,
  authority: Authority<'create_deal'>,
): World {
  assertOrigin(['create_deal'], authority, 'tranche.create');
  const deal = dealOf(world, spec.dealId);
  const facts: TrancheFacts = {
    requiredAmount: spec.requiredAmount,
    collectedAmount: null,
    // Пересчитывается из журнала в `contextFor` на каждом вызове редьюсера;
    // здесь только начальное значение, до первого поступления.
    lockedAmount: null,
    buyerPayerKey: spec.buyerPayerKey,
    buyer: spec.buyer,
    conditionAct: spec.conditionAct,
    evidenceBundleId: null,
    /**
     * Наблюдения нет — и это законное состояние почти всю жизнь транша.
     *
     * Прежде здесь лежали пять булевых полей выписки и одно булево
     * «собственник — покупатель», и они были **выключены**: конструкция
     * читалась как «до выписки не совпало ни одно поле». Разница принципиальна:
     * пять `false` — это вердикт «не сошлось», который можно перезаписать
     * пятью `true`, ничего не имея за душой; `null` — отсутствие документа, и
     * вердикта из него не собрать (`ORACLE.md` §4).
     */
    observation: null,
    // Объект — у сделки, не у транша: транши это график платежей по одному
    // объекту. Второго места, где его можно назвать иначе, не существует.
    expectedCadastralCode: deal.objectCadastralCode,
    observationPolicy: DEFAULT_OBSERVATION_POLICY,
    beneficiary: toBeneficiaryLock(spec.beneficiary),
    preparedBy: actingAccount(authority),
    approvals: Object.freeze([]),
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
    createdOn: spec.createdOn,
    officialRateAtCreation: null,
    // Условное присваивание, а не `feeCeilingPolicy: spec.feeCeilingPolicy`:
    // при `exactOptionalPropertyTypes` «поля нет» и «поле пусто» — разные
    // состояния, и второе означало бы политику, которой не существует.
    ...(spec.feeCeilingPolicy === undefined ? {} : { feeCeilingPolicy: spec.feeCeilingPolicy }),
    activePayouts: 0,
    coverageOk: coverageOk(world.journal),
    sourceAccountKnown: spec.sourceAccountKnown,
    mismatchResolved: true,
  };
  const runtime: TrancheRuntime = {
    dealId: spec.dealId,
    trancheId: spec.trancheId,
    state: initialTrancheState(world.now, DEFAULT_DEADLINE_POLICY),
    facts,
    deductions: spec.deductions,
    tariffVersionId: spec.tariffVersionId,
    payouts: Object.freeze([]),
    approvalRecords: Object.freeze([]),
    beneficiary: spec.beneficiary,
    buyerNames: spec.buyerNames,
    evidence: Object.freeze([]),
    suspendedRemaining: null,
    observation: initialObservationState,
  };
  const created = sealed({
    ...world,
    deals: withDeal(world, { ...deal, trancheIds: [...deal.trancheIds, spec.trancheId] }),
    tranches: withTranche(world, runtime),
    checks: world.checks,
  });
  const subject = trancheSubject(created, spec.trancheId);
  return recordFact(
    recordFact(created, 'prepared', subject, authority),
    'beneficiary_requested',
    subject,
    authority,
  );
}

/* ------------------------------------------------------------------------- */
/* Записи журнала аудита, не привязанные к переходу                          */
/* ------------------------------------------------------------------------- */

export interface DecisionRecord {
  readonly subject: AuditRef;
  readonly related: readonly AuditRef[];
  readonly outcome: DetectorOutcome | string;
  readonly policy: PolicyVersionId;
  readonly reasonKeys: readonly string[];
  readonly evidence: readonly RawSourceRef[];
}

/**
 * Решение комплаенса в журнал.
 *
 * Полномочие — `adjudicate_screening`: это решение, после которого деньги идут
 * дальше (`ACTORS.md` §4.1 A7), поэтому у него класс `release`, второй фактор и
 * несовместимость Н6 (видит маржу ⇒ не двигает деньги). Актора у записи больше
 * нет полем: он выводится из разрешения.
 */
export function recordDecision(
  world: World,
  input: DecisionRecord,
  authority: Authority<'adjudicate_screening'>,
): World {
  assertOrigin(['adjudicate_screening'], authority, 'decision.record');
  const seq = world.seq + 1;
  return sealed({
    ...world,
    seq,
    chain: record(world, {
      recordId: auditId(world, seq),
      recordedAt: auditInstant(world.now),
      actor: journalActor(authority),
      subject: input.subject,
      related: input.related,
      body: {
        kind: 'decision_made',
        outcomeKey: input.outcome,
        policy: policyRef(input.policy),
        reasonKeys: input.reasonKeys,
        evidence: nonEmpty(input.evidence),
      },
    }),
    checks: world.checks,
  });
}

/**
 * Акт получателя об условии — порождающий акт (`CORE.md` Ф13). Пишется в журнал
 * до приёма средств: без него у отложенного платежа нет основания.
 */
export function recordConditionAct(
  world: World,
  dealId: string,
  trancheId: string,
  act: ConditionAct,
  source: RawSourceRef,
  policy: PolicyVersionId,
  authority: Authority<'record_condition_act'>,
): World {
  assertOrigin(['record_condition_act'], authority, 'condition_act.record');
  // Акт совершает **получатель, названный в самом акте** (ст. 27(2), `CORE.md`
  // Ф13). Раньше запись журнала брала его имя из акта, а совершал шаг кто
  // угодно: «кто записан» и «кто это сделал» были не связаны ничем. Расхождение
  // здесь — ошибка, а не подстановка.
  requireSamePerson(authority, act.recipient.partyId, 'condition_act.recipient');
  const seq = world.seq + 1;
  const runtime = trancheOf(world, trancheId);
  return sealed({
    ...world,
    seq,
    tranches: withTranche(world, { ...runtime, evidence: [...runtime.evidence, source] }),
    chain: record(world, {
      recordId: auditId(world, seq),
      recordedAt: auditInstant(world.now),
      actor: journalActor(authority),
      subject: auditRef('tranche', trancheId),
      related: [auditRef('deal', dealId)],
      body: {
        kind: 'condition_act_recorded',
        conditionType: act.conditionType,
        actorSide: 'recipient',
        act: source,
        policy: policyRef(policy),
      },
    }),
    checks: world.checks,
  });
}

/* ------------------------------------------------------------------------- */
/* Деньги, приходящие и уходящие помимо автомата транша                      */
/* ------------------------------------------------------------------------- */

function appendJournal(world: World, entry: JournalEntry): Journal {
  return appendEntry(world.journal, entry);
}

/**
 * Деньги в учёте по банковской выписке — **два полномочия, а не одно**.
 *
 * Шаги ниже делятся ровно надвое, и деление это `ACTORS.md` §5.1.1, а не вкус:
 *
 * - `record_bank_outcome` — то, что **сделал банк**: зачисление на счёт клиента,
 *   удержание неопознанного платежа и его возврат, приход списанного. Человек
 *   здесь переносит факт из выписки, а не принимает решение;
 * - `operate_treasury` — то, что делаем **мы своими деньгами**: признание и
 *   покрытие недостачи корреспондента, получение комиссии на операционный счёт,
 *   три момента конвертации. Это единственный класс `release` из пяти, и
 *   носитель у него другой — ФК, а не ОП (§6.7: покрытие и пофайловое
 *   обеспечение).
 *
 * До этой правки все они выполнялись под чужим `create_deal` — полномочием
 * «завести сделку», взятым как самое узкое существующее, потому что своего у
 * них не было вовсе. Ещё раньше — вообще без проверки: подписи
 * `receiveExternalPayment(world, owner, amount)` хватало, чтобы завести
 * обязательство перед клиентом.
 */
export function receiveExternalPayment(
  world: World,
  owner: ClientKey,
  amount: Money<CurrencyCode>,
  authority: Authority<'record_bank_outcome'>,
): World {
  assertOrigin(['record_bank_outcome'], authority, 'ledger.top_up');
  const { meta, seq } = nextMeta(world, 'top-up');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, creditIncomingPayment(meta, owner, amount)),
    checks: world.checks,
  });
}

/** Платёж третьего лица: деньги в учёте есть, обязательства перед покупателем нет. */
export function holdThirdPartyPayment(
  world: World,
  amount: Money<CurrencyCode>,
  authority: Authority<'record_bank_outcome'>,
): World {
  assertOrigin(['record_bank_outcome'], authority, 'ledger.suspense');
  const { meta, seq } = nextMeta(world, 'suspense');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, holdUnidentifiedPayment(meta, amount)),
    checks: world.checks,
  });
}

export function returnHeldPayment(
  world: World,
  amount: Money<CurrencyCode>,
  authority: Authority<'record_bank_outcome'>,
): World {
  assertOrigin(['record_bank_outcome'], authority, 'ledger.suspense_return');
  const { meta, seq } = nextMeta(world, 'suspense-return');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, returnUnidentifiedPayment(meta, amount)),
    checks: world.checks,
  });
}

/**
 * Списание, момент 2: деньги дошли с номинального счёта на операционный.
 *
 * Отдельный шаг приложения, а не намерение автомата: транш терминален с момента
 * 1, а приход подтверждает банковская выписка (`FUNCTIONAL.md` §3.1, «два
 * момента, а не один»). До этого шага долг перед невостребованными стоит против
 * транзита — и это видно в отчётности, как и требует документ.
 */
export function receiveWriteOffTransit(
  world: World,
  amount: Money<CurrencyCode>,
  authority: Authority<'record_bank_outcome'>,
): World {
  assertOrigin(['record_bank_outcome'], authority, 'ledger.write_off_transit');
  const { meta, seq } = nextMeta(world, 'write-off-transit');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, writeOffTransitArrived(meta, amount)),
    checks: world.checks,
  });
}

/**
 * Недостача корреспондента, **момент 1** (`FUNCTIONAL.md` §3.1, случай А):
 * пришло меньше обещанного, разницу признаёт расходом платформа.
 *
 * Обязательство перед клиентом доводится до полной суммы **в момент
 * поступления**, а не потом. Между этой записью и довнесением покрытие меньше
 * единицы — и документ говорит об этом промежутке дословно: «до второй записи
 * транш не обеспечен, и это видно в системе как расхождение, а не как норма».
 *
 * ⚠ Прежде шаг просто не запечатывался, и это было **неверно дважды**. Первое:
 * исключение стирает состояние, поэтому расхождение оказывалось не видно, а
 * признание — непроводимо; ровно ту же ошибку `0008_views.sql` называет
 * причиной, по которой покрытие сделано представлением, а не `CHECK`. Второе:
 * признание ломает покрытие **всегда** (деньги на номинальный счёт ещё не
 * пришли ниоткуда), поэтому мира, в котором случай А исполним, не существовало
 * вовсе — функция не могла вернуть значение ни при каких данных, а вместе с ней
 * был недостижим и второй момент.
 *
 * Теперь шаг идёт через `recorded` с **поимённым** списком терпимого: покрытие
 * и пофайловое обеспечение. Любое другое нарушение — по-прежнему исключение, а
 * следующий шаг мира запечатывается обычным `sealed` и падает, пока
 * расхождение живо: после признания в мире не может произойти ничего, кроме
 * довнесения.
 */
export interface ShortfallRecognition {
  readonly world: World;
  /**
   * Запись признания. Она же — единственное основание довнести деньги
   * платформы в файл клиента: `fundShortfall` принимает её, а не сумму, и
   * собрать такое значение мимо `absorbShortfall` невозможно по типу.
   */
  readonly recognised: RecognisedShortfall;
  /**
   * Названное расхождение промежутка — значением, а не молчанием. Пусто оно
   * не бывает: признание всегда оставляет покрытие меньше единицы.
   */
  readonly violations: readonly InvariantViolation[];
}

export function absorbIncomingShortfall(
  world: World,
  owner: ClientKey,
  received: Money<CurrencyCode>,
  shortfall: Money<CurrencyCode>,
  authority: Authority<'operate_treasury'>,
): ShortfallRecognition {
  assertOrigin(['operate_treasury'], authority, 'ledger.shortfall_absorbed');
  const { meta, seq } = nextMeta(world, 'shortfall-absorbed');
  const recognised = absorbShortfall(meta, owner, received, shortfall);
  const step = recorded(
    {
      ...world,
      seq,
      journal: appendJournal(world, recognised),
      checks: world.checks,
    },
    // Ровно два и поимённо: недостаёт денег под обязательством, а не денег у
    // клиента. `negative_client_balance` сюда не входит намеренно — это была бы
    // другая ошибка, и терпеть её нельзя.
    ['coverage_below_one', 'funds_source_uncovered'],
  );
  return { world: step.world, recognised, violations: step.violations };
}

/**
 * Недостача, **момент 2**: довнесение с операционного счёта на номинальный.
 *
 * Межбанковский перевод, а не проводка вежливости: счета в разных банках, и
 * между моментами проходит день-два. Довнесение **с пустого операционного
 * счёта** восстанавливает пофайловое обеспечение и тут же ловится
 * отрицательным остатком банковского счёта — дыра, закрытая обещанием, за
 * которым ничего нет.
 *
 * Ни клиента, ни суммы в аргументах больше нет: и то и другое приходит **из
 * записи признания**. Прежняя подпись принимала их отдельно, то есть довнести
 * можно было сколько угодно и кому угодно — единственный конструктор словаря
 * без проверки входа. Второй контур на низкоуровневую дверь остался в самом
 * учёте (`shortfallOverfunded`).
 */
export function fundIncomingShortfall(
  world: World,
  recognised: RecognisedShortfall,
  authority: Authority<'operate_treasury'>,
): World {
  assertOrigin(['operate_treasury'], authority, 'ledger.shortfall_funded');
  const { meta, seq } = nextMeta(world, 'shortfall-funded');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, fundShortfall(meta, recognised)),
    checks: world.checks,
  });
}

/**
 * Комиссия **получена**: удержанное дошло с транзита до операционного счёта.
 *
 * Отдельный шаг приложения, а не намерение автомата, — по той же причине, что и
 * второй момент списания: транш терминален с момента расчёта, а приход
 * подтверждает банковская выписка. До этого шага комиссия числится в транзите,
 * и `feePositions` показывает её отдельной величиной (`CORE.md` Ф16). Забыть
 * этот шаг нельзя молча: остаток `transit:fee` старше двух суток — расхождение
 * `transitStale`, и `sealed` роняет следующий же шаг мира.
 */
export function receiveTrancheFee(
  world: World,
  dealId: string,
  trancheId: string,
  amount: Money<CurrencyCode>,
  authority: Authority<'operate_treasury'>,
): World {
  assertOrigin(['operate_treasury'], authority, 'ledger.fee_received');
  const { meta, seq } = nextMeta(world, 'fee-received');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, receiveFee(meta, { dealId, trancheId }, amount)),
    checks: world.checks,
  });
}

export interface ConversionResult {
  readonly world: World;
  readonly converted: ConvertedAmount<CurrencyCode, CurrencyCode>;
  readonly spread: PlatformSpread<CurrencyCode>;
  /** Объявление обмена: ключ конверсии и три курса. Ими связаны все три записи. */
  readonly execution: FxExecution;
}

/**
 * Конвертация, **момент 1**: исходная валюта ушла валютному контрагенту.
 *
 * Отдельный шаг мира, а не треть одного вызова: между моментами деньги клиента
 * лежат на `fx:settlement:{k}` — они всё ещё его и всё ещё покрывают его
 * обязательство, но уже не на нашем счёте. `sealed` проверяет инварианты
 * **между** моментами, и промежуток обязан их проходить: иначе конвертация
 * была бы мгновением, которого в жизни нет.
 */
export function sendBalanceForConversion(
  world: World,
  owner: ClientKey,
  execution: FxExecution,
  authority: Authority<'operate_treasury'>,
): World {
  assertOrigin(['operate_treasury'], authority, 'ledger.fx_sent');
  const { meta, seq } = nextMeta(world, 'fx-sent');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, sendForConversion(meta, owner, execution)),
    checks: world.checks,
  });
}

/**
 * Конвертация, **момент 2**: обмен исполнен, обязательство перед клиентом
 * переоформлено в целевую валюту.
 *
 * Шаг введён этим батчем и без него запись момента 3 не собирается: до E14
 * моментов было два, и нога встречной валюты повторяла прежнюю форму целиком —
 * номинальный счёт в целевой валюте дебетовался, счёт клиента кредитовался,
 * то есть актив и обязательство под него создавала одна и та же запись.
 * Покрытие в целевой валюте после такой конвертации равнялось единице **по
 * построению записи**, а не по факту денег.
 */
export function executeBalanceConversion(
  world: World,
  owner: ClientKey,
  execution: FxExecution,
  authority: Authority<'operate_treasury'>,
): World {
  assertOrigin(['operate_treasury'], authority, 'ledger.fx_executed');
  const { meta, seq } = nextMeta(world, 'fx-executed');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, executeConversion(meta, owner, execution)),
    checks: world.checks,
  });
}

/**
 * Конвертация, **момент 3**: контрагент поставил встречную валюту.
 *
 * Требование к контрагенту закрывается поставкой, спред уходит на операционный
 * счёт в этой же записи. Обязательства перед клиентом эта запись не касается —
 * оно переоформлено в момент 2, — и именно поэтому покрытие в целевой валюте
 * перестало быть тождеством.
 */
export function receiveConvertedBalance(
  world: World,
  owner: ClientKey,
  execution: FxExecution,
  spread: PlatformSpread<CurrencyCode>,
  authority: Authority<'operate_treasury'>,
): World {
  assertOrigin(['operate_treasury'], authority, 'ledger.fx_received');
  const { meta, seq } = nextMeta(world, 'fx-received');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, receiveConversion(meta, owner, execution, spread)),
    checks: world.checks,
  });
}

/**
 * Конвертация остатка клиента целиком — **три шага, а не один и не два**.
 *
 * Целевой валюты в аргументах нет: её несёт курс (`FxRates.quote`), и второго
 * источника направления, с которым первый можно рассогласовать, не существует.
 * Ключ конверсии обязателен и приезжает снаружи: он же попадает в код счёта
 * `fx:settlement:{k}`, и общий пул нетил бы позиции разных обменов — вопрос
 * «сколько нам не поставили по этому обмену» перестал бы быть величиной.
 */
export function convertBalance(
  world: World,
  owner: ClientKey,
  conversionId: string,
  source: Money<CurrencyCode>,
  rates: FxRates,
  asOf: IsoDate,
  authority: Authority<'operate_treasury'>,
): ConversionResult {
  const converted = convert(source, rates, asOf, 'trunc');
  const spread = platformSpread(converted, 'trunc');
  // Учётная курсовая разница считается здесь же и **не складывается** со
  // спредом: это два разных показателя и два разных типа (`CORE.md` Ф5).
  accountingFxDifference(converted, 'trunc');
  // Объявление обмена: курс становится фактом записи. Восстановить его из двух
  // сумм задним числом нельзя — усечение необратимо (`entry.ts`, `fxExecution`).
  const execution = fxExecution(conversionId, converted);
  const sent = sendBalanceForConversion(world, owner, execution, authority);
  const executed = executeBalanceConversion(sent, owner, execution, authority);
  return {
    world: receiveConvertedBalance(executed, owner, execution, spread, authority),
    converted,
    spread,
    execution,
  };
}

/**
 * Запирания и расфиксации как шагов приложения **больше нет**.
 *
 * Раньше здесь стояли `lockFundsForTranche` и `unlockFundsFromTranche`: у
 * автомата не было намерения ни на то, ни на другое, и тест обязан был не
 * забыть их позвать в нужном месте. Забыть было можно — и тогда транш
 * становился необеспеченным, а обратный вызов уводил запертую часть в минус.
 * Сегодня оба шага — намерения входа (`lock_funds` на входе в `reserved`,
 * `unlock_funds` по `reserve_expired`), и второй двери в журнал у них нет:
 * оставленный экспорт означал бы двойную проводку у теста, который позовёт и
 * то и другое.
 */

/**
 * Комиссия платформы.
 *
 * Отдельного шага вывода комиссии на операционный счёт **больше нет**: расчёт
 * стал одной записью, включающей вывод (`ledger/src/entries.ts`,
 * `settleTrancheToClientAccount`), и запись без вывода конструктор отвергает.
 * Прежняя `sweepFee` выводила комиссию вторым движением; сегодня такое движение
 * создало бы недостачу по файлу транша, который расчёт уже опустошил, и
 * `sealed` уронил бы шаг на инварианте `tranche_uncovered`.
 *
 * Функция ниже считает сумму комиссии для проверок, но ничего не пишет.
 */
export function feeForTranche(world: World, trancheId: string, gross: Money<CurrencyCode>): Money<CurrencyCode> {
  return feeOf(gross, trancheOf(world, trancheId).deductions);
}

/* ------------------------------------------------------------------------- */
/* Факты транша                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Правка фактов транша.
 *
 * ⚠ **Чёрный ход, и он назван.** Функция ставит любое поле фактов, включая
 * денежные, минуя автомат. Убрать её этим батчем нельзя — на ней стоят сценарии
 * guard'ов.
 *
 * У чёрного хода теперь **собственное имя** — `patch_tranche_facts`
 * (`ACTORS.md` §5.1.1), а не заимствованное «завести сделку». Разница не
 * косметическая: под своим именем он виден в перечне полномочий, требует
 * второго фактора и попадает в журнал отдельной строкой, то есть его
 * употребление можно посчитать. Развилка «убрать вовсе, заменив сценарии на
 * события» — в отчёте.
 */
export function patchFacts(
  world: World,
  trancheId: string,
  patch: Partial<TrancheFacts>,
  authority: Authority<'patch_tranche_facts'>,
): World {
  assertOrigin(['patch_tranche_facts'], authority, 'tranche.patch_facts');
  const runtime = trancheOf(world, trancheId);
  return sealed({
    ...world,
    tranches: withTranche(world, { ...runtime, facts: { ...runtime.facts, ...patch } }),
    checks: world.checks,
  });
}

/**
 * Подпись под выплатой.
 *
 * Имя подписавшего — **из разрешения**, а не из аргумента. Свободный `userId`
 * означал ровно то, что «четыре глаза» набирались перечислением строк: два
 * вызова `approve(world, tranche, 'approver-1')` и `approve(world, tranche,
 * 'approver-2')` давали кворум, за которым не стояло ни одной сессии, ни одной
 * роли и ни одного уровня утверждения (`ACTORS.md` §5.2).
 *
 * Кроме имени в фактах домена (там оно по-прежнему строка — `TrancheFacts`
 * чужие) кладётся запись утверждения с **уровнем роли**: ФК даёт уровень 1, РО —
 * уровень 2, прочие роли уровня не дают вовсе, и `recordApproval` такую подпись
 * не выпускает. По этим записям считается кворум на `release_authorized`.
 */
export function approve(
  world: World,
  trancheId: string,
  authority: Authority<'approve_payout'>,
): World {
  assertOrigin(['approve_payout'], authority, 'tranche.approve');
  const runtime = trancheOf(world, trancheId);
  const person = actingPerson(authority);
  const recorded = recordApproval(person, actingRole(authority), world.now);
  if (!recorded.ok) {
    // Роль без уровня утверждения. Сюда сегодня не дойти — `approve_payout`
    // есть только у ФК и РО, — но перечни живут отдельно, и разъехаться могут.
    throw new AuthorityError(`app.approval.level_missing:${recorded.error}`);
  }
  return sealed({
    ...world,
    tranches: withTranche(world, {
      ...runtime,
      facts: {
        ...runtime.facts,
        approvals: [...runtime.facts.approvals, { userId: person.accountId }],
      },
      approvalRecords: [...runtime.approvalRecords, recorded.value],
    }),
    checks: world.checks,
  });
}

/* ------------------------------------------------------------------------- */
/* Наблюдение оракула                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Уровень доверия платной выписки — `ORACLE.md` §2, `STATE-MACHINES.md` §8.
 *
 * Единственный уровень, на котором `OBSERVATION_REQUIREMENTS` открывает путь к
 * деньгам. Константа, а не литерал в трёх местах: уровень выписки — свойство
 * источника, и разъехаться он не должен.
 */
export const PAID_EXTRACT_LEVEL: ObservationLevel = 'L3';

/** Уровень карточки заявления: дешёвый сигнал, деньги не двигает никогда. */
export const APPLICATION_CARD_LEVEL: ObservationLevel = 'L1';

/**
 * Наблюдение из платной выписки.
 *
 * ⚠ **Тип условия здесь не берётся из акта получателя, и это принципиально.**
 * Выписка реестра свидетельствует ровно об одном — о регистрации перехода
 * права; о наступлении календарной даты она не говорит ничего. Если подставить
 * сюда тип из акта, проверка `observationSatisfies` (сверяющая тип наблюдения с
 * типом акта) станет тавтологией: документ будет отвечать сам себе, о чём он.
 * Ровно так же и `sourceKey` берётся из `RELEASE_CONDITIONS`, а не пишется
 * строкой.
 *
 * Вердикт по собственнику считает `reconcileOwner` из `@sdelka/compliance`, а
 * не адаптер реестра: «выписка не отдала номер документа» обязано превращаться
 * в `insufficient`, а не в `false`, неотличимое от «собственник другой»
 * (`CORE.md` Ф7, `ORACLE.md` §5.3). Прежняя редакция порта отдавала готовое
 * `ownerIsBuyer: boolean`, а `ownerDocumentNumber` приложение **выбрасывало**:
 * функция сверки существовала и не вызывалась ниоткуда, кроме тестов.
 */
export function observationFromExtract(
  extract: RegistryExtract,
  buyerNames: readonly NameObservation[],
  policy: CompliancePolicy,
): ReleaseObservation {
  const owner = reconcileOwner(
    extract.ownerDocumentNumber,
    compareNames(extract.ownerNames, buyerNames, {
      strongThresholdBp: policy.nameThresholds.ownerReconciliation.valueBp,
      weights: policy.nameThresholds.weights,
    }),
  );
  return releaseObservation({
    level: PAID_EXTRACT_LEVEL,
    conditionType: 'registration_transfer',
    sourceKey: RELEASE_CONDITIONS.registration_transfer.sourceKey,
    cadastralCode: extract.cadastralCode,
    fields: extract.fields,
    ownerCheck: owner.outcome,
    observedAt: extract.observedAt,
    rawSourceDigest: extract.rawSource.digest,
  });
}

/**
 * Наблюдение из карточки заявления — **бесплатный уровень L1**.
 *
 * Пять полей выписки у карточки не наблюдаются вовсе, поэтому все пять `false`,
 * а собственник — `insufficient`: карточка не отдаёт ни номера документа, ни
 * долей, ни обременений. Это не «не сошлось» — это «не наблюдалось», и разница
 * здесь ничего не меняет, потому что уровень L1 отсекается раньше содержимого
 * (`g_observation_sufficient` стоит до `g_fields_match`). Проверяется это
 * сквозным сценарием «бесплатное наблюдение запускает тайминг и не разрешает
 * выплату».
 */
export function observationFromCard(card: RegistryApplicationCard): ReleaseObservation {
  return releaseObservation({
    level: APPLICATION_CARD_LEVEL,
    conditionType: 'registration_transfer',
    sourceKey: RELEASE_CONDITIONS.registration_transfer.sourceKey,
    cadastralCode: card.cadastralCode,
    fields: {
      cadastralCode: false,
      ownerDocumentNumber: false,
      share: false,
      basis: false,
      noUnexpectedEncumbrances: false,
    },
    ownerCheck: 'insufficient',
    observedAt: card.observedAt,
    rawSourceDigest: card.digest,
  });
}

/**
 * Наблюдение приложено к траншу: платная выписка, пакет доказательств собран.
 *
 * Имена покупателя берутся **с транша**, а не из аргумента: параметр позволял
 * бы сверить выписку с именами постороннего лица.
 */
/**
 * Наблюдение приложено к траншу.
 *
 * Полномочие — `record_observation` (`ACTORS.md` §5.1, Ф7): его носит оператор
 * оракула, и шаг кладёт факт «этот вносил наблюдение». Из этого факта потом
 * работает Н2: тот, кто установил факт регистрации, не утверждает выплату по той
 * же сделке.
 *
 * ⚠ **[открыто]** Актор записи `evidence_attached` остаётся `ORACLE_ACTOR` —
 * источником, а не человеком. Причина названа в `ACTORS.md` §13: в `AUDIT_ROLES`
 * (`@sdelka/audit`, восемь значений) роли `oracle_operator` нет, а подставить
 * похожую нельзя — журнал не редактируется. Запись говорит «приложен ответ
 * источника», и это правда; кто именно его приложил, в цепочке сегодня не
 * появляется. Чинится строкой в чужом пакете.
 */
export function attachObservation(
  world: World,
  trancheId: string,
  extract: RegistryExtract,
  evidenceBundleId: string,
  policy: CompliancePolicy,
  authority: Authority<'record_observation'>,
): World {
  assertOrigin(['record_observation'], authority, 'observation.attach');
  const runtime = trancheOf(world, trancheId);
  const observation = observationFromExtract(extract, runtime.buyerNames, policy);
  const seq = world.seq + 1;
  const next: TrancheRuntime = {
    ...runtime,
    facts: { ...runtime.facts, observation, evidenceBundleId },
    evidence: [...runtime.evidence, extract.rawSource],
  };
  const attached = sealed({
    ...world,
    seq,
    tranches: withTranche(world, next),
    chain: record(world, {
      recordId: auditId(world, seq),
      recordedAt: auditInstant(world.now),
      actor: ORACLE_ACTOR,
      subject: auditRef('tranche', trancheId),
      related: [auditRef('deal', runtime.dealId)],
      body: { kind: 'evidence_attached', evidence: extract.rawSource },
    }),
    checks: world.checks,
  });
  return recordFact(attached, 'observed', trancheSubject(attached, trancheId), authority);
}

/**
 * Платная выписка получена: документ приложен и подан машине наблюдения одним
 * шагом.
 *
 * Два шага порознь означали бы, что можно приложить выписку и не подать её —
 * или подать наблюдение, которого нет в фактах транша. Вердикт при этом считает
 * машина, а деньги двигают guard'ы транша: обе стороны выводят одно и то же из
 * одного документа, и расхождение между ними — это дефект, который обязан быть
 * виден (`ORACLE.md` §8.5).
 */
export function receivePaidExtract(
  world: World,
  trancheId: string,
  extract: RegistryExtract,
  evidenceBundleId: string,
  policy: CompliancePolicy,
  authority: Authority<'record_observation'>,
  options: TrancheEventOptions,
): ObservationStepResult {
  const attached = attachObservation(world, trancheId, extract, evidenceBundleId, policy, authority);
  const observation = trancheOf(attached, trancheId).facts.observation;
  if (observation === null) {
    throw new Error(`app.observation.missing_after_attach:${trancheId}`);
  }
  // **Красная линия №5 на боевом пути.** Наблюдение предъявляется автомату
  // вместе с ответом, из которого разобрано, а не отдельно: `sourcedObservation`
  // сверяет отпечаток с байтами и бросает при расхождении. Разобранные поля без
  // исходника суд не убедит (`CORE.md` Ф11), и раньше сюда проходило наблюдение
  // с отпечатком, за которым не стояло ни одного записанного ответа.
  const sourced = sourcedObservation(observation, extract.rawSource);
  return applyObservationEvent(
    attached,
    trancheId,
    { type: 'extract_received', observation: sourced },
    authority,
    options,
  );
}

export interface ObservationStepResult {
  readonly world: World;
  readonly state: ObservationState;
  readonly intents: readonly ObservationIntent[];
}

/**
 * Шаг машины наблюдения (`@sdelka/oracle`) в мире приложения.
 *
 * **Почему это здесь, а не в самом оракуле.** Машина — чистый редьюсер: она
 * возвращает состояние и намерения и ничего не двигает. Кто-то обязан эти
 * намерения исполнить, и этот кто-то — приложение, ровно как с намерениями
 * транша. До этого батча исполнителя не было вовсе: `g_observation_sufficient`
 * и `g_no_open_filing` не были покрыты ни одним сквозным сценарием, потому что
 * заполнить наблюдение и заявления было нечем, кроме как руками теста.
 *
 * Намерения исполняются **не все**, и это названо здесь, а не спрятано:
 * `order_paid_extract`, `recognise_oracle_cost`, `start_statutory_clock`,
 * `suspend_deal_clock`/`resume_deal_clock` требуют либо порта, либо шаблона
 * учёта, которого нет (`ORACLE.md` §11), либо часов сделки, которых нет у
 * автомата сделки. Они возвращаются вызывающему списком — исполненное и
 * неисполненное различимы, а не молчат.
 */
export function applyObservationEvent<E extends ObservationEvent>(
  world: World,
  trancheId: string,
  event: E,
  authority: Authority<ObservationOrigin<E>>,
  options: TrancheEventOptions,
): ObservationStepResult {
  assertOrigin(observationOriginsOf(event), authority, `observation.${event.type}`);
  const runtime = trancheOf(world, trancheId);
  const deal = dealOf(world, runtime.dealId);
  const act = runtime.facts.conditionAct;
  if (act === null) {
    // Наблюдение без акта получателя не о чем: тип условия определяет
    // получатель (ст. 27(2), Ф13), и спросить его больше негде.
    throw new Error(`app.observation.condition_act_missing:${trancheId}`);
  }
  const result = reduceObservation(runtime.observation, event, {
    dealId: runtime.dealId,
    conditionType: act.conditionType,
    expectedCadastralCode: deal.objectCadastralCode,
    now: world.now,
    policy: runtime.facts.observationPolicy,
  });
  if (!result.ok) {
    throw new Error(`app.observation.rejected:${result.error.code}`);
  }

  let next: World = sealed({
    ...world,
    tranches: withTranche(world, { ...runtime, observation: result.value.state }),
    checks: world.checks,
  });

  for (const intent of result.value.intents) {
    next = applyObservationIntent(next, trancheId, intent, options);
  }
  // Наблюдение внесено человеком — след остаётся в мире, и из него потом
  // работает Н2. Событие `extract_received` уже оставило его в
  // `attachObservation`; повтор не страшен — `peopleOf` схлопывает лицо.
  if (event.type === 'extract_received') {
    next = recordFact(next, 'observed', trancheSubject(next, trancheId), authority);
  }
  return { world: next, state: result.value.state, intents: result.value.intents };
}

function applyObservationIntent(
  world: World,
  trancheId: string,
  intent: ObservationIntent,
  options: TrancheEventOptions,
): World {
  const runtime = trancheOf(world, trancheId);
  switch (intent.type) {
    case 'register_filing':
      // Единственное место, где источник подачи известен достоверно (И3.2).
      // Дальше он живёт в факте сделки и в guard'е `g_no_open_filing`.
      //
      // Разрешение — машинное: подачу зарегистрировала машина наблюдения, а не
      // человек. Выдать его снаружи нельзя — `oracleAuthority` из `index.ts` не
      // экспортируется, и попасть сюда можно только пройдя шаг с полномочием
      // `record_observation`.
      return registerFiling(
        world,
        runtime.dealId,
        intent.applicationId,
        intent.source,
        oracleAuthority(world),
        options,
      );
    case 'emit_tranche_event': {
      if (intent.event === 'mismatch_detected') {
        return applyTrancheEvent(
          world,
          trancheId,
          { type: 'mismatch_detected', field: intent.field },
          oracleAuthority(world),
          options,
        ).world;
      }
      // Наблюдение кладётся в факты **до** события: транш проверит его сам
      // своими guard'ами, а не поверит оракулу на слово.
      const withObservation = sealed({
        ...world,
        tranches: withTranche(world, {
          ...runtime,
          facts: { ...runtime.facts, observation: intent.observation },
        }),
        checks: world.checks,
      });
      const evidenceBundleId = trancheOf(withObservation, trancheId).facts.evidenceBundleId;
      if (evidenceBundleId === null) {
        // Пакета доказательств нет — событие невыразимо (красная линия №5).
        // Отказ здесь, а не `g_evidence_present` тремя строками ниже: у события
        // просто нет обязательного поля, и подставить в него пустую строку
        // значило бы соврать в журнале аудита.
        throw new Error(`app.observation.evidence_bundle_missing:${trancheId}`);
      }
      return applyTrancheEvent(
        withObservation,
        trancheId,
        {
          type: 'condition_established',
          evidenceBundleId,
          conditionType: intent.conditionType,
        },
        oracleAuthority(world),
        options,
      ).world;
    }
    case 'enqueue_operator_task': {
      // Вид задачи берётся **из намерения**, а не из умолчаний транша: оракул
      // назвал, о чём задача, и подменять это `options.taskKind` значило бы
      // показать оператору очередь «источник средств» там, где речь о выписке.
      // Почему список отдельный — см. `ObservationTask` в `world.ts`.
      const observationTasks = [...world.observationTasks];
      observationTasks.push({
        taskId: `task-${trancheId}-observation-${observationTasks.length + 1}`,
        dealId: runtime.dealId,
        trancheId,
        kind: intent.kind,
        enteredAt: world.now,
        policyVersionId: options.policy,
      });
      return sealed({ ...world, observationTasks, checks: world.checks });
    }
    case 'start_statutory_clock':
    case 'order_paid_extract':
    case 'recognise_oracle_cost':
    case 'suspend_deal_clock':
    case 'resume_deal_clock':
      /**
       * Не исполняется — и это названо, а не пропущено молча.
       *
       * `order_paid_extract` требует порта реестра в потоке, `recognise_oracle_cost`
       * — шаблона учёта, которого в словаре нет (`ORACLE.md` §11), часы сделки
       * (`suspend_deal_clock`/`resume_deal_clock`) у автомата сделки не выражены
       * вовсе, а регламентный срок ведёт планировщик, а не журнал.
       *
       * Намерение возвращается вызывающему в `intents`: сценарий, который на
       * него рассчитывает, обязан утверждать о нём сам.
       */
      return world;
    default: {
      const unexpected: never = intent;
      throw new Error(`app.observation.unknown_intent:${JSON.stringify(unexpected)}`);
    }
  }
}

/** Терминальна ли машина наблюдения по траншу: удобство отчётности. */
export function observationSettled(world: World, trancheId: string): boolean {
  return isTerminalObservationStatus(trancheOf(world, trancheId).observation.status);
}

/* ------------------------------------------------------------------------- */
/* Автомат транша                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Всё, чего нет ни в событии, ни в разрешении.
 *
 * Поля `actor` здесь **больше нет**, и это главное изменение подписи: кто
 * совершает шаг, задаётся `Authority`, а не строкой рядом с настройками
 * маршрута. Прежде эти два ответа жили в одном объекте и ни разу не сверялись —
 * `trancheOptions(policy, { actor: ANALYST_ACTOR })` записывал аналитика под
 * шагом, разрешённым кем угодно.
 */
export interface TrancheEventOptions {
  readonly creditRoute: CreditRoute;
  /** Сырой ответ провайдера — обязателен у `settled` и `rejected`. */
  readonly payoutResponse: RawSourceRef | null;
  readonly payoutReasonKey: string | null;
  readonly taskKind: ReviewTaskKind;
  readonly policy: PolicyVersionId;
}

export function contextFor(world: World, runtime: TrancheRuntime): TrancheContext {
  return {
    now: world.now,
    dealId: runtime.dealId,
    trancheId: runtime.trancheId,
    facts: {
      ...runtime.facts,
      // Покрытие считает учёт, домен только читает (`g_coverage_ok`).
      coverageOk: coverageOk(world.journal),
      // Запертое под траншем — тоже из учёта, тем же способом и по той же
      // причине. Приложение здесь ничего не помнит: остаток файла транша
      // читается из журнала на каждый вызов, а не ведётся вторым счётчиком
      // рядом с ним. Раньше эта величина жила в `ProjectionContext` и
      // существовала ровно ради одного шаблона — отвязки при возврате, — потому
      // что запирание не было намерением автомата и обратный шаг он порождал
      // вслепую.
      lockedAmount: accountBalance(
        world.journal,
        clientLockedAccount(payerOf(runtime), runtime.dealId, runtime.trancheId),
        runtime.facts.requiredAmount.currency,
      ),
      activePayouts: runtime.payouts.filter((payout) =>
        (['created', 'submitted', 'unknown'] as readonly string[]).includes(payout.status),
      ).length,
    },
    deadlinePolicy: DEFAULT_DEADLINE_POLICY,
  };
}

function payoutEventFor(event: TrancheEvent): PayoutEvent | null {
  if (event.type === 'payout_result') {
    if (event.outcome === 'settled') return { type: 'provider_confirms' };
    if (event.outcome === 'rejected') return { type: 'provider_rejects' };
    // Сетевой исход ведёт только в `unknown`: отказ — это явный ответ.
    return { type: 'timeout' };
  }
  if (event.type === 'reconciliation_resolved') {
    return event.outcome === 'settled'
      ? { type: 'reconciliation_found_in_statement' }
      : { type: 'reconciliation_absent_from_statement' };
  }
  return null;
}

interface Applied {
  readonly runtime: TrancheRuntime;
  readonly journal: Journal;
  readonly chain: AuditChain;
  readonly tasks: readonly ReviewTask[];
  readonly notifications: readonly Notification[];
  readonly suppressed: readonly SuppressedEntry[];
  readonly reissued: readonly string[];
  readonly seq: number;
}

function applyIntents(
  world: World,
  runtime: TrancheRuntime,
  transition: TrancheTransitionResult,
  event: TrancheEvent,
  actor: AuditActor,
  options: TrancheEventOptions,
): Applied {
  let next: TrancheRuntime = { ...runtime, state: transition.state };
  let journal = world.journal;
  let chain = world.chain;
  let seq = world.seq;
  const tasks = [...world.tasks];
  const notifications = [...world.notifications];
  const suppressed = [...world.suppressed];
  const reissued = [...world.reissuedPayouts];

  if (event.type === 'funds_received' && transition.state.status === 'collected') {
    // Собранную сумму держит приложение: факты приходят снаружи на каждый вызов.
    //
    // ⚠ Условие на статус обязательно. То же событие `funds_received` уводит
    // транш в `release_blocked` при несовпадении плательщика, и деньги при
    // этом на транш **не зачисляются**. Приложение, записавшее сумму на любое
    // `funds_received`, получит возврат из `release_blocked` на сумму, которой
    // у покупателя нет: `moneyForTemplate` берёт для шаблона `refund` именно
    // `collectedAmount`. Отличить одно от другого домен не помогает никак —
    // ни события, ни намерения у этих двух исходов не различаются. Отчёт,
    // расхождение 12; ловушка закреплена тестом в сценарии 4.
    next = { ...next, facts: { ...next.facts, collectedAmount: event.amount } };
  }

  for (const intent of transition.intents) {
    switch (intent.type) {
      case 'set_deadline':
        // Забота планировщика. В журнале следа нет — и не должно быть.
        next = { ...next, suspendedRemaining: null };
        break;
      case 'suspend_deadline':
        next = { ...next, suspendedRemaining: intent.remaining };
        break;
      case 'notify':
        notifications.push({ audience: intent.audience, messageKey: intent.messageKey });
        break;
      case 'lock_beneficiary':
        next = { ...next, beneficiary: lockOnFunding(next.beneficiary) };
        next = { ...next, facts: { ...next.facts, beneficiary: toBeneficiaryLock(next.beneficiary) } };
        break;
      case 'unlock_beneficiary':
        next = { ...next, beneficiary: { ...next.beneficiary, locked: false } };
        next = { ...next, facts: { ...next.facts, beneficiary: toBeneficiaryLock(next.beneficiary) } };
        break;
      case 'build_payout_instruction':
        // ⚠ Поручение здесь только **формируется** (`STATE-MACHINES.md` §1.5:
        // «Формирование поручения с детерминированным ключом»). Материализовать
        // на этом месте `PayoutState` нельзя: его начальный статус `created`
        // входит в активные, и `g_no_active_payout` на следующем же ребре
        // запирает транш в `release_pending` навсегда. Отчёт, расхождение 6;
        // тест-надгробие — в сценарии счастливого пути.
        break;
      case 'enqueue_outbound_payout': {
        // ⚠ Переход `paying_out → paying_out` по `payout_result(unknown)` —
        // это повторный **вход** в `paying_out`, и редьюсер безусловно
        // возвращает намерения входа, среди которых «отправить поручение в
        // исходящую очередь». То есть каждый неответ банка велит выпустить
        // поручение заново — ровно то, что §2.2 объявляет невозможным. Спасает
        // только ключ идемпотентности: он детерминирован по траншу, и очередь
        // гасит повтор. Приложение, доверившееся намерению, выпустит вторую
        // выплату. Отчёт, расхождение 13.
        const active = next.payouts.find(
          (payout) =>
            payout.idempotencyKey === intent.idempotencyKey &&
            (['created', 'submitted', 'unknown'] as readonly string[]).includes(payout.status),
        );
        if (active !== undefined) {
          reissued.push(intent.idempotencyKey);
          break;
        }
        const created: PayoutState = createPayout(runtime.trancheId);
        const submitted = reducePayout(created, { type: 'payout_submitted' });
        if (!submitted.ok) {
          throw new Error(`app.payout.submit_rejected:${submitted.error.code}`);
        }
        next = { ...next, payouts: [...next.payouts, submitted.value.state] };
        const amount = next.facts.collectedAmount ?? next.facts.requiredAmount;
        seq += 1;
        chain = appendRecord(chain, {
          recordId: `${chain.chainId}:r${seq}`,
          recordedAt: auditInstant(world.now),
          actor,
          subject: auditRef('payout', intent.idempotencyKey),
          related: [auditRef('tranche', runtime.trancheId), auditRef('deal', runtime.dealId)],
          body: {
            kind: 'payout_ordered',
            idempotencyKey: intent.idempotencyKey,
            amount: auditAmount(amount.currency, amount.minor),
            beneficiary: auditFingerprint('account', next.beneficiary.requisites.account),
            policy: policyRef(options.policy),
            evidencePackage: nonEmpty(next.evidence),
          },
        });
        break;
      }
      case 'enqueue_outbound_refund': {
        // Возврат — такое же поручение в банк, как расчёт, и **своя** запись
        // выплаты с собственным ключом. До этого записи у возврата не было
        // вовсе, и ответ банка по нему приложение отдавало последней выплате
        // транша: у транша с отклонённым расчётом подтверждение возврата
        // отвергалось как `domain.state.terminal`, а у транша с потерянным
        // ответом — молча закрывало **чужую** ногу.
        //
        // Повтор гасится тем же способом, что у расчёта: активное поручение с
        // тем же ключом второй раз не выпускается. Самоперехода
        // `refunding → refunding` по неответу это не касается — он объявлен
        // внутренним, и действий входа при нём нет.
        const active = next.payouts.find(
          (payout) =>
            payout.idempotencyKey === intent.idempotencyKey &&
            (['created', 'submitted', 'unknown'] as readonly string[]).includes(payout.status),
        );
        if (active !== undefined) {
          reissued.push(intent.idempotencyKey);
          break;
        }
        const created: PayoutState = createRefundPayout(runtime.trancheId);
        const submitted = reducePayout(created, { type: 'payout_submitted' });
        if (!submitted.ok) {
          throw new Error(`app.payout.submit_rejected:${submitted.error.code}`);
        }
        next = { ...next, payouts: [...next.payouts, submitted.value.state] };
        seq += 1;
        // ⚠ Записью журнала аудита здесь идёт переход **машины выплаты**, а не
        // `payout_ordered`: у того пакет доказательств обязателен и непуст по
        // типу (`PayoutOrderedBody`, красная линия №5), а у возврата пакета нет
        // и быть не обязано — возвращаются собственные деньги покупателя.
        // Подставить сюда пустой список нельзя, выдумать непустой — тем более.
        // Своего тела записи у поручения на возврат в `@sdelka/audit` пока нет;
        // до его появления поручение видно в цепочке этим переходом, а его
        // исход — записью `payout_result` с тем же предметом.
        chain = appendRecord(chain, {
          recordId: `${chain.chainId}:r${seq}`,
          recordedAt: auditInstant(world.now),
          actor,
          subject: auditRef('payout', intent.idempotencyKey),
          related: [auditRef('tranche', runtime.trancheId), auditRef('deal', runtime.dealId)],
          body: {
            kind: 'state_transition',
            machine: 'payout',
            from: 'created',
            to: 'submitted',
            eventKey: 'payout_submitted',
            failedGuards: [],
          },
        });
        break;
      }
      case 'enqueue_operator_task':
        // ⚠ Намерение несёт только сумму приоритета. Вид задачи, важность,
        // сторона и версия политики — обязательные поля `ReviewTask` в
        // `@sdelka/compliance`, и все четыре приложение подставляет само.
        // Отчёт, расхождение 7.
        tasks.push({
          taskId: `task-${runtime.trancheId}-${tasks.length + 1}`,
          kind: options.taskKind,
          dealId: runtime.dealId,
          trancheId: runtime.trancheId,
          partyId: next.facts.buyer.partyId,
          rankAmount: intent.priorityAmount,
          enteredAt: world.now,
          deadlineAt: null,
          severity: 'hold',
          assigneeId: null,
          policyVersionId: options.policy,
        });
        break;
      case 'post_journal_entry': {
        seq += 1;
        const projected = projectLedgerIntent(intent, {
          meta: {
            id: `entry-${seq}-${intent.template}`,
            occurredAt: new Date(world.now).toISOString(),
          },
          deductions: next.deductions,
          route: options.creditRoute,
        });
        if (projected.kind === 'entry') {
          journal = appendEntry(journal, projected.entry);
        } else {
          suppressed.push({
            trancheId: runtime.trancheId,
            template: projected.template,
            reasonKey: projected.reasonKey,
          });
        }
        break;
      }
      case 'post_settlement_entry': {
        // ⚠ Здесь приложение ничего не решает и решать не может. Стороны и
        // ссылка на доказательства пришли в намерении, подтверждение выдал
        // автомат — подставить своего получателя нечем, а построить
        // подтверждение самому невозможно по типу. Отчёт, расхождение 3:
        // свободный параметр `recipient` исчез вместе с возможностью ошибиться.
        //
        // Записей теперь две: начисление комиссии и сам расчёт, гасящий
        // требование (`CORE.md` Ф16, И14.1). Порядок значим — удержание без
        // начисления уводит `fee:receivable` в минус и ловится инвариантом.
        const occurredAt = new Date(world.now).toISOString();
        seq += 1;
        const accrualMeta: EntryMeta = { id: `entry-${seq}-fee-accrued`, occurredAt };
        seq += 1;
        const projected = projectSettlementIntent(intent, {
          meta: { id: `entry-${seq}-settlement`, occurredAt },
          accrualMeta,
          deductions: next.deductions,
          tariffVersionId: next.tariffVersionId,
          route: options.creditRoute,
        });
        for (const entry of projected.entries) {
          journal = appendEntry(journal, entry);
        }
        break;
      }
      case 'close_tranche':
        break;
      case 'freeze_tranches':
      case 'unfreeze_tranches':
        // Каскад порождает сделка, а не транш. Сюда попасть нельзя.
        throw new Error(`app.tranche.unexpected_intent:${intent.type}`);
      default: {
        const unexpected: never = intent;
        throw new Error(`app.tranche.unknown_intent:${JSON.stringify(unexpected)}`);
      }
    }
  }

  seq += 1;
  chain = appendRecord(chain, {
    recordId: `${chain.chainId}:r${seq}`,
    recordedAt: auditInstant(world.now),
    actor,
    subject: auditRef('tranche', runtime.trancheId),
    related: [auditRef('deal', runtime.dealId)],
    body: {
      kind: 'state_transition',
      machine: 'tranche',
      from: runtime.state.status,
      to: transition.state.status,
      eventKey: event.type,
      failedGuards: [],
    },
  });

  return { runtime: next, journal, chain, tasks, notifications, suppressed, reissued, seq };
}

const DEFAULT_OPTIONS: Omit<TrancheEventOptions, 'policy'> = {
  creditRoute: 'external_arrival',
  payoutResponse: null,
  payoutReasonKey: null,
  taskKind: 'source_of_funds',
};

export function trancheOptions(
  policy: PolicyVersionId,
  overrides: Partial<TrancheEventOptions> = {},
): TrancheEventOptions {
  return { ...DEFAULT_OPTIONS, policy, ...overrides };
}

export interface TrancheStepResult {
  readonly world: World;
  readonly transition: TrancheTransitionResult;
}

/**
 * Один шаг автомата транша: разрешение, редьюсер, проекция намерений, запись в
 * журнал аудита и проверка инвариантов. Отказ автомата здесь — исключение:
 * тест, ожидающий отказа, пользуется `rejectTrancheEvent`.
 *
 * **Разрешение параметризовано событием.** `Authority<TrancheOrigin<E>>` — это
 * компиляционный рубеж: `applyTrancheEvent(world, id, { type:
 * 'release_authorized' }, operatorAuthority, options)` не собирается, потому что
 * у выпуска поручения происхождение `approve_payout`, а не `create_deal`.
 * Рантайм-рубеж (`assertOrigin` внутри) дублирует его для случая, когда событие
 * приехало из-за границы процесса и типа при нём не осталось.
 */
export function applyTrancheEvent<E extends TrancheEvent>(
  world: World,
  trancheId: string,
  event: E,
  authority: Authority<TrancheOrigin<E>>,
  options: TrancheEventOptions,
): TrancheStepResult {
  return applyTrancheEventInternal(world, trancheId, event, authority, options);
}

/**
 * То же без параметризации по событию: каскад сделки и намерения оракула
 * подают событие, тип которого на месте вызова не известен статически. Проверка
 * происхождения от этого не исчезает — она рантайм-ная и стоит первой строкой.
 */
function applyTrancheEventInternal(
  world: World,
  trancheId: string,
  event: TrancheEvent,
  authority: Authority<StepOrigin>,
  options: TrancheEventOptions,
): TrancheStepResult {
  assertOrigin(trancheOriginsOf(event), authority, `tranche.${event.type}`);
  const runtime = trancheOf(world, trancheId);
  guardTrancheIdentity(world, runtime, event, authority);
  const actor = journalActor(authority);

  // Машина выплаты ведётся отдельно и **раньше** машины транша: у неё легально
  // состояние «неизвестно», которого у транша нет (`STATE-MACHINES.md` §2).
  let payouts = runtime.payouts;
  /** Поручение, которому адресован исход банка. `undefined` — исхода нет вовсе. */
  let addressed: PayoutState | undefined;
  const payoutEvent = payoutEventFor(event);
  if (payoutEvent !== null) {
    /**
     * ⚠ Исход адресуется **поручению в полёте**, а не последней записи.
     *
     * Раньше здесь стояло `payouts[payouts.length - 1]`, и это молча означало
     * «у транша одна нога». У транша их две: расчёт получателю и возврат
     * покупателю, и они случаются подряд — банк отклоняет расчёт, транш уходит
     * в `release_blocked`, оператор ведёт его в возврат. Последней записью при
     * этом остаётся отклонённый расчёт, то есть **терминальная** выплата, и
     * подтверждение возврата отвергалось как `domain.state.terminal`: транш
     * оставался в `refunding` навсегда, а деньги покупателя — на номинальном
     * счёте (красная линия №7). В узком случае «ответ по расчёту потерян»
     * запись была нетерминальной, и выписка о возврате покупателю молча
     * закрывала расчёт продавцу.
     *
     * Поручение в полёте ровно одно: `g_no_active_payout` стоит на обоих
     * рёбрах выпуска (`release_pending → paying_out` и
     * `refund_pending → refunding`), а `violatesSingleActivePayout` держит то
     * же правило инвариантом мира. Больше одного — нарушение, и шаг обязан
     * остановиться здесь, а не выбрать любое.
     *
     * Ни одного активного — тоже остановка: исход банка есть ответ на
     * поручение, и ответ без поручения означает, что мы собираемся двинуть
     * деньги по факту, которого не заказывали.
     */
    const inFlight = activePayoutsForTranche(payouts, trancheId);
    if (inFlight.length > 1) {
      throw new Error(`app.payout.ambiguous:${inFlight.length}`);
    }
    const active = inFlight[0];
    if (active === undefined) {
      throw new Error(`app.payout.missing:${runtime.state.status}`);
    }
    const at = payouts.lastIndexOf(active);
    addressed = active;
    // ⚠ Две машины расходятся на одном и том же событии. У транша
    // `paying_out --payout_result(unknown)--> paying_out` — ребро, которое
    // можно пройти сколько угодно раз; у выплаты из `unknown` сетевого ребра
    // нет вовсе, и второй неответ она отвергает. Правильна выплата: повторный
    // неответ по тому же поручению — это то же самое «неизвестно», а не новое
    // событие, и её состояние меняться не должно. Приложение обязано знать это
    // само: домен различить два случая не помогает. Отчёт, расхождение 14.
    const repeatedUnknown =
      event.type === 'payout_result' && event.outcome === 'unknown' && active.status === 'unknown';
    if (!repeatedUnknown) {
      const moved = reducePayout(active, payoutEvent);
      if (!moved.ok) {
        throw new Error(`app.payout.rejected:${moved.error.code}`);
      }
      payouts = [...payouts.slice(0, at), moved.value.state, ...payouts.slice(at + 1)];
    }
  }

  const withPayouts: TrancheRuntime = { ...runtime, payouts };
  const result = reduceTranche(withPayouts.state, event, contextFor(world, withPayouts));
  if (!result.ok) {
    throw new Error(
      `app.tranche.rejected:${result.error.code}:${result.error.failedGuards.join(',')}`,
    );
  }

  const applied = applyIntents(world, withPayouts, result.value, event, actor, options);

  let chain = applied.chain;
  let seq = applied.seq;
  if (event.type === 'payout_result' || event.type === 'reconciliation_resolved') {
    // Предмет записи — то самое поручение, которому исход адресован. По
    // последней записи транша брать нельзя по той же причине, по которой её
    // нельзя двигать: у транша с двумя ногами последняя запись — не та.
    const last = addressed;
    if (last !== undefined) {
      seq += 1;
      const outcome = event.type === 'payout_result' ? event.outcome : event.outcome;
      chain = appendRecord(chain, {
        recordId: `${chain.chainId}:r${seq}`,
        recordedAt: auditInstant(world.now),
        actor,
        subject: auditRef('payout', last.idempotencyKey),
        related: [auditRef('tranche', trancheId), auditRef('deal', runtime.dealId)],
        body:
          outcome === 'unknown'
            ? {
                kind: 'payout_result',
                outcome: 'unknown',
                response: options.payoutResponse,
                reasonKey: options.payoutReasonKey ?? 'payout.response_lost',
              }
            : {
                kind: 'payout_result',
                outcome,
                response: requireResponse(options.payoutResponse),
                reasonKey: options.payoutReasonKey,
              },
      });
    }
  }

  const stepped = sealed({
    ...world,
    seq,
    journal: applied.journal,
    chain,
    tranches: withTranche(world, applied.runtime),
    tasks: applied.tasks,
    notifications: applied.notifications,
    suppressed: applied.suppressed,
    reissuedPayouts: applied.reissued,
    checks: world.checks,
  });

  return {
    world: BLOCKING_TRANCHE_EVENTS.includes(event.type)
      ? recordFact(stepped, 'caused', trancheSubject(stepped, trancheId), authority)
      : stepped,
    transition: result.value,
  };
}

/**
 * События, после которых транш стоит: расхождение, удержание комплаенса, спор.
 *
 * След «кто это вызвал» кладётся именно здесь и нигде больше — из него потом
 * работает Н5: тот, чьё действие вызвало остановку, её не снимает. Без следа
 * `actionContextFor` вернул бы по заблокированному траншу `UNKNOWN_FACT`, и
 * снять удержание не смог бы вообще никто — что тоже отказ, но не тот.
 */
const BLOCKING_TRANCHE_EVENTS: readonly TrancheEvent['type'][] = Object.freeze([
  'mismatch_detected',
  'operator_blocked',
  'compliance_hold',
  'dispute_raised',
]);

/**
 * Шаги, у которых предмет сам называет исполнителя.
 *
 * Отзыв заявляет **покупатель этого транша**, а не любой обладатель полномочия
 * стороны; новую редакцию акта принимают те, кто в ней назван. Без этой сверки
 * полномочие `freeze_participation` означало бы «любая сторона может отозвать
 * чужую сделку», а `record_condition_act` — «любая сторона может подписать
 * чужой акт».
 */
function guardTrancheIdentity(
  world: World,
  runtime: TrancheRuntime,
  event: TrancheEvent,
  authority: Authority<StepOrigin>,
): void {
  if (event.type === 'revocation_requested') {
    requireSamePerson(authority, runtime.facts.buyer.partyId, 'tranche.revocation.buyer');
    return;
  }
  if (event.type === 'condition_act_amended') {
    const acting = actingAccount(authority);
    if (!event.acceptedBy.includes(acting)) {
      throw new AuthorityError(`app.authority.actor_not_in_acceptance:${acting}`);
    }
    return;
  }
  if (event.type === 'approval_added') {
    // Подпись ставится своим именем: имя в событии и лицо в сессии — одно.
    requireSamePerson(authority, event.userId, 'tranche.approval.user');
    return;
  }
  if (event.type === 'release_authorized') {
    requireQuorum(world, runtime);
  }
}

/**
 * Кворум перед выпуском поручения — **по набору уровней, а не по числу строк**.
 *
 * `g_approvals_sufficient` в домене считает **имена**: две различные строки, ни
 * одна из которых не равна готовившему. Этого мало ровно так, как говорит
 * `ACTORS.md` §0 п.3: учётная запись поддержки, попавшая в список утверждающих,
 * набирает кворум. Здесь тот же порог берётся ещё раз — набором уровней
 * (`evaluateQuorum`, `@sdelka/auth`): одна подпись = уровень 1 (ФК), две =
 * уровень 1 плюс уровень 2 (ФК и РО), и записи с уровнем выдаёт только
 * `recordApproval`.
 *
 * Второй экземпляр правила это **не** делает: guard домена сравнивает имена,
 * кворум — уровни, и снятие любого из двух меняет поведение (что и проверяется
 * сценариями). Готовивший приходит из фактов мира, а не из аргумента; если мир
 * его не знает — отказ, а не «никто не готовил».
 */
function requireQuorum(world: World, runtime: TrancheRuntime): void {
  const amount = runtime.facts.collectedAmount ?? runtime.facts.requiredAmount;
  const required = requiredApprovals(
    runtime.facts.approvalPolicy,
    amount,
    runtime.facts.officialRateAtCreation,
    runtime.facts.createdOn,
  );
  const prepared = actionContextFor(world, trancheSubject(world, runtime.trancheId)).preparedBy;
  const preparedBy: ActorRef | typeof UNKNOWN_FACT =
    prepared === UNKNOWN_FACT ? UNKNOWN_FACT : (prepared[0] ?? UNKNOWN_FACT);
  const quorum = evaluateQuorum({
    required,
    preparedBy,
    approvals: runtime.approvalRecords,
  });
  if (!quorum.ok) {
    throw new AuthorityError(`app.quorum.not_met:${quorum.error}`);
  }
}

function requireResponse(response: RawSourceRef | null): RawSourceRef {
  if (response === null) {
    // `settled` и `rejected` без сырого ответа — это разобранные поля без
    // исходника (`CORE.md` Ф11). Тип записи их и не принимает.
    throw new Error('app.payout.response_required');
  }
  return response;
}

/** Отказ автомата как значение: тест, который его ждёт, обязан его разобрать. */
export function rejectTrancheEvent(
  world: World,
  trancheId: string,
  event: TrancheEvent,
): Rejection {
  const runtime = trancheOf(world, trancheId);
  const result = reduceTranche(runtime.state, event, contextFor(world, runtime));
  if (result.ok) {
    throw new Error(`app.tranche.unexpected_transition:${result.value.state.status}`);
  }
  return result.error;
}

/* ------------------------------------------------------------------------- */
/* Автомат сделки                                                            */
/* ------------------------------------------------------------------------- */

export function dealFactsOf(world: World, dealId: string): DealFacts {
  const deal = dealOf(world, dealId);
  return {
    trancheStatuses: deal.trancheIds.map((id) => trancheOf(world, id).state.status),
    preparedBy: deal.preparedBy,
    conditionAct: deal.conditionAct,
    filings: deal.filings,
    objectCadastralCode: deal.objectCadastralCode,
  };
}

/**
 * Заявление, разрешённое платной выпиской, — **любым вердиктом** (`ORACLE.md`
 * §9). Разрешает только выписка: статус карточки «завершено» не значит ничего,
 * заявление может быть закрыто отказом (`CORE.md` Ф7).
 *
 * Наблюдение берётся с транша: другого места, где оно живёт, нет, а разрешать
 * заявление вправе только то наблюдение, которое прошло через транш.
 * Достаточно одного транша сделки: заявление о регистрации подаётся по объекту,
 * а объект у сделки один.
 */
function resolutionFor(world: World, deal: DealRuntime): ReleaseObservation | null {
  for (const trancheId of deal.trancheIds) {
    const observation = trancheOf(world, trancheId).facts.observation;
    if (observation !== null && observation.level === PAID_EXTRACT_LEVEL) {
      return observation;
    }
  }
  return null;
}

/**
 * Заявления сделки после события.
 *
 * Два случая, и они разные: `filing_registered` заводит заявление, любое другое
 * событие может его **закрыть** — если к этому моменту у сделки появилась
 * платная выписка. Без второй половины `g_no_open_filing` запирал бы откат
 * навсегда: заявление, однажды подтверждённое карточкой, не разрешалось бы
 * ничем, и сделка с расхождением по выписке не смогла бы уйти в возврат.
 */
function filingsAfter(
  world: World,
  deal: DealRuntime,
  event: DealEvent,
): readonly DealFiling[] {
  const resolution = resolutionFor(world, deal);
  const existing = deal.filings.map((filing) =>
    filing.resolution === null && resolution !== null ? { ...filing, resolution } : filing,
  );
  if (event.type !== 'filing_registered') {
    return Object.freeze(existing);
  }
  if (existing.some((filing) => filing.applicationId === event.applicationId)) {
    // Повторная регистрация того же номера — не второе заявление. Источник при
    // этом мог **усилиться**: сторона назвала номер, а потом мы увидели
    // карточку. Ослабление невозможно: подтверждённое карточкой не становится
    // обратно словом стороны.
    return Object.freeze(
      existing.map((filing) =>
        filing.applicationId === event.applicationId && event.source === 'application_card'
          ? { ...filing, source: event.source }
          : filing,
      ),
    );
  }
  return Object.freeze([
    ...existing,
    { applicationId: event.applicationId, source: event.source, resolution },
  ]);
}

/**
 * Заявление зарегистрировано.
 *
 * Статус сделки двигает **только первая подача**: `filed` означает «заявление
 * подано», а не «подано ещё раз». Подтверждение карточкой уже названного
 * стороной номера усиливает источник факта (`party_claim` → `application_card`,
 * то есть включает запрет автооткрата), но состояния сделки не меняет — ребра
 * `filed --filing_registered--> …` в таблице нет, и появляться ему незачем.
 *
 * Это не проглоченный отказ автомата: развилка названа здесь по статусу, а не
 * спрятана в `catch`. Событие уходит в редьюсер ровно тогда, когда таблица
 * переходов его принимает, и отказ в любом другом случае по-прежнему роняет шаг.
 */
export function registerFiling(
  world: World,
  dealId: string,
  applicationId: string,
  source: FilingSource,
  authority: Authority<'oracle_source' | 'create_deal'>,
  options: TrancheEventOptions,
): World {
  assertOrigin(['oracle_source', 'create_deal'], authority, 'deal.filing_registered');
  const deal = dealOf(world, dealId);
  const event: DealEvent = { type: 'filing_registered', applicationId, source };
  // Сделка уже прошла точку подачи: заявление у неё есть, и второй факт о том
  // же (или о соседнем) заявлении её статуса не меняет. Условие именно такое,
  // а не «статус не `funded`»: подача по сделке, до этой точки **не дошедшей**
  // (черновик, ожидание проверки объекта), — это расхождение, и оно обязано
  // упасть отказом автомата, а не осесть фактом в стороне от состояния.
  if (deal.state.status !== 'funded' && deal.filings.length > 0) {
    return sealed({
      ...world,
      deals: withDeal(world, { ...deal, filings: filingsAfter(world, deal, event) }),
      checks: world.checks,
    });
  }
  return applyDealEventInternal(world, dealId, event, authority, options);
}

/**
 * Шаг автомата сделки. Разрешение параметризовано событием — тот же
 * компиляционный рубеж, что у транша (`DEAL_EVENT_ORIGINS` в `origins.ts`).
 */
export function applyDealEvent<E extends DealEvent>(
  world: World,
  dealId: string,
  event: E,
  authority: Authority<DealOrigin<E>>,
  options: TrancheEventOptions,
): World {
  return applyDealEventInternal(world, dealId, event, authority, options);
}

function applyDealEventInternal(
  world: World,
  dealId: string,
  event: DealEvent,
  authority: Authority<StepOrigin>,
  options: TrancheEventOptions,
): World {
  assertOrigin(dealOriginsOf(event), authority, `deal.${event.type}`);
  const deal = dealOf(world, dealId);
  const result = reduceDeal(deal.state, event, {
    dealId,
    facts: dealFactsOf(world, dealId),
    now: world.now,
  });
  if (!result.ok) {
    throw new Error(`app.deal.rejected:${result.error.code}:${result.error.failedGuards.join(',')}`);
  }

  const seq = world.seq + 1;
  let next: World = sealed({
    ...world,
    seq,
    deals: withDeal(world, {
      ...deal,
      state: result.value.state,
      filings: filingsAfter(world, deal, event),
    }),
    chain: record(world, {
      recordId: auditId(world, seq),
      recordedAt: auditInstant(world.now),
      actor: journalActor(authority),
      subject: auditRef('deal', dealId),
      related: [],
      body: {
        kind: 'state_transition',
        machine: 'deal',
        from: deal.state.status,
        to: result.value.state.status,
        eventKey: event.type,
        failedGuards: [],
      },
    }),
    checks: world.checks,
  });

  // Каскад на транши. Без него комплаенс замораживает сделку, а её транши идут
  // к автовозврату по дедлайну (`CORE.md` Ф17).
  for (const intent of result.value.intents) {
    next = applyDealCascade(next, dealId, intent, authority, options);
  }
  // След «кто вызвал остановку» — на сделке целиком: замораживает её один
  // человек, а снимать будут двое, и Н5 обязана видеть первого.
  if (event.type === 'compliance_hold' || event.type === 'dispute_raised') {
    next = recordFact(next, 'caused', dealSubject(dealId), authority);
  }
  return next;
}

/**
 * Каскад «сделка → транши».
 *
 * Разрешение передаётся то же, что у события сделки, и это законно ровно потому,
 * что происхождения совпадают: `compliance_hold` и `dispute_raised` у сделки и у
 * транша разрешены одним `run_screening`, `unfreeze` — одним `lift_block`
 * (`origins.ts`). Совпадение не подразумевается — его проверяет `assertOrigin`
 * внутри шага транша, и разъехавшиеся карты уронят каскад, а не пропустят его.
 */
function applyDealCascade(
  world: World,
  dealId: string,
  intent: Intent,
  authority: Authority<StepOrigin>,
  options: TrancheEventOptions,
): World {
  const deal = dealOf(world, dealId);
  let next = world;
  for (const trancheId of deal.trancheIds) {
    if (intent.type === 'freeze_tranches') {
      // ⚠ Намерение несёт `FreezeReason` целиком, а у транша событий два, и
      // `compliance_hold` не принимает основание `dispute` по типу. Разделять
      // обратно приходится приложению. Отчёт, расхождение 8.
      const event: TrancheEvent =
        intent.reason === 'dispute'
          ? { type: 'dispute_raised', frozenBy: intent.frozenBy }
          : { type: 'compliance_hold', reason: intent.reason, frozenBy: intent.frozenBy };
      next = applyTrancheEventInternal(next, trancheId, event, authority, options).world;
      continue;
    }
    if (intent.type === 'unfreeze_tranches') {
      next = applyTrancheEventInternal(
        next,
        trancheId,
        { type: 'unfreeze', userIds: intent.userIds, resume: intent.resume },
        authority,
        options,
      ).world;
    }
  }
  return next;
}

export function rejectDealEvent(world: World, dealId: string, event: DealEvent): Rejection {
  const deal = dealOf(world, dealId);
  const result = reduceDeal(deal.state, event, {
    dealId,
    facts: dealFactsOf(world, dealId),
    now: world.now,
  });
  if (result.ok) {
    throw new Error(`app.deal.unexpected_transition:${result.value.state.status}`);
  }
  return result.error;
}

export function dealStatusOf(world: World, dealId: string): DealState['status'] {
  return dealOf(world, dealId).state.status;
}

export function trancheStatusOf(world: World, trancheId: string): TrancheState['status'] {
  return trancheOf(world, trancheId).state.status;
}

export type { PolicyRef };
