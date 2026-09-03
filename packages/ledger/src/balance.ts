import { type CurrencyCode, type Money, type Rational, money, rational } from '@sdelka/money';
import {
  type Account,
  accountCode,
  accountType,
  isClientCustodyAccount,
  isClientObligationAccount,
} from './accounts';
import { type Posting, type TrancheRef } from './entry';
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
    if (account.kind === 'client') {
      bump(
        obligations,
        { dealId: account.dealId, trancheId: account.trancheId },
        currency,
        naturalSign(account, posting),
      );
    } else if (isClientCustodyAccount(account) && posting.attribution !== null) {
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
