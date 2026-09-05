import { type CurrencyCode, type Money, type Rational, money, rational } from '@sdelka/money';
import {
  type Account,
  type ClientKey,
  accountCode,
  accountType,
  clientAccountOwner,
  clientFundsFile,
  conversionOfAccount,
  isClientCustodyAccount,
  isClientObligationAccount,
  isPlatformBankAccount,
  platformFundsRole,
  poolDirection,
} from './accounts';
import {
  type Direction,
  type FeeAccrualDeclaration,
  type FundsRef,
  type FxExecution,
  type JournalEntry,
  type JournalEntryKind,
  type Posting,
  type TrancheRef,
  clientAccountFile,
  isClientRef,
  postingNaturalSign,
} from './entry';
import { type Journal } from './journal';

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
    total += postingNaturalSign(posting);
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
    totals.set(key, (totals.get(key) ?? 0n) + postingNaturalSign(posting));
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
    const account = posting.account;
    // Невостребованные средства в это отношение не входят — прямое указание
    // §3.1: «отношение покрытия сопоставляет номинальный счёт с обязательствами
    // по траншам и `unclaimed:liability` не видит вовсе. Нужна вторая
    // проверка». Вторая проверка — `unclaimedCoverage` ниже.
    //
    // Условие — по объявленной природе счёта, а не по имени: клиентский актив
    // против клиентского обязательства, и с обеих сторон вычитается
    // терминальный пул.
    //
    // **[исправляет предыдущее]** Прежде актив отбирался по `in_attribution`, и
    // это работало ровно потому, что из трёх клиентских активов файл приносило
    // отнесение у двух: номинального счёта и счёта расчётов с валютным
    // контрагентом. Как только у счёта обмена появился владелец в коде (см.
    // `accounts.ts`), деньги у контрагента выпали из числителя, и покрытие
    // между моментами 2 и 3 обмена проваливалось ниже единицы — при том, что
    // §3.3 прямо описывает этот промежуток как **покрытый**: деньги клиента,
    // просто не на нашем счёте. Происхождение файла к вопросу «чьи это деньги
    // и лежат ли они где-то» отношения не имеет вовсе; терминальный пул
    // исключается симметрично обеим сторонам, потому что его считает
    // `unclaimedCoverage`.
    if (isClientCustodyAccount(account) && poolDirection(account) !== 'terminal') {
      custody.set(currency, (custody.get(currency) ?? 0n) + postingNaturalSign(posting));
    } else if (isClientObligationAccount(account) && poolDirection(account) !== 'terminal') {
      obligations.set(
        currency,
        (obligations.get(currency) ?? 0n) + postingNaturalSign(posting),
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

/**
 * Обеспечение невостребованных средств — вторая проверка, которую требует §3.1.
 *
 * Деньги, признанные чужими, уходят с номинального счёта и потому выпадают из
 * основного отношения покрытия. Если их не сопоставить ни с чем, они перестают
 * быть кем-либо обеспечены ровно в тот момент, когда за ними больше никто не
 * следит. Сопоставляются они с тем, где физически лежат: операционный счёт
 * плюс транзит списания.
 *
 * ⚠ На операционном счёте лежат и собственные деньги платформы, поэтому
 * отношение показывает лишь **достаточность**, а не раздельность. Раздельность
 * даст только отдельный счёт для невостребованных, и это решение владельца —
 * вместе с ответом на вопрос §3.1, помеченный **[открыто]**.
 */
export function unclaimedCoverage(journal: Journal): readonly CoverageByCurrency[] {
  const custody = new Map<CurrencyCode, bigint>();
  const obligations = new Map<CurrencyCode, bigint>();
  for (const posting of eachPosting(journal)) {
    const currency = posting.amount.currency;
    const account = posting.account;
    if (poolDirection(account) === 'terminal' && accountType(account) === 'liability') {
      obligations.set(
        currency,
        (obligations.get(currency) ?? 0n) + postingNaturalSign(posting),
      );
      continue;
    }
    // Активы, на которых эти деньги лежат: транзит списания (тот же пул) и
    // счета платформы **в банке**.
    //
    // ⚠ Роль счёта здесь обязательна, и это не педантизм. Прежнее условие
    // «любой актив платформы» с появлением `fee:receivable` и `transit:fee`
    // молча завысило бы это покрытие: начисленная комиссия стала бы
    // обеспечением чужих невостребованных денег. Тесты остались бы зелёными —
    // покрытие только выросло бы.
    if (
      isPlatformBankAccount(account) ||
      (poolDirection(account) === 'terminal' && accountType(account) === 'asset')
    ) {
      custody.set(currency, (custody.get(currency) ?? 0n) + postingNaturalSign(posting));
    }
  }
  const currencies = new Set<CurrencyCode>([...custody.keys(), ...obligations.keys()]);
  return [...currencies].sort().flatMap((currency) => {
    const obligationsTotal = obligations.get(currency) ?? 0n;
    // Валюта, в которой невостребованных обязательств нет вовсе, отношения не
    // образует: остаток операционного счёта сам по себе ничего не покрывает.
    if (obligationsTotal === 0n) return [];
    const custodyTotal = custody.get(currency) ?? 0n;
    return [
      Object.freeze({
        currency,
        custody: money(currency, custodyTotal),
        obligations: money(currency, obligationsTotal),
        difference: money(currency, custodyTotal - obligationsTotal),
        covered: custodyTotal >= obligationsTotal,
        ratio: rational(custodyTotal, obligationsTotal),
      }),
    ];
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
        postingNaturalSign(posting),
      );
    } else if (
      isClientCustodyAccount(account) &&
      posting.attribution !== null &&
      !isClientRef(posting.attribution)
    ) {
      // Кастодиан, отнесённый к клиенту вне сделки, в файл транша не попадает:
      // это второй вид файла, он считается `coverageByFundsSource`.
      bump(custody, posting.attribution, currency, postingNaturalSign(posting));
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

/**
 * Отрицательный остаток **банковского счёта платформы** — деньги, которых у нас
 * не было.
 *
 * `negativeClientBalances` сюда не достаёт по построению: номинальный счёт под
 * ним, потому что объявлен клиентскими средствами, а операционный — нет, он
 * деньги платформы. Между тем банковский счёт не уходит в минус ни у кого:
 * овердрафта нет, и запись, уводящая операционный счёт ниже нуля, утверждает
 * перевод, которого банк не исполнил бы. Ровно эта форма — довнесение недостачи
 * (§3.1, случай А, момент 2) с пустого операционного счёта: обещание закрыть
 * дыру деньгами, которых нет.
 *
 * Приём новых сделок этим не останавливается: красная линия №3 говорит о
 * покрытии **клиентских** средств, а здесь расхождение в наших собственных.
 * Видимым оно быть обязано — решение о стоп-кране принимает владелец.
 */
export function negativeBankBalances(journal: Journal): readonly AccountBalance[] {
  // Роль `bank`, а не «актив платформы». С появлением требования по
  // начисленной комиссии и транзита комиссии прежнее условие докладывало бы о
  // них кодом `negative_bank_balance`, и дежурный читал бы «банковский счёт в
  // минусе» там, где в минусе требование. Разные расхождения — разные коды,
  // потому что разбираются они по-разному.
  const bankAccounts = new Set<string>();
  for (const posting of eachPosting(journal)) {
    if (isPlatformBankAccount(posting.account)) {
      bankAccounts.add(accountCode(posting.account));
    }
  }
  return accountBalances(journal).filter(
    (item) => bankAccounts.has(item.accountCode) && item.balance.minor < 0n,
  );
}

/**
 * Отрицательный остаток **прочего актива платформы**: требования или транзита.
 *
 * Прямой случай — удержание комиссии, которая не начислялась: `fee:receivable`
 * уходит в минус, то есть журнал утверждает, что погашено требование, которого
 * не было. Это не банковский счёт и разбирается иначе, поэтому и код другой.
 */
export function negativePlatformAssetBalances(journal: Journal): readonly AccountBalance[] {
  const accounts = new Set<string>();
  for (const posting of eachPosting(journal)) {
    const role = platformFundsRole(posting.account);
    if (role === 'receivable' || role === 'transit') {
      accounts.add(accountCode(posting.account));
    }
  }
  return accountBalances(journal).filter(
    (item) => accounts.has(item.accountCode) && item.balance.minor < 0n,
  );
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

function asSource(ref: FundsRef | null): FundsSource | null {
  if (ref === null) return null;
  return isClientRef(ref)
    ? { kind: 'client', clientKey: ref.clientKey }
    : { kind: 'tranche', deal: { dealId: ref.dealId, trancheId: ref.trancheId } };
}

/**
 * Файл проводки: у обязательства — из кода счёта, у кастодиана — из отнесения.
 * Перечня видов счетов здесь нет: и то и другое читается по объявленной природе
 * счёта, поэтому новый счёт попадает в свой файл сам.
 */
function sourceOfPosting(posting: Posting): FundsSource | null {
  const account = posting.account;
  const scope = clientFundsFile(account);
  if (scope === 'owner_in_code') {
    return asSource(clientAccountFile(account));
  }
  if (scope === 'in_attribution') {
    return asSource(posting.attribution);
  }
  // Пулы файла не образуют: ни сделки, ни клиента у них нет.
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
    bump(target, source, posting.amount.currency, postingNaturalSign(posting));
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
 * Пуловые счета в выписку не попадают: владельца у них нет — ни у непознанного
 * поступления (ещё), ни у невостребованного (уже).
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
    if (!isClientObligationAccount(account) || clientAccountOwner(account) !== owner) continue;
    // Свободно или заперто — это наличие транша в файле счёта, а не его имя:
    // счёт, заведённый завтра, попадёт в выписку сам.
    const file = clientAccountFile(account);
    if (file === null || isClientRef(file)) {
      free.set(currency, (free.get(currency) ?? 0n) + postingNaturalSign(posting));
      continue;
    }
    const deal: TrancheRef = { dealId: file.dealId, trancheId: file.trancheId };
    const key = `${deal.dealId} ${deal.trancheId}`;
    const bucket = locked.get(key) ?? { deal, totals: new Map<CurrencyCode, bigint>() };
    bucket.totals.set(
      currency,
      (bucket.totals.get(currency) ?? 0n) + postingNaturalSign(posting),
    );
    locked.set(key, bucket);
    lockedTotal.set(currency, (lockedTotal.get(currency) ?? 0n) + postingNaturalSign(posting));
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

/**
 * Три величины комиссии по каждому траншу и валюте — CORE.md Ф10 и Ф16,
 * история И14.3: «начислено, удержано и получено — три разные величины».
 *
 * Считаются они по разным счетам, а не по одному признаку, и в этом весь смысл
 * блока: пока комиссия признавалась доходом прямо в записи расчёта, все три
 * величины были одним числом и различить их было нечем.
 *
 * - `accrued` — признанный доход по этому траншу (`fee:income`). Реверс
 *   начисления при уходе в возвратную ветвь уменьшает его, потому что считается
 *   остаток в естественном знаке счёта, а не сумма кредитов.
 * - `withheld` — сколько ушло из платежа в транзит (`Дт transit:fee`).
 * - `received` — сколько дошло до операционного счёта (`Кт transit:fee`).
 * - `notWithheld` — остаток требования (`fee:receivable`): начислено, но из
 *   платежа ещё не удержано (недоплата, транш не дошёл до расчёта).
 * - `inTransit` — удержано, но перевод не дошёл. **Это и есть то состояние,
 *   которое Ф16 требует видеть отдельно и не смешивать с «получено».**
 */
export interface FeePosition {
  readonly deal: TrancheRef;
  readonly currency: CurrencyCode;
  readonly accrued: Money<CurrencyCode>;
  readonly notWithheld: Money<CurrencyCode>;
  readonly withheld: Money<CurrencyCode>;
  readonly received: Money<CurrencyCode>;
  readonly inTransit: Money<CurrencyCode>;
}

interface FeeTotals {
  accrued: bigint;
  receivable: bigint;
  withheld: bigint;
  received: bigint;
}

export function feePositions(journal: Journal): readonly FeePosition[] {
  const totals = new Map<string, FeeTotals>();
  const refs = new Map<string, TrancheRef>();

  const bucket = (deal: TrancheRef, currency: CurrencyCode): FeeTotals => {
    const key = `${deal.dealId} ${deal.trancheId}|${currency}`;
    refs.set(key, deal);
    const existing = totals.get(key);
    if (existing !== undefined) return existing;
    const fresh: FeeTotals = { accrued: 0n, receivable: 0n, withheld: 0n, received: 0n };
    totals.set(key, fresh);
    return fresh;
  };

  for (const posting of eachPosting(journal)) {
    const account = posting.account;
    const attribution = posting.attribution;
    // Отнесение к траншу — единственный способ связать комиссию со сделкой:
    // счета комиссии не клиентские, файла в их коде нет и быть не может.
    if (attribution === null || isClientRef(attribution)) continue;
    const deal: TrancheRef = {
      dealId: attribution.dealId,
      trancheId: attribution.trancheId,
    };
    const currency = posting.amount.currency;
    if (account.kind === 'fee_income') {
      bucket(deal, currency).accrued += postingNaturalSign(posting);
    } else if (account.kind === 'fee_receivable') {
      bucket(deal, currency).receivable += postingNaturalSign(posting);
    } else if (account.kind === 'transit_fee') {
      const target = bucket(deal, currency);
      if (posting.direction === 'debit') {
        target.withheld += posting.amount.minor;
      } else {
        target.received += posting.amount.minor;
      }
    }
  }

  return [...totals.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([key, value]) => {
      const currency = key.slice(key.lastIndexOf('|') + 1) as CurrencyCode;
      const deal = refs.get(key) as TrancheRef;
      return Object.freeze({
        deal,
        currency,
        accrued: money(currency, value.accrued),
        notWithheld: money(currency, value.receivable),
        withheld: money(currency, value.withheld),
        received: money(currency, value.received),
        inTransit: money(currency, value.withheld - value.received),
      });
    });
}

/**
 * Незакрытая дебиторка по комиссии: сколько по траншу **начислено и до сих пор
 * не удержано**, с какого момента и ушли ли уже деньги транша.
 *
 * §4.6 называет «начислено, не удержано» законным состоянием — но законно оно
 * ровно до расчёта: удерживать комиссию не из чего, когда запертая часть транша
 * пуста. Пока такого отчёта не было, состояние «начислено и никогда не
 * удержано» не выражалось ничем: `feePositions` показывает остаток требования,
 * но остаток без возраста и без ответа «а деньги-то ещё есть?» — не расхождение,
 * а просто число, на которое никто не смотрит.
 *
 * Прямой случай, ради которого отчёт появился: **двойное начисление**. Два
 * `accrueFee` по одному траншу удваивают `fee:receivable` и признают доход
 * дважды; расчёт удерживает одно начисление, второе остаётся требованием
 * навсегда. Ни покрытие, ни отрицательный остаток, ни `transitStale` этого не
 * видят — транзит там как раз в порядке.
 *
 * `trancheDrained` — деньги транша ушли: запертая часть по этому траншу в этой
 * валюте **была** и обнулилась (расчёт, отвязка, списание). Оба условия важны:
 * без «была» под правило попал бы транш, под который ещё ничего не запирали, —
 * а это обычное окно между начислением на входе в `release_pending` и расчётом.
 */
export interface FeeReceivablePosition {
  readonly deal: TrancheRef;
  readonly currency: CurrencyCode;
  readonly outstanding: Money<CurrencyCode>;
  readonly openedAt: string;
  readonly lastMovedAt: string;
  readonly trancheDrained: boolean;
}

export function openFeeReceivables(journal: Journal): readonly FeeReceivablePosition[] {
  interface Open {
    deal: TrancheRef;
    openedAt: string;
    lastMovedAt: string;
    total: bigint;
  }
  const open = new Map<string, Open>();
  const lockedTotal = new Map<string, bigint>();
  const lockedTouched = new Set<string>();
  const key = (deal: TrancheRef, currency: CurrencyCode): string =>
    `${deal.dealId} ${deal.trancheId}|${currency}`;

  for (const entry of journal.entries) {
    const touched = new Set<string>();
    for (const posting of entry.postings) {
      const account = posting.account;
      const currency = posting.amount.currency;
      if (account.kind === 'client_locked') {
        const lockedKey = key(account, currency);
        lockedTouched.add(lockedKey);
        lockedTotal.set(
          lockedKey,
          (lockedTotal.get(lockedKey) ?? 0n) + postingNaturalSign(posting),
        );
        continue;
      }
      if (account.kind !== 'fee_receivable') continue;
      const attribution = posting.attribution;
      // Отнесение к траншу — единственный способ связать требование со сделкой:
      // счёт требования не клиентский, файла в его коде нет и быть не может.
      // Требование без отнесения в этот отчёт не попадает — и это видно в
      // `feePositions` тем же способом, а не молча.
      if (attribution === null || isClientRef(attribution)) continue;
      const deal: TrancheRef = {
        dealId: attribution.dealId,
        trancheId: attribution.trancheId,
      };
      const feeKey = key(deal, currency);
      touched.add(feeKey);
      const state = open.get(feeKey) ?? {
        deal,
        openedAt: entry.occurredAt,
        lastMovedAt: entry.occurredAt,
        total: 0n,
      };
      state.total += postingNaturalSign(posting);
      state.lastMovedAt = entry.occurredAt;
      open.set(feeKey, state);
    }
    // Плоскость — по записи целиком, как у позиции обмена: расчёт гасит
    // требование и в той же записи ничего нового не начисляет, но реверс
    // начисления двигает счёт в обе стороны внутри одной записи.
    for (const feeKey of touched) {
      if (open.get(feeKey)?.total === 0n) open.delete(feeKey);
    }
  }

  return [...open.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([feeKey, state]) => {
      const currency = feeKey.slice(feeKey.lastIndexOf('|') + 1) as CurrencyCode;
      return Object.freeze({
        deal: state.deal,
        currency,
        outstanding: money(currency, state.total),
        openedAt: state.openedAt,
        lastMovedAt: state.lastMovedAt,
        trancheDrained: lockedTouched.has(feeKey) && (lockedTotal.get(feeKey) ?? 0n) === 0n,
      });
    });
}

/**
 * Открытая позиция по обмену: сколько по этой конверсии числится за валютным
 * контрагентом в каждой валюте, **у какого клиента** и с какого момента.
 *
 * Позиция **плоская**, когда все её остатки нули: исходная валюта отдана,
 * встречная поставлена, требований нет. Ненулевая позиция сама по себе не
 * нарушение — между тремя моментами обмена она обязана быть ненулевой. Возраст
 * превращает её в расхождение, и это делает инвариант, а не этот отчёт.
 *
 * `openedAt` — момент, с которого позиция перестала быть плоской. Считается
 * по порядку записей в журнале, а не по сортировке `occurredAt`: журнал только
 * дополняется, и его порядок — это порядок, в котором факты стали известны.
 *
 * **Ключ позиции — код счёта, а не ключ конверсии.** Прежде позиция ключевалась
 * одним лишь `conversionId`, и обмены двух клиентов, названные одинаково,
 * складывались в одну позицию: незакрытая нога одного гасилась встречной ногой
 * другого, и «нам не поставили встречную валюту» переставало быть величиной.
 * Владелец теперь стоит в коде счёта (`accounts.ts`), поэтому слияние невозможно
 * по построению; но отчёт читает **журнал, пришедший из базы**, в том числе
 * записанный до этой правки, — и ключ по коду счёта разводит такие позиции
 * даже там, где их свёл бы старый счёт.
 */
export interface FxPosition {
  /** Клиент, за чей счёт открыта позиция. `null` — счёт без владельца в коде. */
  readonly owner: ClientKey | null;
  readonly conversionId: string;
  readonly accountCode: string;
  readonly openedAt: string;
  readonly lastMovedAt: string;
  /** Только ненулевые остатки: плоская позиция в выдачу не попадает вовсе. */
  readonly balances: readonly CurrencyAmount[];
}

export function openFxPositions(journal: Journal): readonly FxPosition[] {
  interface Open {
    owner: ClientKey | null;
    conversionId: string;
    openedAt: string;
    lastMovedAt: string;
    balances: Map<CurrencyCode, bigint>;
  }
  const open = new Map<string, Open>();

  for (const entry of journal.entries) {
    const touched = new Set<string>();
    for (const posting of entry.postings) {
      const conversionId = conversionOfAccount(posting.account);
      if (conversionId === null) continue;
      const key = accountCode(posting.account);
      touched.add(key);
      const state = open.get(key) ?? {
        owner: clientAccountOwner(posting.account),
        conversionId,
        openedAt: entry.occurredAt,
        lastMovedAt: entry.occurredAt,
        balances: new Map<CurrencyCode, bigint>(),
      };
      const currency = posting.amount.currency;
      state.balances.set(
        currency,
        (state.balances.get(currency) ?? 0n) + postingNaturalSign(posting),
      );
      state.lastMovedAt = entry.occurredAt;
      open.set(key, state);
    }
    // Плоскость проверяется **по записи целиком**, а не после каждой проводки.
    // Момент 2 сначала гасит ногу исходной валюты и лишь потом открывает ногу
    // встречной: если смотреть по проводкам, позиция на миг обнуляется, и
    // возраст обмена начинал бы отсчёт заново с каждой записи. Возраст обмена —
    // это возраст обмена, а не последнего движения по нему.
    for (const key of touched) {
      const state = open.get(key);
      if (state === undefined) continue;
      if ([...state.balances.values()].every((value) => value === 0n)) {
        open.delete(key);
      }
    }
  }

  return [...open.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([key, state]) =>
      Object.freeze({
        owner: state.owner,
        conversionId: state.conversionId,
        accountCode: key,
        openedAt: state.openedAt,
        lastMovedAt: state.lastMovedAt,
        balances: Object.freeze(
          [...state.balances.entries()]
            .filter(([, total]) => total !== 0n)
            .sort((left, right) => (left[0] < right[0] ? -1 : 1))
            .map(([currency, total]) =>
              Object.freeze({ currency, amount: money(currency, total) }),
            ),
        ),
      }),
    );
}

/**
 * Незакрытый остаток на транзитном счёте и момент, с которого он висит.
 *
 * Транзитных счетов два, и оба обещают одно и то же: деньги идут между банками
 * и дойдут за день-два (§3.1 для `transit:writeoff`, §4.6 и Ф16 для
 * `transit:fee`). Обещание в документе было, проверки в коде не было ни у
 * одного — `InvariantCode` такого кода не содержал вовсе.
 */
export interface TransitPosition {
  readonly accountCode: string;
  readonly currency: CurrencyCode;
  readonly openedAt: string;
  readonly amount: Money<CurrencyCode>;
}

export function openTransitPositions(journal: Journal): readonly TransitPosition[] {
  const open = new Map<string, { openedAt: string; total: bigint }>();
  for (const entry of journal.entries) {
    const touched = new Set<string>();
    for (const posting of entry.postings) {
      const account = posting.account;
      const isTransit =
        platformFundsRole(account) === 'transit' ||
        (poolDirection(account) === 'terminal' && accountType(account) === 'asset');
      if (!isTransit) continue;
      const key = `${accountCode(account)}|${posting.amount.currency}`;
      touched.add(key);
      const state = open.get(key) ?? { openedAt: entry.occurredAt, total: 0n };
      state.total += postingNaturalSign(posting);
      open.set(key, state);
    }
    for (const key of touched) {
      if (open.get(key)?.total === 0n) open.delete(key);
    }
  }
  return [...open.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([key, state]) => {
      const separator = key.lastIndexOf('|');
      const currency = key.slice(separator + 1) as CurrencyCode;
      return Object.freeze({
        accountCode: key.slice(0, separator),
        currency,
        openedAt: state.openedAt,
        amount: money(currency, state.total),
      });
    });
}

/** Проводка в выписке: счёт, сторона, сумма и файл, к которому она отнесена. */
export interface StatementPosting {
  readonly accountCode: string;
  readonly direction: Direction;
  readonly amount: Money<CurrencyCode>;
  readonly attribution: FundsSource | null;
}

export interface StatementEvent {
  readonly entryId: string;
  readonly occurredAt: string;
  readonly kind: JournalEntryKind;
  /** Ключ локализации, а не текст: три языка, §5. */
  readonly memoKey: string;
  readonly correctsEntryId: string | null;
  /** Объявление обмена вместе с тремя курсами, если запись его несёт. */
  readonly converts: FxExecution | null;
  /** Объявление начисления вместе с версией тарифного плана (§4.2). */
  readonly accrues: FeeAccrualDeclaration | null;
  readonly postings: readonly StatementPosting[];
}

/**
 * Выписка по сделке — история И14.2, «базовый артефакт доверия» (CORE.md §3).
 *
 * **В выписку попадают записи целиком, а не только проводки файла транша.**
 * Иначе главная строка для получателя — зачисление нетто на его свободную
 * часть — выпала бы: она отнесена к файлу получателя, а не к файлу транша.
 * Запись, тронувшая транш, — это событие сделки, и сторона обязана видеть его
 * обеими ногами: сколько списано с транша и сколько зачислено ей.
 *
 * Правила ровно те же, что у `clientStatement`, и по тем же причинам:
 *
 * - **валюты не пересчитываются** — пересчёт требует курса, а курс это
 *   отдельное решение (§4.5). Курс, по которому обмен состоялся, приходит
 *   объявлением записи (`converts`), а не пересчётом задним числом;
 * - **нули не фильтруются** — «было и стало нулём» и «не было вовсе» разные
 *   факты;
 * - **текста нет** — только ключи локализации.
 *
 * Чего здесь нет и не будет: водяного знака, логирования просмотра и PDF
 * (И14.2, третий критерий). Это не журнал: знак и лог живут в `audit`,
 * формирование документа — в интерфейсе. Учёт отдаёт факты.
 */
export interface DealStatement {
  readonly deal: TrancheRef;
  readonly events: readonly StatementEvent[];
  /** Начислено, удержано, получено по этой сделке — раздельно (Ф16). */
  readonly fee: readonly FeePosition[];
}

function postingBelongsToTranche(posting: Posting, deal: TrancheRef): boolean {
  const own = clientAccountFile(posting.account);
  if (own !== null && !isClientRef(own)) {
    if (own.dealId === deal.dealId && own.trancheId === deal.trancheId) return true;
  }
  const attribution = posting.attribution;
  return (
    attribution !== null &&
    !isClientRef(attribution) &&
    attribution.dealId === deal.dealId &&
    attribution.trancheId === deal.trancheId
  );
}

function statementEvent(entry: JournalEntry): StatementEvent {
  return Object.freeze({
    entryId: entry.id,
    occurredAt: entry.occurredAt,
    kind: entry.kind,
    memoKey: entry.memoKey,
    correctsEntryId: entry.correctsEntryId,
    converts: entry.converts,
    accrues: entry.accrues,
    postings: Object.freeze(
      entry.postings.map((posting) =>
        Object.freeze({
          accountCode: accountCode(posting.account),
          direction: posting.direction,
          amount: posting.amount,
          attribution: asSource(posting.attribution),
        }),
      ),
    ),
  });
}

export function dealStatement(journal: Journal, deal: TrancheRef): DealStatement {
  const events = journal.entries
    .filter((entry) => entry.postings.some((posting) => postingBelongsToTranche(posting, deal)))
    .map(statementEvent);
  return Object.freeze({
    deal: Object.freeze({ dealId: deal.dealId, trancheId: deal.trancheId }),
    events: Object.freeze(events),
    fee: Object.freeze(
      feePositions(journal).filter(
        (item) => item.deal.dealId === deal.dealId && item.deal.trancheId === deal.trancheId,
      ),
    ),
  });
}
