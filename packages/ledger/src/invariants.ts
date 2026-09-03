import type { CurrencyCode } from '@sdelka/money';
import { coverage, coverageByTranche, negativeClientBalances } from './balance';
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
      violation.code === InvariantCode.negativeClientBalance,
  );
}
