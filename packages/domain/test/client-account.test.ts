import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type ClientAccountFacts,
  type WithdrawalEvent,
  type WithdrawalState,
  RejectionCode,
  WITHDRAWAL_GUARD_IDS,
  WITHDRAWAL_REQUIRED_APPROVALS,
  WITHDRAWAL_TRANSITIONS,
  createWithdrawal,
  evaluateWithdrawalGuard,
  isTerminalWithdrawalStatus,
  lockedTotal,
  planAllocationToDeal,
  reduceWithdrawal,
  statusesWithoutTerminalPath,
  withdrawalIdempotencyKey,
} from '../src/index';
import { NOW } from './support/facts';

function facts(overrides: Partial<ClientAccountFacts> = {}): ClientAccountFacts {
  return {
    free: money('GEL', 1_000_000n),
    locked: [],
    requestedAmount: money('GEL', 400_000n),
    sourceAccount: { accountRef: 'acc-1', holderIsPayer: true },
    preparedBy: 'operator-1',
    approvals: [{ userId: 'operator-2' }, { userId: 'operator-3' }],
    activeWithdrawals: 0,
    ...overrides,
  };
}

function apply(
  state: WithdrawalState,
  event: WithdrawalEvent,
  overrides: Partial<ClientAccountFacts> = {},
): WithdrawalState {
  const result = reduceWithdrawal(state, event, facts(overrides));
  if (!result.ok) {
    throw new Error(`unexpected rejection: ${result.error.code} ${result.error.failedGuards.join(',')}`);
  }
  return result.value.state;
}

describe('вывод со счёта клиента: guard за guard\'ом', () => {
  it('g_free_balance_sufficient', () => {
    expect(evaluateWithdrawalGuard('g_free_balance_sufficient', facts())).toBe(true);
    expect(
      evaluateWithdrawalGuard(
        'g_free_balance_sufficient',
        facts({ free: money('GEL', 399_999n) }),
      ),
    ).toBe(false);
    // Остаток в другой валюте — не «мало», а «несравнимо»: отказ закрытый,
    // пересчёт «для удобства» здесь запрещён (И12.1, крайний случай).
    expect(
      evaluateWithdrawalGuard(
        'g_free_balance_sufficient',
        facts({ free: money('USD', 100_000_000n) }),
      ),
    ).toBe(false);
    expect(
      evaluateWithdrawalGuard(
        'g_free_balance_sufficient',
        facts({ requestedAmount: money('GEL', 0n) }),
      ),
    ).toBe(false);
  });

  it('g_source_account_known: счёт и имя, а не один только счёт', () => {
    expect(evaluateWithdrawalGuard('g_source_account_known', facts())).toBe(true);
    expect(evaluateWithdrawalGuard('g_source_account_known', facts({ sourceAccount: null }))).toBe(
      false,
    );
    // FUNCTIONAL.md инвариант 20: возврат только на счёт-источник **на имя
    // плательщика**. Счёт может быть известен и при этом быть чужим.
    expect(
      evaluateWithdrawalGuard(
        'g_source_account_known',
        facts({ sourceAccount: { accountRef: 'acc-1', holderIsPayer: false } }),
      ),
    ).toBe(false);
  });

  it('g_approvals_sufficient и g_withdrawal_approvers_distinct', () => {
    expect(WITHDRAWAL_REQUIRED_APPROVALS).toBe(2);
    expect(evaluateWithdrawalGuard('g_approvals_sufficient', facts())).toBe(true);
    expect(
      evaluateWithdrawalGuard('g_approvals_sufficient', facts({ approvals: [{ userId: 'a' }] })),
    ).toBe(false);
    // Готовивший операцию не считается утверждающим.
    expect(
      evaluateWithdrawalGuard(
        'g_approvals_sufficient',
        facts({ approvals: [{ userId: 'operator-1' }, { userId: 'operator-2' }] }),
      ),
    ).toBe(false);
    expect(
      evaluateWithdrawalGuard(
        'g_withdrawal_approvers_distinct',
        facts({ approvals: [{ userId: 'a' }, { userId: 'a' }] }),
      ),
    ).toBe(false);
  });

  it('g_no_active_withdrawal', () => {
    expect(evaluateWithdrawalGuard('g_no_active_withdrawal', facts())).toBe(true);
    expect(
      evaluateWithdrawalGuard('g_no_active_withdrawal', facts({ activeWithdrawals: 1 })),
    ).toBe(false);
  });
});

describe('вывод: стоп-кран не превращается в удержание чужих денег', () => {
  it('has no coverage guard anywhere in the withdrawal machine', () => {
    // Тест-надгробие. ROADMAP.md И12.2: «дано: приём новых сделок остановлен
    // стоп-краном. Тогда вывод и возвраты продолжают исполняться». Покрытие —
    // условие приёма новых обязательств, а не исполнения уже принятых; guard
    // покрытия здесь однажды поставят «за компанию», и это будет удержание
    // чужих денег (красная линия №7).
    expect([...WITHDRAWAL_GUARD_IDS]).not.toContain('g_coverage_ok');
    for (const edge of WITHDRAWAL_TRANSITIONS) {
      expect([...edge.guards, ...edge.negatedGuards]).not.toContain('g_coverage_ok');
    }
  });
});

describe('вывод: машина состояний', () => {
  it('runs requested → approved → paying_out → paid_out', () => {
    let state = createWithdrawal('w-1');
    expect(state.status).toBe('requested');
    state = apply(state, { type: 'withdrawal_approved' });
    expect(state.status).toBe('approved');
    state = apply(state, { type: 'withdrawal_dispatched' });
    expect(state.status).toBe('paying_out');
    state = apply(state, { type: 'payout_result', outcome: 'settled' });
    expect(state.status).toBe('paid_out');
    expect(isTerminalWithdrawalStatus(state.status)).toBe(true);
  });

  it('sends an unknown source account to the operator instead of paying somewhere', () => {
    // И12.2: «счёт-источник неизвестен → вывод не создаётся, задача уходит
    // оператору с причиной». Не тихий отказ клиенту и не выплата «куда-нибудь».
    const state = apply(createWithdrawal('w-2'), { type: 'withdrawal_approved' }, {
      sourceAccount: null,
    });
    expect(state.status).toBe('blocked');
  });

  it('refuses a withdrawal larger than the free balance', () => {
    const result = reduceWithdrawal(
      createWithdrawal('w-3'),
      { type: 'withdrawal_approved' },
      facts({ free: money('GEL', 1n) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.failedGuards).toContain('g_free_balance_sufficient');
    }
  });

  it('keeps an unknown provider answer in place instead of retrying', () => {
    // §2.2: повтор из «неизвестно» запрещён без прохождения через сверку, и это
    // реализовано отсутствием перехода, а не проверкой в обработчике.
    let state = apply(createWithdrawal('w-4'), { type: 'withdrawal_approved' });
    state = apply(state, { type: 'withdrawal_dispatched' });
    state = apply(state, { type: 'payout_result', outcome: 'unknown' });
    expect(state.status).toBe('paying_out');
    const retry = reduceWithdrawal(state, { type: 'withdrawal_dispatched' }, facts());
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.error.code).toBe(RejectionCode.transitionNotAllowed);
    }
  });

  it('resolves paying_out through reconciliation', () => {
    let state = apply(createWithdrawal('w-5'), { type: 'withdrawal_approved' });
    state = apply(state, { type: 'withdrawal_dispatched' });
    state = apply(state, { type: 'reconciliation_resolved', outcome: 'rejected' });
    expect(state.status).toBe('blocked');
    state = apply(state, { type: 'withdrawal_approved' });
    expect(state.status).toBe('approved');
  });

  it('refuses any event on a terminal state', () => {
    const cancelled = apply(createWithdrawal('w-6'), { type: 'withdrawal_cancelled' });
    const result = reduceWithdrawal(cancelled, { type: 'withdrawal_approved' }, facts());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(RejectionCode.terminalState);
    }
  });

  it('has no dead end', () => {
    expect(
      statusesWithoutTerminalPath(
        WITHDRAWAL_TRANSITIONS,
        WITHDRAWAL_TRANSITIONS.flatMap((edge) => [edge.from, edge.to]),
        (status) => status === 'paid_out' || status === 'cancelled',
      ),
    ).toEqual([]);
  });

  it('derives the idempotency key from the withdrawal alone', () => {
    // Ключа по траншу здесь быть не может: у вывода транша нет вовсе. Ни
    // попытки, ни времени в ключе — иначе повтор при потерянном ответе банка
    // создаст второй вывод (инвариант 13).
    expect(createWithdrawal('w-7').idempotencyKey).toBe(withdrawalIdempotencyKey('w-7'));
    expect(createWithdrawal('w-7').idempotencyKey).toBe(createWithdrawal('w-7').idempotencyKey);
    expect(createWithdrawal('w-7').idempotencyKey).not.toBe(createWithdrawal('w-8').idempotencyKey);
  });
});

describe('свободные деньги на свою вторую сделку (И12.4)', () => {
  const request = { dealId: 'deal-b', trancheId: 'tranche-b', amount: money('GEL', 400_000n) };

  it('lets the free part fund another deal of the same client', () => {
    const result = planAllocationToDeal(facts(), request);
    expect(result.ok).toBe(true);
  });

  it('refuses to move money that is locked under another deal', () => {
    // Красная линия №1 говорит про обязательства, а не про людей: собственный
    // резерв под сделку А на сделку Б не идёт — сделка А может откатиться, и
    // деньги обязаны вернуться. Здесь это держится не проверкой, а тем, что
    // запертая часть лежит на другом счёте и в сравнение не входит вовсе.
    const lockedOnly = facts({
      free: money('GEL', 0n),
      locked: [
        {
          dealId: 'deal-a',
          trancheId: 'tranche-a',
          amount: money('GEL', 1_000_000n),
          until: NOW,
        },
      ],
    });
    const result = planAllocationToDeal(lockedOnly, request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.failedGuards).toContain('g_free_balance_sufficient');
    }
    // Запертое видно как запертое, но потратить его нельзя.
    expect(lockedTotal(lockedOnly, 'GEL').minor).toBe(1_000_000n);
    expect(lockedTotal(lockedOnly, 'USD').minor).toBe(0n);
  });

  it('refuses when the checked amount is not the moved amount', () => {
    const result = planAllocationToDeal(facts(), { ...request, amount: money('GEL', 900_000n) });
    expect(result.ok).toBe(false);
  });
});
