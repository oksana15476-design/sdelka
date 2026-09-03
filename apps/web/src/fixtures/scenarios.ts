import type { PartyRef } from '@sdelka/domain';
import type { MoneyState, PaymentFacts, StateModifiers } from '@/view/money-state';
import type { FactOverrides, Step } from './engine';
import data from './data.json';

export type PropertyKey = keyof typeof data.properties;
export type CounterpartyKey = keyof typeof data.counterparties;

/** Роль — свойство сделки, а не состояние интерфейса (`CABINETS.md` §4). */
export type DealRole = 'paying' | 'receiving';

export interface Scenario {
  readonly id: string;
  /** Внешний номер сделки: показывается как данные, не переводится. */
  readonly ref: string;
  readonly role: DealRole;
  readonly property: PropertyKey;
  readonly counterparty: CounterpartyKey;
  readonly requiredMinor: bigint;
  readonly steps: readonly Step[];
  readonly payment: PaymentFacts;
  readonly modifiers: StateModifiers;
  readonly overrides: FactOverrides;
  /** Ожидаемое положение денег: сверяется тестом, а не декларируется. */
  readonly expect: MoneyState;
  /** Номер подтверждения резервирования, если оно выдано. */
  readonly confirmationNo: string | null;
}

export const VIEWER: PartyRef = {
  partyId: data.viewer.partyId,
  accountKey: data.viewer.accountKey,
};

export function counterpartyRef(key: CounterpartyKey): PartyRef {
  const item = data.counterparties[key];
  return { partyId: item.partyId, accountKey: item.accountKey };
}

const NO_PAYMENT_FACTS: PaymentFacts = Object.freeze({
  transferDeclared: false,
  unidentified: false,
  awaitingConversion: false,
  refundDispatched: false,
  refundArrived: false,
});

const NO_MODIFIERS: StateModifiers = Object.freeze({
  clockPaused: false,
  quoteExpired: false,
  requisitesLocked: false,
  requisitesCooling: false,
  coverageBreach: false,
});

const BASE_OVERRIDES: FactOverrides = Object.freeze({
  beneficiaryLocked: true,
  beneficiaryChangedHoursAgo: 240,
  senderName: 'Mark Weiss',
  registryOwnerIsBuyer: true,
  mismatchResolved: true,
  sourceAccountKnown: true,
  coverageOk: true,
});

const GEL = 'GEL' as const;

function payment(hoursAgo: number, minor: bigint, currency: 'GEL' | 'USD' = GEL): Step {
  return { k: 'payment', hoursAgo, minor, currency };
}

function tranche(hoursAgo: number, event: Step extends never ? never : Extract<Step, { k: 'tranche' }>['event']): Step {
  return { k: 'tranche', hoursAgo, event };
}

function deal(hoursAgo: number, event: Extract<Step, { k: 'deal' }>['event']): Step {
  return { k: 'deal', hoursAgo, event };
}

const AMOUNT = 21_700_000n;

/** Начало пути: инструкции выданы, деньги ещё не пришли. */
function opened(hoursAgo: number): readonly Step[] {
  return [tranche(hoursAgo, { type: 'instructions_issued' })];
}

/** Деньги пришли и приняты под транш. */
function funded(paidAgo: number, minor: bigint, credited = minor): readonly Step[] {
  return [
    payment(paidAgo, credited),
    tranche(paidAgo, {
      type: 'funds_received',
      amount: { currency: GEL, minor },
      sender: 'Mark Weiss',
      reference: data.bank.payinReference,
    }),
    deal(paidAgo, { type: 'funds_received' }),
  ];
}

/** Средства зарезервированы под сделку. */
function reserved(hoursAgo: number): readonly Step[] {
  return [
    tranche(hoursAgo, { type: 'reserve_requested' }),
    deal(hoursAgo, { type: 'tranches_reserved' }),
  ];
}

/** Документы поданы на регистрацию. */
function filed(hoursAgo: number): readonly Step[] {
  return [deal(hoursAgo, { type: 'filing_registered', applicationId: 'REG-2026-44810' })];
}

/** Условие расчёта подтверждено реестром. */
function conditionMet(hoursAgo: number): readonly Step[] {
  return [
    tranche(hoursAgo, {
      type: 'condition_established',
      evidenceBundleId: 'evidence-2026-09',
      conditionType: 'registration_transfer',
    }),
    deal(hoursAgo, { type: 'condition_established', conditionType: 'registration_transfer' }),
  ];
}

function scenario(base: Scenario): Scenario {
  return Object.freeze(base);
}

/**
 * Восемнадцать положений денег из `SCREENS.md` §2.2 — по фикстуре на каждое.
 * Ни одно не собрано руками: каждое получено прогоном событий через автоматы
 * домена, и тест сверяет, что автомат привёл именно туда.
 */
export const SCENARIOS: readonly Scenario[] = Object.freeze([
  scenario({
    id: 'm01',
    ref: 'SD-7K42',
    role: 'paying',
    property: 'rustaveli',
    counterparty: 'beridze',
    requiredMinor: AMOUNT,
    steps: [...opened(50)],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'notFunded',
    confirmationNo: null,
  }),
  scenario({
    id: 'm02',
    ref: 'SD-7K43',
    role: 'paying',
    property: 'mtatsminda',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [...opened(50)],
    payment: { ...NO_PAYMENT_FACTS, transferDeclared: true },
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'transferDeclared',
    confirmationNo: null,
  }),
  scenario({
    id: 'm03',
    ref: 'SD-7K44',
    role: 'paying',
    property: 'chugureti',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [...opened(60)],
    payment: { ...NO_PAYMENT_FACTS, unidentified: true },
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'unidentified',
    confirmationNo: null,
  }),
  scenario({
    id: 'm04',
    ref: 'SD-7K45',
    role: 'paying',
    property: 'gldani',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [
      ...opened(60),
      tranche(8, {
        type: 'funds_received',
        amount: { currency: GEL, minor: AMOUNT },
        sender: 'Anna Weiss',
        reference: data.bank.payinReference,
      }),
    ],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'heldThirdParty',
    confirmationNo: null,
  }),
  scenario({
    id: 'm05',
    ref: 'SD-7K46',
    role: 'paying',
    property: 'vera',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [...opened(60), payment(9, 8_000_000n, 'USD')],
    payment: { ...NO_PAYMENT_FACTS, awaitingConversion: true },
    modifiers: { ...NO_MODIFIERS, quoteExpired: true },
    overrides: BASE_OVERRIDES,
    expect: 'onAccountFx',
    confirmationNo: null,
  }),
  scenario({
    id: 'm06',
    ref: 'SD-7K47',
    role: 'paying',
    property: 'vazha',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [...opened(70), ...funded(30, AMOUNT)],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'onAccount',
    confirmationNo: null,
  }),
  scenario({
    id: 'm07',
    ref: 'SD-7K48',
    role: 'paying',
    property: 'batumi',
    counterparty: 'kobalia',
    requiredMinor: 14_500_000n,
    steps: [...opened(70), payment(20, 9_800_000n)],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'partiallyFunded',
    confirmationNo: null,
  }),
  scenario({
    id: 'm08',
    ref: 'SD-7K49',
    role: 'paying',
    property: 'mtatsminda',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [...opened(70), ...funded(28, AMOUNT, 22_450_000n)],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'overfunded',
    confirmationNo: null,
  }),
  scenario({
    id: 'm09',
    ref: 'SD-7K50',
    role: 'paying',
    property: 'vazha',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [...opened(70), ...funded(30, AMOUNT), ...reserved(6)],
    payment: NO_PAYMENT_FACTS,
    modifiers: { ...NO_MODIFIERS, requisitesLocked: true },
    overrides: BASE_OVERRIDES,
    expect: 'reserved',
    confirmationNo: 'SD-CONF-7K50',
  }),
  scenario({
    id: 'm10',
    ref: 'SD-7K51',
    role: 'paying',
    property: 'chugureti',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [...opened(70), ...funded(30, AMOUNT), ...reserved(9), ...filed(5)],
    payment: NO_PAYMENT_FACTS,
    modifiers: { ...NO_MODIFIERS, requisitesLocked: true, clockPaused: true },
    overrides: BASE_OVERRIDES,
    expect: 'submitted',
    confirmationNo: 'SD-CONF-7K51',
  }),
  scenario({
    id: 'm11',
    ref: 'SD-7K52',
    role: 'paying',
    property: 'vera',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [
      ...opened(70),
      ...funded(30, AMOUNT),
      ...reserved(12),
      ...filed(6),
      ...conditionMet(2),
    ],
    payment: NO_PAYMENT_FACTS,
    modifiers: { ...NO_MODIFIERS, requisitesLocked: true },
    overrides: BASE_OVERRIDES,
    expect: 'releasePending',
    confirmationNo: 'SD-CONF-7K52',
  }),
  scenario({
    id: 'm12',
    ref: 'SD-7K53',
    role: 'paying',
    property: 'gldani',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [
      ...opened(70),
      ...funded(40, AMOUNT),
      ...reserved(20),
      ...filed(16),
      ...conditionMet(6),
      tranche(5, { type: 'release_authorized' }),
      { k: 'payoutCreate', hoursAgo: 5 },
      { k: 'payout', hoursAgo: 5, event: { type: 'payout_submitted' } },
      { k: 'payout', hoursAgo: 4, event: { type: 'provider_confirms' } },
      tranche(4, { type: 'payout_result', outcome: 'settled' }),
      deal(4, { type: 'tranches_settled' }),
    ],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'released',
    confirmationNo: 'SD-CONF-7K53',
  }),
  scenario({
    id: 'm13',
    ref: 'SD-7K54',
    role: 'paying',
    property: 'mtatsminda',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [
      ...opened(70),
      ...funded(40, AMOUNT),
      ...reserved(22),
      ...filed(18),
      ...conditionMet(10),
      tranche(9, { type: 'release_authorized' }),
      { k: 'payoutCreate', hoursAgo: 9 },
      { k: 'payout', hoursAgo: 9, event: { type: 'payout_submitted' } },
      { k: 'payout', hoursAgo: 8, event: { type: 'timeout' } },
      tranche(8, { type: 'payout_result', outcome: 'unknown' }),
    ],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'payoutUnknown',
    confirmationNo: 'SD-CONF-7K54',
  }),
  scenario({
    id: 'm14',
    ref: 'SD-7K55',
    role: 'paying',
    property: 'batumi',
    counterparty: 'kobalia',
    requiredMinor: 14_500_000n,
    steps: [
      ...opened(70),
      ...funded(44, 14_500_000n),
      ...reserved(30),
      ...filed(28),
      tranche(3, { type: 'condition_failed' }),
      deal(3, { type: 'condition_failed' }),
    ],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'rollbackInProgress',
    confirmationNo: 'SD-CONF-7K55',
  }),
  scenario({
    id: 'm15',
    ref: 'SD-7K56',
    role: 'paying',
    property: 'gonio',
    counterparty: 'kobalia',
    requiredMinor: 14_500_000n,
    steps: [
      ...opened(90),
      ...funded(60, 14_500_000n),
      ...reserved(40),
      ...filed(38),
      tranche(20, { type: 'condition_failed' }),
      deal(20, { type: 'condition_failed' }),
      tranche(19, { type: 'refund_initiated' }),
      tranche(18, { type: 'payout_result', outcome: 'settled' }),
      deal(18, { type: 'tranches_refunded' }),
    ],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'releasedToAccount',
    confirmationNo: null,
  }),
  scenario({
    id: 'm16',
    ref: 'SD-7K57',
    role: 'paying',
    property: 'batumi',
    counterparty: 'kobalia',
    requiredMinor: 14_500_000n,
    steps: [
      ...opened(120),
      ...funded(96, 14_500_000n),
      ...reserved(70),
      ...filed(68),
      tranche(50, { type: 'condition_failed' }),
      deal(50, { type: 'condition_failed' }),
      tranche(49, { type: 'refund_initiated' }),
      tranche(48, { type: 'payout_result', outcome: 'settled' }),
      deal(48, { type: 'tranches_refunded' }),
    ],
    payment: { ...NO_PAYMENT_FACTS, refundDispatched: true },
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'refundInProgress',
    confirmationNo: null,
  }),
  scenario({
    id: 'm17',
    ref: 'SD-7K58',
    role: 'paying',
    property: 'gonio',
    counterparty: 'kobalia',
    requiredMinor: 14_500_000n,
    steps: [
      ...opened(200),
      ...funded(180, 14_500_000n),
      ...reserved(160),
      ...filed(158),
      tranche(140, { type: 'condition_failed' }),
      deal(140, { type: 'condition_failed' }),
      tranche(139, { type: 'refund_initiated' }),
      tranche(138, { type: 'payout_result', outcome: 'settled' }),
      deal(138, { type: 'tranches_refunded' }),
    ],
    payment: { ...NO_PAYMENT_FACTS, refundDispatched: true, refundArrived: true },
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'refunded',
    confirmationNo: null,
  }),
  scenario({
    id: 'm18',
    ref: 'SD-7K59',
    role: 'paying',
    property: 'vera',
    counterparty: 'kikvadze',
    requiredMinor: AMOUNT,
    steps: [
      ...opened(70),
      ...funded(40, AMOUNT),
      ...reserved(20),
      tranche(4, { type: 'compliance_hold', reason: 'sanctions', frozenBy: 'analyst-1' }),
    ],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'frozen',
    confirmationNo: 'SD-CONF-7K59',
  }),

  /* --------------------------- сделки, где клиент получает --------------- */

  scenario({
    id: 'r01',
    ref: 'SD-8A10',
    role: 'receiving',
    property: 'saburtalo',
    counterparty: 'orbeliani',
    requiredMinor: 18_900_000n,
    steps: [...opened(40)],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'notFunded',
    confirmationNo: null,
  }),
  scenario({
    id: 'r02',
    ref: 'SD-8A11',
    role: 'receiving',
    property: 'saburtalo',
    counterparty: 'orbeliani',
    requiredMinor: 18_900_000n,
    steps: [...opened(70), ...funded(26, 18_900_000n)],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'onAccount',
    confirmationNo: null,
  }),
  scenario({
    id: 'r03',
    ref: 'SD-8A12',
    role: 'receiving',
    property: 'saburtalo',
    counterparty: 'orbeliani',
    requiredMinor: 18_900_000n,
    steps: [...opened(70), ...funded(30, 18_900_000n), ...reserved(7)],
    payment: NO_PAYMENT_FACTS,
    modifiers: { ...NO_MODIFIERS, requisitesLocked: true },
    overrides: BASE_OVERRIDES,
    expect: 'reserved',
    confirmationNo: 'SD-CONF-8A12',
  }),
  scenario({
    id: 'r04',
    ref: 'SD-8A13',
    role: 'receiving',
    property: 'saburtalo',
    counterparty: 'orbeliani',
    requiredMinor: 18_900_000n,
    steps: [
      ...opened(80),
      ...funded(50, 18_900_000n),
      ...reserved(30),
      ...filed(26),
      ...conditionMet(8),
      tranche(7, { type: 'release_authorized' }),
      { k: 'payoutCreate', hoursAgo: 7 },
      { k: 'payout', hoursAgo: 7, event: { type: 'payout_submitted' } },
      { k: 'payout', hoursAgo: 6, event: { type: 'provider_confirms' } },
      tranche(6, { type: 'payout_result', outcome: 'settled' }),
      deal(6, { type: 'tranches_settled' }),
    ],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'released',
    confirmationNo: 'SD-CONF-8A13',
  }),
  scenario({
    id: 'r05',
    ref: 'SD-8A14',
    role: 'receiving',
    property: 'saburtalo',
    counterparty: 'orbeliani',
    requiredMinor: 18_900_000n,
    steps: [
      ...opened(80),
      ...funded(50, 18_900_000n),
      ...reserved(30),
      ...filed(26),
      ...conditionMet(12),
      tranche(11, { type: 'release_authorized' }),
      { k: 'payoutCreate', hoursAgo: 11 },
      { k: 'payout', hoursAgo: 11, event: { type: 'payout_submitted' } },
      { k: 'payout', hoursAgo: 10, event: { type: 'timeout' } },
      tranche(10, { type: 'payout_result', outcome: 'unknown' }),
    ],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'payoutUnknown',
    confirmationNo: 'SD-CONF-8A14',
  }),
  scenario({
    id: 'r06',
    ref: 'SD-8A15',
    role: 'receiving',
    property: 'saburtalo',
    counterparty: 'orbeliani',
    requiredMinor: 18_900_000n,
    steps: [
      ...opened(120),
      ...funded(96, 18_900_000n),
      ...reserved(70),
      ...filed(68),
      tranche(30, { type: 'condition_failed' }),
      deal(30, { type: 'condition_failed' }),
      tranche(29, { type: 'refund_initiated' }),
      tranche(28, { type: 'payout_result', outcome: 'settled' }),
      deal(28, { type: 'tranches_refunded' }),
    ],
    payment: NO_PAYMENT_FACTS,
    modifiers: NO_MODIFIERS,
    overrides: BASE_OVERRIDES,
    expect: 'releasedToAccount',
    confirmationNo: null,
  }),
  scenario({
    id: 'r07',
    ref: 'SD-8A16',
    role: 'receiving',
    property: 'saburtalo',
    counterparty: 'orbeliani',
    requiredMinor: 18_900_000n,
    steps: [...opened(70), ...funded(30, 18_900_000n), ...reserved(10)],
    payment: NO_PAYMENT_FACTS,
    modifiers: { ...NO_MODIFIERS, requisitesLocked: true, requisitesCooling: true },
    overrides: BASE_OVERRIDES,
    expect: 'reserved',
    confirmationNo: 'SD-CONF-8A16',
  }),
]);

export { data as FIXTURE_DATA };
