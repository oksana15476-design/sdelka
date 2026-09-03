import type { CurrencyCode } from '@sdelka/money';
import { LedgerError, LedgerErrorCode } from './errors';

/** План счетов — FUNCTIONAL.md §3.1 и §4.1. Счёт — значение, а не свободная строка. */
export type Account =
  | { readonly kind: 'bank_nominal'; readonly currency: CurrencyCode }
  | { readonly kind: 'bank_operating'; readonly currency: CurrencyCode }
  | { readonly kind: 'client'; readonly dealId: string; readonly trancheId: string }
  | { readonly kind: 'suspense_unidentified' }
  | { readonly kind: 'fee_income' }
  | { readonly kind: 'fx_income' }
  | { readonly kind: 'service_income' }
  | { readonly kind: 'subscription_income' }
  | { readonly kind: 'psp_fee_expense' }
  | { readonly kind: 'oracle_cost_expense' }
  | { readonly kind: 'writeoff_expense' }
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
  client: 'liability',
  suspense_unidentified: 'liability',
  fee_income: 'income',
  fx_income: 'income',
  service_income: 'income',
  subscription_income: 'income',
  psp_fee_expense: 'expense',
  oracle_cost_expense: 'expense',
  writeoff_expense: 'expense',
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
  client: 'client',
  suspense_unidentified: 'client',
  fee_income: 'platform',
  fx_income: 'platform',
  service_income: 'platform',
  subscription_income: 'platform',
  psp_fee_expense: 'platform',
  oracle_cost_expense: 'platform',
  // Списание идёт за счёт платформы, а не других клиентов (FUNCTIONAL.md §3.1).
  writeoff_expense: 'platform',
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
  return account.kind === 'client' || account.kind === 'suspense_unidentified';
}

export function isClientFundsAccount(account: Account): boolean {
  return fundsOwnership(account) === 'client';
}

export function isPlatformIncomeAccount(account: Account): boolean {
  return accountType(account) === 'income';
}

function assertIdentifier(value: string, field: string): string {
  if (value.length === 0 || value.includes(':')) {
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
    case 'client':
      return `client:${assertIdentifier(account.dealId, 'dealId')}:${assertIdentifier(
        account.trancheId,
        'trancheId',
      )}`;
    case 'suspense_unidentified':
      return 'suspense:unidentified';
    case 'fee_income':
      return 'fee:income';
    case 'fx_income':
      return 'fx:income';
    case 'service_income':
      return 'service:income';
    case 'subscription_income':
      return 'subscription:income';
    case 'psp_fee_expense':
      return 'psp:fee:expense';
    case 'oracle_cost_expense':
      return 'oracle:cost:expense';
    case 'writeoff_expense':
      return 'writeoff:expense';
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
export const clientAccount = (dealId: string, trancheId: string): Account => ({
  kind: 'client',
  dealId,
  trancheId,
});
export const writeoffExpense: Account = Object.freeze({ kind: 'writeoff_expense' });
export const fxAccountingDiff: Account = Object.freeze({ kind: 'fx_accounting_diff' });
