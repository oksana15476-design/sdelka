import { describe, expect, it } from 'vitest';
import { STAFF, party } from './support/actors';
import { accountBalance, bankNominal, clientFreeAccount, coverage } from '@sdelka/ledger';
import {
  type World,
  SCHEDULER_INTERVAL_MS,
  advance,
  dealFactsOf,
  dealStatusOf,
  rejectDealEvent,
  rejectUnwind,
  tick,
  trancheOptions,
  trancheStatusOf,
  unwindReviewOf,
} from '@sdelka/app';
import {
  applyDealEvent,
  applyObservationEvent,
  applyTrancheEvent,
  approveUnwind,
  authorizeUnwind,
  requestUnwind,
} from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  CADASTRAL_CODE,
  CONDITION_ACT_SOURCE,
  DAY_MS,
  GEL,
  POLICY_VERSION,
  registryUnavailable,
} from './support/fixtures';
import { toExtractOrdered } from './support/paths';

/**
 * Красная линия №7 в состоянии «подано» — **сквозной** путь, а не редьюсер.
 *
 * Что было установлено до этого сценария. Ребро
 * `filed --unwind_authorized--> unwinding` и guard
 * `g_unwind_approvers_distinct` в домене есть (`packages/domain/src/deal.ts:93`,
 * `:277`, `:386`), и на фактах они проверены
 * (`packages/domain/test/red-line-7-filed.test.ts`). Но строка
 * `unwind_authorized` не встречалась **нигде** за пределами домена и его же
 * тестов: ни в `packages/app`, ни в `packages/e2e`, ни в `apps/web`. Приложение
 * порождало ровно одно событие сделки само — `filing_registered`
 * (`packages/app/src/flow.ts:1578`), остальные приходили аргументом
 * `applyDealEvent`. Часов у сделки нет вовсе: `tick` обходит только транши
 * (`packages/app/src/scheduler.ts:99-105`), а `DUE_TRANCHE_EVENTS`
 * `unwind_authorized` невыразимо.
 *
 * То есть механизм раскрутки был построен, а дороги к нему из продукта не было,
 * и мутационный прогон это показывал прямо: снятие
 * `g_unwind_approvers_distinct` не роняло ни одного сквозного теста. Правило
 * стояло на двери, к которой никто не подходил.
 *
 * Здесь дорога проходится целиком: сделка доведена до «подано» подачей и
 * карточкой заявления, реестр замолкает, время идёт, планировщик работает — и
 * ни одна автоматическая дверь не открывается. Открывает её разбор двумя
 * людьми, после чего деньги возвращаются покупателю.
 */

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на счёте клиента: зачисление было отдельной записью при приёме. */
const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });

/**
 * Утверждающие — аналитики комплаенса, как у разморозки
 * (`sanctions-freeze.test.ts`). Оператор `operator-1` при этом **готовил
 * сделку** (`openDeal` кладёт `preparedBy: 'operator-1'`), и это тот самый
 * случай, который guard обязан отсеять.
 *
 * ⚠ Полномочие названо `lift_block`: полномочия «утвердить откат» в
 * `CAPABILITIES` нет вовсе, и это [открыто] — см. `UNWIND_SIGNING_ROLES`.
 */
/**
 * Подписывают откат **финансовый контролёр и руководитель операций**, а не
 * аналитики.
 *
 * Прежняя редакция принимала подпись оператора, «утверждающего» и аналитика —
 * по роли **актора журнала**, которую называл сам вызывающий. Сегодня подпись
 * идёт под полномочием `approve_lift_block` («вторая подпись» `ACTORS.md`
 * §5.3), а его носители ровно два: ФК (уровень 1) и РО (уровень 2). Оператор и
 * аналитик подписывать больше не могут — это ужесточение, и оно закреплено
 * сценарием «кто подписать не вправе» ниже.
 */
const FIRST_SIGNER = STAFF.controller;
const SECOND_SIGNER = STAFF.head;

/** Ключ локализации, а не текст: причина возврата видна клиенту (три языка). */
const REASON = 'deal.unwind.registry_silent';

/**
 * Сделка доведена до «подано» с открытым подтверждённым заявлением, реестр
 * замолчал, разбор поднят оператором. Дальше сценарии расходятся только
 * подписями.
 */
async function withOpenReview(
  seed: string,
  world?: World,
): Promise<{ readonly world: World; readonly dealId: string; readonly trancheId: string }> {
  const dealId = `deal-unwind-${seed}`;
  const trancheId = `tranche-unwind-${seed}`;
  const ordered = await toExtractOrdered({
    dealId,
    trancheId,
    ...(world === undefined ? {} : { world }),
  });
  const silent = applyObservationEvent(
    ordered.world,
    trancheId,
    { type: 'registry_unavailable', reasonKey: 'oracle.registry.unavailable' },
    OPTIONS,
  ).world;
  const requested = requestUnwind(
    silent,
    dealId,
    { reasonKey: REASON, evidence: [CONDITION_ACT_SOURCE] },
    OPTIONS,
  );
  return { world: requested, dealId, trancheId };
}

describe('красная линия №7: от бездействия до возврата покупателю', () => {
  it('проходит весь путь: молчащий реестр, разбор двумя людьми, деньги у покупателя', async () => {
    const DEAL = 'deal-unwind-path';
    const TRANCHE = 'tranche-unwind-path';
    const ordered = await toExtractOrdered({ dealId: DEAL, trancheId: TRANCHE });
    let world = ordered.world;

    // --- Исходное состояние: деньги заперты, заявление открыто ---
    expect(dealStatusOf(world, DEAL)).toBe('filed');
    expect(trancheStatusOf(world, TRANCHE)).toBe('reserved');
    const filings = dealFactsOf(world, DEAL).filings;
    // Подтверждено карточкой и не разрешено выпиской — то самое «открытое
    // заявление», при котором Ф9 запрещает автооткат.
    expect(filings.map((filing) => filing.source)).toEqual(['application_card']);
    expect(filings.map((filing) => filing.resolution)).toEqual([null]);

    // --- Реестр молчит. Молчание, а не ответ «перехода нет» ---
    expect(registryUnavailable().paidExtract(CADASTRAL_CODE).kind).toBe('unavailable');
    const silent = applyObservationEvent(
      world,
      TRANCHE,
      { type: 'registry_unavailable', reasonKey: 'oracle.registry.unavailable' },
      OPTIONS,
    );
    world = silent.world;
    expect(silent.state.status).toBe('unavailable');
    // Часы сделки приостановить некому: намерение возвращается неисполненным, и
    // это ровно то, почему «подождать» здесь не работает вовсе.
    expect(silent.intents).toEqual([
      { type: 'suspend_deal_clock', reasonKey: 'oracle.registry.unavailable' },
    ]);

    // --- Бездействие: время идёт, планировщик работает, не меняется ничего ---
    world = advance(world, SCHEDULER_INTERVAL_MS);
    const quiet = tick(world, OPTIONS);
    world = quiet.world;
    // Тик молчит не потому, что у сделки не наступил срок, а потому, что часов
    // у сделки нет ни одних: `tick` обходит транши, а транш ещё в резерве.
    expect(quiet.fired).toEqual([]);
    expect(dealStatusOf(world, DEAL)).toBe('filed');

    // Обе автоматические двери закрыты, и каждая по своей причине.
    expect([...rejectDealEvent(world, DEAL, { type: 'deadline_reached' }).failedGuards]).toEqual([
      'g_no_open_filing',
    ]);
    expect(rejectDealEvent(world, DEAL, { type: 'revocation_requested' }).code).toBe(
      'domain.transition.not_allowed',
    );

    // --- Разбор человеком: заявка ---
    world = requestUnwind(
      world,
      DEAL,
      { reasonKey: REASON, evidence: [CONDITION_ACT_SOURCE] },
      OPTIONS,
    );
    const review = unwindReviewOf(world, DEAL);
    expect(review?.requestedBy).toBe('operator-1');
    expect(review?.reasonKey).toBe(REASON);
    // «Разбор идёт» отличимо от «ждём реестр» — заявкой, а не статусом сделки:
    // нового состояния у сделки не появилось (`STATE-MACHINES.md` §3.2).
    expect(review?.approvals).toEqual([]);
    expect(dealStatusOf(world, DEAL)).toBe('filed');

    // --- Одной подписи мало ---
    world = approveUnwind(world, DEAL, OPTIONS, FIRST_SIGNER);
    expect([...rejectUnwind(world, DEAL).failedGuards]).toEqual(['g_unwind_approvers_distinct']);
    expect(dealStatusOf(world, DEAL)).toBe('filed');

    // --- Вторая подпись, другого человека: дверь открывается ---
    world = approveUnwind(world, DEAL, OPTIONS, SECOND_SIGNER);
    expect(unwindReviewOf(world, DEAL)?.approvals.map((item) => item.userId)).toEqual([
      'approver-1',
      'approver-2',
    ]);
    world = authorizeUnwind(world, DEAL, OPTIONS, SECOND_SIGNER);
    expect(dealStatusOf(world, DEAL)).toBe('unwinding');

    // Решение восстановимо по журналу: две подписи разными людьми и переход.
    const decisions = world.chain.records.filter(
      (record) =>
        record.body.kind === 'decision_made' && record.body.outcomeKey === 'deal.unwind_approved',
    );
    expect(decisions.map((record) => record.actor.actorId)).toEqual(['approver-1', 'approver-2']);
    // Актор записи выведен из сессии, а не назван вызывающим: роль журнала и
    // полномочие — те самые, под которыми шаг и прошёл.
    //
    // До миграции `0023` обе строки были `approver`: одна метка на оба уровня
    // утверждения, и «две подписи разными людьми» держались только на различии
    // `actorId`. Теперь в журнале видно **уровень**: финконтролёр даёт первый,
    // руководитель операций — второй (`ACTORS.md` §5.2).
    expect(decisions.map((record) => record.actor.roleId)).toEqual([
      'financial_controller',
      'head_of_operations',
    ]);
    expect(decisions.map((record) => record.actor.capability)).toEqual([
      'approve_lift_block',
      'approve_lift_block',
    ]);
    expect(
      world.chain.records.some(
        (record) =>
          record.body.kind === 'state_transition' && record.body.eventKey === 'unwind_authorized',
      ),
    ).toBe(true);

    // --- Возврат покупателю ---
    // ⚠ Дальше деньги двигают **часы транша**, а не решение сделки: намерений
    // у `unwind_authorized` нет, каскада «сделка → транши» на откате не
    // существует. Это названное [открыто] (`STATE-MACHINES.md` §3.2, второе), и
    // сценарий его фиксирует как есть, а не подгоняет под желаемое.
    world = advance(world, DAY_MS + 1);
    const expired = tick(world, ROLLBACK);
    world = expired.world;
    expect(expired.fired.map((item) => [item.event.type, item.to])).toEqual([
      ['reserve_expired', 'collected'],
    ]);

    world = advance(world, DAY_MS + 1);
    const due = tick(world, ROLLBACK);
    world = due.world;
    expect(due.fired.map((item) => [item.event.type, item.to])).toEqual([
      ['deadline_reached', 'refund_pending'],
    ]);

    world = applyTrancheEvent(world, TRANCHE, { type: 'refund_initiated' }, ROLLBACK).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunding');
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'payout_result', outcome: 'settled' },
      { ...ROLLBACK, payoutResponse: BANK_RESPONSE_SOURCE },
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunded');

    world = applyDealEvent(world, DEAL, { type: 'tranches_refunded' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('unwound');

    // Деньги ушли с номинального счёта, обязательства перед покупателем нет,
    // покрытие сошлось.
    expect(accountBalance(world.journal, clientFreeAccount(ordered.buyerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(0n);
    expect(coverage(world.journal).find((item) => item.currency === GEL)?.difference.minor).toBe(0n);
  });

  it('не открывает дверь ни без подписей, ни одной, ни одной и той же дважды', async () => {
    // Каждый случай — свой мир: подпись поставленной не разставляется обратно,
    // и «уменьшить» разбор нельзя, не переписав историю.
    const empty = await withOpenReview('empty');
    // Ноль подписей. Проверка здесь не «на всякий случай»: приложение
    // намеренно не отбрасывает пустой разбор само, иначе на снятом guard'е
    // откат прошёл бы вообще без единой подписи и никто бы не узнал.
    expect([...rejectUnwind(empty.world, empty.dealId).failedGuards]).toEqual([
      'g_unwind_approvers_distinct',
    ]);

    const single = await withOpenReview('single', empty.world);
    const signedOnce = approveUnwind(single.world, single.dealId, OPTIONS, FIRST_SIGNER);
    expect([...rejectUnwind(signedOnce, single.dealId).failedGuards]).toEqual([
      'g_unwind_approvers_distinct',
    ]);

    // Две подписи одного имени — одна подпись. Приложение их не схлопывает: это
    // правило домена, и второй его экземпляр здесь сделал бы guard
    // непроверяемым.
    const twice = await withOpenReview('twice', signedOnce);
    let repeated = approveUnwind(twice.world, twice.dealId, OPTIONS, FIRST_SIGNER);
    repeated = approveUnwind(repeated, twice.dealId, OPTIONS, FIRST_SIGNER);
    expect(unwindReviewOf(repeated, twice.dealId)?.approvals).toHaveLength(2);
    expect([...rejectUnwind(repeated, twice.dealId).failedGuards]).toEqual([
      'g_unwind_approvers_distinct',
    ]);

    // Готовивший разбор подписать его больше **не может вовсе**: у оператора нет
    // полномочия `approve_lift_block`. Прежде подпись ставилась и отсеивалась
    // guard'ом `g_unwind_approvers_distinct` — теперь рубеж стоит раньше, на
    // праве, а guard остаётся вторым (проверяется строкой ниже).
    const preparer = await withOpenReview('preparer', repeated);
    expect(() => approveUnwind(preparer.world, preparer.dealId, OPTIONS, STAFF.operator)).toThrow(
      'app.authority.denied',
    );

    // Одна подпись — и guard домена по-прежнему её не принимает.
    const byFirst = approveUnwind(preparer.world, preparer.dealId, OPTIONS, FIRST_SIGNER);
    expect([...rejectUnwind(byFirst, preparer.dealId).failedGuards]).toEqual([
      'g_unwind_approvers_distinct',
    ]);

    // И тот же разбор со второй подписью — уже другого человека — проходит.
    // Без этой строки предыдущие четыре доказывали бы только, что дверь
    // заперта всегда.
    const opened = approveUnwind(byFirst, preparer.dealId, OPTIONS, SECOND_SIGNER);
    const unwinding = authorizeUnwind(opened, preparer.dealId, OPTIONS, SECOND_SIGNER);
    expect(dealStatusOf(unwinding, preparer.dealId)).toBe('unwinding');
  });

  it('подписать откат не вправе ни машина, ни сторона, ни поддержка, ни аналитик', async () => {
    const review = await withOpenReview('roles');

    // Разбор человеком автоматическим не является: у события намеренно нет
    // часов. Машина подписать не может **структурно**: разрешение часов из
    // пакета не выходит, и собрать его сценарию нечем — этот запрет держится
    // отсутствием экспорта, а не проверкой роли, которую вызывающий сам и
    // называл.
    //
    // Три остальных запрета — по полномочию, а не по имени роли в журнале.
    for (const actor of [
      // Сторона: подпись покупателя означала бы право отозвать деньги после
      // подачи заявления — второй разбор развилки (`STATE-MACHINES.md` §3.2),
      // который [открыто] и решается владельцем, а не нами молча.
      party('party-buyer'),
      // Поддержка read-only по построению.
      STAFF.support,
      // Аналитик комплаенса: прежняя редакция его подпись принимала. Больше
      // нет — уровня утверждения у него нет, и `approve_lift_block` тоже.
      STAFF.analyst,
      // Оператор оракула: устанавливает факт, но не утверждает (Н2).
      STAFF.oracle,
    ]) {
      expect(() => approveUnwind(review.world, review.dealId, OPTIONS, actor)).toThrow(
        'app.authority.denied',
      );
    }
  });

  it('не принимает подпись под заявкой, которой нет, и решение без основания', async () => {
    const ordered = await toExtractOrdered({
      dealId: 'deal-unwind-none',
      trancheId: 'tranche-unwind-none',
    });

    // Подпись под неподнятым разбором: иначе «кто поднял» останется без ответа
    // именно тогда, когда ответ нужен.
    expect(() => approveUnwind(ordered.world, 'deal-unwind-none', OPTIONS, FIRST_SIGNER)).toThrow(
      'app.unwind.not_requested:deal-unwind-none',
    );

    // Возврат денег без основания невосстановим через год — и запись журнала
    // его не принимает по типу.
    expect(() =>
      requestUnwind(
        ordered.world,
        'deal-unwind-none',
        { reasonKey: REASON, evidence: [] },
        OPTIONS,
      ),
    ).toThrow('app.unwind.evidence_required:deal-unwind-none');
  });
});
