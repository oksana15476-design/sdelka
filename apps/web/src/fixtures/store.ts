import {
  type DealStatus,
  type PayoutStatus,
  type TrancheState,
  type TrancheStatus,
  isTerminalTrancheStatus,
} from '@sdelka/domain';
import {
  type CoverageByCurrency,
  type Journal,
  accountBalance,
  appendEntries,
  clientAccountOwner,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  coverage,
  emptyJournal,
} from '@sdelka/ledger';
import type { IntakeRouting } from '@sdelka/intake';
import { type CurrencyCode, type Money, isPositive, money, subtract } from '@sdelka/money';
import {
  type AssuranceLevel,
  type MoneyState,
  type PaymentFacts,
  type StateModifiers,
  type StateTone,
  MONEY_STATE_CODE,
  MONEY_STATE_TONE,
  projectAssuranceLevel,
  projectMoneyState,
} from '@/view/money-state';
import { FIXTURE_NOW, platformFee, runScenario } from './engine';
import { type CounterpartyKey, type DealRole, type PropertyKey, type Scenario, FIXTURE_DATA, SCENARIOS, VIEWER, counterpartyRef } from './scenarios';

/**
 * Хранилище фикстур: единственное место, которое знает, откуда берутся данные.
 *
 * Экраны ходят только сюда и получают уже собранные представления. Замена на
 * базу — замена тела этих функций: сигнатуры асинхронные именно поэтому, а не
 * потому, что в памяти что-то ждёт.
 */

export interface PropertyView {
  readonly address: string;
  readonly addressLatin: string;
  readonly cadastral: string;
  readonly areaContract: string;
  readonly areaRegistry: string;
  readonly ownerContract: string;
  readonly ownerRegistry: string;
  readonly extractAt: number;
  readonly areaMismatch: boolean;
  readonly ownerMismatch: boolean;
  readonly hasMismatch: boolean;
}

/** Тип последствия дедлайна. Таймер без последствия не рендерится вовсе. */
export type DeadlineKind = 'topup' | 'reserve' | 'registration' | 'settlement' | 'refund' | 'review';

/**
 * Срок и то, что произойдёт при его наступлении. Последствие обязательно:
 * таймер без последствия не рендерится вовсе (`SCREENS.md` §1.2).
 *
 * `at === null` означает не «срока нет», а «часы остановлены»: у замороженного
 * транша дедлайна в домене физически нет — есть неистёкший остаток. Показывать
 * на его месте дату было бы враньём, показывать пустоту — потерей ответа на
 * вопрос «что дальше». Поэтому остаток и причина приходят отдельными полями.
 */
export interface DeadlineView {
  readonly at: number | null;
  readonly remainingMs: number | null;
  readonly kind: DeadlineKind;
  readonly paused: boolean;
  readonly pauseReasonKey: string | null;
}

export interface TimelineMark {
  readonly status: TrancheStatus;
  readonly at: number;
}

/**
 * Конвертационный слой. `null` означает не «курс единица», а «слоя нет вовсе»:
 * валюта перевода совпала с валютой сделки, и тогда исчезают строка курса,
 * комиссия за конвертацию и сам разговор о них (`IMPLEMENTATION.md` §3).
 * Курс 1:1 не показывается никогда.
 */
export interface ConversionView {
  /** Сколько клиент отправил из своего банка, в валюте перевода. */
  readonly transfer: Money<CurrencyCode>;
  /** Курс сделки и рыночный курс — десятичными строками, формат даёт `Intl`. */
  readonly rate: string;
  readonly marketRate: string;
  /** Комиссия за конвертацию — в валюте сделки, невозвратная. */
  readonly fxFee: Money<CurrencyCode>;
}

export interface DealSnapshot {
  readonly id: string;
  readonly ref: string;
  readonly role: DealRole;
  readonly moneyState: MoneyState;
  readonly moneyStateCode: string;
  readonly tone: StateTone;
  readonly trancheStatus: TrancheStatus;
  readonly dealStatus: DealStatus;
  readonly payoutStatus: PayoutStatus | null;
  readonly assurance: AssuranceLevel;
  readonly property: PropertyView;
  readonly counterpartyName: string;
  /** Валюта сделки: отдельный счёт номинального держания и отдельная сверка. */
  readonly dealCurrency: CurrencyCode;
  /** Валюта перевода независима от валюты сделки; совпали — слоя нет. */
  readonly conversion: ConversionView | null;
  readonly required: Money<CurrencyCode>;
  readonly credited: Money<CurrencyCode>;
  readonly locked: Money<CurrencyCode>;
  readonly fee: Money<CurrencyCode>;
  readonly payeeReceives: Money<CurrencyCode>;
  readonly excess: Money<CurrencyCode> | null;
  readonly shortfall: Money<CurrencyCode> | null;
  readonly foreignBalance: Money<CurrencyCode> | null;
  readonly deadline: DeadlineView | null;
  readonly reservedAt: number | null;
  readonly confirmationNo: string | null;
  readonly payment: PaymentFacts;
  readonly modifiers: StateModifiers;
  readonly marks: readonly TimelineMark[];
  readonly applicationId: string | null;
  readonly counterpartyVerified: boolean;
}

const DEADLINE_KIND: Readonly<Record<TrancheStatus, DeadlineKind | null>> = Object.freeze({
  pending: 'topup',
  collecting: 'topup',
  collected: 'reserve',
  reserved: 'registration',
  release_pending: 'settlement',
  release_blocked: 'review',
  paying_out: 'settlement',
  refund_pending: 'refund',
  refunding: 'refund',
  paid_out: null,
  refunded: null,
  written_off: null,
  frozen: null,
});

/**
 * Валюта перевода по сделке. Отсутствие записи означает совпадение с валютой
 * сделки — и тогда конвертационного слоя нет вовсе, а не «курс 1:1».
 *
 * Курсы и суммы заданы целыми минорными единицами и десятичными строками:
 * плавающей точки в деньгах нет ни одной (красная линия №4).
 */
const TRANSFER: Readonly<
  Record<string, { readonly currency: CurrencyCode; readonly minor: bigint; readonly rate: string; readonly market: string }>
> = Object.freeze({
  m05: { currency: 'USD', minor: 8_084_560n, rate: '2.6842', market: '2.7104' },
  m06: { currency: 'USD', minor: 8_084_560n, rate: '2.6842', market: '2.7104' },
  m09: { currency: 'USD', minor: 8_084_560n, rate: '2.6842', market: '2.7104' },
  m11: { currency: 'EUR', minor: 7_428_710n, rate: '2.9211', market: '2.9502' },
  m14: { currency: 'USD', minor: 8_084_560n, rate: '2.6842', market: '2.7104' },
  r03: { currency: 'USD', minor: 8_084_560n, rate: '2.6842', market: '2.7104' },
});

/** Комиссия за конвертацию: 0,8% от суммы сделки, целыми минорными единицами. */
function conversionFee(required: Money<CurrencyCode>): Money<CurrencyCode> {
  return money(required.currency, (required.minor * 8n) / 1000n);
}

function conversionOf(scenarioId: string, required: Money<CurrencyCode>): ConversionView | null {
  const item = TRANSFER[scenarioId];
  if (item === undefined || item.currency === required.currency) return null;
  return {
    transfer: money(item.currency, item.minor),
    rate: item.rate,
    marketRate: item.market,
    fxFee: conversionFee(required),
  };
}

function propertyView(key: PropertyKey): PropertyView {
  const item = FIXTURE_DATA.properties[key];
  const areaMismatch = item.areaContract !== item.areaRegistry;
  const ownerMismatch = item.ownerContract !== item.ownerRegistry;
  return {
    address: item.address,
    addressLatin: item.addressLatin,
    cadastral: item.cadastral,
    areaContract: item.areaContract,
    areaRegistry: item.areaRegistry,
    ownerContract: item.ownerContract,
    ownerRegistry: item.ownerRegistry,
    extractAt: Date.parse(item.extractAt),
    areaMismatch,
    ownerMismatch,
    hasMismatch: areaMismatch || ownerMismatch,
  };
}

function counterpartyName(key: CounterpartyKey): string {
  return FIXTURE_DATA.counterparties[key].displayName;
}

function deadlineOf(state: TrancheState, clockPaused: boolean, at: number): DeadlineView | null {
  if (state.status === 'frozen') {
    const kind = DEADLINE_KIND[state.suspendedFrom];
    if (kind === null) return null;
    return {
      at: null,
      remainingMs: state.remaining,
      kind,
      paused: true,
      pauseReasonKey: 'deadline.paused.compliance',
    };
  }
  if (!('deadline' in state)) return null;
  const kind = DEADLINE_KIND[state.status];
  if (kind === null) return null;
  if (clockPaused) {
    return {
      at: null,
      remainingMs: Math.max(0, state.deadline.at - at),
      kind,
      paused: true,
      pauseReasonKey: 'deadline.paused.registry',
    };
  }
  return { at: state.deadline.at, remainingMs: null, kind, paused: false, pauseReasonKey: null };
}

interface BuiltDeal {
  readonly snapshot: DealSnapshot;
  readonly journal: Journal;
  readonly scenario: Scenario;
}

function build(scenario: Scenario): BuiltDeal {
  const payer = scenario.role === 'paying' ? VIEWER : counterpartyRef(scenario.counterparty);
  const recipient = scenario.role === 'paying' ? counterpartyRef(scenario.counterparty) : VIEWER;
  const required: Money<CurrencyCode> = money('GEL', scenario.requiredMinor);
  const trancheId = `${scenario.id}-t1`;
  const run = runScenario({
    dealId: scenario.id,
    trancheId,
    payer,
    recipient,
    required,
    steps: scenario.steps,
    overrides: scenario.overrides,
    refundDispatched: scenario.payment.refundDispatched,
  });

  const lockedAccount = clientLockedAccount(clientKey(payer.accountKey), scenario.id, trancheId);
  const locked = accountBalance(run.journal, lockedAccount, 'GEL');
  const credited = run.creditedTotal;
  const foreign = accountBalance(run.journal, clientFreeAccount(clientKey(payer.accountKey)), 'USD');

  const moneyState = projectMoneyState({
    trancheStatus: run.tranche.status,
    dealStatus: run.deal.status,
    payoutStatus: run.payout === null ? null : run.payout.status,
    requiredMinor: required.minor,
    collectedMinor: run.collected.minor,
    creditedMinor: credited.minor + locked.minor,
    payment: scenario.payment,
  });

  const fee = platformFee(required);
  const reservedMark = run.marks.find((mark) => mark.status === 'reserved');
  const withUs: Money<CurrencyCode> = money('GEL', credited.minor + locked.minor);
  const shortfall = subtract(required, withUs);
  const excess = subtract(withUs, required);

  const snapshot: DealSnapshot = {
    id: scenario.id,
    ref: scenario.ref,
    role: scenario.role,
    moneyState,
    moneyStateCode: MONEY_STATE_CODE[moneyState],
    tone: MONEY_STATE_TONE[moneyState],
    trancheStatus: run.tranche.status,
    dealStatus: run.deal.status,
    payoutStatus: run.payout === null ? null : run.payout.status,
    assurance: projectAssuranceLevel(moneyState),
    property: propertyView(scenario.property),
    counterpartyName: counterpartyName(scenario.counterparty),
    dealCurrency: required.currency,
    conversion: conversionOf(scenario.id, required),
    required,
    credited,
    locked,
    fee,
    payeeReceives: subtract(required, fee),
    excess: moneyState === 'overfunded' && isPositive(excess) ? excess : null,
    shortfall: moneyState === 'partiallyFunded' && isPositive(shortfall) ? shortfall : null,
    foreignBalance: isPositive(foreign) ? foreign : null,
    deadline: deadlineOf(run.tranche, scenario.modifiers.clockPaused, FIXTURE_NOW),
    reservedAt: reservedMark === undefined ? null : reservedMark.at,
    confirmationNo: scenario.confirmationNo,
    payment: scenario.payment,
    modifiers: scenario.modifiers,
    marks: run.marks,
    applicationId: run.deal.status === 'filed' || run.deal.status === 'settling' ? 'REG-2026-44810' : null,
    counterpartyVerified: true,
  };

  return { snapshot, journal: run.journal, scenario };
}

const BUILT: readonly BuiltDeal[] = SCENARIOS.map(build);

/** Один журнал на весь мир фикстур: покрытие считается по нему целиком. */
const WORLD_JOURNAL: Journal = BUILT.reduce(
  (journal, item) => appendEntries(journal, item.journal.entries),
  emptyJournal,
);

export function now(): number {
  return FIXTURE_NOW;
}

export function viewerTimeZone(): string {
  return FIXTURE_DATA.viewer.deviceTimeZone;
}

export function viewerName(): string {
  return FIXTURE_DATA.viewer.displayName;
}

/** Карточка клиента в панели: имя, почта и инициалы — данные, а не текст. */
export function viewerCard(): { readonly name: string; readonly email: string; readonly initials: string } {
  const name = FIXTURE_DATA.viewer.displayName;
  const initials = name
    .split(' ')
    .map((part) => part.slice(0, 1))
    .join('')
    .slice(0, 2);
  return { name, email: FIXTURE_DATA.viewer.email, initials };
}

export function verifyUrl(): string {
  return FIXTURE_DATA.site.verifyUrl;
}

export async function listDeals(): Promise<readonly DealSnapshot[]> {
  // Порядок — по срочности: сначала то, у чего срок ближе, затем по сумме.
  return [...BUILT.map((item) => item.snapshot)].sort((left, right) => {
    const leftAt = left.deadline?.at ?? Number.MAX_SAFE_INTEGER;
    const rightAt = right.deadline?.at ?? Number.MAX_SAFE_INTEGER;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return Number(right.required.minor - left.required.minor);
  });
}

export async function getDeal(id: string): Promise<DealSnapshot | null> {
  return BUILT.find((item) => item.snapshot.id === id)?.snapshot ?? null;
}

export interface LockedPart {
  readonly dealId: string;
  readonly dealRef: string;
  readonly amount: Money<CurrencyCode>;
  readonly deadline: DeadlineView | null;
  readonly address: string;
}

/**
 * Остаток в одной валюте. Валют несколько, и они **не суммируются**: единой
 * суммы «всего у вас» не существует, показывать её было бы вымыслом
 * (`IMPLEMENTATION.md` §3). Поэтому здесь список, а не итог.
 */
export interface CurrencyBalance {
  readonly currency: CurrencyCode;
  readonly free: Money<CurrencyCode>;
  readonly locked: Money<CurrencyCode>;
}

export interface AccountView {
  readonly balances: readonly CurrencyBalance[];
  readonly free: Money<CurrencyCode>;
  readonly freeForeign: Money<CurrencyCode> | null;
  readonly lockedTotal: Money<CurrencyCode>;
  readonly lockedParts: readonly LockedPart[];
  readonly records: readonly AccountRecord[];
  readonly withdrawState: WithdrawState;
  readonly sourceAccountMasked: string;
  readonly sourceBank: string;
}

export interface AccountRecord {
  readonly id: string;
  readonly at: number;
  readonly memoKey: string;
  readonly amount: Money<CurrencyCode>;
  readonly dealId: string | null;
  readonly dealRef: string | null;
}

/** Состояния кнопки вывода `W-01…W-07` (`SCREENS.md` §3.5). */
export type WithdrawState = 'W-01' | 'W-02' | 'W-03' | 'W-04' | 'W-05' | 'W-06';

const MEMO_LABEL: Readonly<Record<string, string>> = Object.freeze({
  'ledger.entry.client_top_up': 'account.op.topup',
  'ledger.entry.locked_for_tranche': 'account.op.reserve',
  'ledger.entry.unlocked_to_client': 'account.op.unreserve',
  'ledger.entry.tranche_settled': 'account.op.settle',
  'ledger.entry.refund_to_source': 'account.op.withdraw',
  'ledger.entry.suspense_identified': 'account.op.identified',
});

export async function getAccount(): Promise<AccountView> {
  const owner = clientKey(VIEWER.accountKey);
  const free = accountBalance(WORLD_JOURNAL, clientFreeAccount(owner), 'GEL');
  const freeForeign = accountBalance(WORLD_JOURNAL, clientFreeAccount(owner), 'USD');

  const lockedParts: LockedPart[] = [];
  for (const item of BUILT) {
    if (item.snapshot.role !== 'paying') continue;
    if (!isPositive(item.snapshot.locked)) continue;
    lockedParts.push({
      dealId: item.snapshot.id,
      dealRef: item.snapshot.ref,
      amount: item.snapshot.locked,
      deadline: item.snapshot.deadline,
      address: item.snapshot.property.address,
    });
  }
  const lockedTotal = money(
    'GEL',
    lockedParts.reduce((total, part) => total + part.amount.minor, 0n),
  );

  const records: AccountRecord[] = [];
  for (const item of BUILT) {
    for (const entry of item.journal.entries) {
      const touchesViewer = entry.postings.some((posting) => {
        const attribution = posting.attribution;
        if (attribution === null) return false;
        return 'clientKey' in attribution
          ? attribution.clientKey === owner
          : item.snapshot.role === 'paying';
      });
      if (!touchesViewer) continue;
      // Движение показывается по **своему** счёту клиента, а не по первой
      // попавшейся клиентской проводке записи. У расчёта их две — дебет
      // запертой части плательщика и кредит свободной части получателя, — и
      // выбор первой давал получателю расчёт со знаком минус: он видел, как у
      // него списывают деньги, которые ему пришли.
      const own = entry.postings.filter(
        (posting) => clientAccountOwner(posting.account) === owner,
      );
      // Свободная часть важнее запертой: экран показывает доступный остаток, а
      // запирание объясняет, куда он делся.
      const signed =
        own.find((posting) => posting.account.kind === 'client_free') ?? own[0];
      if (signed === undefined) continue;
      const direction = signed.direction === 'credit' ? 1n : -1n;
      records.push({
        id: entry.id,
        at: Date.parse(entry.occurredAt),
        memoKey: MEMO_LABEL[entry.memoKey] ?? 'account.op.other',
        amount: money(signed.amount.currency, signed.amount.minor * direction),
        dealId: item.snapshot.id,
        dealRef: item.snapshot.ref,
      });
    }
  }
  records.sort((left, right) => right.at - left.at);

  const withdrawState: WithdrawState = isPositive(lockedTotal)
    ? isPositive(free)
      ? 'W-02'
      : 'W-03'
    : isPositive(free)
      ? 'W-01'
      : 'W-04';

  // Валюта сделки — одна из трёх, у каждой свой счёт номинального держания и
  // своя сверка. Строка показывается, даже когда остаток нулевой: отсутствие
  // строки читается как «такой валюты у вас нет», а счёт есть.
  const balances: CurrencyBalance[] = (['GEL', 'USD', 'EUR'] as const).map((currency) => ({
    currency,
    free: accountBalance(WORLD_JOURNAL, clientFreeAccount(owner), currency),
    locked: money(
      currency,
      lockedParts
        .filter((part) => part.amount.currency === currency)
        .reduce((total, part) => total + part.amount.minor, 0n),
    ),
  }));

  return {
    balances,
    free,
    freeForeign: isPositive(freeForeign) ? freeForeign : null,
    lockedTotal,
    lockedParts,
    records: records.slice(0, 14),
    withdrawState,
    sourceAccountMasked: FIXTURE_DATA.viewer.sourceAccountMasked,
    sourceBank: FIXTURE_DATA.viewer.sourceBank,
  };
}

/** Состояния периметра реквизитов `P-01…P-12` (`SCREENS.md` §4.2). */
export const PERIMETER_STATES = [
  'P-01',
  'P-03',
  'P-04',
  'P-06',
  'P-07',
  'P-09',
  'P-10',
] as const;

export type PerimeterState = (typeof PERIMETER_STATES)[number];

export interface RequisitesView {
  readonly state: PerimeterState;
  readonly holderName: string;
  readonly ibanMasked: string;
  readonly bank: string;
  readonly verifiedAt: number;
  readonly lockedByDealRef: string | null;
  readonly coolingUntil: number | null;
  readonly releaseAt: number | null;
  readonly attemptsLeft: number;
  readonly history: readonly RequisitesHistoryItem[];
}

export interface RequisitesHistoryItem {
  readonly at: number;
  readonly changeKey: string;
  readonly actorKey: string;
  readonly confirmationKey: string;
}

export async function getRequisites(state: PerimeterState): Promise<RequisitesView> {
  const reservedDeal = BUILT.find((item) => item.snapshot.id === 'r03');
  return {
    state,
    holderName: FIXTURE_DATA.viewer.payoutHolderName,
    ibanMasked: FIXTURE_DATA.viewer.payoutIbanMasked,
    bank: FIXTURE_DATA.viewer.payoutBank,
    verifiedAt: FIXTURE_NOW - 9 * 24 * 60 * 60 * 1000,
    lockedByDealRef: reservedDeal?.snapshot.ref ?? null,
    coolingUntil: state === 'P-09' ? FIXTURE_NOW + 31 * 60 * 60 * 1000 : null,
    releaseAt: reservedDeal?.snapshot.deadline?.at ?? null,
    attemptsLeft: 2,
    history: [
      {
        at: FIXTURE_NOW - 9 * 24 * 60 * 60 * 1000,
        changeKey: 'requisites.history.added',
        actorKey: 'requisites.history.actor.self',
        confirmationKey: 'requisites.history.confirm.test',
      },
      {
        at: FIXTURE_NOW - 8 * 24 * 60 * 60 * 1000,
        changeKey: 'requisites.history.verified',
        actorKey: 'requisites.history.actor.platform',
        confirmationKey: 'requisites.history.confirm.code',
      },
    ],
  };
}

/**
 * Виды задач консоли.
 *
 * Восемь первых пришли из `SCREENS.md` §5.1 — и покрывали ровно четыре вида
 * разбора из тринадцати, объявленных в коде (`REVIEW_TASK_KINDS`,
 * `packages/compliance/src/queue.ts`). Девять остальных существовали в домене
 * комплаенса и приёма и **не имели в интерфейсе места вовсе**: оператор
 * физически не мог их увидеть. У недоплаты это прямое расхождение с
 * требованием — `INTAKE.md` И2.1, критерий 3: «оператор видит задачу».
 *
 * Порядок перечисления — порядок появления, а не важности: важность считает
 * очередь по сроку и сумме, а не человек глазами.
 */
export const TASK_TYPES = [
  'verifyClient',
  'reviewSof',
  'reviewSanction',
  'matchPayment',
  'confirmRegistration',
  'approvePayout',
  'reviewBreak',
  'releaseBlock',
  'sanctionsUnavailable',
  'payerException',
  'priceMismatch',
  'structuring',
  'linkage',
  'flipping',
  'relatedParties',
  'beneficiaryChange',
  'intakeUnderpayment',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/**
 * Вид разбора из кода — тот же тип, что возвращает маршрутизация приёма
 * (`queueTask`, `packages/intake/src/route.ts`). Пакет `@sdelka/compliance` в
 * зависимостях приложения не значится, и добавлять его сюда незачем: тип
 * доезжает через `@sdelka/intake`, зато доезжает **типом**, а не списком строк.
 * Новый вид разбора в `REVIEW_TASK_KINDS` теперь ломает сборку интерфейса, а не
 * тихо остаётся невидимым для оператора.
 */
type ReviewTaskKind = NonNullable<IntakeRouting['queueTask']>;

/**
 * Какому виду разбора отвечает вид задачи. `null` — задача не из очереди
 * комплаенса: проверка личности живёт в `packages/compliance/src/identity.ts`,
 * подтверждение регистрации — в `packages/oracle`, утверждение выплаты и разбор
 * расхождения — в домене и сверке. Ставить им выдуманный вид разбора было бы
 * враньём в обратную сторону.
 */
const REVIEW_KIND_OF = Object.freeze({
  verifyClient: null,
  reviewSof: 'source_of_funds',
  reviewSanction: 'sanctions_possible_match',
  matchPayment: 'intake_unmatched',
  confirmRegistration: null,
  approvePayout: null,
  reviewBreak: null,
  releaseBlock: 'payer_hold',
  sanctionsUnavailable: 'sanctions_unavailable',
  payerException: 'payer_exception',
  priceMismatch: 'price_mismatch',
  structuring: 'structuring',
  linkage: 'linkage',
  flipping: 'flipping',
  relatedParties: 'related_parties',
  beneficiaryChange: 'beneficiary_change',
  intakeUnderpayment: 'intake_underpayment',
} as const) satisfies Readonly<Record<TaskType, ReviewTaskKind | null>>;

export function reviewKindOf(type: TaskType): ReviewTaskKind | null {
  return REVIEW_KIND_OF[type];
}

type PlacedReviewKind = NonNullable<(typeof REVIEW_KIND_OF)[TaskType]>;

/**
 * Не значение, а утверждение компилятору: **каждый** вид разбора из кода имеет
 * место в очереди. Приём тот же, что у `EXCEPTIONS_ARE_EXACTLY_AS_DOCUMENTED`
 * в `packages/compliance/src/detectors/payer.ts`: перечень закрыт не обещанием,
 * а сборкой.
 */
export const EVERY_REVIEW_KIND_HAS_A_PLACE: [ReviewTaskKind] extends [PlacedReviewKind]
  ? true
  : never = true;

/**
 * Факт разбора — строка карточки, которую оператор читает перед решением.
 *
 * Размеченное объединение, а не «метка и строка»: число, сумма, момент и срок
 * форматируются локалью по-разному, и склеенная заранее строка ломает и
 * грузинский формат, и правило «никаких сумм в плавающей точке». Через границу
 * сервер → клиент едут только данные и ключи — ни одной функции.
 */
export type CaseFact =
  /** Значение — из словаря: перечень закрыт, строка не сочиняется на месте. */
  | { readonly kind: 'phrase'; readonly labelKey: string; readonly valueKey: string }
  /** Идентификатор, ссылка, маскированный счёт: данные, а не текст. */
  | { readonly kind: 'code'; readonly labelKey: string; readonly value: string }
  | { readonly kind: 'money'; readonly labelKey: string; readonly value: Money<CurrencyCode> }
  /** Разница: со знаком, иначе «меньше на» и «больше на» неразличимы. */
  | { readonly kind: 'delta'; readonly labelKey: string; readonly value: Money<CurrencyCode> }
  | { readonly kind: 'moment'; readonly labelKey: string; readonly at: number }
  | { readonly kind: 'span'; readonly labelKey: string; readonly ms: number }
  | { readonly kind: 'count'; readonly labelKey: string; readonly value: number }
  /** Доля целыми базисными пунктами: плавающей точки в долях тоже нет. */
  | { readonly kind: 'share'; readonly labelKey: string; readonly bp: number }
  /** Условие проверки: пройдено или нет, цветом и словом сразу. */
  | { readonly kind: 'signal'; readonly labelKey: string; readonly tone: StateTone; readonly textKey: string };

export interface OpsTask {
  readonly id: string;
  readonly type: TaskType;
  /** Положение денег по сделке: третий текст состояния — операторский. */
  readonly moneyState: MoneyState;
  readonly dealId: string;
  readonly dealRef: string;
  readonly address: string;
  /**
   * Сумма ранжирования — **в валюте сделки**, и только в ней.
   *
   * Тот же смысл, что у `rankAmount` в `packages/compliance/src/queue.ts`:
   * очередь сортирует по одной шкале, а пересчёт по официальному курсу делает
   * вызывающий. Величины в других валютах (перевод, цена договора, недостача)
   * живут в `facts` со своей валютой и не складываются ни с чем.
   */
  readonly amount: Money<CurrencyCode>;
  readonly deadline: DeadlineView | null;
  readonly ageMs: number;
  readonly claimedBy: string | null;
  readonly blockedReasonKey: string | null;
  /** Материал разбора. Пусто — у вида задачи тела разбора в этом слое нет. */
  readonly facts: readonly CaseFact[];
}

const NO_FACTS: readonly CaseFact[] = Object.freeze([]);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Задачи, которые из положения денег не выводятся: они живут в комплаенсе и в
 * реквизитах выплаты, а этого слоя в фикстурах нет. Заданы явно и по одному
 * правдоподобному примеру на вид — молчаливое отсутствие вида читается как
 * «такого в очереди не бывает».
 *
 * Факты каждого примера собраны из тех же величин, что живут в учёте: целые
 * минорные единицы, валюта при каждой сумме, доли — базисными пунктами. Ни
 * одного правила здесь не введено: пороги, лестницы исходов и перечни причин
 * лежат в пакетах, а тут только пример, на котором рамку видно.
 */
const SEEDED_TASKS: readonly { readonly dealId: string; readonly type: TaskType; readonly facts: readonly CaseFact[] }[] = [
  { dealId: 'r01', type: 'verifyClient', facts: NO_FACTS },
  { dealId: 'm04', type: 'reviewSof', facts: NO_FACTS },
  {
    /* Провайдер скрининга не ответил. `decideSanctions` отвечает `unavailable`,
       а не пустым списком кандидатов, и лестница переводит это в удержание, а
       не в «чисто» (`packages/compliance/src/screening.ts`, fail-closed). */
    dealId: 'm09',
    type: 'sanctionsUnavailable',
    facts: Object.freeze([
      { kind: 'phrase', labelKey: 'ops.fact.subject', valueKey: 'ops.fact.value.subject.recipient' },
      { kind: 'code', labelKey: 'ops.fact.provider', value: 'screening-provider-1' },
      { kind: 'moment', labelKey: 'ops.fact.requestedAt', at: FIXTURE_NOW - 3 * HOUR },
      { kind: 'signal', labelKey: 'ops.fact.response', tone: 'danger', textKey: 'ops.fact.value.providerUnavailable' },
      { kind: 'phrase', labelKey: 'ops.fact.route', valueKey: 'ops.fact.value.hold' },
    ] as const),
  },
  {
    /* Исключение по плательщику: супруг, документ проверен, проверка стороны
       завершена. `assessPayer` отвечает `review` и `exceptionApplied`, маршрут —
       на счёт клиента (`packages/intake/src/route.ts`). Перевод пришёл в валюте,
       отличной от валюты сделки: сумма стоит в своей валюте и ни с чем не
       складывается — единой суммы «всего по задаче» не существует. */
    dealId: 'm06',
    type: 'payerException',
    facts: Object.freeze([
      { kind: 'phrase', labelKey: 'ops.fact.relationship', valueKey: 'ops.fact.value.relationship.spouse' },
      { kind: 'signal', labelKey: 'ops.fact.kinshipProof', tone: 'ok', textKey: 'ops.fact.value.verified' },
      { kind: 'signal', labelKey: 'ops.fact.payerKyc', tone: 'ok', textKey: 'ops.fact.value.complete' },
      { kind: 'money', labelKey: 'ops.fact.transfer', value: money('USD', 8_084_560n) },
      { kind: 'phrase', labelKey: 'ops.fact.route', valueKey: 'ops.fact.value.toClientAccount' },
    ] as const),
  },
  {
    /* Расхождение цены: сумма через платформу ниже цены договора.
       Сравниваются две **заявленные** величины, а не полученная с отправленной,
       поэтому задача существует до всякого поступления — здесь она стоит на
       сделке, по которой деньги ещё не пришли. Доля считается с округлением
       вверх: на границе допуска решение принимается в строгую сторону
       (`packages/compliance/src/detectors/price.ts:41`). */
    dealId: 'm01',
    type: 'priceMismatch',
    facts: Object.freeze([
      { kind: 'money', labelKey: 'ops.fact.contractPrice', value: money('GEL', 24_000_000n) },
      { kind: 'money', labelKey: 'ops.fact.platformAmount', value: money('GEL', 21_700_000n) },
      { kind: 'delta', labelKey: 'ops.fact.delta', value: money('GEL', -2_300_000n) },
      { kind: 'share', labelKey: 'ops.fact.deltaShare', bp: 959 },
      { kind: 'signal', labelKey: 'ops.fact.secondAmount', tone: 'ok', textKey: 'ops.fact.value.notRequested' },
    ] as const),
  },
  {
    /* Разбиение платежа: три поступления одного плательщика в одном окне, каждое
       под порогом, вместе — выше (`findStructuringClusters`). Исход `review`:
       операция продолжается, деньги не удерживаются. */
    dealId: 'm08',
    type: 'structuring',
    facts: Object.freeze([
      { kind: 'count', labelKey: 'ops.fact.payments', value: 3 },
      { kind: 'span', labelKey: 'ops.fact.window', ms: 72 * HOUR },
      { kind: 'money', labelKey: 'ops.fact.clusterTotal', value: money('GEL', 22_450_000n) },
      { kind: 'money', labelKey: 'ops.fact.threshold', value: money('GEL', 7_600_000n) },
      { kind: 'phrase', labelKey: 'ops.fact.route', valueKey: 'ops.fact.value.toClientAccount' },
    ] as const),
  },
  {
    /* Связанность сторон по общему признаку. Общий счёт — единственный признак,
       который `assessLinkage` поднимает до удержания; остальные дают разбор. */
    dealId: 'm02',
    type: 'linkage',
    facts: Object.freeze([
      { kind: 'phrase', labelKey: 'ops.fact.signal', valueKey: 'ops.fact.value.signal.account' },
      { kind: 'count', labelKey: 'ops.fact.parties', value: 2 },
      { kind: 'signal', labelKey: 'ops.fact.declaredRelation', tone: 'danger', textKey: 'ops.fact.value.notDeclared' },
      { kind: 'phrase', labelKey: 'ops.fact.route', valueKey: 'ops.fact.value.hold' },
    ] as const),
  },
  {
    /* Быстрая перепродажа: переход того же объекта внутри окна плюс скачок цены.
       Скачок считается к цене прошлого перехода в базисных пунктах
       (`packages/compliance/src/detectors/flipping.ts`). */
    dealId: 'r02',
    type: 'flipping',
    facts: Object.freeze([
      { kind: 'moment', labelKey: 'ops.fact.lastTransfer', at: FIXTURE_NOW - 41 * DAY },
      { kind: 'span', labelKey: 'ops.fact.sinceTransfer', ms: 41 * DAY },
      { kind: 'money', labelKey: 'ops.fact.previousPrice', value: money('GEL', 16_800_000n) },
      { kind: 'money', labelKey: 'ops.fact.currentPrice', value: money('GEL', 18_900_000n) },
      { kind: 'share', labelKey: 'ops.fact.priceJump', bp: 1_250 },
    ] as const),
  },
  {
    /* Связанные лица по обе стороны одной сделки — усиленная проверка, не отказ
       (И6.4). Отказ здесь ровно один и он про другое: один и тот же ключ
       личности по обе стороны (`selfDealingPairs`). */
    dealId: 'r03',
    type: 'relatedParties',
    facts: Object.freeze([
      { kind: 'phrase', labelKey: 'ops.fact.relation', valueKey: 'ops.fact.value.relation.parent' },
      { kind: 'signal', labelKey: 'ops.fact.proof', tone: 'danger', textKey: 'ops.fact.value.missing' },
      { kind: 'signal', labelKey: 'ops.fact.sameIdentity', tone: 'ok', textKey: 'ops.fact.value.no' },
      { kind: 'phrase', labelKey: 'ops.fact.route', valueKey: 'ops.fact.value.enhancedCheck' },
    ] as const),
  },
  {
    /* Изменение реквизитов выплаты: заявка в охлаждении, повторная проверка
       владельца ещё не пройдена. Четыре условия применения проверяются вместе,
       и окно релиза — повторно на момент применения
       (`packages/compliance/src/beneficiary.ts`). */
    dealId: 'r07',
    type: 'beneficiaryChange',
    facts: Object.freeze([
      { kind: 'moment', labelKey: 'ops.fact.requestedAt', at: FIXTURE_NOW - 20 * HOUR },
      { kind: 'code', labelKey: 'ops.fact.proposedIban', value: 'GE** **** **** **41' },
      { kind: 'signal', labelKey: 'ops.fact.reverification', tone: 'danger', textKey: 'ops.fact.value.missing' },
      { kind: 'span', labelKey: 'ops.fact.coolingLeft', ms: 28 * HOUR },
      { kind: 'count', labelKey: 'ops.decision.fourEyes.approvals', value: 1 },
    ] as const),
  },
];

/**
 * Вид задачи по положению денег.
 *
 * `partiallyFunded` попал сюда не как новая проекция, а как исправление: транш
 * остаётся в `collecting`, стороне показана недостающая сумма, и `INTAKE.md`
 * (И2.1, критерий 3) требует, чтобы задачу видел и оператор. Он её не видел.
 */
function taskTypeOf(snapshot: DealSnapshot): TaskType | null {
  switch (snapshot.moneyState) {
    case 'unidentified':
      return 'matchPayment';
    case 'submitted':
      return 'confirmRegistration';
    case 'releasePending':
      return 'approvePayout';
    case 'payoutUnknown':
      return 'reviewBreak';
    case 'frozen':
      return 'reviewSanction';
    case 'heldThirdParty':
      return 'releaseBlock';
    case 'partiallyFunded':
      return 'intakeUnderpayment';
    default:
      return null;
  }
}

/**
 * Факты недоплаты берутся не из таблицы, а из учёта: требуемое, накопленное и
 * разница — те же величины, которыми считается положение денег. Допуск показан
 * отдельной строкой и равен нулю, потому что без факта раскрытия он равен нулю
 * (`INTAKE.md` §3.3), а причина недостачи — «неизвестна», и при неизвестной
 * причине допуск не применяется вовсе (§3.5, отказ закрытый).
 */
function derivedFacts(snapshot: DealSnapshot, type: TaskType): readonly CaseFact[] {
  if (type !== 'intakeUnderpayment') return NO_FACTS;
  const currency = snapshot.required.currency;
  const received = money(currency, snapshot.credited.minor + snapshot.locked.minor);
  const shortfall = snapshot.shortfall ?? money(currency, snapshot.required.minor - received.minor);
  return Object.freeze([
    { kind: 'money', labelKey: 'ops.fact.required', value: snapshot.required },
    { kind: 'money', labelKey: 'ops.fact.received', value: received },
    { kind: 'money', labelKey: 'ops.fact.shortfall', value: shortfall },
    { kind: 'money', labelKey: 'ops.fact.tolerance', value: money(currency, 0n) },
    { kind: 'phrase', labelKey: 'ops.fact.shortfallCause', valueKey: 'ops.fact.value.cause.unknown' },
  ] as const);
}

export interface OpsView {
  readonly tasks: readonly OpsTask[];
  readonly coverage: readonly CoverageByCurrency[];
  readonly liveDeals: number;
  readonly withoutDeadline: number;
  /** Доля сделок, прошедших без человека: консоль — стол исключений. */
  readonly automatedShare: number;
  readonly automatedOf: number;
  readonly automatedTotal: number;
  /** Мест, где человек обязателен: `release_blocked`, второе утверждение, разморозка. */
  readonly humanRequired: number;
}

export async function getOpsQueue(): Promise<OpsView> {
  const tasks: OpsTask[] = [];
  for (const item of BUILT) {
    const snapshot = item.snapshot;
    const derived = taskTypeOf(snapshot);
    const seeded = SEEDED_TASKS.filter((task) => task.dealId === snapshot.id);
    const entries: { readonly type: TaskType; readonly facts: readonly CaseFact[] }[] =
      derived === null ? [] : [{ type: derived, facts: derivedFacts(snapshot, derived) }];
    for (const task of seeded) entries.push({ type: task.type, facts: task.facts });
    for (const entry of entries) {
      tasks.push({
        id: `${snapshot.id}-${entry.type}`,
        type: entry.type,
        moneyState: snapshot.moneyState,
        dealId: snapshot.id,
        dealRef: snapshot.ref,
        address: snapshot.property.addressLatin,
        amount: snapshot.required,
        deadline: snapshot.deadline,
        ageMs: FIXTURE_NOW - (snapshot.marks.at(-1)?.at ?? FIXTURE_NOW),
        claimedBy: entry.type === 'confirmRegistration' ? 'operator-2' : null,
        blockedReasonKey: entry.type === 'approvePayout' ? 'ops.task.blocked.samePreparer' : null,
        facts: entry.facts,
      });
    }
  }
  tasks.sort((left, right) => {
    const leftAt = left.deadline?.at ?? Number.MAX_SAFE_INTEGER;
    const rightAt = right.deadline?.at ?? Number.MAX_SAFE_INTEGER;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return Number(right.amount.minor - left.amount.minor);
  });

  const live = BUILT.filter((item) => !isTerminalTrancheStatus(item.snapshot.trancheStatus));
  return {
    tasks,
    coverage: coverage(WORLD_JOURNAL),
    liveDeals: live.length,
    withoutDeadline: live.filter((item) => item.snapshot.deadline === null).length,
    automatedShare: 24 / 29,
    automatedOf: 24,
    automatedTotal: 29,
    humanRequired: 3,
  };
}

export function worldJournal(): Journal {
  return WORLD_JOURNAL;
}
