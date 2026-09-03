import type { CurrencyCode } from '@sdelka/money';
import {
  coverage,
  coverageByFundsSource,
  coverageByTranche,
  negativeClientBalances,
} from './balance';
import { balanceByCurrency } from './entry';
import type { Journal } from './journal';

/**
 * Инварианты учёта, проверяемые в коде.
 *
 * В целевой архитектуре их держит база: триггер на нулевую сумму журнала,
 * ограничение на неотрицательный остаток, частичный уникальный индекс на
 * выплату. Пока базы нет, те же правила проверяются здесь — и остаются здесь
 * после, как второй контур для регулярной проверки и для отчёта дежурному.
 */
export const InvariantCode = {
  entryUnbalanced: 'ledger.invariant.entry_unbalanced',
  negativeClientBalance: 'ledger.invariant.negative_client_balance',
  coverageBelowOne: 'ledger.invariant.coverage_below_one',
  trancheUncovered: 'ledger.invariant.tranche_uncovered',
  // Второй вид файла (FUNCTIONAL.md §3.1): свободная часть счёта клиента.
  // Обязательство перед клиентом вне сделки без денег на номинальном счёте —
  // такое же расхождение, как необеспеченный транш, и точно так же должно
  // останавливать приём новых сделок.
  clientAccountUncovered: 'ledger.invariant.client_account_uncovered',
  /**
   * Средства на номинальном счёте, отнесённые к файлу, но никому по этому файлу
   * не должные.
   *
   * Профицит по файлу — не запас прочности, а одно из двух нарушений, и оба
   * красные. Либо на счёте клиентских средств лежат деньги платформы
   * (комиссия, которую забыли вывести, — красная линия №2), либо обязательство
   * из файла увели, а деньги оставили: дебет обязательства без встречного
   * движения кастодиана уносит транш в профицит, и до появления этой проверки
   * такую двухзаписную «отмывку» через `suspense` не ловило вообще ничто —
   * пофайловое покрытие считает профицит покрытием (`custody >= obligations`),
   * а у непознанного поступления файла нет вовсе.
   */
  custodySurplus: 'ledger.invariant.custody_surplus',
} as const;

export type InvariantCode = (typeof InvariantCode)[keyof typeof InvariantCode];

export interface InvariantViolation {
  readonly code: InvariantCode;
  readonly currency: CurrencyCode | null;
  readonly subject: string;
  readonly amountMinor: bigint;
}

export function checkLedgerInvariants(journal: Journal): readonly InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  for (const entry of journal.entries) {
    for (const [currency, total] of balanceByCurrency(entry.postings)) {
      if (total !== 0n) {
        violations.push({
          code: InvariantCode.entryUnbalanced,
          currency,
          subject: entry.id,
          amountMinor: total,
        });
      }
    }
  }

  for (const item of negativeClientBalances(journal)) {
    violations.push({
      code: InvariantCode.negativeClientBalance,
      currency: item.currency,
      subject: item.accountCode,
      amountMinor: item.balance.minor,
    });
  }

  for (const item of coverage(journal)) {
    if (!item.covered) {
      violations.push({
        code: InvariantCode.coverageBelowOne,
        currency: item.currency,
        subject: 'portfolio',
        amountMinor: item.difference.minor,
      });
    }
  }

  for (const item of coverageByTranche(journal)) {
    if (!item.covered) {
      violations.push({
        code: InvariantCode.trancheUncovered,
        currency: item.currency,
        subject: `${item.deal.dealId}:${item.deal.trancheId}`,
        amountMinor: item.difference.minor,
      });
    }
  }

  for (const item of coverageByFundsSource(journal)) {
    const subject =
      item.source.kind === 'client'
        ? item.source.clientKey
        : `${item.source.deal.dealId}:${item.source.deal.trancheId}`;
    // Транши уже посчитаны выше своим отношением: недостача по файлу клиента
    // добавляется здесь, иначе одно и то же расхождение попадало бы в отчёт
    // дважды.
    if (item.source.kind === 'client' && !item.covered) {
      violations.push({
        code: InvariantCode.clientAccountUncovered,
        currency: item.currency,
        subject,
        amountMinor: item.difference.minor,
      });
    }
    // Профицит считается по обоим видам файла: деньги платформы на номинальном
    // счёте (красная линия №2) и опустошённый файл (красная линия №1) выглядят
    // одинаково — средств больше, чем обязательств, — и оба обязаны быть
    // расхождением, а не запасом.
    if (item.difference.minor > 0n) {
      violations.push({
        code: InvariantCode.custodySurplus,
        currency: item.currency,
        subject,
        amountMinor: item.difference.minor,
      });
    }
  }

  return violations;
}

/**
 * Нарушение покрытия останавливает приём новых сделок автоматически
 * (красная линия №3, CORE.md Ф10). Решение принимает приложение — здесь
 * только признак, вычисленный из журнала.
 */
export function shouldStopAcceptingDeals(journal: Journal): boolean {
  return checkLedgerInvariants(journal).some(
    (violation) =>
      violation.code === InvariantCode.coverageBelowOne ||
      violation.code === InvariantCode.trancheUncovered ||
      violation.code === InvariantCode.clientAccountUncovered ||
      // Профицит — тоже отклонение покрытия от единицы, только в другую
      // сторону, и останавливает приём ровно так же: пока на счёте клиентских
      // средств лежит чужое этому счёту, новые деньги туда принимать нельзя.
      violation.code === InvariantCode.custodySurplus ||
      violation.code === InvariantCode.negativeClientBalance,
  );
}
