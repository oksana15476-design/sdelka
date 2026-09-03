import type { CurrencyCode } from '@sdelka/money';
import { LedgerError, LedgerErrorCode } from './errors';

/**
 * Ключ счёта клиента.
 *
 * FUNCTIONAL.md §2.1 и §3.1: **один клиент — один счёт на все его сделки в любых
 * ролях**, и ключом этого счёта является ключ личности, а не пара «сделка +
 * роль». Роль — свойство участия в сделке, а не человека, поэтому в ключе счёта
 * её нет вовсе.
 *
 * Тип брендированный: сырую строку на место владельца подставить нельзя, иначе
 * `dealId` и ключ личности начинают путешествовать по одним и тем же аргументам.
 *
 * Форма ключа личности (`страна:тип:отпечаток`, `packages/compliance`) сюда не
 * попадает: она содержит двоеточие — разделитель кода счёта — и несёт семантику
 * персональных данных, которой в учёте не место. Перевод одного в другое —
 * забота compliance, ledger видит только непрозрачный идентификатор.
 */
export type ClientKey = string & { readonly __clientKey: unique symbol };

const CLIENT_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

export function clientKey(value: string): ClientKey {
  if (!CLIENT_KEY_PATTERN.test(value)) {
    throw new LedgerError(LedgerErrorCode.accountInvalidIdentifier, { field: 'clientKey', value });
  }
  return value as ClientKey;
}

/** План счетов — FUNCTIONAL.md §3.1 и §4.1. Счёт — значение, а не свободная строка. */
export type Account =
  | { readonly kind: 'bank_nominal'; readonly currency: CurrencyCode }
  | { readonly kind: 'bank_operating'; readonly currency: CurrencyCode }
  // Свободная часть счёта клиента: его собственные и отзывные деньги вне сделок.
  | { readonly kind: 'client_free'; readonly clientKey: ClientKey }
  // Запертая часть: обязательство перед тем же клиентом под конкретный транш.
  // Владелец и транш вместе входят в код счёта — именно этим «заперто под сделку
  // А» отличается от «заперто под сделку Б» структурно, а не проверкой.
  | {
      readonly kind: 'client_locked';
      readonly clientKey: ClientKey;
      readonly dealId: string;
      readonly trancheId: string;
    }
  | { readonly kind: 'suspense_unidentified' }
  | { readonly kind: 'fee_income' }
  | { readonly kind: 'fx_income' }
  | { readonly kind: 'service_income' }
  | { readonly kind: 'psp_fee_expense' }
  | { readonly kind: 'oracle_cost_expense' }
  | { readonly kind: 'shortfall_expense' }
  | { readonly kind: 'unclaimed_liability' }
  | { readonly kind: 'fx_accounting_diff' };

export type AccountKind = Account['kind'];

export type AccountType = 'asset' | 'liability' | 'income' | 'expense';

/**
 * Чьи это деньги. Красная линия №2 и покрытие (CORE.md Ф10) держатся на этом
 * различении, поэтому оно свойство счёта, а не соглашение об именовании.
 */
export type FundsOwnership = 'client' | 'platform';

const ACCOUNT_TYPE: Readonly<Record<AccountKind, AccountType>> = {
  bank_nominal: 'asset',
  bank_operating: 'asset',
  client_free: 'liability',
  client_locked: 'liability',
  suspense_unidentified: 'liability',
  fee_income: 'income',
  fx_income: 'income',
  service_income: 'income',
  psp_fee_expense: 'expense',
  oracle_cost_expense: 'expense',
  // Случай А из §3.1: недостача, покрытая платформой. Признаётся в момент
  // поступления, состоянием транша не является.
  shortfall_expense: 'expense',
  // Случай Б: невостребованные средства. Обязательство, а не доход. Признать
  // их доходом было бы удобно и, возможно, незаконно — порядок обращения
  // с ними помечен в §3.1 как [открыто], до ответа юриста это долг.
  unclaimed_liability: 'liability',
  // FUNCTIONAL.md §3.1 помечает учётную курсовую разницу как «расход/доход»:
  // она бывает обеих знаков. Тип счёта в плане один, поэтому знак несёт
  // направление проводки, а не отдельный счёт: кредитовый остаток на этом
  // счёте читается как доход. Разводить на два счёта — решение владельца,
  // здесь его нет.
  fx_accounting_diff: 'expense',
};

const FUNDS_OWNERSHIP: Readonly<Record<AccountKind, FundsOwnership>> = {
  // Номинальный счёт — актив, на котором лежат чужие деньги. Именно он
  // сопоставляется с обязательствами при проверке покрытия.
  bank_nominal: 'client',
  bank_operating: 'platform',
  client_free: 'client',
  client_locked: 'client',
  suspense_unidentified: 'client',
  fee_income: 'platform',
  fx_income: 'platform',
  service_income: 'platform',
  psp_fee_expense: 'platform',
  oracle_cost_expense: 'platform',
  // Недостачу платформа покрывает своими деньгами — это её расход.
  shortfall_expense: 'platform',
  // Невостребованные средства — по-прежнему чужие деньги, поэтому 'client'.
  // В отношение покрытия (номинальный счёт против обязательств по траншам)
  // они при этом не входят: они лежат на операционном счёте, а не на
  // номинальном. Обеспеченность этого долга операционным остатком отдельным
  // отношением здесь не проверяется — см. отчёт по батчу.
  unclaimed_liability: 'client',
  // Учётная курсовая разница — средства платформы. Это не наш спред: спред и
  // разница разведены типами в money (FUNCTIONAL.md §4.5, CORE.md Ф5).
  fx_accounting_diff: 'platform',
};

export function accountType(account: Account): AccountType {
  return ACCOUNT_TYPE[account.kind];
}

export function fundsOwnership(account: Account): FundsOwnership {
  return FUNDS_OWNERSHIP[account.kind];
}

/** Актив, на котором физически лежат клиентские средства. */
export function isClientCustodyAccount(account: Account): boolean {
  return account.kind === 'bank_nominal';
}

/** Обязательство перед клиентом, включая непознанные поступления. */
export function isClientObligationAccount(account: Account): boolean {
  return (
    account.kind === 'client_free' ||
    account.kind === 'client_locked' ||
    account.kind === 'suspense_unidentified'
  );
}

/** Запертая под конкретный транш часть счёта клиента. */
export function isClientLockedAccount(account: Account): boolean {
  return account.kind === 'client_locked';
}

/**
 * Владелец обязательства. `null` у непознанного поступления — это не пробел, а
 * его определение: клиента у него ещё нет (FUNCTIONAL.md §3.3, шаг 1).
 */
export function clientAccountOwner(account: Account): ClientKey | null {
  return account.kind === 'client_free' || account.kind === 'client_locked'
    ? account.clientKey
    : null;
}

export function isClientFundsAccount(account: Account): boolean {
  return fundsOwnership(account) === 'client';
}

export function isPlatformIncomeAccount(account: Account): boolean {
  return accountType(account) === 'income';
}

/**
 * Идентификатор, из которого собирается код счёта. Экспортируется, потому что
 * то же ограничение обязано действовать на значениях, которые кодом счёта не
 * являются, но с ним сверяются, — например на объявлении расчёта
 * (`TrancheSettlement`, `entry.ts`): сравнение по коду счёта работает только
 * тогда, когда обе стороны сравнения собраны по одним и тем же правилам.
 */
export function assertAccountIdentifier(value: string, field: string): string {
  // Двоеточие — разделитель кода счёта, вертикальная черта — разделитель
  // внутренних ключей источника средств (`entry.ts`). Идентификатор с любым из
  // них делает два разных счёта неотличимыми в сверке.
  if (value.length === 0 || value.includes(':') || value.includes('|')) {
    throw new LedgerError(LedgerErrorCode.accountInvalidIdentifier, { field, value });
  }
  return value;
}

export function accountCode(account: Account): string {
  switch (account.kind) {
    case 'bank_nominal':
      return `bank:nominal:${account.currency.toLowerCase()}`;
    case 'bank_operating':
      return `bank:operating:${account.currency.toLowerCase()}`;
    // Сегменты `free` и `tranche` фиксированные, а не позиционные: без них
    // сделка с идентификатором `free` давала бы код чужого счёта.
    case 'client_free':
      return `client:${assertAccountIdentifier(account.clientKey, 'clientKey')}:free`;
    case 'client_locked':
      return `client:${assertAccountIdentifier(account.clientKey, 'clientKey')}:tranche:${assertAccountIdentifier(
        account.dealId,
        'dealId',
      )}:${assertAccountIdentifier(account.trancheId, 'trancheId')}`;
    case 'suspense_unidentified':
      return 'suspense:unidentified';
    case 'fee_income':
      return 'fee:income';
    case 'fx_income':
      return 'fx:income';
    case 'service_income':
      return 'service:income';
    case 'psp_fee_expense':
      return 'psp:fee:expense';
    case 'oracle_cost_expense':
      return 'oracle:cost:expense';
    case 'shortfall_expense':
      return 'shortfall:expense';
    case 'unclaimed_liability':
      return 'unclaimed:liability';
    case 'fx_accounting_diff':
      return 'fx:accounting:diff';
  }
}

export function accountsEqual(left: Account, right: Account): boolean {
  return accountCode(left) === accountCode(right);
}

export const bankNominal = (currency: CurrencyCode): Account => ({ kind: 'bank_nominal', currency });
export const bankOperating = (currency: CurrencyCode): Account => ({
  kind: 'bank_operating',
  currency,
});
export const clientFreeAccount = (owner: ClientKey): Account => ({
  kind: 'client_free',
  clientKey: owner,
});
export const clientLockedAccount = (
  owner: ClientKey,
  dealId: string,
  trancheId: string,
): Account => ({
  kind: 'client_locked',
  clientKey: owner,
  dealId,
  trancheId,
});
export const shortfallExpense: Account = Object.freeze({ kind: 'shortfall_expense' });
export const unclaimedLiability: Account = Object.freeze({ kind: 'unclaimed_liability' });
export const fxAccountingDiff: Account = Object.freeze({ kind: 'fx_accounting_diff' });
