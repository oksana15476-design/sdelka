import {
  type Journal,
  type JournalEntry,
  type TrancheRef,
  clientAccountFile,
  isClientObligationAccount,
  isClientRef,
  poolDirection,
} from '@sdelka/ledger';
import {
  type CurrencyCode,
  type FxRate,
  type IsoDate,
  type Money,
  convertAtRate,
  isoDate,
  money,
  subtract,
} from '@sdelka/money';
import {
  type AmountLine,
  type ExpenseKind,
  type RevenueKind,
  type RevenueLeg,
  EXPENSE_KINDS,
  REVENUE_KINDS,
  REVENUE_LEG_OF,
  SIGNIFICANCE_THRESHOLD,
  SIGNIFICANCE_WARN_AT_BP,
  naturalMinor,
} from './owner-economics';

/**
 * Как идут дела **за период** — проекция журнала проводок, а не второй расчёт
 * рядом с ним (И16.3, `ROADMAP.md`).
 *
 * ## Чем это отличается от `periodSummary` в `owner-economics.ts`
 *
 * Тот складывает уже посчитанные `DealEconomics` по списку сделок: период в нём
 * — свойство **вызывающего**, который сам решил, какая сделка в какой месяц
 * попала, а всё, что не относится ни к одной сделке, в сводку не попадает
 * вовсе. Здесь период — свойство **журнала**: величина считается по проводкам,
 * попавшим в окно по `occurredAt`, и расход без отнесения к сделке (недостача
 * относится к клиенту, а не к траншу) из сводки не исчезает.
 *
 * Две сводки живут рядом временно: экран владельца читает старую, а экран —
 * это `app/**`, которым этот заход не владеет. Что делать со старой после
 * перевода экрана — **[открыто]**, см. отчёт по батчу.
 *
 * ## Правила, которые здесь держатся
 *
 * 1. **Валюты не суммируются** — выдача повалютная, функции «итого по всем
 *    валютам» здесь нет ни одной. Единственный пересчёт в лари живёт в
 *    `significanceApproach`, где порог назван в лари законом, и делается он по
 *    официальному курсу на дату операции, а не по курсу «на сегодня».
 * 2. **Плавающей точки нет** (красная линия №4): всё в целых минорных единицах,
 *    доли — в базисных пунктах, деление — целочисленное с явным направлением.
 * 3. **Ничего не оценивается.** Величина, которой в проводках нет, в сводке не
 *    появляется: валюта без операций не даёт нулевой строки, запись без
 *    читаемой даты не растворяется в периоде, а называется по идентификатору.
 * 4. **Начислено, удержано и получено — три числа** (`FUNCTIONAL.md` §4.6), и
 *    они не складываются.
 * 5. **Наш спред и учётная курсовая разница — разные величины** (§4.5): первая
 *    в выручке, вторая рядом и **не** в результате.
 */

/**
 * Окно периода: полуинтервал `[from, to)` в миллисекундах эпохи.
 *
 * Полуинтервал, потому что месяцы обязаны стыковаться без нахлёста: запись
 * ровно в полночь первого числа принадлежит одному месяцу, а не двум.
 *
 * Календарь считает вызывающий. Проекция журнала не знает ни часового пояса
 * владельца, ни того, что считать месяцем, и заводить здесь второй календарь
 * значило бы получить два ответа на вопрос «какой это месяц».
 */
export interface JournalPeriod {
  readonly from: number;
  readonly to: number;
}

/**
 * Исход по траншу. Три, как их называет владелец: расчёт, возврат, списание.
 *
 * Читаются **из проводок**, а не из состояния транша: состояние живёт в домене
 * и до сводки не доезжает, а деньги, ушедшие из запертой части, — факт журнала.
 * Признак у всех трёх один — дебет `client:{владелец}:tranche:{сделка}:{транш}`;
 * различает их встречная нога.
 */
export const PERIOD_OUTCOMES = ['settled', 'refunded', 'written_off'] as const;
export type PeriodOutcome = (typeof PERIOD_OUTCOMES)[number];

/**
 * Сколько сделок и траншей пришло к исходу.
 *
 * Числа по трём исходам **не обязаны складываться в число сделок периода**: у
 * транша бывает больше одного исхода (частичный возврат резерва, потом расчёт
 * остатка), и такой транш честно считается в обоих.
 */
export interface OutcomeCount {
  readonly deals: number;
  readonly tranches: number;
}

/**
 * Три состояния комиссии как **движение за период**, а не как остаток.
 *
 * - `accrued` — признано доходом (`Кт fee:income`);
 * - `withheld` — удержано из платежа в транзит (`Дт transit:fee`);
 * - `received` — дошло до операционного счёта (`Кт transit:fee`).
 *
 * «Удержано, не получено» здесь нет намеренно: это **остаток** на транзитном
 * счёте, то есть величина на дату, а не за период. Разность движений за
 * произвольное окно ей не равна — удержанное в прошлом месяце доходит в этом,
 * — и назвать разность остатком значило бы завести вторую, расходящуюся,
 * модель того же счёта. Остаток отдаёт `feePositions` из `packages/ledger`.
 */
export interface PeriodFeeFlow {
  readonly accrued: Money<CurrencyCode>;
  readonly withheld: Money<CurrencyCode>;
  readonly received: Money<CurrencyCode>;
}

export interface PeriodCurrencySummary {
  readonly currency: CurrencyCode;
  /**
   * Оборот **принятых средств**: сколько чужих денег вошло в учёт за период.
   *
   * Считается по приросту обязательств перед клиентами в записи, а не по
   * дебету номинального счёта: номинальный счёт дебетуется и при переносе
   * файла (опознание поступления, запирание под транш), где ничего не
   * поступало. Внутренние переносы дают ноль сами собой — обязательство
   * уходит с одного счёта и приходит на другой в той же записи.
   *
   * Что сюда **не** попадает и почему:
   * - записи с объявлением обмена (`converts`): конвертация переоформляет уже
   *   принятые деньги в другую валюту, и вторая нога считалась бы вторым
   *   поступлением — тот же оборот дважды, в двух валютах;
   * - записи с объявлением расчёта (`settles`): расчёт и его реверс двигают
   *   обязательство между клиентами, снаружи не приходит ничего;
   * - выплаты, возвраты и списания: оборот принятых средств от них не
   *   уменьшается — деньги были приняты, и это отдельный факт от того, что
   *   потом с ними стало (исходы считаются отдельно).
   *
   * Уменьшают его только исправления (`kind: 'correction'`), снимающие
   * ошибочно записанное поступление: у них обязательство падает, и оборот
   * падает вместе с ним.
   */
  readonly intake: Money<CurrencyCode>;
  /** Сколько денег ушло из запертых частей по каждому исходу. */
  readonly outcomes: Readonly<Record<PeriodOutcome, Money<CurrencyCode>>>;
  readonly fee: PeriodFeeFlow;
  readonly revenue: readonly AmountLine<RevenueKind>[];
  readonly revenueByLeg: Readonly<Record<RevenueLeg, Money<CurrencyCode>>>;
  readonly revenueTotal: Money<CurrencyCode>;
  readonly expenses: readonly AmountLine<ExpenseKind>[];
  readonly expensesTotal: Money<CurrencyCode>;
  /** Выручка минус прямые расходы. Ни налога, ни постоянных затрат здесь нет. */
  readonly result: Money<CurrencyCode>;
  /**
   * Учётная курсовая разница по официальному курсу (`fx:accounting:diff`).
   *
   * Стоит **рядом с результатом, а не в нём**, и это не осторожность, а §4.5:
   * наш спред (`fx:income`, он же нога `conversion` в выручке) и учётная
   * разница — разные показатели, смешивать их нельзя. Знак — естественная
   * сторона счёта: плюс это расход, минус это доход. Включать разницу в
   * результат — решение владельца, здесь его нет.
   */
  readonly accountingFxDifference: Money<CurrencyCode>;
}

export interface PeriodJournalSummary {
  readonly period: JournalPeriod;
  /** Записей журнала, попавших в окно. Ноль — период пуст, а не сломан. */
  readonly entries: number;
  /**
   * Записи, дату которых прочитать не удалось: в период их не отнести, и молча
   * выкинуть их нельзя — выкинутая запись это потерянные деньги в сводке.
   * Названы идентификаторами, чтобы их можно было найти в журнале.
   */
  readonly undated: readonly string[];
  readonly outcomes: Readonly<Record<PeriodOutcome, OutcomeCount>>;
  /**
   * Расчёты, отмотанные назад исправлением. В исходы такой расчёт не попадает
   * — факта больше нет, — но исчезнуть бесследно тоже не может.
   *
   * ⚠ Реверс учитывается **где бы он ни лежал в журнале**, в том числе позже
   * периода: сводка отвечает «как было на самом деле», а не «что мы думали в
   * конце месяца». Замораживать период на его конце — другое поведение и
   * другое решение владельца, **[открыто]**.
   */
  readonly settlementsReversed: number;
  /**
   * Записи, где из запертой части ушли деньги, а исход не читается ни как
   * расчёт, ни как возврат, ни как списание. Пусто в норме; непусто — значит
   * в журнале появилась форма, которой сводка не знает, и её нельзя тихо
   * посчитать нулём.
   */
  readonly unclassifiedOutflows: readonly string[];
  readonly byCurrency: readonly PeriodCurrencySummary[];
}

/* ------------------------------------------------------------------- разбор */

interface CurrencyBucket {
  intake: bigint;
  readonly outcomes: Map<PeriodOutcome, bigint>;
  feeAccrued: bigint;
  feeWithheld: bigint;
  feeReceived: bigint;
  readonly revenue: Map<RevenueKind, bigint>;
  readonly expenses: Map<ExpenseKind, bigint>;
  accountingFx: bigint;
}

/** Одно поступление или один расчёт с датой: сырьё для пересчёта в лари. */
interface DatedAmount {
  readonly on: IsoDate;
  readonly amount: Money<CurrencyCode>;
}

interface Scan {
  entries: number;
  readonly undated: string[];
  readonly buckets: Map<CurrencyCode, CurrencyBucket>;
  readonly outcomeDeals: Readonly<Record<PeriodOutcome, Set<string>>>;
  readonly outcomeTranches: Readonly<Record<PeriodOutcome, Set<string>>>;
  settlementsReversed: number;
  readonly unclassifiedOutflows: string[];
  /** Поступления по датам — для пересчёта по курсу **на дату операции**. */
  readonly intakeDated: DatedAmount[];
  /** Расчёты по датам: из них считается средний размер сделки. */
  readonly settledDated: DatedAmount[];
}

/**
 * Запись по всем трём исходам сразу. Перечень один (`PERIOD_OUTCOMES`), поэтому
 * четвёртый исход, когда он появится, обязан быть заполнен здесь же — а не
 * забыт в одном из мест, где исходы перечислены руками.
 */
function outcomeRecord<T>(make: (outcome: PeriodOutcome) => T): Readonly<Record<PeriodOutcome, T>> {
  const record = {} as Record<PeriodOutcome, T>;
  for (const outcome of PERIOD_OUTCOMES) record[outcome] = make(outcome);
  return Object.freeze(record);
}

function freshBucket(): CurrencyBucket {
  return {
    intake: 0n,
    outcomes: new Map<PeriodOutcome, bigint>(),
    feeAccrued: 0n,
    feeWithheld: 0n,
    feeReceived: 0n,
    revenue: new Map<RevenueKind, bigint>(),
    expenses: new Map<ExpenseKind, bigint>(),
    accountingFx: 0n,
  };
}

function bucketOf(scan: Scan, currency: CurrencyCode): CurrencyBucket {
  const existing = scan.buckets.get(currency);
  if (existing !== undefined) return existing;
  const fresh = freshBucket();
  scan.buckets.set(currency, fresh);
  return fresh;
}

function isRevenueKind(kind: string): kind is RevenueKind {
  return (REVENUE_KINDS as readonly string[]).includes(kind);
}

function isExpenseKind(kind: string): kind is ExpenseKind {
  return (EXPENSE_KINDS as readonly string[]).includes(kind);
}

/**
 * Календарная дата операции — из момента записи, а не из первых десяти символов
 * строки: строка приезжает из базы и из сериализации, где смещение зоны бывает
 * любым, и `slice(0, 10)` на `…T23:00:00+04:00` дал бы дату по местному
 * времени клиента, а не по одному календарю для всех.
 *
 * ⚠ Календарь здесь **UTC**, а официальный курс НБГ публикуется на грузинский
 * банковский день (UTC+4). Операция после 20:00 по Тбилиси получит вчерашнюю
 * дату и вчерашний курс. Правильная зона — решение владельца, **[открыто]**;
 * до ответа берётся зона, одинаковая для всех записей, а не разная.
 *
 * `null` — момент за пределами календаря ISO. Проекция журнала не падает на
 * негодных данных: такая запись попадает в «без даты», где её видно по имени.
 */
function dateOf(at: number): IsoDate | null {
  try {
    return isoDate(new Date(at).toISOString().slice(0, 10));
  } catch {
    return null;
  }
}

/** Момент записи. `null` — дату прочитать нечем. */
function instantOf(entry: JournalEntry): number | null {
  const at = Date.parse(entry.occurredAt);
  return Number.isFinite(at) ? at : null;
}

/**
 * Прирост обязательств перед клиентами в записи, повалютно.
 *
 * Обязательство — свойство природы счёта (`isClientObligationAccount`), а не
 * перечня имён: перечень уже дважды оказывался неполным в `packages/ledger`, и
 * заводить его третий раз здесь нельзя.
 */
function obligationGrowth(entry: JournalEntry): ReadonlyMap<CurrencyCode, bigint> {
  const growth = new Map<CurrencyCode, bigint>();
  for (const posting of entry.postings) {
    if (!isClientObligationAccount(posting.account)) continue;
    const currency = posting.amount.currency;
    const signed = posting.direction === 'credit' ? posting.amount.minor : -posting.amount.minor;
    growth.set(currency, (growth.get(currency) ?? 0n) + signed);
  }
  return growth;
}

/**
 * Исход записи по встречной ноге. `null` — запись из запертой части ничего не
 * забирает или забирает способом, которого сводка не знает.
 *
 * Порядок проверок значим: списание невостребованного тоже кредитует
 * номинальный счёт и тоже закрывает транш, а расчёт — единственная форма, где
 * деньги уходят **другому клиенту**, и он назван объявлением.
 */
function outcomeOf(entry: JournalEntry): PeriodOutcome | null {
  if (entry.settles !== null) return 'settled';
  for (const posting of entry.postings) {
    if (posting.direction !== 'credit') continue;
    if (poolDirection(posting.account) === 'terminal') return 'written_off';
  }
  for (const posting of entry.postings) {
    if (posting.direction !== 'credit') continue;
    const file = clientAccountFile(posting.account);
    // Свободная часть счёта клиента: файл читается из кода счёта и не несёт
    // транша. Красная линия №7 — при бездействии деньги возвращаются клиенту.
    if (file !== null && isClientRef(file)) return 'refunded';
  }
  return null;
}

/**
 * Сколько и по каким траншам ушло из запертых частей в этой записи.
 *
 * Транш берётся **из кода счёта**, а не из отнесения проводки: у запертой части
 * владелец и транш стоят в коде (`accounts.ts`), и отнесение с ними может
 * разойтись только по ошибке — а сводка исходов обязана считать по тому же
 * признаку, по которому учёт держит красную линию №1.
 */
function drainedTranches(entry: JournalEntry): readonly (TrancheRef & {
  readonly amount: Money<CurrencyCode>;
})[] {
  const out: (TrancheRef & { readonly amount: Money<CurrencyCode> })[] = [];
  for (const posting of entry.postings) {
    const account = posting.account;
    if (account.kind !== 'client_locked' || posting.direction !== 'debit') continue;
    out.push({ dealId: account.dealId, trancheId: account.trancheId, amount: posting.amount });
  }
  return out;
}

/** Идентификаторы расчётов, отмотанных исправлением где угодно в журнале. */
function reversedSettlements(journal: Journal): ReadonlySet<string> {
  const reversed = new Set<string>();
  for (const entry of journal.entries) {
    if (entry.kind !== 'correction') continue;
    if (entry.settles === null || entry.correctsEntryId === null) continue;
    reversed.add(entry.correctsEntryId);
  }
  return reversed;
}

function scanPeriod(journal: Journal, period: JournalPeriod): Scan {
  const scan: Scan = {
    entries: 0,
    undated: [],
    buckets: new Map<CurrencyCode, CurrencyBucket>(),
    outcomeDeals: outcomeRecord(() => new Set<string>()),
    outcomeTranches: outcomeRecord(() => new Set<string>()),
    settlementsReversed: 0,
    unclassifiedOutflows: [],
    intakeDated: [],
    settledDated: [],
  };
  const reversed = reversedSettlements(journal);

  for (const entry of journal.entries) {
    const at = instantOf(entry);
    if (at === null) {
      scan.undated.push(entry.id);
      continue;
    }
    if (at < period.from || at >= period.to) continue;
    const on = dateOf(at);
    if (on === null) {
      scan.undated.push(entry.id);
      continue;
    }
    scan.entries += 1;

    // Оборот принятых средств.
    if (entry.converts === null && entry.settles === null) {
      for (const [currency, growth] of obligationGrowth(entry)) {
        // Обычная запись даёт только прирост: уход денег — это исход, а не
        // отрицательное поступление. Исправление даёт только убыль: оно
        // снимает ошибочно записанное поступление.
        const contribution =
          entry.kind === 'settlement' ? (growth > 0n ? growth : 0n) : growth < 0n ? growth : 0n;
        if (contribution === 0n) continue;
        bucketOf(scan, currency).intake += contribution;
        scan.intakeDated.push({ on, amount: money(currency, contribution) });
      }
    }

    // Исходы по траншам. Отмотанный расчёт исходом не является: факта больше
    // нет, и считать его вместе с его же реверсом значило бы показать сделку,
    // которой не было. Реверс при этом виден отдельным числом.
    if (entry.kind === 'settlement' && !reversed.has(entry.id)) {
      const drained = drainedTranches(entry);
      if (drained.length > 0) {
        const outcome = outcomeOf(entry);
        if (outcome === null) {
          scan.unclassifiedOutflows.push(entry.id);
        } else {
          for (const item of drained) {
            const bucket = bucketOf(scan, item.amount.currency);
            bucket.outcomes.set(outcome, (bucket.outcomes.get(outcome) ?? 0n) + item.amount.minor);
            scan.outcomeDeals[outcome].add(item.dealId);
            scan.outcomeTranches[outcome].add(`${item.dealId}|${item.trancheId}`);
            if (outcome === 'settled') scan.settledDated.push({ on, amount: item.amount });
          }
        }
      }
    } else if (entry.kind === 'correction' && entry.settles !== null) {
      scan.settlementsReversed += 1;
    }

    // Выручка, расходы, комиссия, учётная разница.
    for (const posting of entry.postings) {
      const kind = posting.account.kind;
      const currency = posting.amount.currency;
      if (isRevenueKind(kind)) {
        const bucket = bucketOf(scan, currency);
        bucket.revenue.set(kind, (bucket.revenue.get(kind) ?? 0n) + naturalMinor(posting));
        if (kind === 'fee_income') bucket.feeAccrued += naturalMinor(posting);
        continue;
      }
      if (isExpenseKind(kind)) {
        const bucket = bucketOf(scan, currency);
        bucket.expenses.set(kind, (bucket.expenses.get(kind) ?? 0n) + naturalMinor(posting));
        continue;
      }
      if (kind === 'transit_fee') {
        const bucket = bucketOf(scan, currency);
        if (posting.direction === 'debit') bucket.feeWithheld += posting.amount.minor;
        else bucket.feeReceived += posting.amount.minor;
        continue;
      }
      if (kind === 'fx_accounting_diff') {
        bucketOf(scan, currency).accountingFx += naturalMinor(posting);
      }
    }
  }

  return scan;
}

/* --------------------------------------------------------- сводка за период */

export function periodJournalSummary(
  journal: Journal,
  period: JournalPeriod,
): PeriodJournalSummary {
  const scan = scanPeriod(journal, period);

  const byCurrency = [...scan.buckets.entries()]
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
      return Object.freeze({
        currency,
        intake: money(currency, bucket.intake),
        outcomes: outcomeRecord((outcome) => money(currency, bucket.outcomes.get(outcome) ?? 0n)),
        fee: Object.freeze({
          accrued: money(currency, bucket.feeAccrued),
          withheld: money(currency, bucket.feeWithheld),
          received: money(currency, bucket.feeReceived),
        }),
        revenue: Object.freeze(revenue),
        revenueByLeg: Object.freeze({
          service: money(currency, service),
          conversion: money(currency, conversion),
        }),
        revenueTotal: money(currency, service + conversion),
        expenses: Object.freeze(expenses),
        expensesTotal: money(currency, expensesTotal),
        result: money(currency, service + conversion - expensesTotal),
        accountingFxDifference: money(currency, bucket.accountingFx),
      });
    });

  return Object.freeze({
    period: Object.freeze({ from: period.from, to: period.to }),
    entries: scan.entries,
    undated: Object.freeze([...scan.undated]),
    outcomes: outcomeRecord((outcome) =>
      Object.freeze({
        deals: scan.outcomeDeals[outcome].size,
        tranches: scan.outcomeTranches[outcome].size,
      }),
    ),
    settlementsReversed: scan.settlementsReversed,
    unclassifiedOutflows: Object.freeze([...scan.unclassifiedOutflows]),
    byCurrency: Object.freeze(byCurrency),
  });
}

/* ------------------------------------------------- порог значимости провайдера */

/**
 * Окно измерения порога — **последние 12 месяцев**.
 *
 * **[установлено]** Приказ президента НБГ №77/04 от 01.05.2023 (редакция
 * 27.02.2025), ст. 5(1): значимым считается провайдер, у которого среднемесячный
 * объём платёжных операций **за последние 12 месяцев превышает 9 000 000 лари**
 * (`docs/research/BLOCKERS-DESK.md`). Сам порог живёт в
 * `SIGNIFICANCE_THRESHOLD` — здесь окно, а не сумма: одно имя на величину.
 */
export const SIGNIFICANCE_WINDOW_MONTHS = 12;

/**
 * Официальный курс к лари на дату операции. `null` — курса на эту дату нет.
 *
 * Функция, а не таблица: источник курса (НБГ, база, кэш) — не дело проекции, а
 * `null` обязан быть выразим. Подставить вместо отсутствующего курса ноль,
 * единицу или курс соседнего дня нельзя ни одним из трёх способов: ноль
 * обнуляет чужой оборот, единица приравнивает доллар к лари, а курс соседнего
 * дня — это уже оценка, которой в журнале нет.
 *
 * Пара курса проверяется дважды: типами (`FxRate` несёт базу и котировку) и
 * рантаймом внутри `convertAtRate` — типы не переживают границу процесса.
 */
export type OfficialRateLookup = (
  currency: CurrencyCode,
  on: IsoDate,
) => FxRate<CurrencyCode, 'GEL'> | null;

/** Сумма, которую не на что пересчитать: курса на её дату нет. */
export interface UnpricedAmount {
  /** Какую величину недосчитали: оборот или средний размер сделки. */
  readonly of: 'intake' | 'settlement';
  readonly on: IsoDate;
  readonly amount: Money<CurrencyCode>;
}

interface SignificanceCommon {
  /** Сколько месяцев в окне: делитель среднемесячного объёма. */
  readonly months: number;
  /** Окно равно регуляторному (12 месяцев). Короче — величина не та, что в ст. 5(1). */
  readonly regulatoryWindow: boolean;
  readonly threshold: Money<'GEL'>;
  readonly unpriced: readonly UnpricedAmount[];
}

/**
 * Приближение к порогу значимости — величина, которую владелец видит **заранее**.
 *
 * Союз с признаком `known`, а не поля с `null`: «не посчитано» обязано быть
 * состоянием, которое вызывающий не может случайно прочитать как ноль. За
 * порогом включается режим значимого провайдера и требования к капиталу, и
 * ноль вместо неизвестности здесь — это «всё спокойно» вместо «мы не знаем».
 */
export type SignificanceApproach =
  | (SignificanceCommon & {
      readonly known: false;
      /** Ключ причины, а не текст: локализация живёт в словаре. */
      readonly reason: 'no_months' | 'missing_official_rate';
    })
  | (SignificanceCommon & {
      readonly known: true;
      /** Объём принятых средств за всё окно, в лари. */
      readonly volume: Money<'GEL'>;
      readonly monthly: Money<'GEL'>;
      /** Порог минус среднемесячный объём. Минус — порог уже пройден. */
      readonly headroom: Money<'GEL'>;
      /** Доля порога в базисных пунктах: целое, без плавающей точки. */
      readonly shareBp: number;
      readonly warn: boolean;
      readonly crossed: boolean;
      /** Число расчётов, по которым посчитан средний размер сделки. */
      readonly settledTranches: number;
      /** Средний размер расчитанной сделки в лари. `null` — расчётов в окне нет. */
      readonly averageDeal: Money<'GEL'> | null;
      /**
       * Сколько сделок среднего размера **в месяц сверх текущего темпа**
       * доводят среднемесячный объём до порога.
       *
       * Ноль — порог уже пройден. `null` — считать не из чего: среднего
       * размера сделки в окне нет.
       */
      readonly dealsToThreshold: number | null;
    });

/**
 * Целочисленное деление **вверх**, в обе стороны от нуля.
 *
 * Вверх, потому что округление здесь работает против нас: объём, округлённый
 * вниз, занижает регуляторный риск, а тетри разницы в девяти миллионах не
 * стоит того, чтобы порог оказался пройден раньше, чем показан.
 */
function divideCeil(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  if (value % divisor === 0n) return quotient;
  return value > 0n ? quotient + 1n : quotient;
}

/**
 * Пересчёт в лари по официальному курсу **на дату операции** (§4.5).
 *
 * `null` — курса нет, и это не ноль. Лари в лари не пересчитывается вовсе:
 * курса пары `GEL→GEL` не существует по построению (`fxRate` отвергает
 * совпадающие валюты), и спрашивать его у источника было бы вопросом, на
 * который честный источник обязан ответить `null`.
 */
function toGel(
  amount: Money<CurrencyCode>,
  on: IsoDate,
  rateOn: OfficialRateLookup,
): Money<'GEL'> | null {
  if (amount.currency === 'GEL') return money('GEL', amount.minor);
  const rate = rateOn(amount.currency, on);
  if (rate === null) return null;
  return convertAtRate(amount, rate, 'ceil');
}

/**
 * Приближение к порогу значимости провайдера по журналу за окно месяцев.
 *
 * Месяцы приходят списком окон, а не «последними N от сегодня»: календарь —
 * дело вызывающего (см. `JournalPeriod`), а делитель среднемесячного объёма
 * обязан быть тем же числом месяцев, за которые взяты проводки. Двенадцать
 * месяцев ст. 5(1) — в `SIGNIFICANCE_WINDOW_MONTHS`; окно короче не запрещено,
 * но помечено (`regulatoryWindow: false`), потому что средняя за три месяца —
 * это не та величина, о которой говорит приказ.
 */
export function significanceApproach(
  journal: Journal,
  months: readonly JournalPeriod[],
  rateOn: OfficialRateLookup,
): SignificanceApproach {
  const threshold = SIGNIFICANCE_THRESHOLD;
  const common = {
    months: months.length,
    regulatoryWindow: months.length === SIGNIFICANCE_WINDOW_MONTHS,
    threshold,
  };
  if (months.length === 0) {
    // Окно без месяцев — не пустой период, а отсутствие делителя: среднего
    // здесь не существует, и ноль был бы утверждением «объёма нет».
    return Object.freeze({ ...common, known: false, reason: 'no_months', unpriced: Object.freeze([]) });
  }

  const unpriced: UnpricedAmount[] = [];
  let volume = 0n;
  let settledTotal = 0n;
  let settledTranches = 0;
  let volumeKnown = true;
  let averageKnown = true;

  for (const month of months) {
    const scan = scanPeriod(journal, month);
    for (const item of scan.intakeDated) {
      const gel = toGel(item.amount, item.on, rateOn);
      if (gel === null) {
        unpriced.push(Object.freeze({ of: 'intake' as const, on: item.on, amount: item.amount }));
        volumeKnown = false;
        continue;
      }
      volume += gel.minor;
    }
    for (const item of scan.settledDated) {
      settledTranches += 1;
      const gel = toGel(item.amount, item.on, rateOn);
      if (gel === null) {
        unpriced.push(
          Object.freeze({ of: 'settlement' as const, on: item.on, amount: item.amount }),
        );
        averageKnown = false;
        continue;
      }
      settledTotal += gel.minor;
    }
  }

  if (!volumeKnown) {
    // Недостача курса под объёмом обрушает **весь** ответ, а не одну строку:
    // среднемесячный объём с пропущенной операцией — это заниженный объём,
    // выданный за посчитанный.
    return Object.freeze({
      ...common,
      known: false,
      reason: 'missing_official_rate',
      unpriced: Object.freeze([...unpriced]),
    });
  }

  const monthly = money('GEL', divideCeil(volume, BigInt(months.length)));
  const headroom = subtract(threshold, monthly);
  const shareBp = Number((monthly.minor * 10_000n) / threshold.minor);
  // «Превышает» — ст. 5(1): равенство порогу его ещё не пересекает.
  const crossed = monthly.minor > threshold.minor;
  const averageDeal =
    !averageKnown || settledTranches === 0
      ? null
      : money('GEL', divideCeil(settledTotal, BigInt(settledTranches)));

  return Object.freeze({
    ...common,
    known: true,
    volume: money('GEL', volume),
    monthly,
    headroom,
    shareBp,
    warn: shareBp >= SIGNIFICANCE_WARN_AT_BP,
    crossed,
    settledTranches,
    averageDeal,
    // Сделки среднего размера, добавленные к темпу: столько их нужно в месяц,
    // чтобы среднемесячный объём **достиг** порога. Порог считается пройденным
    // при превышении, поэтому это нижняя граница, а не точный ответ — и она
    // называет момент, когда о пороге поздно узнавать.
    dealsToThreshold:
      crossed || headroom.minor <= 0n
        ? 0
        : averageDeal === null || averageDeal.minor <= 0n
          ? null
          : Number(divideCeil(headroom.minor, averageDeal.minor)),
    unpriced: Object.freeze([...unpriced]),
  });
}
