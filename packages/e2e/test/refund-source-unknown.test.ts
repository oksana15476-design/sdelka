import { describe, expect, it } from 'vitest';
import { accountFingerprint, assessRefundDestination, payerKeyForDomain } from '@sdelka/compliance';
import { accountBalance, bankNominal, clientFreeAccount } from '@sdelka/ledger';
import {
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyTrancheEvent,
  patchFacts,
  receiveExternalPayment,
} from './support/acting';
import {
  BUYER,
  DEAL_AMOUNT,
  GEL,
  NOW,
  POLICY_VERSION,
  SELLER,
  THIRD_PARTY,
  fp,
} from './support/fixtures';
import { openDeal } from './support/open';

const OPTIONS = trancheOptions(POLICY_VERSION, { taskKind: 'source_of_funds' });
const ATTACHED = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const DEAL = 'deal-refund-blind';
const TRANCHE = 'tranche-refund-blind';

/**
 * Сценарий 15 — возврат, у которого нет счёта-источника.
 *
 * Красная линия №9: возврат только на счёт-источник, на имя плательщика. Из
 * этого следует неочевидное: **не всякий возврат можно исполнить**. Платёж мог
 * прийти так, что реквизитов отправителя у нас нет — взнос наличными в кассе
 * банка, перевод через корсчёт без раскрытия исходного счёта, платёж из
 * системы, которая отдаёт только имя.
 *
 * Автомат отвечает на это не отказом и не удержанием, а **третьей дверью**:
 * `refund_pending --refund_initiated--> release_blocked`. Возврат назначен,
 * исполнить его нельзя, разбирает человек — и всё это время деньги стоят
 * отзывными на счёте покупателя, а не уходят «куда-нибудь».
 *
 * Мимо `g_source_account_known` это ребро пройти нельзя: без него деньги ушли
 * бы на реквизиты, назначенные кем-то в момент разбора, — то есть ровно тем
 * способом, которым выводят чужие деньги.
 */
describe('возврат без счёта-источника', () => {
  it('уводит возврат в разбор, а не в банк, и продолжает его, когда источник установлен', async () => {
    const opened = await openDeal({
      dealId: DEAL,
      trancheId: TRANCHE,
      buyer: BUYER,
      seller: SELLER,
      sourceAccountKnown: false,
    });
    let world = applyTrancheEvent(opened.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;
    world = receiveExternalPayment(world, opened.buyerKey, DEAL_AMOUNT);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      {
        type: 'funds_received',
        amount: DEAL_AMOUNT,
        sender: payerKeyForDomain(BUYER.document),
        reference: 'payment-blind',
      },
      ATTACHED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('collected');
    expect(trancheOf(world, TRANCHE).facts.sourceAccountKnown).toBe(false);

    // Покупатель передумал: сделка отменяется, деньги надо вернуть.
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'revocation_requested', actor: 'buyer', reason: 'buyer.changed_mind' },
      ATTACHED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refund_pending');
    const entriesBefore = world.journal.entries.length;

    // --- Возврат назначен, но исполнить его нечем ---
    world = applyTrancheEvent(world, TRANCHE, { type: 'refund_initiated' }, ATTACHED).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_blocked');
    // Ни одной проводки: деньги никуда не отправлены.
    expect(world.journal.entries).toHaveLength(entriesBefore);
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(20_000_000n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
    // Разбирает человек, и задача у него в очереди.
    expect(world.tasks.filter((task) => task.trancheId === TRANCHE)).toHaveLength(1);

    // --- Пока источник неизвестен, реквизиты «по заявлению» не годятся ---
    // Комплаенс отвечает на тот же вопрос с другой стороны: счёт назначения
    // обязан совпасть со счётом-источником и с именем плательщика.
    const foreign = assessRefundDestination(
      {
        sourceAccount: accountFingerprint(fp(700)),
        sourceHolder: BUYER.document,
        requestedAccount: accountFingerprint(fp(701)),
        requestedHolder: THIRD_PARTY.document,
        sanctionsFrozen: false,
        evidence: [],
      },
      POLICY_VERSION,
      NOW,
    );
    expect(foreign.outcome).toBe('block');

    // --- Источник установлен: возврат идёт своим путём ---
    // Банк раскрыл исходный счёт по запросу; факт пришёл снаружи, как и все
    // остальные факты транша.
    world = patchFacts(world, TRANCHE, { sourceAccountKnown: true });
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'refund_requested', reason: 'buyer.changed_mind' },
      ATTACHED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refund_pending');
    world = applyTrancheEvent(world, TRANCHE, { type: 'refund_initiated' }, ATTACHED).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunding');
    world = applyTrancheEvent(world, TRANCHE, { type: 'payout_result', outcome: 'settled' }, ATTACHED).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunded');

    // Деньги ушли с номинального счёта, обязательства перед покупателем нет.
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(0n);
  });
});
