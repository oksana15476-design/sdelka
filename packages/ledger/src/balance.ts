import { type CurrencyCode, type Money, type Rational, money, rational } from '@sdelka/money';
import {
  type Account,
  type ClientKey,
  accountCode,
  accountType,
  isClientCustodyAccount,
  isClientObligationAccount,
} from './accounts';
import { type FundsRef, type Posting, type TrancheRef, isClientRef } from './entry';
import { type Journal } from './journal';

/**
 * Остаток в естественном знаке счёта: актив и расход — Дт минус Кт,
 * обязательство и доход — Кт минус Дт. Так «отрицательный остаток клиентского
 * счёта» означает ровно то, что означает в инварианте, а не зависит от того,
 * с какой стороны смотреть.
 */
function naturalSign(account: Account, posting: Posting): bigint {
  const type = accountType(account);
  const debitPositive = type === 'asset' || type === 'expense';
  const signed = posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor;
  return debitPositive ? signed : -signed;
}

function eachPosting(journal: Journal): readonly Posting[] {
  return journal.entries.flatMap((entry) => entry.postings);
}

export function accountBalance(
  journal: Journal,
  account: Account,
  currency: CurrencyCode,
): Money<CurrencyCode> {
  const code = accountCode(account);
  let total = 0n;
  for (const posting of eachPosting(journal)) {
    if (posting.amount.currency !== currency) continue;
    if (accountCode(posting.account) !== code) continue;
    total += naturalSign(posting.account, posting);
  }
  return money(currency, total);
}

export interface AccountBalance {
  readonly accountCode: string;
  readonly currency: CurrencyCode;
  readonly balance: Money<CurrencyCode>;
}

export function accountBalances(journal: Journal): readonly AccountBalance[] {
  const totals = new Map<string, bigint>();
  for (const posting of eachPosting(journal)) {
    const key = `${accountCode(posting.account)}|${posting.amount.currency}`;
    totals.set(key, (totals.get(key) ?? 0n) + naturalSign(posting.account, posting));
  }
  return [...totals.entries()]
    .map(([key, total]) => {
      const separator = key.lastIndexOf('|');
      const currency = key.slice(separator + 1) as CurrencyCode;
      return {
        accountCode: key.slice(0, separator),
        currency,
        balance: money(currency, total),
      };
    })
    .sort((left, right) => (left.accountCode < right.accountCode ? -1 : 1));
}

export interface CoverageByCurrency {
  readonly currency: CurrencyCode;
  /** Остаток на счетах клиентских средств. */
  readonly custody: Money<CurrencyCode>;
  /** Обязательства перед клиентами, включая непознанные поступления. */
  readonly obligations: Money<CurrencyCode>;
  /** Средства минус обязательства. Отрицательное — нарушение красной линии №3. */
  readonly difference: Money<CurrencyCode>;
  readonly covered: boolean;
  /** Покрытие как отношение, а не как число с плавающей точкой. */
  readonly ratio: Rational | null;
}

/**
 * Покрытие клиентских средств (CORE.md Ф10, красная линия №3). Возвращает не
 * «да/нет», а фактические величины по каждой валюте: расхождение нужно видеть
 * и измерять, а не только фиксировать факт нарушения.
 */
export function coverage(journal: Journal): readonly CoverageByCurrency[] {
  const custody = new Map<CurrencyCode, bigint>();
  const obligations = new Map<CurrencyCode, bigint>();
  for (const posting of eachPosting(journal)) {
    const currency = posting.amount.currency;
    if (isClientCustodyAccount(posting.account)) {
      custody.set(currency, (custody.get(currency) ?? 0n) + naturalSign(posting.account, posting));
    } else if (isClientObligationAccount(posting.account)) {
      obligations.set(
        currency,
        (obligations.get(currency) ?? 0n) + naturalSign(posting.account, posting),
      );
    }
  }
  const currencies = new Set<CurrencyCode>([...custody.keys(), ...obligations.keys()]);
  return [...currencies].sort().map((currency) => {
    const custodyTotal = custody.get(currency) ?? 0n;
    const obligationsTotal = obligations.get(currency) ?? 0n;
    return Object.freeze({
      currency,
      custody: money(currency, custodyTotal),
      obligations: money(currency, obligationsTotal),
      difference: money(currency, custodyTotal - obligationsTotal),
      covered: custodyTotal >= obligationsTotal,
      ratio: obligationsTotal === 0n ? null : rational(custodyTotal, obligationsTotal),
    });
  });
}

export function isFullyCovered(journal: Journal): boolean {
  return coverage(journal).every((item) => item.covered);
}

export interface TrancheCoverage {
  readonly deal: TrancheRef;
  readonly currency: CurrencyCode;
  readonly custody: Money<CurrencyCode>;
  readonly obligations: Money<CurrencyCode>;
  readonly difference: Money<CurrencyCode>;
  readonly covered: boolean;
}

function trancheKey(ref: TrancheRef): string {
  return `${ref.dealId} ${ref.trancheId}`;
}

/**
 * Пофайловая (по сделке и траншу) проверка обеспечения — красная линия №1 и
 * прямое требование CORE.md Ф10: покрытие сходится по портфелю при расхождении
 * внутри отдельной сделки, и портфельная сверка этого не видит.
 *
 * Непознанные поступления сюда не попадают: у них нет сделки, и это не дефект,
 * а их определение. Они учитываются в портфельном покрытии.
 *
 * Свободная часть счетов клиентов сюда тоже не попадает: у неё нет транша.
 * Общий случай — `coverageByFundsSource`, эта функция остаётся частным: по ней
 * измеряется метрика Г1 «пофайловое обеспечение 100%» (FUNCTIONAL.md §3.1).
 */
export function coverageByTranche(journal: Journal): readonly TrancheCoverage[] {
  const custody = new Map<string, Map<CurrencyCode, bigint>>();
  const obligations = new Map<string, Map<CurrencyCode, bigint>>();
  const refs = new Map<string, TrancheRef>();

  const bump = (
    target: Map<string, Map<CurrencyCode, bigint>>,
    ref: TrancheRef,
    currency: CurrencyCode,
    value: bigint,
  ): void => {
    const key = trancheKey(ref);
    refs.set(key, ref);
    const byCurrency = target.get(key) ?? new Map<CurrencyCode, bigint>();
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0n) + value);
    target.set(key, byCurrency);
  };

  for (const posting of eachPosting(journal)) {
    const currency = posting.amount.currency;
    const account = posting.account;
    if (account.kind === 'client_locked') {
      bump(
        obligations,
        { dealId: account.dealId, trancheId: account.trancheId },
        currency,
        naturalSign(account, posting),
      );
    } else if (
      isClientCustodyAccount(account) &&
      posting.attribution !== null &&
      !isClientRef(posting.attribution)
    ) {
      // Кастодиан, отнесённый к клиенту вне сделки, в файл транша не попадает:
      // это второй вид файла, он считается `coverageByFundsSource`.
      bump(custody, posting.attribution, currency, naturalSign(account, posting));
    }
  }

  const result: TrancheCoverage[] = [];
  const sortedRefs = [...refs.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1));
  for (const [key, ref] of sortedRefs) {
    const custodyByCurrency = custody.get(key) ?? new Map<CurrencyCode, bigint>();
    const obligationsByCurrency = obligations.get(key) ?? new Map<CurrencyCode, bigint>();
    const currencies = new Set<CurrencyCode>([
      ...custodyByCurrency.keys(),
      ...obligationsByCurrency.keys(),
    ]);
    for (const currency of [...currencies].sort()) {
      const custodyTotal = custodyByCurrency.get(currency) ?? 0n;
      const obligationsTotal = obligationsByCurrency.get(currency) ?? 0n;
      result.push(
        Object.freeze({
          deal: ref,
          currency,
          custody: money(currency, custodyTotal),
          obligations: money(currency, obligationsTotal),
          difference: money(currency, custodyTotal - obligationsTotal),
          covered: custodyTotal >= obligationsTotal,
        }),
      );
    }
  }
  return result;
}

export function isEveryTrancheCovered(journal: Journal): boolean {
  return coverageByTranche(journal).every((item) => item.covered);
}

/** Отрицательный остаток клиентского счёта невозможен — здесь он ловится в коде. */
export function negativeClientBalances(journal: Journal): readonly AccountBalance[] {
  const clientCodes = new Set<string>();
  for (const posting of eachPosting(journal)) {
    if (isClientObligationAccount(posting.account) || isClientCustodyAccount(posting.account)) {
      clientCodes.add(accountCode(posting.account));
    }
  }
  return accountBalances(journal).filter(
    (item) => clientCodes.has(item.accountCode) && item.balance.minor < 0n,
  );
}

/** Источник средств, по которому строится файл обеспечения. */
export type FundsSource =
  | { readonly kind: 'tranche'; readonly deal: TrancheRef }
  | { readonly kind: 'client'; readonly clientKey: ClientKey };

export interface FundsSourceCoverage {
  readonly source: FundsSource;
  readonly currency: CurrencyCode;
  readonly custody: Money<CurrencyCode>;
  readonly obligations: Money<CurrencyCode>;
  readonly difference: Money<CurrencyCode>;
  readonly covered: boolean;
}

function sourceKey(source: FundsSource): string {
  return source.kind === 'client'
    ? `client|${source.clientKey}`
    : `tranche|${source.deal.dealId}|${source.deal.trancheId}`;
}

function sourceOfPosting(posting: Posting): FundsSource | null {
  const account = posting.account;
  if (account.kind === 'client_locked') {
    return { kind: 'tranche', deal: { dealId: account.dealId, trancheId: account.trancheId } };
  }
  if (account.kind === 'client_free') {
    return { kind: 'client', clientKey: account.clientKey };
  }
  if (isClientCustodyAccount(account)) {
    const attribution: FundsRef | null = posting.attribution;
    if (attribution === null) return null;
    return isClientRef(attribution)
      ? { kind: 'client', clientKey: attribution.clientKey }
      : { kind: 'tranche', deal: attribution };
  }
  return null;
}

/**
 * Пофайловое обеспечение по обоим видам файла: транш и клиент вне сделки
 * (FUNCTIONAL.md §3.1, CORE.md Ф10).
 *
 * Со счётом клиента файл перестал быть только траншем: деньги в свободной части
 * — такие же чужие деньги на номинальном счёте, и остаться необеспеченными они
 * могут ровно так же. `coverageByTranche` сохранена как частный случай, чтобы
 * прежняя метрика считалась тем же способом, что и раньше.
 *
 * Непознанные поступления не попадают и сюда: у них нет ни сделки, ни клиента.
 * Они видны в портфельном покрытии.
 */
export function coverageByFundsSource(journal: Journal): readonly FundsSourceCoverage[] {
  const custody = new Map<string, Map<CurrencyCode, bigint>>();
  const obligations = new Map<string, Map<CurrencyCode, bigint>>();
  const sources = new Map<string, FundsSource>();

  const bump = (
    target: Map<string, Map<CurrencyCode, bigint>>,
    source: FundsSource,
    currency: CurrencyCode,
    value: bigint,
  ): void => {
    const key = sourceKey(source);
    sources.set(key, source);
    const byCurrency = target.get(key) ?? new Map<CurrencyCode, bigint>();
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0n) + value);
    target.set(key, byCurrency);
  };

  for (const posting of eachPosting(journal)) {
    const source = sourceOfPosting(posting);
    if (source === null) continue;
    const target = isClientCustodyAccount(posting.account) ? custody : obligations;
    bump(target, source, posting.amount.currency, naturalSign(posting.account, posting));
  }

  const result: FundsSourceCoverage[] = [];
  for (const [key, source] of [...sources.entries()].sort((left, right) =>
    left[0] < right[0] ? -1 : 1,
  )) {
    const custodyByCurrency = custody.get(key) ?? new Map<CurrencyCode, bigint>();
    const obligationsByCurrency = obligations.get(key) ?? new Map<CurrencyCode, bigint>();
    const currencies = new Set<CurrencyCode>([
      ...custodyByCurrency.keys(),
      ...obligationsByCurrency.keys(),
    ]);
    for (const currency of [...currencies].sort()) {
      const custodyTotal = custodyByCurrency.get(currency) ?? 0n;
      const obligationsTotal = obligationsByCurrency.get(currency) ?? 0n;
      result.push(
        Object.freeze({
          source,
          currency,
          custody: money(currency, custodyTotal),
          obligations: money(currency, obligationsTotal),
          difference: money(currency, custodyTotal - obligationsTotal),
          covered: custodyTotal >= obligationsTotal,
        }),
      );
    }
  }
  return result;
}

export function isEveryFundsSourceCovered(journal: Journal): boolean {
  return coverageByFundsSource(journal).every((item) => item.covered);
}

export interface CurrencyAmount {
  readonly currency: CurrencyCode;
  readonly amount: Money<CurrencyCode>;
}

export interface LockedPortion {
  readonly deal: TrancheRef;
  readonly currency: CurrencyCode;
  readonly amount: Money<CurrencyCode>;
}

export interface ClientStatement {
  readonly clientKey: ClientKey;
  /** Свободная часть по каждой валюте — деньги, которые клиент вправе забрать. */
  readonly free: readonly CurrencyAmount[];
  /** Запертая часть, итог по каждой валюте. */
  readonly lockedTotal: readonly CurrencyAmount[];
  /** Та же запертая часть, разбитая по (сделка, транш). */
  readonly locked: readonly LockedPortion[];
}

function byCurrencyList(totals: ReadonlyMap<CurrencyCode, bigint>): readonly CurrencyAmount[] {
  return [...totals.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([currency, total]) => Object.freeze({ currency, amount: money(currency, total) }));
}

/**
 * Выписка по счёту клиента — И12.1: один счёт по всем сделкам в любых ролях,
 * свободная и запертая части раздельно, запертая — с указанием сделки и транша.
 *
 * Валюты **не пересчитываются**: суммы в разных валютах стоят рядом. Пересчёт
 * «для удобства» требует курса, а курс — это отдельная проводка и отдельное
 * решение (FUNCTIONAL.md §4.5); в выписке ему места нет.
 *
 * До какого момента заперто, здесь не отвечается и отвечаться не может: срок —
 * это дедлайн транша, состояние автомата (STATE-MACHINES.md §1.5), а не факт
 * журнала. Разбивка по (сделка, транш) — ровно то, чем приложение джойнит одно
 * с другим.
 *
 * Непознанные поступления в выписку не попадают: клиента у них ещё нет.
 *
 * Нулевые строки не отфильтрованы: «была валюта и вся заперта» и «валюты не
 * было вовсе» — разные факты, и различать их — забота представления, а не
 * учёта. Скрывать ноль здесь означало бы принять это решение молча.
 */
export function clientStatement(journal: Journal, owner: ClientKey): ClientStatement {
  const free = new Map<CurrencyCode, bigint>();
  const lockedTotal = new Map<CurrencyCode, bigint>();
  const locked = new Map<string, { deal: TrancheRef; totals: Map<CurrencyCode, bigint> }>();

  for (const posting of eachPosting(journal)) {
    const account = posting.account;
    const currency = posting.amount.currency;
    if (account.kind === 'client_free' && account.clientKey === owner) {
      free.set(currency, (free.get(currency) ?? 0n) + naturalSign(account, posting));
      continue;
    }
    if (account.kind === 'client_locked' && account.clientKey === owner) {
      const deal: TrancheRef = { dealId: account.dealId, trancheId: account.trancheId };
      const key = `${deal.dealId} ${deal.trancheId}`;
      const bucket = locked.get(key) ?? { deal, totals: new Map<CurrencyCode, bigint>() };
      bucket.totals.set(
        currency,
        (bucket.totals.get(currency) ?? 0n) + naturalSign(account, posting),
      );
      locked.set(key, bucket);
      lockedTotal.set(currency, (lockedTotal.get(currency) ?? 0n) + naturalSign(account, posting));
    }
  }

  const lockedList: LockedPortion[] = [];
  for (const [, bucket] of [...locked.entries()].sort((left, right) =>
    left[0] < right[0] ? -1 : 1,
  )) {
    for (const [currency, total] of [...bucket.totals.entries()].sort((left, right) =>
      left[0] < right[0] ? -1 : 1,
    )) {
      lockedList.push(
        Object.freeze({ deal: bucket.deal, currency, amount: money(currency, total) }),
      );
    }
  }

  return Object.freeze({
    clientKey: owner,
    free: Object.freeze(byCurrencyList(free)),
    lockedTotal: Object.freeze(byCurrencyList(lockedTotal)),
    locked: Object.freeze(lockedList),
  });
}

/**
 * Свободный остаток клиента в одной валюте.
 *
 * Нужен для предпроверки перед привязкой к сделке: конструктор записи журнала
 * не видит и не должен видеть — он проверяет форму одной записи, а не историю.
 * Поэтому «нельзя запереть больше, чем свободно» проверяет тот, кто строит
 * запись, а журнал ловит нарушение вторым контуром: отрицательный остаток
 * клиентского счёта — инвариант (`checkLedgerInvariants`) и стоп-кран.
 */
export function freeBalance(
  journal: Journal,
  owner: ClientKey,
  currency: CurrencyCode,
): Money<CurrencyCode> {
  const entry = clientStatement(journal, owner).free.find((item) => item.currency === currency);
  return entry?.amount ?? money(currency, 0n);
}
