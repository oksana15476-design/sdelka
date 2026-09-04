import {
  DEFAULT_FEE_CEILING_POLICY,
  type TrancheStatus,
  isTerminalTrancheStatus,
} from '@sdelka/domain';
import { PROPOSED_INTAKE_POLICY, disclosedMarkupBp } from '@sdelka/intake';
import {
  type Journal,
  type JournalEntry,
  type TrancheRef,
  appendEntries,
  appendEntry,
  bankOperating,
  checkLedgerInvariants,
  clientKey,
  clientTopUp,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  executeConversion,
  fxExecution,
  receiveConversion,
  sendForConversion,
} from '@sdelka/ledger';
import {
  type CurrencyCode,
  type FxRates,
  type Money,
  convert,
  fxRates,
  isoDate,
  money,
  platformSpread,
  rationalFromDecimalString,
} from '@sdelka/money';
import {
  type DealEconomics,
  type PeriodSummary,
  type SignificanceView,
  dealEconomics,
  periodSummary,
  significance,
} from '@/view/owner-economics';
import {
  type FactOverrides,
  type RunInput,
  type Step,
  FIXTURE_NOW,
  PLATFORM_DEDUCTIONS,
  platformFee,
  runScenario,
} from './engine';
import { type CounterpartyKey, type PropertyKey, FIXTURE_DATA, VIEWER, counterpartyRef } from './scenarios';

/**
 * Мир владельца: сделки, у которых экономика видна целиком.
 *
 * ## Почему отдельный набор фикстур, а не тот же, что у клиента и консоли
 *
 * Клиентские фикстуры (`scenarios.ts`) собраны под **положения денег**, и
 * конвертации в журнале у них нет вовсе: слой конвертации там показан
 * представлением `ConversionView` с курсом-строкой, а проводок обмена никто не
 * пишет. Экономика по двум ногам на таком журнале недостижима — валютная нога
 * равнялась бы нулю всегда, и экран честно показывал бы ноль там, где в жизни
 * основной источник маржи.
 *
 * Довести туда обмен — правка `engine.ts` и `scenarios.ts`, то есть общих
 * фикстур, которыми этот заход не владеет (см. отчёт). Поэтому мир владельца
 * строится здесь и **тем же** способом: события подаются в автоматы домена
 * через `runScenario`, а проводки собираются словарём `@sdelka/ledger`. Ни одна
 * величина не выдумана: журнал проходит `checkLedgerInvariants`, а экономика
 * читается из него проекцией.
 *
 * ## Чего здесь нет
 *
 * Сделки в валюте, отличной от лари, **завершиться не могут**: `factsOf` в
 * `engine.ts` жёстко ставит `officialRateAtCreation: null`, а
 * `g_approvals_sufficient` при валюте транша, отличной от валюты порогов, без
 * курса не набирает утверждений вовсе (отказ закрытый, `guards.ts`). Поэтому
 * валютная сделка здесь живая, а не расчитанная, и это ограничение общей
 * фикстуры, а не решение.
 */

const HOUR_MS = 60 * 60 * 1000;

const OWNER_OVERRIDES: FactOverrides = Object.freeze({
  beneficiaryLocked: true,
  beneficiaryChangedHoursAgo: 240,
  senderName: 'Mark Weiss',
  registryOwnerIsBuyer: true,
  mismatchResolved: true,
  sourceAccountKnown: true,
  coverageOk: true,
});

/**
 * Три курса пары USD→GEL, из которых собран обмен фикстуры.
 *
 * Значения выбраны так, чтобы экран показывал **измеренную** картину, а не
 * желаемую: `BACKLOG.md` фиксирует замер витринного курса BOG на 04.09.2026 —
 * 1,375 % по нашей ноге против 0,20 %, заложенных в экономику. Отсюда
 * эталонный курс ниже официального примерно на эту долю, а клиентский ниже
 * эталонного на 0,7 % — наша наценка. Иначе фикстура рисовала бы валютную ногу
 * прибыльнее, чем она измерена, и экран владельца врал бы в самую дорогую
 * сторону.
 */
const USD_GEL_TEXT = Object.freeze({
  client: '2.6544',
  reference: '2.6731',
  official: '2.7104',
});

const USD_GEL: FxRates<'USD', 'GEL'> = fxRates('USD', 'GEL', {
  client: rationalFromDecimalString(USD_GEL_TEXT.client),
  reference: rationalFromDecimalString(USD_GEL_TEXT.reference),
  official: rationalFromDecimalString(USD_GEL_TEXT.official),
});

/** Сколько клиент отправил из своего банка по валютной сделке. */
const FX_SOURCE: Money<'USD'> = money('USD', 8_084_560n);

const FX_CONVERTED = convert(FX_SOURCE, USD_GEL, isoDate('2026-09-01'), 'trunc');

/**
 * Прямые расходы сделки — величины фикстуры, а не принятые нормы.
 *
 * Строк ровно столько, сколько счетов расхода есть в плане (`accounts.ts`):
 * платная выписка и мониторинг заявления (`oracle:cost:expense`), банковские
 * комиссии на приём и возврат (`psp:fee:expense`). Счёта под «человеко-часы»,
 * невозмещаемый НДС и вознаграждение партнёра в плане нет — их в экономике не
 * появляется, и досчитывать их мимо учёта нельзя (E16-8, E16-10).
 */
const ORACLE_COST_MINOR = 6_000n;
const PSP_COST_MINOR = 4_500n;
const REFUND_COST_MINOR = 13_000n;

const OWNER_CASE_KINDS = [
  'settled_fx',
  'settled_plain',
  'fee_in_transit',
  'in_progress',
  'rolled_back',
  'live_foreign',
] as const;
export type OwnerCaseKind = (typeof OWNER_CASE_KINDS)[number];

interface OwnerCase {
  readonly id: string;
  readonly ref: string;
  readonly kind: OwnerCaseKind;
  readonly property: PropertyKey;
  readonly counterparty: CounterpartyKey;
  readonly currency: CurrencyCode;
  readonly minor: bigint;
  readonly hoursAgo: number;
}

/**
 * Номера сделок не пересекаются с клиентскими фикстурами (`scenarios.ts`
 * занимает `SD-7K42`…`SD-8A16`). Совпадение номера не сломало бы ни одну
 * проверку и было бы видно только глазом на экране, где одна и та же сделка
 * показана с двумя разными суммами — поэтому диапазон здесь отдельный.
 */
const NAMED_CASES: readonly OwnerCase[] = Object.freeze([
  {
    id: 'ow01',
    ref: 'SD-9C11',
    kind: 'settled_fx',
    property: 'vera',
    counterparty: 'kikvadze',
    currency: 'GEL',
    minor: FX_CONVERTED.target.minor,
    hoursAgo: 52,
  },
  {
    id: 'ow02',
    ref: 'SD-9C12',
    kind: 'settled_plain',
    property: 'gldani',
    counterparty: 'beridze',
    currency: 'GEL',
    minor: 18_400_000n,
    hoursAgo: 46,
  },
  {
    id: 'ow03',
    ref: 'SD-9C13',
    kind: 'fee_in_transit',
    property: 'chugureti',
    counterparty: 'kikvadze',
    currency: 'GEL',
    minor: 24_900_000n,
    hoursAgo: 40,
  },
  {
    id: 'ow04',
    ref: 'SD-9C14',
    kind: 'in_progress',
    property: 'mtatsminda',
    counterparty: 'kobalia',
    currency: 'GEL',
    minor: 21_700_000n,
    hoursAgo: 30,
  },
  {
    id: 'ow05',
    ref: 'SD-9C15',
    kind: 'rolled_back',
    property: 'batumi',
    counterparty: 'kobalia',
    currency: 'GEL',
    minor: 14_500_000n,
    hoursAgo: 34,
  },
  {
    id: 'ow06',
    ref: 'SD-9C16',
    kind: 'live_foreign',
    property: 'gonio',
    counterparty: 'beridze',
    currency: 'USD',
    minor: 9_500_000n,
    hoursAgo: 26,
  },
]);

/**
 * Фон: завершённые сделки того же месяца.
 *
 * Нужны ровно для одного — чтобы месячный оборот в лари подходил к порогу
 * значимости провайдера (9 млн ₾) и блок приближения показывал состояние, ради
 * которого он существует. На шести сделках он показывал бы полпроцента порога,
 * то есть не показывал бы ничего.
 */
const BACKGROUND_COUNT = 32;

function backgroundCases(): readonly OwnerCase[] {
  const properties: readonly PropertyKey[] = ['rustaveli', 'saburtalo', 'vazha', 'gldani', 'vera'];
  const counterparties: readonly CounterpartyKey[] = ['kikvadze', 'beridze', 'kobalia', 'orbeliani'];
  const out: OwnerCase[] = [];
  for (let index = 0; index < BACKGROUND_COUNT; index += 1) {
    out.push({
      id: `owb${String(index + 10)}`,
      ref: `SD-9D${String(index + 10)}`,
      kind: 'settled_plain',
      property: properties[index % properties.length] as PropertyKey,
      counterparty: counterparties[index % counterparties.length] as CounterpartyKey,
      currency: 'GEL',
      // Суммы разные: средний чек по одинаковым сделкам не показал бы ничего.
      minor: 17_000_000n + BigInt(index % 9) * 1_450_000n,
      // Все фоновые сделки закрыты в текущем месяце: предыдущий пуст намеренно,
      // потому что пустой период — отдельное состояние экрана, и без фикстуры
      // его никто не увидит.
      hoursAgo: 30 + index,
    });
  }
  return Object.freeze(out);
}

const ALL_CASES: readonly OwnerCase[] = Object.freeze([...NAMED_CASES, ...backgroundCases()]);

/* ------------------------------------------------------------- шаги сценария */

function tranche(hoursAgo: number, event: Extract<Step, { k: 'tranche' }>['event']): Step {
  return { k: 'tranche', hoursAgo, event };
}

function deal(hoursAgo: number, event: Extract<Step, { k: 'deal' }>['event']): Step {
  return { k: 'deal', hoursAgo, event };
}

/**
 * Путь до расчёта. `topUp` выключается у валютной сделки: там лари появляются
 * на счёте клиента конвертацией, а не поступлением, и второе зачисление удвоило
 * бы обязательство.
 */
function settledSteps(item: OwnerCase, topUp: boolean): readonly Step[] {
  const paid = item.hoursAgo;
  const amount = { currency: item.currency, minor: item.minor };
  return [
    { k: 'tranche', hoursAgo: paid + 20, event: { type: 'instructions_issued' } },
    ...(topUp
      ? [{ k: 'payment', hoursAgo: paid, minor: item.minor, currency: item.currency } as Step]
      : []),
    tranche(paid, {
      type: 'funds_received',
      amount,
      sender: OWNER_OVERRIDES.senderName,
      reference: FIXTURE_DATA.bank.payinReference,
    }),
    deal(paid, { type: 'funds_received' }),
    tranche(paid - 6, { type: 'reserve_requested' }),
    deal(paid - 6, { type: 'tranches_reserved' }),
    deal(paid - 8, {
      type: 'filing_registered',
      applicationId: 'REG-2026-44810',
      source: 'application_card',
    }),
    tranche(paid - 12, {
      type: 'condition_established',
      evidenceBundleId: 'evidence-2026-09',
      conditionType: 'registration_transfer',
    }),
    deal(paid - 12, { type: 'condition_established', conditionType: 'registration_transfer' }),
    tranche(paid - 14, { type: 'release_authorized' }),
    { k: 'payoutCreate', hoursAgo: paid - 14 },
    { k: 'payout', hoursAgo: paid - 14, event: { type: 'payout_submitted' } },
    { k: 'payout', hoursAgo: paid - 15, event: { type: 'provider_confirms' } },
    tranche(paid - 15, { type: 'payout_result', outcome: 'settled' }),
    deal(paid - 15, { type: 'tranches_settled' }),
  ];
}

function liveSteps(item: OwnerCase): readonly Step[] {
  const paid = item.hoursAgo;
  return [
    { k: 'tranche', hoursAgo: paid + 20, event: { type: 'instructions_issued' } },
    { k: 'payment', hoursAgo: paid, minor: item.minor, currency: item.currency },
    tranche(paid, {
      type: 'funds_received',
      amount: { currency: item.currency, minor: item.minor },
      sender: OWNER_OVERRIDES.senderName,
      reference: FIXTURE_DATA.bank.payinReference,
    }),
    deal(paid, { type: 'funds_received' }),
    tranche(paid - 6, { type: 'reserve_requested' }),
    deal(paid - 6, { type: 'tranches_reserved' }),
    deal(paid - 8, {
      type: 'filing_registered',
      applicationId: 'REG-2026-44810',
      source: 'application_card',
    }),
  ];
}

function rolledBackSteps(item: OwnerCase): readonly Step[] {
  const paid = item.hoursAgo;
  return [
    { k: 'tranche', hoursAgo: paid + 20, event: { type: 'instructions_issued' } },
    { k: 'payment', hoursAgo: paid, minor: item.minor, currency: item.currency },
    tranche(paid, {
      type: 'funds_received',
      amount: { currency: item.currency, minor: item.minor },
      sender: OWNER_OVERRIDES.senderName,
      reference: FIXTURE_DATA.bank.payinReference,
    }),
    deal(paid, { type: 'funds_received' }),
    tranche(paid - 6, { type: 'reserve_requested' }),
    deal(paid - 6, { type: 'tranches_reserved' }),
    deal(paid - 8, {
      type: 'filing_registered',
      applicationId: 'REG-2026-44810',
      source: 'application_card',
    }),
    tranche(paid - 16, { type: 'condition_failed' }),
    deal(paid - 16, { type: 'condition_failed' }),
    tranche(paid - 17, { type: 'refund_initiated' }),
    tranche(paid - 18, { type: 'payout_result', outcome: 'settled' }),
    deal(paid - 18, { type: 'tranches_refunded' }),
  ];
}

function stepsOf(item: OwnerCase): readonly Step[] {
  if (item.kind === 'in_progress' || item.kind === 'live_foreign') return liveSteps(item);
  if (item.kind === 'rolled_back') return rolledBackSteps(item);
  return settledSteps(item, item.kind !== 'settled_fx');
}

/* -------------------------------------------------------- проводки, которых
   автомат не порождает: обмен и прямые расходы */

function at(hoursAgo: number): string {
  return new Date(FIXTURE_NOW - hoursAgo * HOUR_MS).toISOString();
}

/**
 * Обмен тремя моментами (`FUNCTIONAL.md` §3.3): отправили, исполнили, получили.
 * Наш доход признаётся в третьем и в той же записи выводится на операционный
 * счёт — красная линия №2, комиссия и спред на номинальном счёте не оседают.
 */
function conversionEntries(item: OwnerCase): readonly JournalEntry[] {
  const owner = clientKey(VIEWER.accountKey);
  const execution = fxExecution(`${item.id}fx`, FX_CONVERTED);
  const spread = platformSpread(FX_CONVERTED, 'trunc');
  const paid = item.hoursAgo;
  return [
    clientTopUp({ id: `${item.id}-fx0`, occurredAt: at(paid + 6) }, owner, FX_SOURCE),
    sendForConversion({ id: `${item.id}-fx1`, occurredAt: at(paid + 5) }, owner, execution),
    executeConversion({ id: `${item.id}-fx2`, occurredAt: at(paid + 4) }, owner, execution),
    receiveConversion({ id: `${item.id}-fx3`, occurredAt: at(paid + 3) }, owner, execution, spread),
  ];
}

/**
 * Прямой расход, отнесённый к сделке.
 *
 * Отнесение обязательно: без него расход не относится ни к одной сделке и
 * экономика сделки перестаёт быть экономикой сделки. Встречная нога —
 * операционный счёт: платим мы, из своих.
 */
function expenseEntry(
  id: string,
  occurredAt: string,
  kind: 'oracle_cost_expense' | 'psp_fee_expense',
  ref: TrancheRef,
  amount: Money<CurrencyCode>,
): JournalEntry {
  return createJournalEntry({
    id,
    occurredAt,
    kind: 'settlement',
    memoKey: `ledger.entry.${kind}`,
    postings: [
      debit({ kind } as const, amount, ref),
      credit(bankOperating(amount.currency), amount, ref),
    ],
  });
}

/**
 * Расходы по сделке. Считаются в лари **всегда**, даже когда сделка в долларах:
 * выписку и банковскую комиссию мы платим в лари. Отсюда у валютной сделки
 * оборот в одной валюте, а расход в другой — и единой маржи у неё не
 * существует. Это не дефект показа, а то, как устроены деньги.
 */
function expenseEntries(item: OwnerCase, ref: TrancheRef): readonly JournalEntry[] {
  const paid = item.hoursAgo;
  const out: JournalEntry[] = [
    expenseEntry(`${item.id}-x1`, at(paid - 9), 'oracle_cost_expense', ref, money('GEL', ORACLE_COST_MINOR)),
    expenseEntry(`${item.id}-x2`, at(paid - 1), 'psp_fee_expense', ref, money('GEL', PSP_COST_MINOR)),
  ];
  if (item.kind === 'rolled_back') {
    // Возврат крупной суммы за границу — отдельная банковская комиссия, и она
    // наша: красная линия №9 не оставляет выбора адреса, а §4.4 не даёт
    // начислить за расчёт ничего. Отсюда отрицательный итог сделки.
    out.push(
      expenseEntry(`${item.id}-x3`, at(paid - 19), 'psp_fee_expense', ref, money('GEL', REFUND_COST_MINOR)),
    );
  }
  return out;
}

/* --------------------------------------------------------------- сборка мира */

export interface OwnerDeal {
  readonly id: string;
  readonly ref: string;
  readonly kind: OwnerCaseKind;
  readonly address: string;
  readonly counterpartyName: string;
  readonly amount: Money<CurrencyCode>;
  readonly trancheStatus: TrancheStatus;
  readonly settled: boolean;
  /** Версия тарифа — из объявления начисления в журнале, а не из настройки. */
  readonly tariffVersionId: string | null;
  readonly economics: DealEconomics;
  /**
   * Ожидаемая комиссия по действующему тарифу — только у сделки **в работе**.
   *
   * У откаченной её нет и быть не может: §4.4 не начисляет за расчёт ничего,
   * сделка терминальна, и «ожидаемая» комиссия по ней была бы обещанием денег,
   * которых уже не будет. Признак — терминальность статуса, а не «не
   * расчитана»: `refunded` тоже не расчитана.
   */
  readonly expectedFee: Money<CurrencyCode> | null;
  readonly settledAt: number | null;
  /** Первое и последнее движение по журналу сделки — границы её жизни. */
  readonly openedAt: number;
  readonly lastMovedAt: number;
}

interface Built {
  readonly deal: OwnerDeal;
  readonly journal: Journal;
}

function build(item: OwnerCase): Built {
  const ref: TrancheRef = { dealId: item.id, trancheId: `${item.id}-t1` };
  const run = runScenario({
    dealId: item.id,
    trancheId: ref.trancheId,
    payer: VIEWER,
    recipient: counterpartyRef(item.counterparty),
    required: money(item.currency, item.minor),
    steps: stepsOf(item),
    overrides: OWNER_OVERRIDES,
    refundDispatched: item.kind === 'rolled_back',
  } satisfies RunInput);

  const before = item.kind === 'settled_fx' ? conversionEntries(item) : [];
  /**
   * ⚠ У случая «удержано, но не получено» запись прихода комиссии на
   * операционный счёт из журнала **исключается при сборке**.
   *
   * `engine.ts` порождает все три момента комиссии одним куском: начисление,
   * удержание и приход. Значит состояние §4.6 «удержано, перевод не дошёл» —
   * то самое, которое Ф16 требует видеть отдельной величиной, — через общую
   * фикстуру недостижимо вовсе. Здесь запись не правится и не подменяется: она
   * просто не кладётся в журнал, потому что в жизни её кладёт сверка по
   * выписке, а выписки ещё нет.
   */
  const own =
    item.kind === 'fee_in_transit'
      ? run.journal.entries.filter((entry) => entry.memoKey !== 'ledger.entry.fee_received')
      : run.journal.entries;

  let journal = appendEntries(emptyJournal, [...before, ...own]);
  for (const entry of expenseEntries(item, ref)) {
    journal = appendEntry(journal, entry);
  }

  // Расчёт исполнен — это `paid_out` у транша: «settled» такого статуса в
  // домене нет, и сверять по нему значило бы сверять с несуществующим именем.
  const settled = run.tranche.status === 'paid_out';
  const accrual = journal.entries.find((entry) => entry.accrues !== null)?.accrues ?? null;
  const settledMark = run.marks.find((mark) => mark.status === 'paid_out');
  const property = FIXTURE_DATA.properties[item.property];

  return {
    journal,
    deal: Object.freeze({
      id: item.id,
      ref: item.ref,
      kind: item.kind,
      address: property.address,
      counterpartyName: FIXTURE_DATA.counterparties[item.counterparty].displayName,
      amount: money(item.currency, item.minor),
      trancheStatus: run.tranche.status,
      settled,
      tariffVersionId: accrual === null ? null : accrual.tariffVersionId,
      economics: dealEconomics(journal, ref, settled),
      expectedFee: isTerminalTrancheStatus(run.tranche.status)
        ? null
        : platformFee(money(item.currency, item.minor)),
      settledAt: settledMark === undefined ? null : settledMark.at,
      // Минимум и максимум, а не первая и последняя записи: порядок в массиве
      // — порядок сборки, а не времени. Расход по выписке проводится задним
      // числом относительно расчёта, и «последняя запись» дала бы дату раньше
      // расчёта — сделка уехала бы в чужой месяц.
      openedAt: Math.min(...journal.entries.map((entry) => Date.parse(entry.occurredAt))),
      lastMovedAt: Math.max(...journal.entries.map((entry) => Date.parse(entry.occurredAt))),
    }),
  };
}

const BUILT: readonly Built[] = ALL_CASES.map(build);

/** Журнал мира владельца целиком: на нём проверяются инварианты учёта. */
export function ownerJournal(): Journal {
  return BUILT.reduce((journal, item) => appendEntries(journal, item.journal.entries), emptyJournal);
}

export function ownerInvariantBreaches(): readonly string[] {
  return checkLedgerInvariants(ownerJournal()).map((item) => item.code);
}

export async function listOwnerDeals(): Promise<readonly OwnerDeal[]> {
  // По марже вверх: убыточная сделка стоит первой, потому что о ней и разговор.
  return [...BUILT.map((item) => item.deal)].sort((left, right) => {
    const leftMargin = left.economics.byCurrency[0]?.margin.minor ?? 0n;
    const rightMargin = right.economics.byCurrency[0]?.margin.minor ?? 0n;
    if (leftMargin !== rightMargin) return leftMargin < rightMargin ? -1 : 1;
    return left.ref < right.ref ? -1 : 1;
  });
}

export async function getOwnerDeal(id: string): Promise<OwnerDeal | null> {
  return BUILT.find((item) => item.deal.id === id)?.deal ?? null;
}

/* ------------------------------------------------------------ сводка периода */

export const OWNER_PERIODS = ['current', 'previous'] as const;
export type OwnerPeriod = (typeof OWNER_PERIODS)[number];

export function ownerPeriodOf(value: string | undefined): OwnerPeriod {
  return value === 'previous' ? 'previous' : 'current';
}

export interface PeriodBounds {
  readonly from: number;
  readonly to: number;
  /** Год и месяц для `Intl`: свой формат дат в проекте не заводится. */
  readonly monthAt: number;
}

export function periodBounds(period: OwnerPeriod): PeriodBounds {
  const now = new Date(FIXTURE_NOW);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - (period === 'previous' ? 1 : 0);
  const from = Date.UTC(year, month, 1);
  const to = Date.UTC(year, month + 1, 1);
  return { from, to, monthAt: from };
}

export interface OwnerSummary {
  readonly period: OwnerPeriod;
  readonly bounds: PeriodBounds;
  readonly summary: PeriodSummary;
  readonly significance: SignificanceView;
}

/**
 * Сводка за период.
 *
 * Сделка попадает в период по **последнему движению в журнале**, а не по
 * расчёту: иначе убыток по откаченной сделке исчезал бы из периода вовсе —
 * расчёта у неё нет, а расходы понесены и уже проведены. Оборот при этом
 * складывается только из расчётов: у незавершённой сделки он ноль по
 * построению, и число сделок периода потому больше числа завершённых.
 */
export async function getOwnerSummary(period: OwnerPeriod): Promise<OwnerSummary> {
  const bounds = periodBounds(period);
  const inPeriod = BUILT.filter(
    (item) => item.deal.lastMovedAt >= bounds.from && item.deal.lastMovedAt < bounds.to,
  );
  const summary = periodSummary(
    inPeriod.map((item) => ({
      deal: { dealId: item.deal.id, trancheId: `${item.deal.id}-t1` },
      economics: item.deal.economics,
    })),
  );
  const gel = summary.byCurrency.find((item) => item.currency === 'GEL');
  return {
    period,
    bounds,
    summary,
    significance: significance(money('GEL', gel === undefined ? 0n : gel.turnover.minor)),
  };
}

/* ------------------------------------------------------- тариф и наценка */

export const FEE_PAYERS = ['payer', 'recipient', 'split'] as const;
export type FeePayer = (typeof FEE_PAYERS)[number];

export interface TariffView {
  /** Ставка комиссии в базисных пунктах: целое, без плавающей точки. */
  readonly rateBp: number;
  readonly fixed: Money<CurrencyCode>;
  /** Потолок удержания из домена (`tariff.ts`), в базисных пунктах. */
  readonly ceilingBp: number;
  /** Наценка на конвертации — из курсов обмена, а не из настройки. */
  readonly markupBp: number;
  /** Фактическая стоимость конвертации: официальный курс против эталонного. */
  readonly conversionCostBp: number;
  readonly quoteValidityMs: number;
  readonly quoteDriftBp: number;
  readonly toleranceShareBp: number;
  readonly toleranceAbsolute: readonly Money<CurrencyCode>[];
  /**
   * Кто платит комиссию. **Величина выведена из конструкции расчёта, а не
   * прочитана из настройки:** `settleTrancheToClientAccount` удерживает
   * комиссию из суммы транша, то есть её несёт получатель. Настройки с таким
   * смыслом в домене не существует вовсе — это E16-4, и до неё «плательщик
   * комиссии» здесь только показывается.
   */
  readonly feePayer: FeePayer;
  readonly feePayerIsSetting: false;
  /** Версия тарифа, под которой заведены сделки — из журнала. */
  readonly versionId: string | null;
  readonly rates: FxRates<'USD', 'GEL'>;
  /**
   * Те же три курса десятичными строками. Строкой, а не числом: `Intl`
   * форматирует десятичную строку без потери разрядов, а `Number` четвёртый
   * знак курса уже теряет — и курс на экране разошёлся бы с курсом в журнале.
   */
  readonly rateText: { readonly client: string; readonly reference: string; readonly official: string };
  readonly sample: Money<CurrencyCode>;
  readonly sampleFee: Money<CurrencyCode>;
  readonly sampleConversion: {
    readonly source: Money<CurrencyCode>;
    readonly atOfficial: Money<CurrencyCode>;
    readonly atReference: Money<CurrencyCode>;
    readonly toClient: Money<CurrencyCode>;
    readonly cost: Money<CurrencyCode>;
    readonly markup: Money<CurrencyCode>;
  };
}

/**
 * Доля в базисных пунктах из дроби. Целочисленно и с усечением: доля с
 * плавающей точкой в денежном домене запрещена (красная линия №4), а базисный
 * пункт — наименьшая единица, в которой владелец о ставке думает.
 */
function bpOf(numerator: bigint, denominator: bigint): number {
  return Number((numerator * 10_000n) / denominator);
}

export async function getTariff(): Promise<TariffView> {
  const deduction = PLATFORM_DEDUCTIONS[0];
  if (deduction === undefined || deduction.rate === undefined) {
    // Тариф без ставки — не тариф. Отказ громкий: сборка падает, а экран не
    // показывает ноль там, где величина потеряна.
    throw new Error('PLATFORM_DEDUCTIONS');
  }
  const sample = money('GEL', 21_700_000n);
  const legs = BUILT.find((item) => item.deal.kind === 'settled_fx');
  const leg = legs?.deal.economics.byCurrency[0]?.conversions[0];
  const version = BUILT.map((item) => item.deal.tariffVersionId).find((value) => value !== null);
  return {
    rateBp: bpOf(deduction.rate.numerator, deduction.rate.denominator),
    fixed: money('GEL', deduction.fixed ?? 0n),
    ceilingBp: bpOf(
      DEFAULT_FEE_CEILING_POLICY.maxShare.numerator,
      DEFAULT_FEE_CEILING_POLICY.maxShare.denominator,
    ),
    markupBp: disclosedMarkupBp(USD_GEL),
    conversionCostBp: leg === undefined ? 0 : bpOf(leg.cost.minor, leg.atOfficial.minor),
    quoteValidityMs: PROPOSED_INTAKE_POLICY.quote.validity,
    quoteDriftBp: PROPOSED_INTAKE_POLICY.quote.driftThreshold.valueBp,
    toleranceShareBp: PROPOSED_INTAKE_POLICY.tolerance.shareBp,
    toleranceAbsolute: PROPOSED_INTAKE_POLICY.tolerance.absolute,
    feePayer: 'recipient',
    feePayerIsSetting: false,
    versionId: version ?? null,
    rates: USD_GEL,
    rateText: USD_GEL_TEXT,
    sample,
    sampleFee: platformFee(sample),
    sampleConversion: {
      source: FX_CONVERTED.source,
      atOfficial: leg?.atOfficial ?? money('GEL', 0n),
      atReference: leg?.atReference ?? money('GEL', 0n),
      toClient: FX_CONVERTED.target,
      cost: leg?.cost ?? money('GEL', 0n),
      markup: leg?.markup ?? money('GEL', 0n),
    },
  };
}
