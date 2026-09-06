import { describe, expect, it } from 'vitest';
import { STAFF } from './support/actors';
import {
  APPROVER_ROLE,
  OPERATOR_ROLE,
  accountFingerprint,
  actor,
  advanceBeneficiaryChange,
  applyBeneficiaryChange,
  authorize,
  openBeneficiaryChange,
  prioritize,
  toBeneficiaryConfirmation,
} from '@sdelka/compliance';
import { instant, payoutIdempotencyKey } from '@sdelka/domain';
import {
  accountBalance,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientFreeAccount,
  clientLockedAccount,
} from '@sdelka/ledger';
import {
  advance,
  dealStatusOf,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyTrancheEvent,
  approve,
  patchFacts,
} from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  DEAL_AMOUNT,
  GEL,
  POLICY,
  POLICY_VERSION,
  SELLER,
  beneficiaryFor,
  evidenceRef,
  fp,
  nameConsistentBeneficiary,
} from './support/fixtures';
import { toConditionReady, toPayingOut, toReleasePending } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);
const BENEFICIARY_TASK = trancheOptions(POLICY_VERSION, { taskKind: 'beneficiary_change' });
const SETTLED = trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE });

const HOUR_MS = 60 * 60 * 1000;

/**
 * Сценарий 9 — реквизиты выплаты как защитный периметр.
 *
 * Самый вероятный вектор атаки на продукт: дата расчёта, сумма и обе стороны
 * известны заранее, и подмена реквизитов в последний момент стоит всей суммы
 * сделки (`CORE.md` Ф15). Периметр держится на трёх разных утверждениях, и
 * каждое проверяется здесь отдельно:
 *
 *  1. `g_beneficiary_verified` — владение счётом доказано, а не «имя сошлось»;
 *  2. `g_beneficiary_locked` — реквизиты заперты и не менялись в окне 72 часов;
 *  3. `openBeneficiaryChange` — изменение внутри окна отвергается автоматом.
 *
 * До этого файла сквозной контур не проверял из них **ни одного**: во всех
 * сценариях реквизиты приходили из `beneficiaryFor`, то есть сразу
 * `verified`, — и удаление `g_beneficiary_verified` из таблицы переходов не
 * роняло здесь ни одного теста.
 */
describe('реквизиты выплаты: доказательство владения счётом', () => {
  it('не выпускает выплату на реквизиты, у которых сошлось только имя, и уводит транш в разбор', async () => {
    const DEAL = 'deal-name-only';
    const TRANCHE = 'tranche-name-only';

    // Статус считает настоящий `verifyBeneficiaryHolder`, а не фикстура:
    // подставить `verified` руками значило бы обойти ровно тот guard, ради
    // которого он существует.
    const beneficiary = nameConsistentBeneficiary(DEAL, SELLER, 502);
    expect(beneficiary.status).toBe('name_consistent');
    expect(beneficiary.requisites.ownershipEvidence).toBeNull();

    const ready = await toConditionReady({ dealId: DEAL, trancheId: TRANCHE, beneficiary });
    let world = ready.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('reserved');
    // Реквизиты **заперты** — и это не помогает: заперты и доказаны владением
    // счётом суть два разных утверждения (`STATE-MACHINES.md` §1.3, E13-2).
    expect(trancheOf(world, TRANCHE).beneficiary.locked).toBe(true);

    // --- Первое ребро пути выплаты: reserved → release_pending ---
    const refused = rejectTrancheEvent(world, TRANCHE, {
      type: 'condition_established',
      evidenceBundleId: `evidence-${TRANCHE}`,
      conditionType: 'registration_transfer',
    });
    expect(refused.code).toBe('domain.guard.failed');
    // Провален ровно один guard: пакет доказательств собран, поля выписки
    // сошлись, собственник — покупатель, реквизиты заперты. Не проходит только
    // владение счётом.
    expect([...refused.failedGuards]).toEqual(['g_beneficiary_verified']);

    // --- Разбор: транш блокируется, задача уходит оператору ---
    const blocked = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'mismatch_detected', field: 'beneficiary.ownership_evidence' },
      BENEFICIARY_TASK,
    );
    world = blocked.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_blocked');
    expect(world.tasks).toHaveLength(1);
    const ranked = prioritize(world.tasks, POLICY.queue, world.now);
    expect(ranked[0]?.task.kind).toBe('beneficiary_change');
    expect(ranked[0]?.task.trancheId).toBe(TRANCHE);
    // Узнают обе стороны: получатель не должен догадываться о задержке по факту
    // неполучения денег.
    expect(world.notifications).toContainEqual({
      audience: 'both',
      messageKey: 'tranche.release_blocked.both',
    });
    // Сделка дальше `filed` не уходит: расчёта не было.
    expect(dealStatusOf(world, DEAL)).toBe('filed');

    // --- Второе ребро: обход через release_blocked тоже закрыт ---
    // Именно ради этого guard'ы доказательств продублированы на
    // `release_pending → paying_out`: оператор снимает блокировку, транш
    // возвращается в `release_pending`, и если бы проверка стояла только на
    // входе из `reserved`, выплата ушла бы отсюда.
    world = approve(world, TRANCHE, STAFF.controller);
    world = approve(world, TRANCHE, STAFF.head);
    world = applyTrancheEvent(world, TRANCHE, { type: 'approval_added', userId: 'approver-1' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');

    // Разбор блокировку реквизитов **не снимает** (§1.5: `release_blocked`
    // внутри периметра резерва, как и `frozen`), поэтому отказ ровно один и
    // именно тот, о котором сценарий. Прежде отказов было два, и второй —
    // `g_beneficiary_locked` — снимался вызовом `patchFacts`, то есть чёрным
    // ходом: без него сценарий не доходил до своего утверждения.
    expect(trancheOf(world, TRANCHE).beneficiary.locked).toBe(true);
    const refusedAgain = rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' });
    expect([...refusedAgain.failedGuards]).toEqual(['g_beneficiary_verified']);

    // --- Итог: денег не двинулось ---
    expect(trancheOf(world, TRANCHE).payouts).toEqual([]);
    expect(accountBalance(world.journal, clientFreeAccount(ready.sellerKey), GEL).minor).toBe(0n);
    // Средства покупателя стоят там, где стояли: в файле его транша.
    expect(
      accountBalance(world.journal, clientLockedAccount(ready.buyerKey, DEAL, TRANCHE), GEL).minor,
    ).toBe(20_000_000n);
    expect(checkLedgerInvariants(world.journal)).toEqual([]);
  });

  it('выпускает выплату на реквизиты с доказательством владения счётом', async () => {
    const DEAL = 'deal-verified';
    const TRANCHE = 'tranche-verified';

    // Отличие от предыдущего сценария ровно одно и оно названо: доказательство
    // владения счётом. Имя владельца, документ и счёт — те же.
    const verified = beneficiaryFor(DEAL, SELLER, 502);
    const nameOnly = nameConsistentBeneficiary(DEAL, SELLER, 502);
    expect(verified.requisites.account).toEqual(nameOnly.requisites.account);
    expect(verified.requisites.holderNames).toEqual(nameOnly.requisites.holderNames);
    expect(verified.status).toBe('verified');
    expect(nameOnly.status).toBe('name_consistent');

    const path = await toPayingOut({ dealId: DEAL, trancheId: TRANCHE, beneficiary: verified });
    let world = path.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paying_out');
    expect(trancheOf(world, TRANCHE).payouts).toHaveLength(1);
    expect(trancheOf(world, TRANCHE).payouts[0]?.idempotencyKey).toBe(payoutIdempotencyKey(TRANCHE));

    world = applyTrancheEvent(world, TRANCHE, { type: 'payout_result', outcome: 'settled' }, SETTLED).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paid_out');
    expect(accountBalance(world.journal, clientFreeAccount(path.sellerKey), GEL).minor).toBe(19_700_000n);
    expect(checkLedgerInvariants(world.journal)).toEqual([]);
  });

  /**
   * И13.1, вторая половина: «сторона получает деньги по двум сделкам — реквизиты
   * висят на **участии**, а не на личности».
   *
   * Сценарий тот самый, ради которого понятие участия заведено: продавец уже
   * прошёл тестовый перевод по сделке А и заводит сделку Б. Если подтверждение
   * переносится, то один пройденный тестовый перевод открывает подтверждённый
   * канал вывода навсегда — по любой будущей сделке этого лица.
   */
  it('не пускает подтверждение по одной сделке в другую сделку того же получателя', async () => {
    const DEAL_A = 'deal-participation-a';
    const DEAL_B = 'deal-participation-b';
    // ⚠ Имена траншей короткие не для красоты: ключ идемпотентности — UUID5 от
    // имени транша, и примерно у 3% имён он содержит подряд девять цифр, а
    // `assertNoRawIdentifiers` в журнале аудита считает такой прогон сырым
    // идентификатором и отвергает запись поручения (`digit_run`,
    // `packages/audit/src/values.ts`). `tranche-participation-b` — как раз
    // такое имя. Дефект настоящий и заведён строкой в `ROADMAP.md`; здесь
    // сценарий обходит его, а не прячет.
    const TRANCHE_A = 'tranche-p-a';
    const TRANCHE_B = 'tranche-p-b';

    // Сделка А: реквизиты подтверждены по-настоящему, выплата доходит до банка.
    const confirmedInA = beneficiaryFor(DEAL_A, SELLER, 503);
    expect(confirmedInA.status).toBe('verified');
    const pathA = await toPayingOut({
      dealId: DEAL_A,
      trancheId: TRANCHE_A,
      beneficiary: confirmedInA,
    });
    expect(trancheStatusOf(pathA.world, TRANCHE_A)).toBe('paying_out');

    // Сделка Б: то же лицо, тот же счёт, то же подтверждение — и оно сюда не
    // годится. Отказ на **заведении транша**, а не отказом guard'а перед
    // выплатой: «это подтверждение не от этой сделки» — другая беда, чем
    // «владение не доказано», и ждать её до момента расчёта незачем.
    await expect(
      toConditionReady({ dealId: DEAL_B, trancheId: TRANCHE_B, beneficiary: confirmedInA }),
    ).rejects.toThrow(/beneficiary_participation_mismatch/u);

    // А со своим подтверждением сделка Б идёт обычным путём: второе участие —
    // законный случай, ему нужна своя проверка, а не запрет.
    const confirmedInB = beneficiaryFor(DEAL_B, SELLER, 503);
    expect(confirmedInB.requisites.account).toEqual(confirmedInA.requisites.account);
    const pathB = await toPayingOut({
      dealId: DEAL_B,
      trancheId: TRANCHE_B,
      beneficiary: confirmedInB,
    });
    expect(trancheStatusOf(pathB.world, TRANCHE_B)).toBe('paying_out');
  });

  it('отвергает смену реквизитов в окне 72 часа перед расчётом и запирает выплату после смены вне окна', async () => {
    const DEAL = 'deal-blackout';
    const TRANCHE = 'tranche-blackout';

    const pending = await toReleasePending({ dealId: DEAL, trancheId: TRANCHE });
    let world = approve(pending.world, TRANCHE, STAFF.controller);
    world = approve(world, TRANCHE, STAFF.head);
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');

    const state = trancheOf(world, TRANCHE).beneficiary;
    expect(state.status).toBe('verified');
    expect(state.locked).toBe(true);

    const writer = authorize(actor('operator-1', OPERATOR_ROLE), 'write_beneficiary');
    const proposed = {
      account: accountFingerprint(fp(777)),
      holderNames: SELLER.names,
      holderDocument: SELLER.document,
      ownershipEvidence: null,
    };

    // --- Внутри окна: отказ автоматом, а не задача в очередь ---
    const inside = openBeneficiaryChange(
      state,
      { requestId: 'change-inside', proposed, releaseAt: instant(world.now + 24 * HOUR_MS), dealFunded: true },
      writer,
      POLICY,
      world.now,
    );
    expect(inside.ok).toBe(false);
    if (!inside.ok) {
      // Терминально: у заявки внутри окна нет пути к исполнению, поэтому и
      // эффектов («переверифицировать», «уведомить», «второе утверждение») нет.
      expect(inside.error.request.status).toBe('auto_blocked');
      expect(inside.error.effects).toEqual([]);
      expect(advanceBeneficiaryChange(inside.error.request, { type: 'parties_notified' }, world.now).ok).toBe(
        false,
      );
    }
    // Реквизиты транша не тронуты, выплата по-прежнему разрешена.
    expect(trancheOf(world, TRANCHE).beneficiary.requisites.account).toEqual(state.requisites.account);
    expect(rejectTrancheEvent).toBeTypeOf('function');

    // --- Вне окна: смена проходит, и выплата запирается уже двумя guard'ами ---
    // Оба обязательны и оба падают по разным причинам: новые реквизиты не
    // наследуют доказательство владения (оно относилось к другому счёту), и
    // отметка изменения попадает внутрь запретных 72 часов.
    const opened = openBeneficiaryChange(
      state,
      { requestId: 'change-outside', proposed, releaseAt: null, dealFunded: false },
      writer,
      POLICY,
      world.now,
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('unreachable');
    let request = opened.value.request;
    for (const event of [
      { type: 'reverification_passed' as const },
      { type: 'parties_notified' as const },
      { type: 'approval_added' as const, userId: 'approver-1' },
    ]) {
      const moved = advanceBeneficiaryChange(request, event, world.now);
      expect(moved.ok).toBe(true);
      if (!moved.ok) throw new Error('unreachable');
      request = moved.value;
    }

    // Охлаждение 24 часа — настоящее, не пропущенное: применение до его
    // истечения отвергается.
    const tooEarly = applyBeneficiaryChange(
      state,
      request,
      { releaseAt: null, dealFunded: false, locked: state.locked },
      authorize(actor('approver-2', APPROVER_ROLE), 'approve_beneficiary_change'),
      POLICY,
      world.now,
    );
    expect(tooEarly.ok).toBe(false);

    world = advance(world, 25 * HOUR_MS);
    const applied = applyBeneficiaryChange(
      state,
      request,
      { releaseAt: null, dealFunded: false, locked: state.locked },
      authorize(actor('approver-2', APPROVER_ROLE), 'approve_beneficiary_change'),
      POLICY,
      world.now,
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('unreachable');
    expect(applied.value.status).toBe('name_consistent');
    expect(applied.value.lastChangedAt).toBe(world.now);

    world = patchFacts(world, TRANCHE, { beneficiary: toBeneficiaryConfirmation(applied.value) });
    const refused = rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' });
    // Третий отказ — про **свежесть выписки**, и он появился здесь сам, без
    // единой правки сценария: часы этого теста ушли на 25 часов вперёд, а
    // предельный возраст наблюдения — сутки (`ORACLE.md` §6.3,
    // `DEFAULT_OBSERVATION_POLICY`). Выписка суточной давности не утверждает
    // ничего о сегодняшних обременениях, и `g_observation_sufficient` это
    // видит. Утверждение оставлено полным нарочно: сокращать список до
    // «интересных» guard'ов значит перестать замечать такие изменения.
    expect([...refused.failedGuards].sort()).toEqual([
      'g_beneficiary_locked',
      'g_beneficiary_verified',
      'g_observation_sufficient',
    ]);

    // Через 72 часа окно закрывается, но доказательство владения так и не
    // появилось: guard блокировки снялся, два других держат.
    world = advance(world, 72 * HOUR_MS);
    const stillRefused = rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' });
    expect([...stillRefused.failedGuards]).toEqual([
      'g_observation_sufficient',
      'g_beneficiary_verified',
    ]);

    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');
    expect(accountBalance(world.journal, clientFreeAccount(pending.sellerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
    expect(evidenceRef(1).kind).toBe('test_transfer');
    expect(DEAL_AMOUNT.minor).toBe(20_000_000n);
  });
});
