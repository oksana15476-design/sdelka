import { describe, expect, it } from 'vitest';
import { verifyChain } from '@sdelka/audit';
import { STAFF } from './support/actors';
import {
  type ClientKey,
  accountBalance,
  bankNominal,
  clientFreeAccount,
  clientLockedAccount,
  freeBalance,
} from '@sdelka/ledger';
import { money } from '@sdelka/money';
import {
  type World,
  AppInvariantError,
  advance,
  trancheOptions,
} from '@sdelka/app';
import {
  applyTrancheEvent,
  receiveExternalPayment,
} from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  DAY_MS,
  DEAL_AMOUNT,
  GEL,
  POLICY_VERSION,
  STATEMENT_SOURCE,
  WITHDRAWAL_CLOCK,
} from './support/fixtures';
import { toCollected, toReserved } from './support/paths';
import {
  type WithdrawalStepOptions,
  type WithdrawalWorld,
  FOREIGN_SOURCE_ACCOUNT,
  rejectWithdrawalEvent,
  withWithdrawals,
  withdrawalStatusOf,
} from '@sdelka/app';
import {
  applyWithdrawalEvent,
  approveWithdrawal,
  requestWithdrawal,
} from './support/acting';

const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });

const STEP: WithdrawalStepOptions = {
    policy: POLICY_VERSION,
  evidence: [STATEMENT_SOURCE],
};

const SETTLED: WithdrawalStepOptions = { ...STEP, response: BANK_RESPONSE_SOURCE };

/** Своя часть, не обещанная сделке: 10 000 ₾ сверх суммы транша. */
const SPARE = money(GEL, 10_000_000n);
const PART = money(GEL, 5_000_000n);

/**
 * Клиент, у которого есть и деньги под сделкой, и своя свободная часть.
 *
 * Разделение существенное, а не для удобства: собранное под живым траншем — не
 * свободные деньги клиента, даже когда лежит на свободной части счёта до
 * резерва (см. последний сценарий файла). Пять сценариев ниже двигают именно
 * своё, чтобы каждый проверял правило вывода, а не спотыкался о чужое.
 */
async function clientWithSpareMoney(
  suffix: string,
): Promise<{ readonly scene: WithdrawalWorld; readonly buyer: ClientKey; readonly world: World }> {
  const collected = await toCollected({ dealId: `deal-${suffix}`, trancheId: `tranche-${suffix}` });
  const world = receiveExternalPayment(collected.world, collected.buyerKey, SPARE);
  return { scene: withWithdrawals(world, WITHDRAWAL_CLOCK), buyer: collected.buyerKey, world };
}

/**
 * Вывод свободных денег со счёта клиента — И12.2.
 *
 * ## Что этот файл закрывает
 *
 * Машина вывода жила в домене со своими пятью guard'ами и **ни разу не звалась
 * из продукта**: единственным её вызывающим было тело теста
 * (`evaluateWithdrawalGuard(…)` в `reserve-expiry.test.ts`). Проверка вида
 * «функция возвращает то, что в ней написано» держит ровно ноль: сними guard с
 * ребра `reduceWithdrawal` — и такой тест останется зелёным, потому что он
 * смотрит на функцию, а не на дверь.
 *
 * Мутационный прогон (`pnpm --filter @sdelka/e2e mutation`) до этого батча
 * guard'ов вывода не видел вовсе: он читал один перечень из `guards.ts`.
 * Теперь читает все три, и каждый guard вывода обязан ронять хотя бы один
 * сценарий отсюда — по отдельности, а не в компании соседа.
 *
 * Здесь вывод проходит той же дорогой, что транш: редьюсер домена на фактах,
 * посчитанных учётом, проводка из словаря, запись в журнал аудита, проверка
 * инвариантов после каждого шага.
 */
describe('вывод свободных денег со счёта клиента', () => {
  it('уходит на счёт-источник после двух подписей и уносит ровно свою сумму', async () => {
    const start = await clientWithSpareMoney('wd-1');
    const buyer = start.buyer;
    let scene = start.scene;

    expect(freeBalance(scene.world.journal, buyer, GEL).minor).toBe(30_000_000n);

    scene = requestWithdrawal(scene, {
      withdrawalId: 'wd-1',
      owner: buyer,
      amount: PART,
    });

    // --- Одной подписи мало: guard называется поимённо ---
    scene = approveWithdrawal(scene, 'wd-1', STAFF.controller);
    const one = rejectWithdrawalEvent(scene, 'wd-1', { type: 'withdrawal_approved' });
    expect(one.code).toBe('domain.guard.failed');
    expect(one.failedGuards).toEqual(['g_approvals_sufficient']);

    // --- Две разные подписи ---
    scene = approveWithdrawal(scene, 'wd-1', STAFF.head);
    scene = applyWithdrawalEvent(scene, 'wd-1', { type: 'withdrawal_approved' }, STEP);
    expect(withdrawalStatusOf(scene, 'wd-1')).toBe('approved');

    // Утверждение денег не двигает: обязательство перед клиентом целое.
    expect(accountBalance(scene.world.journal, clientFreeAccount(buyer), GEL).minor).toBe(
      30_000_000n,
    );

    // --- Поручение ушло ---
    scene = applyWithdrawalEvent(scene, 'wd-1', { type: 'withdrawal_dispatched' }, STEP);
    expect(withdrawalStatusOf(scene, 'wd-1')).toBe('paying_out');
    // ⚠ И это по-прежнему **не** списание: поручение отправлено, но не
    // исполнено, и деньги всё ещё клиента. Списать их здесь значило бы
    // показать клиенту ноль там, где у него ещё есть остаток.
    expect(accountBalance(scene.world.journal, clientFreeAccount(buyer), GEL).minor).toBe(
      30_000_000n,
    );

    // --- Банк подтвердил ---
    scene = applyWithdrawalEvent(
      scene,
      'wd-1',
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    );
    expect(withdrawalStatusOf(scene, 'wd-1')).toBe('paid_out');
    expect(accountBalance(scene.world.journal, clientFreeAccount(buyer), GEL).minor).toBe(
      25_000_000n,
    );
    // Ушло ровно столько же с номинального счёта — и ни тетри больше.
    expect(accountBalance(scene.world.journal, bankNominal(GEL), GEL).minor).toBe(25_000_000n);
    expect(verifyChain(scene.world.chain).intact).toBe(true);

    // --- Из терминального состояния машина не двигается ---
    const done = rejectWithdrawalEvent(scene, 'wd-1', { type: 'withdrawal_cancelled' });
    expect(done.code).toBe('domain.state.terminal');
  });

  it('не считает второй подписью повтор той же и подпись готовившего', async () => {
    const start = await clientWithSpareMoney('wd-6');
    let scene = start.scene;
    scene = requestWithdrawal(scene, {
      withdrawalId: 'wd-6',
      owner: start.buyer,
      amount: PART,
    });

    // Три подписи, из которых различных — две: `g_approvals_sufficient`
    // пропускает, и отказ приходит **только** от правила различности. Разведено
    // намеренно: guard, который никогда не отказывает в одиночку, невозможно
    // проверить поимённо (`STATE-MACHINES.md` §7) — его отказ всегда объясним
    // соседом.
    scene = approveWithdrawal(scene, 'wd-6', STAFF.controller);
    scene = approveWithdrawal(scene, 'wd-6', STAFF.head);
    scene = approveWithdrawal(scene, 'wd-6', STAFF.controller);
    const repeated = rejectWithdrawalEvent(scene, 'wd-6', { type: 'withdrawal_approved' });
    expect(repeated.failedGuards).toEqual(['g_withdrawal_approvers_distinct']);

    // Своя же подпись готовившего не считается вовсе: остаётся одна.
    let own = start.scene;
    own = requestWithdrawal(own, {
      withdrawalId: 'wd-6b',
      owner: start.buyer,
      amount: PART,
    });
    own = approveWithdrawal(own, 'wd-6b', STAFF.controller);
    // Подпись готовившего заявку теперь невозможна вовсе: `approve_payout` у
    // оператора нет. Прежде она ставилась и отсеивалась guard'ом; рубеж
    // переехал на право, а guard остался вторым — строкой ниже.
    expect(() => approveWithdrawal(own, 'wd-6b', STAFF.operator)).toThrow('e2e.withdrawal.denied');
    const prepared = rejectWithdrawalEvent(own, 'wd-6b', { type: 'withdrawal_approved' });
    expect(prepared.failedGuards).toContain('g_approvals_sufficient');
  });

  it('не выпускает больше, чем лежит в свободной части: запертое под траншем не в счёт', async () => {
    // Резерв запер все деньги под траншем. Клиент видит их на своей странице —
    // и не может забрать: они лежат на другом счёте (красная линия №1).
    const reserved = await toReserved({ dealId: 'deal-wd-2', trancheId: 'tranche-wd-2' });
    const buyer = reserved.buyerKey;
    let scene = withWithdrawals(reserved.world, WITHDRAWAL_CLOCK);

    expect(
      accountBalance(
        scene.world.journal,
        clientLockedAccount(buyer, 'deal-wd-2', 'tranche-wd-2'),
        GEL,
      ).minor,
    ).toBe(20_000_000n);
    expect(freeBalance(scene.world.journal, buyer, GEL).minor).toBe(0n);

    scene = requestWithdrawal(scene, {
      withdrawalId: 'wd-2',
      owner: buyer,
      amount: DEAL_AMOUNT,
    });
    scene = approveWithdrawal(scene, 'wd-2', STAFF.controller);
    scene = approveWithdrawal(scene, 'wd-2', STAFF.head);

    const locked = rejectWithdrawalEvent(scene, 'wd-2', { type: 'withdrawal_approved' });
    expect(locked.failedGuards).toEqual(['g_free_balance_sufficient']);

    // --- Резерв снят часами: обещание «деньги останутся у вас» ---
    let world = advance(scene.world, DAY_MS + 1);
    world = applyTrancheEvent(world, 'tranche-wd-2', { type: 'reserve_expired' }, ROLLBACK).world;
    scene = { ...scene, world };

    // Тот же вывод, те же подписи — и теперь утверждение проходит. Между
    // «нельзя» и «можно» не изменилось ничего, кроме того, где лежат деньги.
    scene = applyWithdrawalEvent(scene, 'wd-2', { type: 'withdrawal_approved' }, STEP);
    expect(withdrawalStatusOf(scene, 'wd-2')).toBe('approved');
  });

  it('со счётом-источником не на имя плательщика уходит оператору, а не наружу', async () => {
    const start = await clientWithSpareMoney('wd-3');
    const buyer = start.buyer;
    let scene = start.scene;

    scene = requestWithdrawal(scene, {
      withdrawalId: 'wd-3',
      owner: buyer,
      amount: PART,
      sourceAccount: FOREIGN_SOURCE_ACCOUNT,
    });
    scene = approveWithdrawal(scene, 'wd-3', STAFF.controller);
    scene = approveWithdrawal(scene, 'wd-3', STAFF.head);

    // Ребро с отрицанием guard'а: чужой или неизвестный счёт-источник — это не
    // отказ клиенту, а работа человека. Вывод создаётся, но идёт в `blocked`.
    scene = applyWithdrawalEvent(scene, 'wd-3', { type: 'withdrawal_approved' }, STEP);
    expect(withdrawalStatusOf(scene, 'wd-3')).toBe('blocked');
    // Наружу не ушло ничего.
    expect(accountBalance(scene.world.journal, bankNominal(GEL), GEL).minor).toBe(30_000_000n);

    // Счёт-источник неизвестен вовсе — тот же выход, та же дверь.
    let unknown = withWithdrawals(start.world, WITHDRAWAL_CLOCK);
    unknown = requestWithdrawal(unknown, {
      withdrawalId: 'wd-3b',
      owner: buyer,
      amount: PART,
      sourceAccount: null,
    });
    unknown = approveWithdrawal(unknown, 'wd-3b', STAFF.controller);
    unknown = approveWithdrawal(unknown, 'wd-3b', STAFF.head);
    unknown = applyWithdrawalEvent(unknown, 'wd-3b', { type: 'withdrawal_approved' }, STEP);
    expect(withdrawalStatusOf(unknown, 'wd-3b')).toBe('blocked');
  });

  it('не отправляет второе поручение, пока первое в полёте', async () => {
    const start = await clientWithSpareMoney('wd-4');
    const buyer = start.buyer;
    let scene = start.scene;

    for (const id of ['wd-4a', 'wd-4b']) {
      scene = requestWithdrawal(scene, {
        withdrawalId: id,
        owner: buyer,
        amount: PART,
      });
      scene = approveWithdrawal(scene, id, STAFF.controller);
      scene = approveWithdrawal(scene, id, STAFF.head);
      scene = applyWithdrawalEvent(scene, id, { type: 'withdrawal_approved' }, STEP);
    }

    scene = applyWithdrawalEvent(scene, 'wd-4a', { type: 'withdrawal_dispatched' }, STEP);
    expect(withdrawalStatusOf(scene, 'wd-4a')).toBe('paying_out');

    // Свободного остатка хватает на оба поручения — арифметика второе пропускает.
    expect(freeBalance(scene.world.journal, buyer, GEL).minor).toBe(30_000_000n);
    // Останавливает его правило, а не арифметика.
    const second = rejectWithdrawalEvent(scene, 'wd-4b', { type: 'withdrawal_dispatched' });
    expect(second.failedGuards).toEqual(['g_no_active_withdrawal']);

    // Первое поручение завершилось — второе идёт.
    scene = applyWithdrawalEvent(
      scene,
      'wd-4a',
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    );
    scene = applyWithdrawalEvent(scene, 'wd-4b', { type: 'withdrawal_dispatched' }, STEP);
    expect(withdrawalStatusOf(scene, 'wd-4b')).toBe('paying_out');
  });

  it('«неизвестно» оставляет вывод в полёте и не выпускает деньги дважды', async () => {
    const start = await clientWithSpareMoney('wd-5');
    const buyer = start.buyer;
    let scene = start.scene;

    scene = requestWithdrawal(scene, {
      withdrawalId: 'wd-5',
      owner: buyer,
      amount: PART,
    });
    scene = approveWithdrawal(scene, 'wd-5', STAFF.controller);
    scene = approveWithdrawal(scene, 'wd-5', STAFF.head);
    scene = applyWithdrawalEvent(scene, 'wd-5', { type: 'withdrawal_approved' }, STEP);
    scene = applyWithdrawalEvent(scene, 'wd-5', { type: 'withdrawal_dispatched' }, STEP);

    // Красная линия №8: «неизвестно» — легальное состояние, повтор из него
    // запрещён без сверки. Вывод остаётся в полёте, деньги не двигаются.
    scene = applyWithdrawalEvent(
      scene,
      'wd-5',
      { type: 'payout_result', outcome: 'unknown' },
      { ...STEP, reasonKey: 'payout.timeout' },
    );
    expect(withdrawalStatusOf(scene, 'wd-5')).toBe('paying_out');
    expect(accountBalance(scene.world.journal, clientFreeAccount(buyer), GEL).minor).toBe(
      30_000_000n,
    );

    // Сверка сказала «дошло» — и только теперь деньги ушли, один раз.
    scene = applyWithdrawalEvent(
      scene,
      'wd-5',
      { type: 'reconciliation_resolved', outcome: 'settled' },
      SETTLED,
    );
    expect(withdrawalStatusOf(scene, 'wd-5')).toBe('paid_out');
    expect(accountBalance(scene.world.journal, clientFreeAccount(buyer), GEL).minor).toBe(
      25_000_000n,
    );
    expect(verifyChain(scene.world.chain).intact).toBe(true);
  });

  /**
   * ⚠ **Шов, найденный этим файлом. [открыто]**
   *
   * Собранное под живым траншем лежит на **свободной** части счёта до резерва:
   * отнесения свободной части к траншу в учёте не записано. И12.2 обещает
   * клиенту прямо: «вывод доступен, пока средства не зарезервированы». Обе
   * половины по отдельности верны, а вместе они означают, что клиент может
   * вывести деньги, которые платформа уже считает собранными по сделке, — и ни
   * один guard вывода этого не видит, потому что в фактах вывода
   * (`ClientAccountFacts`) притязаний траншей нет вовсе.
   *
   * Останавливает это сегодня только инвариант сквозного мира
   * (`collected_not_backed`, введён в этом же батче), то есть **шаг не
   * запечатывается**. В продукте это значило бы не отказ клиенту, а инцидент.
   *
   * Тест закрепляет ровно то, что есть: правило отсутствует, расхождение
   * видно. Когда решение будет принято — либо `funds_received` запирает деньги
   * сразу, либо в фактах вывода появляется притязание живых траншей, — этот
   * тест обязан быть переписан, а не удалён.
   */
  it('вывод собранного, но не запертого, не имеет правила — и ловится инвариантом мира', async () => {
    const collected = await toCollected({ dealId: 'deal-wd-7', trancheId: 'tranche-wd-7' });
    const buyer = collected.buyerKey;
    let scene = withWithdrawals(collected.world, WITHDRAWAL_CLOCK);

    scene = requestWithdrawal(scene, {
      withdrawalId: 'wd-7',
      owner: buyer,
      amount: PART,
    });
    scene = approveWithdrawal(scene, 'wd-7', STAFF.controller);
    scene = approveWithdrawal(scene, 'wd-7', STAFF.head);

    // Все пять guard'ов вывода пропускают: свободный остаток есть, источник
    // известен, подписей две и они разные, других поручений нет.
    scene = applyWithdrawalEvent(scene, 'wd-7', { type: 'withdrawal_approved' }, STEP);
    scene = applyWithdrawalEvent(scene, 'wd-7', { type: 'withdrawal_dispatched' }, STEP);
    expect(withdrawalStatusOf(scene, 'wd-7')).toBe('paying_out');

    // И только когда деньги действительно уходят, мир отказывается запечатать
    // шаг: транш продолжает утверждать, что под ним 20 000 ₾.
    let violations: readonly { readonly invariant: string }[] = [];
    expect(() => {
      try {
        applyWithdrawalEvent(scene, 'wd-7', { type: 'payout_result', outcome: 'settled' }, SETTLED);
      } catch (error) {
        if (error instanceof AppInvariantError) violations = error.violations;
        throw error;
      }
    }).toThrow(AppInvariantError);
    expect(violations.map((item) => item.invariant)).toContain('collected_not_backed');
  });
});
