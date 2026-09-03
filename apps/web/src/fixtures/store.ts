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

export interface AccountView {
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

  return {
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

/** Восемь типов задач консоли (`SCREENS.md` §5.1). */
export const TASK_TYPES = [
  'verifyClient',
  'reviewSof',
  'reviewSanction',
  'matchPayment',
  'confirmRegistration',
  'approvePayout',
  'reviewBreak',
  'releaseBlock',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export interface OpsTask {
  readonly id: string;
  readonly type: TaskType;
  readonly dealId: string;
  readonly dealRef: string;
  readonly address: string;
  readonly amount: Money<CurrencyCode>;
  readonly deadline: DeadlineView | null;
  readonly ageMs: number;
  readonly claimedBy: string | null;
  readonly blockedReasonKey: string | null;
}

/**
 * Две задачи из восьми не выводятся из положения денег: проверка клиента и
 * разбор источника средств живут в комплаенсе, которого в этом слое нет.
 * Поэтому они заданы явно и помечены — молчаливое отсутствие двух типов из
 * восьми выглядело бы как «в очереди их не бывает».
 */
const COMPLIANCE_TASKS: readonly { readonly dealId: string; readonly type: TaskType }[] = [
  { dealId: 'r01', type: 'verifyClient' },
  { dealId: 'm04', type: 'reviewSof' },
];

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
    default:
      return null;
  }
}

export interface OpsView {
  readonly tasks: readonly OpsTask[];
  readonly coverage: readonly CoverageByCurrency[];
  readonly liveDeals: number;
  readonly withoutDeadline: number;
}

export async function getOpsQueue(): Promise<OpsView> {
  const tasks: OpsTask[] = [];
  for (const item of BUILT) {
    const snapshot = item.snapshot;
    const derived = taskTypeOf(snapshot);
    const extra = COMPLIANCE_TASKS.filter((task) => task.dealId === snapshot.id).map((task) => task.type);
    const types = derived === null ? extra : [derived, ...extra];
    for (const type of types) {
      tasks.push({
        id: `${snapshot.id}-${type}`,
        type,
        dealId: snapshot.id,
        dealRef: snapshot.ref,
        address: snapshot.property.addressLatin,
        amount: snapshot.required,
        deadline: snapshot.deadline,
        ageMs: FIXTURE_NOW - (snapshot.marks.at(-1)?.at ?? FIXTURE_NOW),
        claimedBy: type === 'confirmRegistration' ? 'operator-2' : null,
        blockedReasonKey: type === 'approvePayout' ? 'ops.task.blocked.samePreparer' : null,
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
  };
}

export function worldJournal(): Journal {
  return WORLD_JOURNAL;
}
