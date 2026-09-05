import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type ClientAccountFacts,
  type Instant,
  type WithdrawalContext,
  type WithdrawalEvent,
  type WithdrawalState,
  NON_TERMINAL_WITHDRAWAL_STATUSES,
  PROVISIONAL_WITHDRAWAL_CLOCK,
  RejectionCode,
  WITHDRAWAL_CLOCK_EVENTS,
  WITHDRAWAL_GUARD_IDS,
  WITHDRAWAL_REQUIRED_APPROVALS,
  WITHDRAWAL_TRANSITIONS,
  createWithdrawal,
  evaluateWithdrawalGuard,
  instant,
  isTerminalWithdrawalStatus,
  lockedTotal,
  planAllocationToDeal,
  reduceWithdrawal,
  statusesWithoutTerminalPath,
  withdrawalIdempotencyKey,
  isWithdrawalStalled,
  withdrawalStateAge,
} from '../src/index';
import { NOW } from './support/facts';

/**
 * Часы заявки в тестах — **временное умолчание владельца целиком**, а не свои
 * числа: тест, придумавший себе норматив, проверяет придуманное.
 */
const CLOCK = PROVISIONAL_WITHDRAWAL_CLOCK;
const CONTEXT: WithdrawalContext = { now: NOW, deadlinePolicy: CLOCK.deadline };

function newWithdrawal(withdrawalId: string): WithdrawalState {
  return createWithdrawal(withdrawalId, NOW, CLOCK.deadline);
}

function later(ms: number): Instant {
  return instant(NOW + ms);
}

function facts(overrides: Partial<ClientAccountFacts> = {}): ClientAccountFacts {
  return {
    // Чей это остаток: без владельца разрешение на внутреннее движение не
    // выдаётся вовсе (`allocation.ts`, И12.4).
    clientKey: 'ge.passport.buyer-1',
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
  const result = reduceWithdrawal(state, event, facts(overrides), CONTEXT);
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
    let state = newWithdrawal('w-1');
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
    const state = apply(newWithdrawal('w-2'), { type: 'withdrawal_approved' }, {
      sourceAccount: null,
    });
    expect(state.status).toBe('blocked');
  });

  it('refuses a withdrawal larger than the free balance', () => {
    const result = reduceWithdrawal(
      newWithdrawal('w-3'),
      { type: 'withdrawal_approved' },
      facts({ free: money('GEL', 1n) }),
      CONTEXT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.failedGuards).toContain('g_free_balance_sufficient');
    }
  });

  it('keeps an unknown provider answer in place instead of retrying', () => {
    // §2.2: повтор из «неизвестно» запрещён без прохождения через сверку, и это
    // реализовано отсутствием перехода, а не проверкой в обработчике.
    let state = apply(newWithdrawal('w-4'), { type: 'withdrawal_approved' });
    state = apply(state, { type: 'withdrawal_dispatched' });
    state = apply(state, { type: 'payout_result', outcome: 'unknown' });
    expect(state.status).toBe('paying_out');
    const retry = reduceWithdrawal(state, { type: 'withdrawal_dispatched' }, facts(), CONTEXT);
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.error.code).toBe(RejectionCode.transitionNotAllowed);
    }
  });

  it('resolves paying_out through reconciliation', () => {
    let state = apply(newWithdrawal('w-5'), { type: 'withdrawal_approved' });
    state = apply(state, { type: 'withdrawal_dispatched' });
    state = apply(state, { type: 'reconciliation_resolved', outcome: 'rejected' });
    expect(state.status).toBe('blocked');
    state = apply(state, { type: 'withdrawal_approved' });
    expect(state.status).toBe('approved');
  });

  it('не отменяет утверждённое поручение — отмена идёт через приостановку', () => {
    // Ребро `approved → cancelled` расходилось с принятым текстом интерфейса,
    // который утверждает о машине прямо: «перехода из утверждённой в
    // отменённую в системе нет» (`withdraw.cancel.blocked`). Сведено к строгой
    // стороне — к той, что уже обещана клиенту.
    const approved = apply(newWithdrawal('w-9'), { type: 'withdrawal_approved' });
    expect(approved.status).toBe('approved');
    const direct = reduceWithdrawal(approved, { type: 'withdrawal_cancelled' }, facts(), CONTEXT);
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.error.code).toBe(RejectionCode.transitionNotAllowed);
    }
    // Дорога к отмене остаётся, но проходит через приостановку с причиной:
    // `withdrawal_blocked` несёт `reason`, `withdrawal_cancelled` — ничего.
    const blocked = apply(approved, { type: 'withdrawal_blocked', reason: 'client_asked' });
    expect(blocked.status).toBe('blocked');
    expect(apply(blocked, { type: 'withdrawal_cancelled' }).status).toBe('cancelled');
  });

  it('refuses any event on a terminal state', () => {
    const cancelled = apply(newWithdrawal('w-6'), { type: 'withdrawal_cancelled' });
    const result = reduceWithdrawal(cancelled, { type: 'withdrawal_approved' }, facts(), CONTEXT);
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
    expect(newWithdrawal('w-7').idempotencyKey).toBe(withdrawalIdempotencyKey('w-7'));
    expect(newWithdrawal('w-7').idempotencyKey).toBe(newWithdrawal('w-7').idempotencyKey);
    expect(newWithdrawal('w-7').idempotencyKey).not.toBe(newWithdrawal('w-8').idempotencyKey);
  });
});

describe('часы заявки: дедлайн и норматив простоя (§H4)', () => {
  it('нетерминальная заявка без дедлайна невыразима', () => {
    // Проверяется не значение, а **структура**: у нетерминального варианта союза
    // поля обязательны, у терминального их нет вовсе. Это тот же приём, которым
    // выражен инвариант 7 у транша, и то же, что зеркалит проверка базы
    // (`withdrawal_state_shape`, `0022_withdrawal_deadline.sql`).
    let state = newWithdrawal('w-clock-1');
    expect('deadline' in state).toBe(true);
    expect('enteredAt' in state).toBe(true);
    state = apply(state, { type: 'withdrawal_approved' });
    expect('deadline' in state).toBe(true);
    state = apply(state, { type: 'withdrawal_blocked', reason: 'operator' });
    expect('deadline' in state).toBe(true);
    const cancelled = apply(state, { type: 'withdrawal_cancelled' });
    expect('deadline' in cancelled).toBe(false);
    expect(withdrawalStateAge(cancelled, later(10 * 24 * 60 * 60 * 1000))).toBeNull();
  });

  it('дедлайн есть у каждого нетерминального состояния', () => {
    // Таблица сроков — `Record` по нетерминальным статусам: состояние без своей
    // строки не соберётся, и «забыли завести срок новому статусу» ловится типом.
    for (const status of NON_TERMINAL_WITHDRAWAL_STATUSES) {
      expect(CLOCK.deadline[status]).toBeGreaterThan(0);
      expect(CLOCK.escalation[status]).toBeGreaterThan(0);
    }
  });

  it('простой дольше норматива поднимает заявку человеку', () => {
    const state = newWithdrawal('w-clock-2');
    const norm = CLOCK.escalation.requested;
    expect(isWithdrawalStalled(state, later(norm - 1), CLOCK.escalation)).toBe(false);
    // Норматив «через сутки» означает, что на исходе суток заявка уже просрочена,
    // а не ещё нет, — то же правило, что у возраста задачи в очереди разбора.
    expect(isWithdrawalStalled(state, later(norm), CLOCK.escalation)).toBe(true);
    expect(withdrawalStateAge(state, later(norm))).toBe(norm);
  });

  it('терминальную заявку не эскалируют ни при каком возрасте', () => {
    const cancelled = apply(newWithdrawal('w-clock-3'), { type: 'withdrawal_cancelled' });
    expect(isWithdrawalStalled(cancelled, later(365 * 24 * 60 * 60 * 1000), CLOCK.escalation)).toBe(
      false,
    );
  });

  it('«неизвестно» двигает дедлайн, но не возраст', () => {
    // Иначе каждый неответ банка обнулял бы возраст, и застрявшая в «неизвестно»
    // заявка выглядела бы вечно свежей — то же, о чём §5 и `queue.ts`.
    let state = apply(newWithdrawal('w-clock-4'), { type: 'withdrawal_approved' });
    state = apply(state, { type: 'withdrawal_dispatched' });
    const entered = 'enteredAt' in state ? state.enteredAt : null;
    const firstDeadline = 'deadline' in state ? state.deadline.at : null;
    const hour = 60 * 60 * 1000;
    const laterContext: WithdrawalContext = { now: later(hour), deadlinePolicy: CLOCK.deadline };
    const unknown = reduceWithdrawal(
      state,
      { type: 'payout_result', outcome: 'unknown' },
      facts(),
      laterContext,
    );
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    const moved = unknown.value.state;
    expect(moved.status).toBe('paying_out');
    expect('enteredAt' in moved ? moved.enteredAt : null).toBe(entered);
    expect('deadline' in moved ? moved.deadline.at : null).not.toBe(firstDeadline);
    expect(withdrawalStateAge(moved, later(hour))).toBe(hour);
  });

  it('часы заявки не порождают ни одного события ни из одного состояния', () => {
    // Красная линия №8: повтор из «неизвестно» запрещён без сверки. Событие по
    // сроку у `paying_out` и было бы тем самым автоматическим повтором. Здесь
    // это проверяется перечнем целиком, а не одной строкой: `Record<…, null>`
    // не даёт завести событие правкой значения.
    for (const status of NON_TERMINAL_WITHDRAWAL_STATUSES) {
      expect(WITHDRAWAL_CLOCK_EVENTS[status]).toBeNull();
    }
    expect(Object.keys(WITHDRAWAL_CLOCK_EVENTS).sort()).toEqual(
      [...NON_TERMINAL_WITHDRAWAL_STATUSES].sort(),
    );
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
