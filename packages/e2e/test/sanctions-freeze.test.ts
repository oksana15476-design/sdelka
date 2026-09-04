import { describe, expect, it } from 'vitest';
import { auditRef } from '@sdelka/audit';
import { decideSanctions, sanctionsToDetectorOutcome } from '@sdelka/compliance';
import { assessRefundDestination, accountFingerprint } from '@sdelka/compliance';
import { dealState, reduceDeal } from '@sdelka/domain';
import { accountBalance, clientLockedAccount } from '@sdelka/ledger';
import {
  ANALYST_ACTOR,
  advance,
  applyDealEvent,
  applyTrancheEvent,
  dealFactsOf,
  dealStatusOf,
  feeForTranche,
  recordDecision,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '../src/index';
import {
  BANK_RESPONSE_SOURCE,
  BUYER,
  DAY_MS,
  DEAL_AMOUNT,
  GEL,
  NOW,
  POLICY,
  POLICY_VERSION,
  SCREENING_SOURCE,
  SELLER,
  fp,
  sanctionedScreening,
} from './support/fixtures';
import { toReserved } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);
const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const DEAL = 'deal-frozen';
const TRANCHE = 'tranche-frozen';

/**
 * Сценарий 6 — санкционная заморозка.
 *
 * Дедлайн приостановлен, автовозврат НЕ происходит: приоритет заморозки над
 * возвратом реализован **отсутствием переходов** из `frozen`, а не проверкой
 * (`CORE.md` Ф17, `STATE-MACHINES.md` §1.4.1).
 */
describe('санкционная заморозка', () => {
  it('приостанавливает дедлайн, не даёт автовозврату случиться и выходит только по решению двух людей', async () => {
    const path = await toReserved({ dealId: DEAL, trancheId: TRANCHE });
    let world = path.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('reserved');
    const entriesBefore = world.journal.entries.length;

    // Скрининг в ходе жизни сделки дал совпадение по сильному идентификатору.
    const response = await sanctionedScreening().screen({
      subjectRef: BUYER.partyId,
      names: BUYER.names,
      nationalities: BUYER.nationalities,
      lists: POLICY.sanctions.lists,
      requestedAt: world.now,
      policyVersionId: POLICY_VERSION,
    });
    const sanctions = decideSanctions(
      {
        subjectRef: BUYER.partyId,
        subjectNames: BUYER.names,
        subjectNationalities: BUYER.nationalities,
        response,
        whitelist: [],
        evidence: [],
      },
      POLICY,
      world.now,
    );
    expect(sanctions.outcome).toBe('confirmed_match');
    expect(sanctionsToDetectorOutcome(sanctions.outcome)).toBe('block');

    world = recordDecision(world, {
      subject: auditRef('party', BUYER.partyId),
      related: [auditRef('deal', DEAL), auditRef('tranche', TRANCHE)],
      actor: ANALYST_ACTOR,
      outcome: sanctions.outcome,
      policy: POLICY_VERSION,
      reasonKeys: sanctions.reasons,
      evidence: [SCREENING_SOURCE],
    });

    // Заморозка сделки каскадируется на транши: без каскада комплаенс
    // замораживает сделку, а транш продолжает идти к автовозврату.
    world = applyDealEvent(
      world,
      DEAL,
      { type: 'compliance_hold', reason: 'sanctions', frozenBy: 'analyst-1' },
      OPTIONS,
    );
    expect(dealStatusOf(world, DEAL)).toBe('frozen');
    expect(trancheStatusOf(world, TRANCHE)).toBe('frozen');

    const frozen = trancheOf(world, TRANCHE).state;
    // Дедлайн приостановлен структурой: поля дедлайна у замороженного нет вовсе,
    // а неистёкшая часть сохранена.
    expect('deadline' in frozen).toBe(false);
    expect('remaining' in frozen ? frozen.remaining : null).toBeGreaterThan(0);
    expect(trancheOf(world, TRANCHE).suspendedRemaining).toBeGreaterThan(0);
    // Блокировка реквизитов сохраняется: заморозка — не уход из резерва, а его
    // приостановка. Иначе она стала бы способом сбросить периметр Ф15.
    expect(trancheOf(world, TRANCHE).beneficiary.locked).toBe(true);

    // --- Автовозврат не происходит ---
    world = advance(world, 30 * DAY_MS);
    expect(rejectTrancheEvent(world, TRANCHE, { type: 'deadline_reached' }).code).toBe(
      'domain.transition.not_allowed',
    );
    expect(rejectTrancheEvent(world, TRANCHE, { type: 'refund_initiated' }).code).toBe(
      'domain.transition.not_allowed',
    );
    expect(
      rejectTrancheEvent(world, TRANCHE, { type: 'payout_result', outcome: 'settled' }).code,
    ).toBe('domain.transition.not_allowed');
    // Ни одной проводки за месяц заморозки: деньги стоят там, где стояли.
    expect(world.journal.entries).toHaveLength(entriesBefore);
    expect(accountBalance(world.journal, clientLockedAccount(path.buyerKey, DEAL, TRANCHE), GEL).minor).toBe(
      20_000_000n,
    );

    // Возврат тоже заблокирован комплаенсом, и по той же причине.
    const destination = assessRefundDestination(
      {
        sourceAccount: accountFingerprint(fp(700)),
        sourceHolder: BUYER.document,
        requestedAccount: accountFingerprint(fp(700)),
        requestedHolder: BUYER.document,
        sanctionsFrozen: true,
        evidence: [],
      },
      POLICY_VERSION,
      NOW,
    );
    expect(destination.outcome).toBe('block');
    expect(destination.reasons).toContain('compliance.refund.sanctions_freeze_precedence');

    // --- Разморозка: два разных человека, ни один не замораживал ---
    const byFreezer = rejectTrancheEvent(world, TRANCHE, {
      type: 'unfreeze',
      userIds: ['analyst-1', 'analyst-2'],
      resume: 'suspended_from',
    });
    expect(byFreezer.failedGuards).toContain('g_unfreeze_approvers_distinct');

    // Возврат в приостановленный статус досчитывает неистёкшую часть дедлайна и
    // **не переигрывает вход**: ни повторной блокировки реквизитов, ни второго
    // «средства подтверждены» продавцу.
    const restored = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'unfreeze', userIds: ['analyst-2', 'analyst-3'], resume: 'suspended_from' },
      OPTIONS,
    );
    expect(trancheStatusOf(restored.world, TRANCHE)).toBe('reserved');
    expect(restored.transition.intents).toEqual([
      { type: 'set_deadline', at: expect.any(Number) as unknown as number },
    ]);
    expect(
      restored.world.notifications.filter((item) => item.messageKey === 'tranche.reserved.seller'),
    ).toHaveLength(1);
    const thawed = trancheOf(restored.world, TRANCHE).state;
    expect('enteredAt' in thawed ? thawed.enteredAt : null).toBe(restored.world.now);

    // ⚠ Тупик. Если разморозить сделку в `settling`, а её транш потом уйдёт в
    // возврат, сделке некуда деваться: у `settling` есть единственное ребро
    // наружу — `tranches_settled` с guard'ом «все транши выплачены». Обход
    // графа этого не видит: ребро существует, непроходим только guard.
    // Отчёт, расхождение 15.
    const deadEnd = reduceDeal(dealState('settling'), { type: 'tranches_refunded' }, {
      dealId: DEAL,
      facts: { ...dealFactsOf(world, DEAL), trancheStatuses: ['refunded'] },
      now: world.now,
    });
    expect(deadEnd.ok).toBe(false);

    // --- Совпадение подтверждено: сделка откатывается, транш идёт в возврат ---
    world = applyDealEvent(
      world,
      DEAL,
      { type: 'unfreeze', userIds: ['analyst-2', 'analyst-3'], resume: 'unwinding' },
      OPTIONS,
    );
    expect(dealStatusOf(world, DEAL)).toBe('unwinding');
    expect(trancheStatusOf(world, TRANCHE)).toBe('refund_pending');

    world = applyTrancheEvent(world, TRANCHE, { type: 'refund_initiated' }, ROLLBACK).world;
    world = applyTrancheEvent(world, TRANCHE, { type: 'payout_result', outcome: 'settled' }, ROLLBACK).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunded');
    world = applyDealEvent(world, DEAL, { type: 'tranches_refunded' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('unwound');

    expect(accountBalance(world.journal, clientLockedAccount(path.buyerKey, DEAL, TRANCHE), GEL).minor).toBe(0n);
    expect(feeForTranche(world, TRANCHE, DEAL_AMOUNT).minor).toBe(300_000n);
    expect(BANK_RESPONSE_SOURCE.sourceKind).toBe('payment_provider_response');
    expect(SELLER.partyId).toBe('party-seller');
  });
  /**
   * Разморозка — вторая операция «четырёх глаз» после списания, и правило у неё
   * то же: два разных человека, ни один из которых не готовил операцию и не
   * замораживал транш.
   *
   * ⚠ Проверка распалась на две половины, и это видно снаружи. Сверка с автором
   * заморозки живёт в редьюсере (автор лежит в состоянии, а `GuardInput`
   * состояния не видит), а «двое и они разные» — в guard'е. Первая половина
   * закрыта сценарием выше; здесь закрыта вторая, и потому все попытки ниже
   * подписаны кем угодно, только не замораживавшим: иначе они разбились бы о
   * первую половину, и guard остался бы непроверенным.
   */
  it('не выпускает транш из заморозки по одной учётной записи', async () => {
    const DEAL_SOLO = 'deal-unfreeze-solo';
    const TRANCHE_SOLO = 'tranche-unfreeze-solo';

    const path = await toReserved({ dealId: DEAL_SOLO, trancheId: TRANCHE_SOLO });
    // Спор сторон — то же основание заморозки, что и комплаенс, и та же дверь
    // наружу (`CORE.md` Ф17).
    let world = applyTrancheEvent(
      path.world,
      TRANCHE_SOLO,
      { type: 'dispute_raised', frozenBy: 'analyst-1' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE_SOLO)).toBe('frozen');
    const entriesBefore = world.journal.entries.length;

    // --- Одна учётная запись ---
    expect([
      ...rejectTrancheEvent(world, TRANCHE_SOLO, {
        type: 'unfreeze',
        userIds: ['analyst-2'],
        resume: 'suspended_from',
      }).failedGuards,
    ]).toEqual(['g_unfreeze_approvers_distinct']);

    // --- Один человек дважды ---
    expect([
      ...rejectTrancheEvent(world, TRANCHE_SOLO, {
        type: 'unfreeze',
        userIds: ['analyst-2', 'analyst-2'],
        resume: 'suspended_from',
      }).failedGuards,
    ]).toEqual(['g_unfreeze_approvers_distinct']);

    // --- Вторым подписантом подставлен тот, кто готовил операцию ---
    expect(trancheOf(world, TRANCHE_SOLO).facts.preparedBy).toBe('operator-1');
    expect([
      ...rejectTrancheEvent(world, TRANCHE_SOLO, {
        type: 'unfreeze',
        userIds: ['operator-1', 'analyst-2'],
        resume: 'suspended_from',
      }).failedGuards,
    ]).toEqual(['g_unfreeze_approvers_distinct']);

    // Транш всё это время заморожен, и ни одной проводки не появилось.
    expect(trancheStatusOf(world, TRANCHE_SOLO)).toBe('frozen');
    expect(world.journal.entries).toHaveLength(entriesBefore);

    // --- Двое разных, ни один не замораживал: транш возвращается ---
    world = applyTrancheEvent(
      world,
      TRANCHE_SOLO,
      { type: 'unfreeze', userIds: ['analyst-2', 'analyst-3'], resume: 'suspended_from' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE_SOLO)).toBe('reserved');
  });
});
