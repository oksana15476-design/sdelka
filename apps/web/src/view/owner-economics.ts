import {
  type FxExecution,
  type Journal,
  type JournalEntry,
  type Posting,
  type TrancheRef,
  accountType,
  feePositions,
  isClientRef,
} from '@sdelka/ledger';
import {
  type CurrencyCode,
  type Money,
  convertAtRate,
  isNegative,
  isZero,
  money,
  subtract,
} from '@sdelka/money';

/**
 * Экономика сделки и периода — **проекция журнала проводок**, а не отдельный
 * расчёт рядом с ним.
 *
 * ## Почему проекция, а не таблица
 *
 * `BACKLOG.md` E16 говорит прямо: экономика сегодня живёт в исследовательском
 * документе и пересчитывается руками, при том что в системе она считается сама.
 * Расчёт, который **может** разойтись с учётом, — не расчёт: он расходится не
 * когда-нибудь, а в первый же месяц, и узнают об этом по расхождению с банком.
 * Поэтому здесь нет ни одной величины, взятой откуда-либо, кроме проводок; всё,
 * чего в проводках нет, помечено как отсутствующее, а не досчитано.
 *
 * ## Правила, которые здесь держатся
 *
 * 1. **Валюты не суммируются.** Выдача — массив по валютам, и функции «итого»
 *    здесь нет ни одной. Единой цифры «всего» не существует нигде, включая этот
 *    экран (решение владельца). Пересчёт в лари ради одной строки потребовал бы
 *    курса, которого у файла комиссии нет, и превратил бы факт в оценку.
 * 2. **Наценка ставится сверх фактической стоимости конвертации.** Спред целиком
 *    нашим доходом не является: часть его забирает валютный контрагент. Поэтому
 *    у валютной ноги три величины, а не одна: себестоимость (сколько ушло
 *    контрагенту), наценка (`fx:income`, наш доход) и цена клиенту.
 * 3. **Начислено, удержано и получено — три разных числа** (`CORE.md` Ф16,
 *    `FUNCTIONAL.md` §4.6). Они приходят из `feePositions` и не складываются:
 *    сложить их значит потерять ровно то различие, ради которого они заведены.
 * 4. **Плавающей точки нет** (красная линия №4): всё в целых минорных единицах,
 *    курсы — рациональные, пересчёт — `convertAtRate` с явным усечением.
 */

/** Ключ строки дохода. Значение перечня, а не строка: на нём стоит ключ локализации. */
export const REVENUE_KINDS = ['fee_income', 'service_income', 'fx_income'] as const;
export type RevenueKind = (typeof REVENUE_KINDS)[number];

/** Ключ строки прямого расхода. */
export const EXPENSE_KINDS = ['psp_fee_expense', 'oracle_cost_expense', 'shortfall_expense'] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];

/**
 * Нога выручки. Две, как их называет E16-2: комиссия за услугу и наценка на
 * конвертации. Счёт `service:income` попадает в ногу услуги отдельной строкой,
 * а не сливается с `fee:income`: у них **разный режим НДС** (`FUNCTIONAL.md`
 * §4.1), и слияние стёрло бы единственное различие, ради которого они разведены.
 */
export type RevenueLeg = 'service' | 'conversion';

export const REVENUE_LEG_OF: Readonly<Record<RevenueKind, RevenueLeg>> = Object.freeze({
  fee_income: 'service',
  service_income: 'service',
  fx_income: 'conversion',
});

/**
 * Режим НДС по строке дохода — из таблицы `FUNCTIONAL.md` §4.1, а не из расчёта.
 *
 * ⚠ Сумма НДС здесь **не считается намеренно**. `CORE.md` Ф16: форма НДС зависит
 * от открытого блокера — признаётся ли налоговой базой только вознаграждение или
 * вся сумма, прошедшая через счёт, — и «посчитанный на всякий случай налог стал
 * бы фактом системы раньше, чем ответом налоговой». Плана счетов под НДС нет
 * вовсе: ни `vat:payable`, ни `vat:input` в `packages/ledger` не существует,
 * поэтому взять налог из проводок нельзя даже при желании. Показывается режим,
 * а не сумма.
 */
export const VAT_REGIME_OF: Readonly<Record<RevenueKind, 'exempt' | 'standard'>> = Object.freeze({
  fee_income: 'exempt',
  fx_income: 'exempt',
  service_income: 'standard',
});

export interface AmountLine<K extends string> {
  readonly kind: K;
  readonly amount: Money<CurrencyCode>;
}

/**
 * Три состояния комиссии по сделке. Ровно те же величины, что отдаёт
 * `feePositions`, и переименовывать их здесь нельзя: одно имя на слой.
 */
export interface FeeStates {
  readonly accrued: Money<CurrencyCode>;
  readonly notWithheld: Money<CurrencyCode>;
  readonly withheld: Money<CurrencyCode>;
  readonly received: Money<CurrencyCode>;
  readonly inTransit: Money<CurrencyCode>;
}

/**
 * Валютная нога, разобранная так, чтобы наценку было видно **сверх** стоимости.
 *
 * Все четыре величины — во встречной валюте, и получены из одного объявления
 * обмена на записи журнала: `converts` несёт исходную сумму и три курса
 * (`FUNCTIONAL.md` §4.5). Ни одна не досчитана по ставке из настройки.
 *
 * - `atOfficial` — сколько дал бы официальный курс НБГ на дату операции;
 * - `cost` — `atOfficial − atReference`: столько забрал валютный контрагент,
 *   это и есть фактическая стоимость конвертации;
 * - `markup` — `atReference − toClient`: наш доход, он же `fx:income`;
 * - `toClient` — что зачислено клиенту.
 *
 * Складывать `cost` и `markup` в «спред» модуль не умеет намеренно: слитая
 * величина — ровно то заблуждение, из-за которого валютная нога считалась
 * прибыльной при витринном исполнении (`BACKLOG.md`, E0-16).
 */
export interface ConversionLeg {
  readonly conversionId: string;
  readonly source: Money<CurrencyCode>;
  readonly atOfficial: Money<CurrencyCode>;
  readonly atReference: Money<CurrencyCode>;
  readonly toClient: Money<CurrencyCode>;
  readonly cost: Money<CurrencyCode>;
  readonly markup: Money<CurrencyCode>;
}

export interface CurrencyEconomics {
  readonly currency: CurrencyCode;
  /** Сумма сделки, прошедшая расчётом. Ноль — расчёта не было. */
  readonly turnover: Money<CurrencyCode>;
  readonly revenue: readonly AmountLine<RevenueKind>[];
  readonly revenueByLeg: Readonly<Record<RevenueLeg, Money<CurrencyCode>>>;
  readonly expenses: readonly AmountLine<ExpenseKind>[];
  readonly expensesTotal: Money<CurrencyCode>;
  readonly margin: Money<CurrencyCode>;
  readonly fee: FeeStates;
  /** Пусто — конвертации не было. Это ноль в ноге, а не отсутствие ноги. */
  readonly conversions: readonly ConversionLeg[];
}

export interface DealEconomics {
  readonly deal: TrancheRef;
  /**
   * `false` — сделка не завершена, и всё, что ниже, это факт на сегодня, а не
   * итог. Ожидаемую маржу считает экран из тарифа и суммы сделки: в проводках
   * её нет и быть не может, и подмешивать её сюда значило бы выдать ожидание за
   * учёт.
   */
  readonly settled: boolean;
  readonly byCurrency: readonly CurrencyEconomics[];
}

/**
 * Естественная сторона счёта. Дохода — кредит, актива и расхода — дебет.
 * Считается из типа счёта, а не из перечня имён: счёт, заведённый мимо перечня,
 * иначе тихо считался бы с обратным знаком.
 */
function signedMinor(posting: Posting): bigint {
  const type = accountType(posting.account);
  const natural = type === 'asset' || type === 'expense' ? 'debit' : 'credit';
  return posting.direction === natural ? posting.amount.minor : -posting.amount.minor;
}

function belongsTo(posting: Posting, deal: TrancheRef): boolean {
  const attribution = posting.attribution;
  return (
    attribution !== null &&
    !isClientRef(attribution) &&
    attribution.dealId === deal.dealId &&
    attribution.trancheId === deal.trancheId
  );
}

class Bucket {
  readonly revenue = new Map<RevenueKind, bigint>();
  readonly expenses = new Map<ExpenseKind, bigint>();
  turnover = 0n;
  readonly conversions: ConversionLeg[] = [];
}

function bucketOf(map: Map<CurrencyCode, Bucket>, currency: CurrencyCode): Bucket {
  const existing = map.get(currency);
  if (existing !== undefined) return existing;
  const fresh = new Bucket();
  map.set(currency, fresh);
  return fresh;
}

function isRevenueKind(kind: string): kind is RevenueKind {
  return (REVENUE_KINDS as readonly string[]).includes(kind);
}

function isExpenseKind(kind: string): kind is ExpenseKind {
  return (EXPENSE_KINDS as readonly string[]).includes(kind);
}

/**
 * Валютная нога из объявления обмена на записи.
 *
 * Пересчёт — `convertAtRate` с усечением, тем же, каким считает сам обмен
 * (`FUNCTIONAL.md` §4.3: направление округления задаётся явно, значения по
 * умолчанию у операции нет). Иначе `atReference` разошёлся бы с `platformSpread`
 * на минорную единицу, и наценка на экране не сошлась бы с `fx:income` в
 * журнале — а именно это равенство здесь и проверяется тестом.
 */
function conversionLeg(execution: FxExecution): ConversionLeg {
  const converted = execution.converted;
  const atReference = convertAtRate(converted.source, converted.rates.reference, 'trunc');
  const atOfficial = convertAtRate(converted.source, converted.rates.official, 'trunc');
  return Object.freeze({
    conversionId: execution.conversionId,
    source: converted.source,
    atOfficial,
    atReference,
    toClient: converted.target,
    cost: subtract(atOfficial, atReference),
    markup: subtract(atReference, converted.target),
  });
}

/**
 * Обмен относится к сделке **файлом клиента, а не отнесением проводки**.
 *
 * ⚠ Дыра, которую здесь обходить нечем и которая названа в отчёте: проводки
 * дохода в `receiveConversion` (`packages/ledger/src/entries.ts`) отнесения не
 * несут вовсе, а сам обмен отнесён к файлу клиента, потому что конвертируются
 * деньги клиента, а не транша. Связать `fx:income` со сделкой в общем журнале
 * сегодня нельзя ничем.
 *
 * Здесь это работает потому, что журнал строится по сделке: в нём нет чужих
 * обменов. На общем журнале потребуется отнесение к траншу на проводках спреда —
 * это правка `packages/ledger`, которым владеет другой пакет.
 */
function collectConversions(entry: JournalEntry, buckets: Map<CurrencyCode, Bucket>): void {
  const converts = entry.converts;
  if (converts === null) return;
  const leg = conversionLeg(converts);
  const bucket = bucketOf(buckets, leg.toClient.currency);
  if (bucket.conversions.some((item) => item.conversionId === leg.conversionId)) return;
  bucket.conversions.push(leg);
}

/**
 * Экономика одной сделки из журнала.
 *
 * `settled` приходит снаружи, из состояния транша: учёт про расчёт знает только
 * то, что деньги ушли, а «сделка завершена» — факт домена, и подменять его
 * признаком «есть проводка расчёта» значило бы завести второй ответ на тот же
 * вопрос.
 */
export function dealEconomics(
  journal: Journal,
  deal: TrancheRef,
  settled: boolean,
): DealEconomics {
  const buckets = new Map<CurrencyCode, Bucket>();

  for (const entry of journal.entries) {
    collectConversions(entry, buckets);
    for (const posting of entry.postings) {
      const kind = posting.account.kind;
      const currency = posting.amount.currency;
      if (isRevenueKind(kind)) {
        // Отнесение обязательно у комиссии и необязательно у спреда: см.
        // `collectConversions`. Спред без отнесения относится к сделке потому,
        // что журнал сделки построен по ней.
        if (kind !== 'fx_income' && !belongsTo(posting, deal)) continue;
        const bucket = bucketOf(buckets, currency);
        bucket.revenue.set(kind, (bucket.revenue.get(kind) ?? 0n) + signedMinor(posting));
        continue;
      }
      if (isExpenseKind(kind)) {
        if (!belongsTo(posting, deal)) continue;
        const bucket = bucketOf(buckets, currency);
        bucket.expenses.set(kind, (bucket.expenses.get(kind) ?? 0n) + signedMinor(posting));
        continue;
      }
      // Оборот сделки — сумма, списанная с запертой части при расчёте: именно
      // она прошла через нас, и именно её видит регулятор в объёме. Зачисление
      // получателю для оборота не годится: оно нетто, то есть уже без комиссии.
      if (
        posting.account.kind === 'client_locked' &&
        posting.direction === 'debit' &&
        posting.account.dealId === deal.dealId &&
        posting.account.trancheId === deal.trancheId &&
        entry.settles !== null
      ) {
        bucketOf(buckets, currency).turnover += posting.amount.minor;
      }
    }
  }

  const fees = feePositions(journal).filter(
    (item) => item.deal.dealId === deal.dealId && item.deal.trancheId === deal.trancheId,
  );
  for (const position of fees) bucketOf(buckets, position.currency);

  const byCurrency = [...buckets.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([currency, bucket]) => {
      const revenue = REVENUE_KINDS.filter((kind) => bucket.revenue.has(kind)).map((kind) =>
        Object.freeze({ kind, amount: money(currency, bucket.revenue.get(kind) ?? 0n) }),
      );
      const expenses = EXPENSE_KINDS.filter((kind) => bucket.expenses.has(kind)).map((kind) =>
        Object.freeze({ kind, amount: money(currency, bucket.expenses.get(kind) ?? 0n) }),
      );
      let service = 0n;
      let conversion = 0n;
      for (const line of revenue) {
        if (REVENUE_LEG_OF[line.kind] === 'service') service += line.amount.minor;
        else conversion += line.amount.minor;
      }
      const expensesTotal = expenses.reduce((total, line) => total + line.amount.minor, 0n);
      const position = fees.find((item) => item.currency === currency);
      const zero = money(currency, 0n);
      return Object.freeze({
        currency,
        turnover: money(currency, bucket.turnover),
        revenue: Object.freeze(revenue),
        revenueByLeg: Object.freeze({
          service: money(currency, service),
          conversion: money(currency, conversion),
        }),
        expenses: Object.freeze(expenses),
        expensesTotal: money(currency, expensesTotal),
        margin: money(currency, service + conversion - expensesTotal),
        fee:
          position === undefined
            ? Object.freeze({
                accrued: zero,
                notWithheld: zero,
                withheld: zero,
                received: zero,
                inTransit: zero,
              })
            : Object.freeze({
                accrued: position.accrued,
                notWithheld: position.notWithheld,
                withheld: position.withheld,
                received: position.received,
                inTransit: position.inTransit,
              }),
        conversions: Object.freeze(bucket.conversions),
      });
    });

  return Object.freeze({ deal: Object.freeze({ ...deal }), settled, byCurrency });
}

/* --------------------------------------------------------- сводка за период */

export interface PeriodCurrencyTotals {
  readonly currency: CurrencyCode;
  readonly turnover: Money<CurrencyCode>;
  readonly revenueByLeg: Readonly<Record<RevenueLeg, Money<CurrencyCode>>>;
  readonly revenue: readonly AmountLine<RevenueKind>[];
  readonly cost: Money<CurrencyCode>;
  readonly margin: Money<CurrencyCode>;
  /** Сколько завершённых сделок дали этот оборот — база среднего чека. */
  readonly settledDeals: number;
  /** Средний чек по **завершённым**; `null` — завершённых в периоде нет. */
  readonly averageDeal: Money<CurrencyCode> | null;
}

export interface PeriodSummary {
  readonly deals: number;
  readonly settledDeals: number;
  readonly byCurrency: readonly PeriodCurrencyTotals[];
}

export interface PeriodInput {
  readonly deal: TrancheRef;
  readonly economics: DealEconomics;
}

/**
 * Сводка за период. Складывает **только одноимённые валюты**, и это не
 * ограничение реализации, а правило: остатки и обороты в разных валютах не
 * суммируются, единой цифры «всего» не существует (решение владельца).
 *
 * Средний чек считается по завершённым сделкам, потому что у незавершённой чека
 * ещё нет: включить её значит поделить оборот на большее число и получить
 * величину, которая падает от того, что сделок стало больше.
 */
export function periodSummary(items: readonly PeriodInput[]): PeriodSummary {
  interface Totals {
    turnover: bigint;
    service: bigint;
    conversion: bigint;
    revenue: Map<RevenueKind, bigint>;
    cost: bigint;
    settled: number;
  }
  const byCurrency = new Map<CurrencyCode, Totals>();
  let settledDeals = 0;

  for (const item of items) {
    if (item.economics.settled) settledDeals += 1;
    for (const slice of item.economics.byCurrency) {
      const totals = byCurrency.get(slice.currency) ?? {
        turnover: 0n,
        service: 0n,
        conversion: 0n,
        revenue: new Map<RevenueKind, bigint>(),
        cost: 0n,
        settled: 0,
      };
      totals.turnover += slice.turnover.minor;
      totals.service += slice.revenueByLeg.service.minor;
      totals.conversion += slice.revenueByLeg.conversion.minor;
      for (const line of slice.revenue) {
        totals.revenue.set(line.kind, (totals.revenue.get(line.kind) ?? 0n) + line.amount.minor);
      }
      totals.cost += slice.expensesTotal.minor;
      if (item.economics.settled && slice.turnover.minor > 0n) totals.settled += 1;
      byCurrency.set(slice.currency, totals);
    }
  }

  return Object.freeze({
    deals: items.length,
    settledDeals,
    byCurrency: Object.freeze(
      [...byCurrency.entries()]
        .sort((left, right) => (left[0] < right[0] ? -1 : 1))
        .map(([currency, totals]) =>
          Object.freeze({
            currency,
            turnover: money(currency, totals.turnover),
            revenueByLeg: Object.freeze({
              service: money(currency, totals.service),
              conversion: money(currency, totals.conversion),
            }),
            revenue: Object.freeze(
              REVENUE_KINDS.filter((kind) => totals.revenue.has(kind)).map((kind) =>
                Object.freeze({ kind, amount: money(currency, totals.revenue.get(kind) ?? 0n) }),
              ),
            ),
            cost: money(currency, totals.cost),
            margin: money(currency, totals.service + totals.conversion - totals.cost),
            settledDeals: totals.settled,
            averageDeal:
              totals.settled === 0
                ? null
                : money(currency, totals.turnover / BigInt(totals.settled)),
          }),
        ),
    ),
  });
}

/* ------------------------------------------------- порог значимости провайдера */

/**
 * Порог значимости платёжного провайдера — **9 млн лари среднемесячного
 * объёма** (`ROADMAP.md` Г3, `ACTORS.md`). За ним включаются требования к
 * капиталу (125 000 ₾) и режим значимого провайдера, и пройти его надо
 * осознанно, а не обнаружить по факту.
 */
export const SIGNIFICANCE_THRESHOLD: Money<'GEL'> = Object.freeze({
  currency: 'GEL' as const,
  minor: 900_000_000n,
});

/** Доля порога, с которой блок перестаёт быть справочным и становится предупреждением. */
export const SIGNIFICANCE_WARN_AT_BP = 7_500;

export interface SignificanceView {
  readonly monthly: Money<'GEL'>;
  readonly threshold: Money<'GEL'>;
  readonly headroom: Money<'GEL'>;
  /** Доля порога в базисных пунктах: целое, без плавающей точки. */
  readonly shareBp: number;
  readonly warn: boolean;
}

/**
 * ⚠ Считается **только по обороту в лари**, и это не упрощение, а следствие
 * правила: обороты в разных валютах не суммируются, а порог назван в лари.
 * Пересчёт валютного оборота в лари ради этой цифры — отдельное решение
 * владельца с ценой: до ответа сюда попадает лишь лариевая нога, и цифра
 * заведомо **занижена**. Занижение названо на экране, а не спрятано.
 */
export function significance(monthlyGel: Money<'GEL'>): SignificanceView {
  const threshold = SIGNIFICANCE_THRESHOLD;
  const shareBp = Number((monthlyGel.minor * 10_000n) / threshold.minor);
  return Object.freeze({
    monthly: monthlyGel,
    threshold,
    headroom: subtract(threshold, monthlyGel),
    shareBp,
    warn: shareBp >= SIGNIFICANCE_WARN_AT_BP,
  });
}

/** Тон строки денег: минус, ноль и плюс читаются разными знаками, а не только цветом. */
export function moneyTone(value: Money<CurrencyCode>): 'ok' | 'danger' | 'wait' {
  if (isNegative(value)) return 'danger';
  if (isZero(value)) return 'wait';
  return 'ok';
}
