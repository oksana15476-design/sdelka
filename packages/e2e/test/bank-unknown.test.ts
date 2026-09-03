import { describe, expect, it } from 'vitest';
import {
  createPayout,
  payoutIdempotencyKey,
  reducePayout,
  trancheStateAge,
  violatesSingleActivePayout,
} from '@sdelka/domain';
import { accountBalance, bankNominal, bankOperating, clientFreeAccount } from '@sdelka/ledger';
import {
  applyDealEvent,
  applyTrancheEvent,
  advance,
  dealStatusOf,
  feeForTranche,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '../src/index';
import { BANK_RESPONSE_SOURCE, DAY_MS, DEAL_AMOUNT, GEL, POLICY_VERSION, STATEMENT_SOURCE, bankPort, settledOutcome, unknownOutcome } from './support/fixtures';
import { toPayingOut } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);
const DEAL = 'deal-unknown';
const TRANCHE = 'tranche-unknown';

/**
 * Сценарий 5 — банк не ответил.
 *
 * «Неизвестно» — легальное состояние; повтор из него запрещён; выход только
 * через сверку с выпиской (`STATE-MACHINES.md` §2.2, красная линия №8).
 */
describe('банк не ответил', () => {
  it('остаётся в paying_out, запрещает повтор и выходит только через сверку', async () => {
    const path = await toPayingOut({ dealId: DEAL, trancheId: TRANCHE });
    let world = path.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paying_out');

    const bank = bankPort({ outcomes: [unknownOutcome(), unknownOutcome()], reconciliation: 'settled' });
    const entriesBefore = world.journal.entries.length;
    const stateBefore = trancheOf(world, TRANCHE).state;
    const deadlineBefore = 'deadline' in stateBefore ? stateBefore.deadline.at : null;
    expect(deadlineBefore).not.toBeNull();

    // --- Первый неответ ---
    const first = bank.outcomeFor(payoutIdempotencyKey(TRANCHE));
    expect(first.outcome).toBe('unknown');
    world = advance(world, DAY_MS);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'payout_result', outcome: 'unknown' },
      trancheOptions(POLICY_VERSION, { payoutResponse: null, payoutReasonKey: 'payout.timeout' }),
    ).world;

    // Транш остаётся здесь: перехода наружу по неответу в таблице нет.
    expect(trancheStatusOf(world, TRANCHE)).toBe('paying_out');
    // Выплата ушла в «неизвестно» — и это её отдельная машина, не транша.
    const payout = trancheOf(world, TRANCHE).payouts.at(-1);
    expect(payout?.status).toBe('unknown');
    // Ни одной проводки: деньги, возможно, ушли, но мы этого не знаем.
    expect(world.journal.entries).toHaveLength(entriesBefore);
    // Повтора поручения нет вовсе. Самопереход `paying_out → paying_out` по
    // неответу объявлен **внутренним**: действия входа при нём не выполняются,
    // и намерение `enqueue_outbound_payout` не порождается. Раньше здесь стоял
    // ключ идемпотентности как последняя линия обороны, и тест это фиксировал.
    // `reissuedPayouts` осталось признаком нарушения, а не нормой: непустой
    // список означает, что автомат снова велел выпустить поручение.
    expect(world.reissuedPayouts).toEqual([]);
    expect(trancheOf(world, TRANCHE).payouts).toHaveLength(1);

    // --- Повтор запрещён отсутствием перехода, а не проверкой в обработчике ---
    if (payout === undefined) throw new Error('unreachable');
    const resubmit = reducePayout(payout, { type: 'payout_submitted' });
    expect(resubmit.ok).toBe(false);
    if (!resubmit.ok) {
      expect(resubmit.error.code).toBe('domain.transition.not_allowed');
    }
    // Вторая выплата по тому же траншу — нарушение, а не редкость.
    expect(violatesSingleActivePayout([payout, createPayout(TRANCHE)], TRANCHE)).toBe(true);
    // Ключ идемпотентности от попытки не зависит: ни номера, ни времени в нём нет.
    expect(createPayout(TRANCHE).idempotencyKey).toBe(payout.idempotencyKey);

    // --- Второй неответ: дедлайн двигается, возраст состояния — нет ---
    const stateAfterFirst = trancheOf(world, TRANCHE).state;
    const enteredAtFirst = 'enteredAt' in stateAfterFirst ? stateAfterFirst.enteredAt : null;
    world = advance(world, DAY_MS);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'payout_result', outcome: 'unknown' },
      trancheOptions(POLICY_VERSION, { payoutResponse: null, payoutReasonKey: 'payout.timeout' }),
    ).world;
    const stateAfterSecond = trancheOf(world, TRANCHE).state;
    expect('enteredAt' in stateAfterSecond ? stateAfterSecond.enteredAt : null).toBe(enteredAtFirst);
    const deadlineAfter = 'deadline' in stateAfterSecond ? stateAfterSecond.deadline.at : null;
    // Дедлайн отодвинулся, а часы дежурного идут: застрявшая выплата не
    // выглядит вечно свежей (`STATE-MACHINES.md` §5).
    expect(deadlineAfter).not.toBe(deadlineBefore);
    expect(trancheStateAge(stateAfterSecond, world.now)).toBeGreaterThanOrEqual(2 * DAY_MS);
    // Второй неответ — тоже не повтор: список так и остался пустым.
    expect(world.reissuedPayouts).toEqual([]);
    // ⚠ Машина выплаты второй неответ по тому же поручению не принимает вовсе:
    // из `unknown` сетевого ребра нет, а у транша такое ребро есть. Расхождение
    // двух машин на одном событии; отчёт, расхождение 14.
    const stillUnknown = trancheOf(world, TRANCHE).payouts.at(-1);
    expect(stillUnknown?.status).toBe('unknown');
    if (stillUnknown !== undefined) {
      expect(reducePayout(stillUnknown, { type: 'timeout' }).ok).toBe(false);
    }

    // --- Выход только через сверку ---
    expect(bank.reconcile(payoutIdempotencyKey(TRANCHE))).toBe('settled');
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'reconciliation_resolved', outcome: 'settled' },
      trancheOptions(POLICY_VERSION, { payoutResponse: STATEMENT_SOURCE }),
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paid_out');
    expect(trancheOf(world, TRANCHE).payouts.at(-1)?.status).toBe('settled');

    // Комиссия ушла на операционный счёт той же записью расчёта: отдельного
    // шага вывода в приложении больше нет.
    expect(feeForTranche(world, TRANCHE, DEAL_AMOUNT).minor).toBe(300_000n);
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(300_000n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(19_700_000n);
    world = applyDealEvent(world, DEAL, { type: 'tranches_settled' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('settled');
    expect(accountBalance(world.journal, clientFreeAccount(path.sellerKey), GEL).minor).toBe(19_700_000n);

    // Выплата ровно одна, несмотря на два неответа.
    expect(trancheOf(world, TRANCHE).payouts).toHaveLength(1);
    expect(settledOutcome(BANK_RESPONSE_SOURCE).outcome).toBe('settled');
  });
});
