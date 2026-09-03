import { describe, expect, it } from 'vitest';
import {
  ANALYST_ROLE,
  OPERATOR_ROLE,
  actor,
  assessPayer,
  authorize,
  compareNames,
  payerKeyForDomain,
  prioritize,
} from '@sdelka/compliance';
import { dealState, reduceDeal } from '@sdelka/domain';
import { accountBalance, bankNominal } from '@sdelka/ledger';
import { money } from '@sdelka/money';
import {
  E2eInvariantError,
  applyDealEvent,
  applyTrancheEvent,
  dealFactsOf,
  dealStatusOf,
  holdThirdPartyPayment,
  patchFacts,
  returnHeldPayment,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '../src/index';
import {
  BUYER,
  GEL,
  NOW,
  POLICY,
  POLICY_VERSION,
  SELLER,
  THIRD_PARTY,
} from './support/fixtures';
import { openDeal } from './support/open';

const OPTIONS = trancheOptions(POLICY_VERSION, { taskKind: 'payer_hold' });
const DEAL = 'deal-third-party';
const TRANCHE = 'tranche-third-party';

/** Заведомо ничтожная сумма: удержание не зависит от размера платежа. */
const TINY = money(GEL, 100n);

/**
 * Сценарий 4 — платёж от третьего лица: удержание при любой сумме и разбор
 * оператором. `FUNCTIONAL.md` инвариант 19.
 */
describe('платёж от третьего лица', () => {
  it('удерживает средства при любой сумме и доводит транш до возврата', async () => {
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = applyTrancheEvent(opened.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;

    // Деньги физически пришли, но обязательства перед покупателем из них не
    // возникает: они висят непознанным поступлением.
    world = holdThirdPartyPayment(world, TINY);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(100n);

    const blocked = applyTrancheEvent(
      world,
      TRANCHE,
      {
        type: 'funds_received',
        amount: TINY,
        sender: payerKeyForDomain(THIRD_PARTY.document),
        reference: 'payment-third-party',
      },
      OPTIONS,
    );
    world = blocked.world;
    // Сумма ничтожна, но удержание всё равно наступило: `g_amount_sufficient`
    // на этом ребре не стоит вовсе — решает только несовпадение плательщика.
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_blocked');
    // На транш ничего не зачислено: деньги висят непознанным поступлением.
    expect(trancheOf(world, TRANCHE).facts.collectedAmount).toBeNull();

    // Комплаенс: третье лицо без родства — удержание, а не отказ и не пропуск.
    const assessment = assessPayer(
      {
        buyerDocument: BUYER.document,
        origin: {
          kind: 'external_transfer',
          payerDocument: THIRD_PARTY.document,
          senderNameMatch: compareNames(BUYER.names, THIRD_PARTY.names, { strongThresholdBp: 9_500 }),
        },
        relationship: { kind: 'unrelated_third_party' },
        evidence: [],
      },
      POLICY_VERSION,
      NOW,
    );
    expect(assessment.outcome).toBe('hold');
    expect(assessment.exceptionApplied).toBeNull();

    // Задача оператору поставлена автоматом, приоритет — по сумме транша.
    expect(world.tasks).toHaveLength(1);
    const ranked = prioritize(world.tasks, POLICY.queue, world.now);
    expect(ranked[0]?.task.kind).toBe('payer_hold');
    expect(ranked[0]?.task.trancheId).toBe(TRANCHE);

    // Снять блокировку может аналитик, а не оператор: полномочия `lift_block` в
    // роли оператора нет, и это проверяет тип, а не инструкция.
    expect(() => authorize(actor('operator-1', OPERATOR_ROLE), 'read_deal')).not.toThrow();
    expect(() => authorize(actor('analyst-1', ANALYST_ROLE), 'lift_block')).not.toThrow();

    // ⚠ Отмена сделки не проверяет, что её транши терминальны: у
    // `cancellation_requested` guard'а `g_no_live_tranche` нет, хотя у
    // `tranches_settled` и `tranches_refunded` он есть. Отчёт, расхождение 11.
    const facts = dealFactsOf(world, DEAL);
    expect(facts.trancheStatuses).toEqual(['release_blocked']);
    const wouldCancel = reduceDeal(dealState('ready'), { type: 'cancellation_requested' }, {
      dealId: DEAL,
      facts,
      now: world.now,
    });
    expect(wouldCancel.ok).toBe(true);

    // ⚠ Ловушка шва. Если приложение запишет `collectedAmount` на любое
    // `funds_received` — а различить два исхода одного события домен не
    // помогает ничем, — возврат из `release_blocked` заплатит покупателю
    // сумму, которой он не вносил. Инвариант неотрицательности клиентского
    // остатка ловит это на первом же шаге. Отчёт, расхождение 12.
    const trapped = patchFacts(world, TRANCHE, { collectedAmount: TINY });
    let trap = applyTrancheEvent(
      trapped,
      TRANCHE,
      { type: 'refund_requested', reason: 'compliance.payer_mismatch' },
      OPTIONS,
    ).world;
    trap = applyTrancheEvent(trap, TRANCHE, { type: 'refund_initiated' }, OPTIONS).world;
    expect(() =>
      applyTrancheEvent(trap, TRANCHE, { type: 'payout_result', outcome: 'settled' }, OPTIONS),
    ).toThrow(E2eInvariantError);

    // Разбор: деньги возвращаются отправителю, транш закрывается возвратом.
    // Проводки у возврата транша нет — на транш ничего не зачислялось.
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'refund_requested', reason: 'compliance.payer_mismatch' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refund_pending');
    world = applyTrancheEvent(world, TRANCHE, { type: 'refund_initiated' }, OPTIONS).world;
    const refunded = applyTrancheEvent(world, TRANCHE, { type: 'payout_result', outcome: 'settled' }, OPTIONS);
    world = refunded.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunded');

    // Возврат отправителю: непознанное поступление уходит тем же путём, каким
    // пришло. Обязательства перед покупателем не возникало ни на секунду.
    world = returnHeldPayment(world, TINY);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, { kind: 'suspense_unidentified' }, GEL).minor).toBe(0n);

    world = applyDealEvent(world, DEAL, { type: 'cancellation_requested' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('cancelled');
  });
});
