import { describe, expect, it } from 'vitest';
import {
  type WithdrawalStepOptions,
  IntakeHaltedError,
  closeBankingDay,
  intakeHaltOf,
  isIntakeOpen,
  toClientKey,
  trancheOptions,
  trancheStatusOf,
  withWithdrawals,
  withdrawalStatusOf,
} from '@sdelka/app';
import { accountBalance, bankNominal, bankOperating, coverage, freeBalance } from '@sdelka/ledger';
import { money } from '@sdelka/money';
import { STAFF } from './support/actors';
import {
  absorbIncomingShortfall,
  applyTrancheEvent,
  applyWithdrawalEvent,
  approveWithdrawal,
  convertBalance,
  fundIncomingShortfall,
  haltIntake,
  liftIntakeHalt,
  receiveExternalPayment,
  requestHaltLift,
  requestWithdrawal,
  liftIntakeHalt as secondSignature,
} from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  BUYER,
  CREATED_ON,
  DEAL_AMOUNT,
  DEAL_AMOUNT_USD,
  FX_RATES,
  GEL,
  POLICY_VERSION,
  SELLER,
  STATEMENT_SOURCE,
  THIRD_PARTY,
  WITHDRAWAL_CLOCK,
  partyRef,
} from './support/fixtures';
import { openDeal } from './support/open';

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на свободной части счёта: зачисление сделано отдельным событием. */
const ATTACHED = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const REFUNDED = { ...ATTACHED, payoutResponse: BANK_RESPONSE_SOURCE };
const STEP: WithdrawalStepOptions = { policy: POLICY_VERSION, evidence: [STATEMENT_SOURCE] };
const SETTLED: WithdrawalStepOptions = { ...STEP, response: BANK_RESPONSE_SOURCE };

const DEAL = 'deal-halt';
const TRANCHE = 'tranche-halt';
const WITHDRAWAL = 'wd-halt-1';
/** Недостача корреспондента: 100 ₾ из 10 000 ₾ перевода. */
const RECEIVED = money(GEL, 990_000n);
const SHORTFALL = money(GEL, 10_000n);
const WITHDRAWN = money(GEL, 5_000_000n);
const THIRD_KEY = toClientKey(THIRD_PARTY.document);

const LIFT = {
  reasonKey: 'intake.lift.reconciliation_matched',
  evidence: [STATEMENT_SOURCE],
  policy: POLICY_VERSION,
};

/**
 * Красная линия №3 — **автоматически**, а не «человек заметит и нажмёт».
 *
 * ## Что здесь проверяется
 *
 * Полномочие `halt_intake` существовало с подключения `@sdelka/auth`, и его
 * комментарий прямо называл цену отсутствия: «цена не нажатого стоп-крана —
 * покрытие ≠ 1». Нажать было нечем: ни одного шага мира с этим полномочием не
 * существовало, а автоматической части не было тем более — `@sdelka/ledger` и
 * база считали **признак** (`shouldStopAcceptingDeals`,
 * `v_should_stop_accepting_deals`), оба писали «решение принимает приложение», и
 * приложение решения не принимало.
 *
 * ## Границы, которые сценарий проводит явно
 *
 * 1. **Промежуток между признанием недостачи и довнесением** (`FUNCTIONAL.md`
 *    §3.1, случай А) остановку **не** ставит: покрытие там законно меньше
 *    единицы, и автостоп на этом промежутке останавливал бы платформу на ровном
 *    месте. Меряет автомат на **закрытии банковского дня** — ровно так, как
 *    сформулирована красная линия.
 * 2. **Сошедшееся покрытие остановку не снимает.** Второе закрытие дня по
 *    чистому журналу оставляет приём остановленным.
 * 3. **Остановка не удерживает чужих денег.** Вывод клиента и возврат
 *    покупателю проходят при остановленном приёме целиком, до ухода денег с
 *    номинального счёта.
 */
describe('остановка приёма новых сделок', () => {
  /**
   * Мир, в котором у платформы есть **свои** деньги.
   *
   * Довнесение недостачи идёт с операционного счёта, а он в сквозном мире
   * пополняется только заработанным: спред конвертации признаётся доходом сразу.
   * Отсюда доллары у покупателя и обмен — без них случай А доходит до второго
   * момента только в мире, где уже расчитана хотя бы одна сделка.
   */
  async function opened() {
    const deal = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = applyTrancheEvent(deal.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS)
      .world;
    world = receiveExternalPayment(world, deal.buyerKey, DEAL_AMOUNT_USD);
    const converted = convertBalance(
      world,
      deal.buyerKey,
      'fx-halt-1',
      DEAL_AMOUNT_USD,
      FX_RATES,
      CREATED_ON,
    );
    world = converted.world;
    // Спред 4 000 ₾ на операционном счёте: этим и будет закрыта недостача.
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(400_000n);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      {
        type: 'funds_received',
        amount: DEAL_AMOUNT,
        sender: 'GE:passport:' + BUYER.document.numberFingerprint,
        reference: 'payment-halt',
      },
      ATTACHED,
    ).world;
    // Третье лицо кладёт свои деньги: их же оно потом и выведет при
    // остановленном приёме.
    world = receiveExternalPayment(world, THIRD_KEY, WITHDRAWN);
    return { ...deal, world };
  }

  it('останавливает приём сама на закрытии дня, не открывается сама и снимается только двоими', async () => {
    const start = await opened();
    let world = start.world;

    /* --- День закрыт, покрытие сошлось: приём открыт --- */
    const clean = closeBankingDay(world);
    expect(clean.violations).toEqual([]);
    expect(clean.tripped).toBe(false);
    expect(clean.halt).toBeNull();
    expect(isIntakeOpen(clean.world)).toBe(true);
    world = clean.world;

    /* --- Момент 1: недостача признана, покрытие ушло ниже единицы --- */
    const absorbed = absorbIncomingShortfall(world, THIRD_KEY, RECEIVED, SHORTFALL);
    expect(absorbed.violations.map((item) => item.invariant)).toContain('coverage_below_one');
    // Названный промежуток остановки **не** ставит: он закрывается довнесением
    // в тот же день, и стоп-кран здесь остановил бы платформу на ровном месте.
    expect(intakeHaltOf(absorbed.world)).toBeNull();
    // Приём при этом закрыт **измерением**: расхождение живо прямо сейчас.
    expect(isIntakeOpen(absorbed.world)).toBe(false);

    /* --- День закрылся, а недостача не закрыта: автомат останавливает приём --- */
    const tripped = closeBankingDay(absorbed.world);
    expect(tripped.tripped).toBe(true);
    const halt = tripped.halt;
    expect(halt).not.toBeNull();
    if (halt === null) throw new Error('unreachable');
    // Остановил автомат, а не человек: в записи `system`, и Н5 никого не
    // исключает — исключать некого.
    expect(halt.by.kind).toBe('machine');
    expect(halt.reasonKey).toBe('intake.halt.coverage_deviation');
    expect(halt.violations.map((item) => item.code)).toContain(
      'ledger.invariant.coverage_below_one',
    );
    // Числа, а не факт: расхождение равно ровно признанной недостаче.
    const measured = halt.coverage.find((item) => item.currency === GEL);
    expect(measured?.difference.minor).toBe(-SHORTFALL.minor);
    world = tripped.world;

    /* --- Запись в вечном журнале: кто, по какому факту, с числами --- */
    const record = world.chain.records.find((item) => item.recordId === halt.recordId);
    expect(record).toBeDefined();
    expect(record?.actor.actorId).toBe('scheduler');
    expect(record?.actor.roleId).toBe('system');
    const body = record?.body;
    if (body?.kind !== 'state_transition' || body.machine !== 'intake') {
      throw new Error('unreachable: запись остановки не переход машины приёма');
    }
    expect(body.from).toBe('accepting');
    expect(body.to).toBe('halted');
    expect(body.failedGuards).toContain('ledger.invariant.coverage_below_one');
    const written = body.coverage.find((item) => item.currency === GEL);
    expect(written?.custody.minor).toBe(measured?.custody.minor);
    expect(written?.obligations.minor).toBe(measured?.obligations.minor);

    /* --- Пока покрытие не сошлось, снимать нечего --- */
    const early = requestHaltLift(world, LIFT, STAFF.controller);
    let refusedEarly: unknown = null;
    try {
      liftIntakeHalt(early, STAFF.head);
    } catch (error) {
      refusedEarly = error;
    }
    expect(refusedEarly).toBeInstanceOf(IntakeHaltedError);
    expect((refusedEarly as IntakeHaltedError).reasonKey).toBe(
      'intake.lift.coverage_still_deviates',
    );

    /* --- Момент 2: недостача довнесена, покрытие сошлось --- */
    world = fundIncomingShortfall(world, absorbed.recognised);
    expect(coverage(world.journal).find((item) => item.currency === GEL)?.difference.minor).toBe(0n);

    /* --- Покрытие сошлось — приём сам НЕ открылся --- */
    const second = closeBankingDay(world);
    expect(second.violations).toEqual([]);
    expect(second.tripped).toBe(false);
    expect(second.halt).not.toBeNull();
    expect(intakeHaltOf(second.world)).toBe(halt);
    expect(isIntakeOpen(second.world)).toBe(false);
    // Второй записи о той же остановке не появилось: журнал не редактируется, и
    // повтор читался бы через год вторым инцидентом.
    expect(second.world.chain.records.length).toBe(world.chain.records.length);
    world = second.world;

    /* --- Новая сделка отвергнута на входе --- */
    let refused: unknown = null;
    try {
      await openDeal({
        dealId: 'deal-halt-second',
        trancheId: 'tranche-halt-second',
        buyer: BUYER,
        seller: SELLER,
        world,
      });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(IntakeHaltedError);
    expect((refused as IntakeHaltedError).reasonKey).toBe('intake.refused.halted');
    expect((refused as IntakeHaltedError).halt).toBe(halt);

    /* --- Вывод клиента остановкой не задет --- */
    const nominalBefore = accountBalance(world.journal, bankNominal(GEL), GEL).minor;
    let scene = withWithdrawals(world, WITHDRAWAL_CLOCK);
    scene = requestWithdrawal(scene, {
      withdrawalId: WITHDRAWAL,
      party: partyRef(THIRD_PARTY),
      amount: WITHDRAWN,
    });
    scene = approveWithdrawal(scene, WITHDRAWAL, STAFF.controller);
    scene = approveWithdrawal(scene, WITHDRAWAL, STAFF.head);
    scene = applyWithdrawalEvent(scene, WITHDRAWAL, { type: 'withdrawal_approved' }, STEP);
    scene = applyWithdrawalEvent(scene, WITHDRAWAL, { type: 'withdrawal_dispatched' }, STEP);
    scene = applyWithdrawalEvent(
      scene,
      WITHDRAWAL,
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    );
    expect(withdrawalStatusOf(scene, WITHDRAWAL)).toBe('paid_out');
    // Деньги действительно ушли: остановка приёма чужих денег не держит
    // (красная линия №7).
    expect(freeBalance(scene.world.journal, THIRD_KEY, GEL).minor).toBe(SHORTFALL.minor + RECEIVED.minor - 0n);
    expect(accountBalance(scene.world.journal, bankNominal(GEL), GEL).minor).toBe(
      nominalBefore - WITHDRAWN.minor,
    );
    // И приём всё это время остановлен: вывод его не открыл.
    expect(intakeHaltOf(scene.world)).toBe(halt);
    world = scene.world;

    /* --- Возврат покупателю остановкой не задет тоже --- */
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'revocation_requested', actor: 'buyer', reason: 'buyer.changed_mind' },
      ATTACHED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refund_pending');
    world = applyTrancheEvent(world, TRANCHE, { type: 'refund_initiated' }, ATTACHED).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunding');
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'payout_result', outcome: 'settled' },
      REFUNDED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunded');
    expect(intakeHaltOf(world)).toBe(halt);

    /* --- Снятие: двое, разных уровней, ни один не остановивший --- */
    const requested = requestHaltLift(world, LIFT, STAFF.controller);
    // Первая подпись ничего не открывает.
    expect(intakeHaltOf(requested)?.lift?.signatures).toHaveLength(1);
    expect(isIntakeOpen(requested)).toBe(false);

    // Та же рука второй раз — не двое.
    let alone: unknown = null;
    try {
      liftIntakeHalt(requested, STAFF.controller);
    } catch (error) {
      alone = error;
    }
    expect(alone).toBeInstanceOf(IntakeHaltedError);
    expect((alone as IntakeHaltedError).reasonKey).toBe('intake.lift.quorum_not_met');

    // ФК плюс ФК — двое, но уровень один: §7.4 требует ФК **и** РО.
    let sameLevel: unknown = null;
    try {
      liftIntakeHalt(requested, STAFF.controller2);
    } catch (error) {
      sameLevel = error;
    }
    expect(sameLevel).toBeInstanceOf(IntakeHaltedError);
    expect((sameLevel as IntakeHaltedError).reasonKey).toBe('intake.lift.quorum_not_met');

    // ФК и РО: приём открыт.
    world = secondSignature(requested, STAFF.head);
    expect(intakeHaltOf(world)).toBeNull();
    expect(isIntakeOpen(world)).toBe(true);
    const lifted = world.chain.records[world.chain.records.length - 1];
    if (lifted?.body.kind !== 'state_transition' || lifted.body.machine !== 'intake') {
      throw new Error('unreachable: снятие не записано переходом машины приёма');
    }
    expect(lifted.body.from).toBe('halted');
    expect(lifted.body.to).toBe('accepting');

    /* --- И новая сделка заводится --- */
    const after = await openDeal({
      dealId: 'deal-halt-after',
      trancheId: 'tranche-halt-after',
      buyer: BUYER,
      seller: SELLER,
      world,
    });
    expect(after.world.deals.has('deal-halt-after')).toBe(true);
  });

  it('стоп-кран человека снимает не он сам: Н5 отказывает полномочием, а не условием', async () => {
    const start = await opened();
    // Останавливает финансовый контролёр — у него есть и `halt_intake`, и
    // `lift_halt`. Ровно та пара, на которой Н5 обязана сработать.
    const world = haltIntake(start.world, 'ops.incident.suspected', STAFF.controller);
    const halt = intakeHaltOf(world);
    expect(halt).not.toBeNull();
    expect(halt?.by.kind).toBe('person');
    // Расхождений в записи нет: человек остановил по суждению, а не по журналу.
    expect(halt?.violations).toEqual([]);
    expect(isIntakeOpen(world)).toBe(false);

    // Он же и снимает — отказ **на выдаче полномочия**, до шага.
    expect(() => requestHaltLift(world, LIFT, STAFF.controller)).toThrow('e2e.intake.denied');

    // Дежурный аналитик остановку не снимает вовсе: полномочия нет.
    expect(() => requestHaltLift(world, LIFT, STAFF.analyst)).toThrow('e2e.intake.denied');

    // Снимают двое других: РО поднимает заявку, второй ФК подписывает.
    const requested = requestHaltLift(world, LIFT, STAFF.head);
    const open = liftIntakeHalt(requested, STAFF.controller2);
    expect(intakeHaltOf(open)).toBeNull();
    expect(isIntakeOpen(open)).toBe(true);
  });
});
