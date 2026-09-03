import type { Anchor, AuditChain, RawSourceRef } from '@sdelka/audit';
import { verifyChain } from '@sdelka/audit';
import type { BeneficiaryState, ReviewTask } from '@sdelka/compliance';
import {
  type Audience,
  type ConditionAct,
  type DealState,
  type Instant,
  type PayoutState,
  type TrancheFacts,
  type TrancheState,
  isTerminalTrancheStatus,
  violatesSingleActivePayout,
} from '@sdelka/domain';
import {
  type ClientKey,
  type Journal,
  balanceByCurrency,
  checkLedgerInvariants,
  isEveryFundsSourceCovered,
  isEveryTrancheCovered,
  isFullyCovered,
  negativeClientBalances,
} from '@sdelka/ledger';
import type { CurrencyCode, Deduction, Money } from '@sdelka/money';
import type { LedgerTemplate } from '@sdelka/domain';

/** Уведомление стороне. `messageKey` — ключ локализации, текста в коде нет. */
export interface Notification {
  readonly audience: Audience;
  readonly messageKey: string;
}

/** Намерение проводки, у которого проводки не оказалось. Видно тесту, а не молча. */
export interface SuppressedEntry {
  readonly trancheId: string;
  readonly template: LedgerTemplate;
  readonly reasonKey: string;
}

export interface TrancheRuntime {
  readonly dealId: string;
  readonly trancheId: string;
  readonly state: TrancheState;
  readonly facts: TrancheFacts;
  /** Владелец обязательства по траншу — плательщик. Ключ счёта, не ключ личности. */
  readonly payer: ClientKey;
  readonly recipient: ClientKey;
  readonly deductions: readonly Deduction[];
  readonly payouts: readonly PayoutState[];
  readonly beneficiary: BeneficiaryState;
  /** Сырые ответы источников, из которых собирается пакет доказательств. */
  readonly evidence: readonly RawSourceRef[];
  /** Приостановленный остаток дедлайна, если транш заморожен. */
  readonly suspendedRemaining: number | null;
}

export interface DealRuntime {
  readonly dealId: string;
  readonly state: DealState;
  readonly conditionAct: ConditionAct | null;
  readonly preparedBy: string | null;
  readonly trancheIds: readonly string[];
}

export interface World {
  readonly now: Instant;
  readonly journal: Journal;
  readonly chain: AuditChain;
  readonly anchors: readonly Anchor[];
  readonly deals: ReadonlyMap<string, DealRuntime>;
  readonly tranches: ReadonlyMap<string, TrancheRuntime>;
  readonly tasks: readonly ReviewTask[];
  readonly notifications: readonly Notification[];
  readonly suppressed: readonly SuppressedEntry[];
  /**
   * Ключи идемпотентности поручений, которые автомат велел отправить повторно.
   * Гасятся ключом, а не молчанием: повтор обязан быть виден. Отчёт, расхождение 13.
   */
  readonly reissuedPayouts: readonly string[];
  /** Сколько раз инварианты проверялись. Растёт на каждом шаге, тест это видит. */
  readonly checks: number;
  /** Счётчик идентификаторов записей журнала и аудита. */
  readonly seq: number;
}

/* ------------------------------------------------------------------------- */
/* Инварианты                                                                */
/* ------------------------------------------------------------------------- */

export const E2E_INVARIANTS = [
  'entry_not_zero',
  'coverage_below_one',
  'tranche_uncovered',
  'funds_source_uncovered',
  'negative_client_balance',
  'double_active_payout',
  'non_terminal_without_deadline',
  'audit_chain_broken',
] as const;

export type E2eInvariant = (typeof E2E_INVARIANTS)[number];

export interface InvariantViolation {
  readonly invariant: E2eInvariant;
  readonly subject: string;
  readonly detail: string;
}

/**
 * Проверка после каждого шага.
 *
 * Четыре денежных инварианта здесь проверяются **поимённо**, а не одним вызовом
 * `checkLedgerInvariants`, хотя он их и покрывает: сквозной прогон обязан
 * называть нарушенное правило, а не отдавать список кодов. Пятый и шестой —
 * из домена: одна активная выплата на транш и «нетерминальное состояние несёт
 * дедлайн либо остаток приостановленного дедлайна» (`STATE-MACHINES.md` §5,
 * уточнение E9-10). Седьмой — целостность журнала аудита: он тоже часть шага.
 */
export function invariantViolations(world: World): readonly InvariantViolation[] {
  const out: InvariantViolation[] = [];

  // 1. Сумма проводок в записи равна нулю по каждой валюте.
  for (const entry of world.journal.entries) {
    for (const [currency, total] of balanceByCurrency(entry.postings)) {
      if (total !== 0n) {
        out.push({ invariant: 'entry_not_zero', subject: entry.id, detail: `${currency}:${total}` });
      }
    }
  }

  // 2. Покрытие клиентских средств по портфелю.
  if (!isFullyCovered(world.journal)) {
    out.push({ invariant: 'coverage_below_one', subject: 'portfolio', detail: '' });
  }

  // 3. Пофайловое обеспечение: по траншу и по счёту клиента.
  if (!isEveryTrancheCovered(world.journal)) {
    out.push({ invariant: 'tranche_uncovered', subject: 'tranche', detail: '' });
  }
  if (!isEveryFundsSourceCovered(world.journal)) {
    out.push({ invariant: 'funds_source_uncovered', subject: 'funds_source', detail: '' });
  }

  // 4. Неотрицательность остатков клиентских счетов.
  for (const item of negativeClientBalances(world.journal)) {
    out.push({
      invariant: 'negative_client_balance',
      subject: item.accountCode,
      detail: item.balance.minor.toString(),
    });
  }

  for (const tranche of world.tranches.values()) {
    if (violatesSingleActivePayout(tranche.payouts, tranche.trancheId)) {
      out.push({ invariant: 'double_active_payout', subject: tranche.trancheId, detail: '' });
    }
    const state = tranche.state;
    if (isTerminalTrancheStatus(state.status)) continue;
    if (!('deadline' in state) && !('remaining' in state)) {
      out.push({
        invariant: 'non_terminal_without_deadline',
        subject: tranche.trancheId,
        detail: state.status,
      });
    }
  }

  const integrity = verifyChain(world.chain);
  if (!integrity.intact) {
    out.push({
      invariant: 'audit_chain_broken',
      subject: world.chain.chainId,
      detail: integrity.firstBreak.kind,
    });
  }

  // Второй контур: коды учёта. Если он что-то видит, а поимённые проверки нет —
  // расходятся не деньги, а наши представления о них, и это тоже отказ.
  for (const violation of checkLedgerInvariants(world.journal)) {
    if (out.some((item) => item.subject === violation.subject)) continue;
    out.push({
      invariant: 'coverage_below_one',
      subject: violation.subject,
      detail: violation.code,
    });
  }

  return Object.freeze(out);
}

export class E2eInvariantError extends Error {
  readonly violations: readonly InvariantViolation[];

  constructor(violations: readonly InvariantViolation[]) {
    super(
      `invariant violated: ${violations
        .map((item) => `${item.invariant}(${item.subject}${item.detail === '' ? '' : ` ${item.detail}`})`)
        .join(', ')}`,
    );
    this.name = 'E2eInvariantError';
    this.violations = violations;
  }
}

/**
 * Запечатать шаг: проверить инварианты и вернуть новое состояние мира.
 *
 * Единственный способ получить новый `World` — пройти через эту функцию, и
 * поэтому «инварианты проверяются после каждого шага» держится структурой, а не
 * дисциплиной тестов.
 */
export function sealed(next: Omit<World, 'checks'> & { readonly checks: number }): World {
  const candidate: World = Object.freeze({ ...next, checks: next.checks + 1 });
  const violations = invariantViolations(candidate);
  if (violations.length > 0) {
    throw new E2eInvariantError(violations);
  }
  return candidate;
}

export function trancheOf(world: World, trancheId: string): TrancheRuntime {
  const runtime = world.tranches.get(trancheId);
  if (runtime === undefined) {
    throw new Error(`e2e.unknown_tranche:${trancheId}`);
  }
  return runtime;
}

export function dealOf(world: World, dealId: string): DealRuntime {
  const runtime = world.deals.get(dealId);
  if (runtime === undefined) {
    throw new Error(`e2e.unknown_deal:${dealId}`);
  }
  return runtime;
}

export function withTranche(world: World, runtime: TrancheRuntime): ReadonlyMap<string, TrancheRuntime> {
  const next = new Map(world.tranches);
  next.set(runtime.trancheId, runtime);
  return next;
}

export function withDeal(world: World, runtime: DealRuntime): ReadonlyMap<string, DealRuntime> {
  const next = new Map(world.deals);
  next.set(runtime.dealId, runtime);
  return next;
}

/** Свободный остаток клиента — читается из учёта, домен его не считает. */
export function coverageOk(journal: Journal): boolean {
  return isFullyCovered(journal) && isEveryTrancheCovered(journal) && isEveryFundsSourceCovered(journal);
}

export function moneyLabel(value: Money<CurrencyCode>): string {
  return `${value.currency}:${value.minor}`;
}
