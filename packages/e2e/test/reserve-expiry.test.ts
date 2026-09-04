import { describe, expect, it } from 'vitest';
import { dueTrancheEvent } from '@sdelka/domain';
import {
  type ClientKey,
  accountBalance,
  bankNominal,
  clientFreeAccount,
  clientLockedAccount,
} from '@sdelka/ledger';
import {
  OPERATOR_ACTOR,
  advance,
  applyTrancheEvent,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '../src/index';
import { DAY_MS, DEAL_AMOUNT, GEL, POLICY_VERSION, STATEMENT_SOURCE } from './support/fixtures';
import { toReserved } from './support/paths';
import {
  type WithdrawalStepOptions,
  type WithdrawalWorld,
  applyWithdrawalEvent,
  approveWithdrawal,
  rejectWithdrawalEvent,
  requestWithdrawal,
  withWithdrawals,
} from './support/withdrawal';

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на счёте клиента: откат резерва их туда возвращает, а не зачисляет. */
const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const DEAL = 'deal-reserve-expiry';
const TRANCHE = 'tranche-reserve-expiry';

const WITHDRAWAL_STEP: WithdrawalStepOptions = {
  actor: OPERATOR_ACTOR,
  policy: POLICY_VERSION,
  evidence: [STATEMENT_SOURCE],
};

/**
 * Вывод всей суммы транша, подготовленный и подписанный двумя.
 *
 * Раньше здесь стоял прямой вызов `evaluateWithdrawalGuard(…)` из тела теста, и
 * он не проверял ничего: guard можно было снять со всех рёбер
 * `reduceWithdrawal`, и тест остался бы зелёным, потому что смотрел на
 * функцию, а не на дверь. Теперь И12.2 проверяется там, где клиент её и
 * встретит — на переходе машины вывода.
 */
function preparedWithdrawal(
  world: Parameters<typeof withWithdrawals>[0],
  owner: ClientKey,
  id: string,
): WithdrawalWorld {
  let scene = requestWithdrawal(withWithdrawals(world), {
    withdrawalId: id,
    owner,
    amount: DEAL_AMOUNT,
    preparedBy: 'operator-1',
  });
  scene = approveWithdrawal(scene, id, 'approver-1');
  return approveWithdrawal(scene, id, 'approver-2');
}

/**
 * Сценарий — резерв снимается часами, а не человеком.
 *
 * Обещание, ради которого этот сценарий существует, дано клиенту дословно
 * (`CABINETS.md` §3.2 блок 6): «если регистрация не завершится до 18:00
 * сегодня, резерв будет снят автоматически **и деньги останутся у вас. Сделку
 * можно будет провести заново**». Три его половины до сих пор не проверялись
 * сквозным контуром ни одна:
 *
 * 1. **«автоматически»** — у дедлайна не было вызывающего вовсе. `Deadline`
 *    лежал в состоянии, `isPast` был объявлен и не звался нигде, а
 *    `DEFAULT_DEADLINE_POLICY` ставила срок девяти статусам, из которых
 *    `deadline_reached` обслуживает три.
 * 2. **«деньги останутся у вас»** — расфиксации не было ни у одной проекции:
 *    при снятии резерва деньги в учёте оставались запертыми под траншем,
 *    который интерфейс уже считал свободным. Запись сходится в ноль с обеих
 *    сторон, поэтому ни один инвариант учёта этого не видел.
 * 3. **«провести заново»** — второго резервирования никто не пробовал.
 *
 * Планировщика здесь нет и быть не должно: домен отдаёт **событие**, тик — за
 * портом (`STATE-MACHINES.md` §1.6). Тест играет порт: спрашивает часы и подаёт
 * ровно то, что они ответили, в ту же дверь, куда ходит человек.
 */
describe('снятие резерва по сроку', () => {
  it('возвращает деньги в свободную часть счёта и оставляет сделку живой', async () => {
    const reserved = await toReserved({ dealId: DEAL, trancheId: TRANCHE });
    let world = reserved.world;
    const buyer = reserved.buyerKey;
    const trancheFile = clientLockedAccount(buyer, DEAL, TRANCHE);

    // --- Пока резерв держится: деньги в файле транша, свободного остатка нет ---
    expect(accountBalance(world.journal, trancheFile, GEL).minor).toBe(20_000_000n);
    expect(accountBalance(world.journal, clientFreeAccount(buyer), GEL).minor).toBe(0n);
    // И12.2 буква в букву: «вывод доступен, пока средства не зарезервированы».
    // Пока запирание стояло на входе в `collected`, это обещание было ложным с
    // другой стороны — забрать было нельзя ничего, а экран говорил, что можно.
    expect(
      rejectWithdrawalEvent(preparedWithdrawal(world, buyer, 'wd-reserve-held'), 'wd-reserve-held', {
        type: 'withdrawal_approved',
      }).failedGuards,
    ).toEqual(['g_free_balance_sufficient']);

    // --- Срок не настал: часы молчат ---
    expect(dueTrancheEvent(trancheOf(world, TRANCHE).state, world.now)).toBeNull();

    world = advance(world, DAY_MS + 1);

    // --- Срок настал: часы называют событие, а не состояние ---
    const due = dueTrancheEvent(trancheOf(world, TRANCHE).state, world.now);
    expect(due).toEqual({ type: 'reserve_expired' });
    if (due === null) throw new Error('unreachable');

    // Часы не сочиняют рёбер. `deadline_reached` увёл бы транш прямо в
    // `refund_pending`, минуя обещанное «провести заново», и таблица переходов
    // его отвергает — второй контур поверх выбора события.
    expect(rejectTrancheEvent(world, TRANCHE, { type: 'deadline_reached' }).code).toBe(
      'domain.transition.not_allowed',
    );

    // --- Порт подаёт ровно то, что вернули часы ---
    const rolled = applyTrancheEvent(world, TRANCHE, due, ROLLBACK);
    world = rolled.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('collected');

    // Расфиксация — намерение автомата, а не шаг приложения: у теста больше нет
    // двери, через которую он мог бы забыть её позвать.
    expect(rolled.transition.intents).toContainEqual(
      expect.objectContaining({ type: 'post_journal_entry', template: 'unlock_funds' }),
    );
    // И это **не** повторное зачисление: проводка прихода принадлежит событию
    // `funds_received`, а в `collected` возвращаются и без него.
    expect(rolled.transition.intents).not.toContainEqual(
      expect.objectContaining({ type: 'post_journal_entry', template: 'funds_received' }),
    );

    // --- «Деньги останутся у вас» ---
    expect(accountBalance(world.journal, trancheFile, GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, clientFreeAccount(buyer), GEL).minor).toBe(20_000_000n);
    // Наружу не ушло ничего: снятие резерва — внутреннее движение по счёту
    // одного и того же клиента, а не перевод.
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);

    // --- Клиент выбирает: вывести… ---
    const released = applyWithdrawalEvent(
      preparedWithdrawal(world, buyer, 'wd-reserve-released'),
      'wd-reserve-released',
      { type: 'withdrawal_approved' },
      WITHDRAWAL_STEP,
    );
    expect(released.withdrawals.get('wd-reserve-released')?.state.status).toBe('approved');

    // --- …или провести заново ---
    const again = applyTrancheEvent(world, TRANCHE, { type: 'reserve_requested' }, OPTIONS);
    expect(trancheStatusOf(again.world, TRANCHE)).toBe('reserved');
    expect(accountBalance(again.world.journal, trancheFile, GEL).minor).toBe(20_000_000n);
    expect(accountBalance(again.world.journal, clientFreeAccount(buyer), GEL).minor).toBe(0n);
    // Второй заход не удвоил ни обязательство, ни файл транша: запирание берёт
    // сумму из собранного автоматом, а не прибавляет к тому, что уже лежит.
    expect(accountBalance(again.world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
  });

  it('у замороженного транша часы молчат структурно, а не проверкой', async () => {
    const reserved = await toReserved({
      dealId: 'deal-frozen-clock',
      trancheId: 'tranche-frozen-clock',
    });
    let world = advance(reserved.world, DAY_MS + 1);

    // До заморозки часы срабатывают.
    expect(dueTrancheEvent(trancheOf(world, 'tranche-frozen-clock').state, world.now)).toEqual({
      type: 'reserve_expired',
    });

    world = applyTrancheEvent(
      world,
      'tranche-frozen-clock',
      { type: 'compliance_hold', reason: 'sanctions', frozenBy: 'analyst-1' },
      OPTIONS,
    ).world;

    // Заморозка приостанавливает дедлайн отсутствием поля, а не флагом рядом с
    // ним (`CORE.md` Ф17): сравнивать нечего, и ветка невыразима. Проверка
    // «а не заморожен ли» здесь не стоит — её нельзя забыть, потому что её нет.
    const frozen = trancheOf(world, 'tranche-frozen-clock').state;
    expect('deadline' in frozen).toBe(false);
    expect(dueTrancheEvent(frozen, world.now)).toBeNull();
    // Второй контур — таблица переходов: у `frozen` нет строки ни на одно
    // автоматическое событие.
    expect(rejectTrancheEvent(world, 'tranche-frozen-clock', { type: 'reserve_expired' }).code).toBe(
      'domain.transition.not_allowed',
    );
  });
});
