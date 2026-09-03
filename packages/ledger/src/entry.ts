import type { CurrencyCode, Money } from '@sdelka/money';
import {
  type Account,
  accountCode,
  isClientCustodyAccount,
  isClientFundsAccount,
  isPlatformIncomeAccount,
} from './accounts';
import { LedgerError, LedgerErrorCode } from './errors';

export type Direction = 'debit' | 'credit';

/** Отнесение проводки к сделке и траншу — основание пофайловой сверки. */
export interface TrancheRef {
  readonly dealId: string;
  readonly trancheId: string;
}

export interface Posting {
  readonly account: Account;
  readonly direction: Direction;
  readonly amount: Money<CurrencyCode>;
  /** `null` допустим только там, где сделка ещё не известна: непознанное поступление. */
  readonly attribution: TrancheRef | null;
}

/**
 * `correction` — единственный способ исправления (красная линия №11: журнал не
 * редактируется, исправление только новой записью со ссылкой на предыдущую).
 */
export type JournalEntryKind = 'settlement' | 'correction';

export interface JournalEntryInput {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: JournalEntryKind;
  readonly postings: readonly Posting[];
  /** Ключ локализации/тип операции, не текст для клиента. */
  readonly memoKey: string;
  readonly correctsEntryId?: string;
}

export interface JournalEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: JournalEntryKind;
  readonly postings: readonly Posting[];
  readonly memoKey: string;
  readonly correctsEntryId: string | null;
}

function signedMinor(posting: Posting): bigint {
  return posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor;
}

/** Дт минус Кт по каждой валюте отдельно. */
export function balanceByCurrency(postings: readonly Posting[]): ReadonlyMap<CurrencyCode, bigint> {
  const totals = new Map<CurrencyCode, bigint>();
  for (const posting of postings) {
    const currency = posting.amount.currency;
    totals.set(currency, (totals.get(currency) ?? 0n) + signedMinor(posting));
  }
  return totals;
}

function assertBalanced(postings: readonly Posting[]): void {
  // Мультивалютная запись балансируется в каждой валюте, а не в пересчёте:
  // пересчёт зависит от курса, а курс — это отдельная проводка (FUNCTIONAL.md §3.3).
  for (const [currency, total] of balanceByCurrency(postings)) {
    if (total !== 0n) {
      throw new LedgerError(LedgerErrorCode.entryUnbalanced, {
        currency,
        difference: total.toString(),
      });
    }
  }
}

function assertAttribution(postings: readonly Posting[]): void {
  // Непознанное поступление не может быть отнесено к сделке — на то оно и
  // непознанное (FUNCTIONAL.md §3.3, шаг 1). Во всех остальных записях проводка
  // по номинальному счёту обязана нести отнесение, иначе пофайловая сверка
  // (CORE.md Ф10) не построится.
  const hasSuspense = postings.some((posting) => posting.account.kind === 'suspense_unidentified');
  for (const posting of postings) {
    const account = posting.account;
    if (account.kind === 'client') {
      const attribution = posting.attribution;
      if (
        attribution !== null &&
        (attribution.dealId !== account.dealId || attribution.trancheId !== account.trancheId)
      ) {
        throw new LedgerError(LedgerErrorCode.postingAttributionMismatch, {
          account: accountCode(account),
          dealId: attribution.dealId,
          trancheId: attribution.trancheId,
        });
      }
      continue;
    }
    if (isClientCustodyAccount(account) && posting.attribution === null && !hasSuspense) {
      throw new LedgerError(LedgerErrorCode.postingCustodyWithoutAttribution, {
        account: accountCode(account),
      });
    }
  }
}

function assertFeeNeverLandsOnClientFunds(
  kind: JournalEntryKind,
  postings: readonly Posting[],
): void {
  // Красная линия №2: комиссия платформы не может иметь конечным счётом
  // клиентские средства. Признак — доход платформы по дебету (уходит с дохода)
  // и клиентские средства по кредиту (приходят на них) в одной записи.
  // Обратная проводка при исправлении — законный случай: возврат ошибочно
  // удержанной комиссии клиенту. Поэтому он разрешён только записью типа
  // `correction`, у которой обязана быть ссылка на исправляемую запись.
  if (kind === 'correction') {
    return;
  }
  const debitsIncome = postings.some(
    (posting) => posting.direction === 'debit' && isPlatformIncomeAccount(posting.account),
  );
  if (!debitsIncome) {
    return;
  }
  const creditsClientFunds = postings.find(
    (posting) => posting.direction === 'credit' && isClientFundsAccount(posting.account),
  );
  if (creditsClientFunds !== undefined) {
    throw new LedgerError(LedgerErrorCode.entryFeeIntoClientFunds, {
      account: accountCode(creditsClientFunds.account),
    });
  }
}

export function createJournalEntry(input: JournalEntryInput): JournalEntry {
  if (input.postings.length < 2) {
    throw new LedgerError(LedgerErrorCode.entryTooFewPostings, {
      postings: String(input.postings.length),
    });
  }
  for (const posting of input.postings) {
    if (posting.amount.minor <= 0n) {
      // Знак несёт направление (Дт/Кт), а не сумма: иначе одна и та же операция
      // записывается двумя способами и сверка перестаёт быть однозначной.
      throw new LedgerError(LedgerErrorCode.postingNonPositiveAmount, {
        account: accountCode(posting.account),
        amount: posting.amount.minor.toString(),
      });
    }
  }
  assertBalanced(input.postings);
  assertAttribution(input.postings);
  assertFeeNeverLandsOnClientFunds(input.kind, input.postings);
  if (input.kind === 'correction' && input.correctsEntryId === undefined) {
    throw new LedgerError(LedgerErrorCode.entryCorrectionWithoutReference, { id: input.id });
  }
  if (input.kind === 'settlement' && input.correctsEntryId !== undefined) {
    throw new LedgerError(LedgerErrorCode.entrySettlementWithReference, { id: input.id });
  }
  return Object.freeze({
    id: input.id,
    occurredAt: input.occurredAt,
    kind: input.kind,
    postings: Object.freeze([...input.postings]),
    memoKey: input.memoKey,
    correctsEntryId: input.correctsEntryId ?? null,
  });
}

export function debit(
  account: Account,
  amount: Money<CurrencyCode>,
  attribution: TrancheRef | null = null,
): Posting {
  return Object.freeze({ account, direction: 'debit', amount, attribution });
}

export function credit(
  account: Account,
  amount: Money<CurrencyCode>,
  attribution: TrancheRef | null = null,
): Posting {
  return Object.freeze({ account, direction: 'credit', amount, attribution });
}
