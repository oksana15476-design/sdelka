import { describe, expect, it } from 'vitest';
import { type ConditionAct, instant } from '@sdelka/domain';
import { accountBalance, clientFreeAccount } from '@sdelka/ledger';
import { STAFF } from './support/actors';
import {
  recipientOf,
  rejectTrancheEvent,
  toClientKey,
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
  BUYER,
  DAY_MS,
  GEL,
  NOW,
  POLICY_VERSION,
  SELLER,
  TWO_ROLE,
  conditionAct,
  partyRef,
} from './support/fixtures';
import { openDeal } from './support/open';
import { toCollected, toReleasePending } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);
const SETTLED = trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE });

/**
 * Сценарий 16 — акт получателя об условии.
 *
 * `g_condition_agreed` стоит на самой первой двери всей конструкции: выдаче
 * инструкций на оплату. Причина не в порядке шагов, а в статье 27(2) — она
 * держится на том, что обстоятельство определил **получатель**. Без записанного
 * акта его воли у отложенного платежа нет основания, есть только наше
 * утверждение, что мы так решили; а условие, зависящее от усмотрения площадки,
 * делает сделку ничтожной целиком (красная линия №6).
 *
 * Поэтому отказ здесь закрытый и стоит **до денег**: принять средства и потом
 * выяснить, что основания не было, — это принять чужие деньги ни на чём.
 *
 * Вторая половина сценария — `g_amendment_accepted_by_both`. После внесения
 * средств условие меняется единственным путём: новой редакцией, принятой
 * обеими сторонами. И вместе с редакцией меняется получатель расчёта — потому
 * что получателя называет акт, и второго места, откуда его взять, нет.
 */
describe('акт получателя об условии', () => {
  it('не открывает приём средств без годного акта', async () => {
    const DEAL = 'deal-no-act';
    const TRANCHE = 'tranche-no-act';
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });

    // --- Акта нет вовсе ---
    const withoutAct = patchFacts(opened.world, TRANCHE, { conditionAct: null });
    expect([...rejectTrancheEvent(withoutAct, TRANCHE, { type: 'instructions_issued' }).failedGuards]).toEqual([
      'g_condition_agreed',
    ]);

    // --- Акт есть, но получателем в нём назван сам покупатель ---
    // Условие, которое получатель определил сам себе, будучи покупателем,
    // зависит только от воли одной стороны. Учёт отвергнет такой расчёт своим
    // `settlementSelfDealing`, но к тому моменту деньги уже приняты —
    // отказывать надо здесь, на входе (§2.1, красная линия №6).
    const selfDealing = patchFacts(opened.world, TRANCHE, {
      conditionAct: conditionAct(partyRef(BUYER)),
    });
    expect([...rejectTrancheEvent(selfDealing, TRANCHE, { type: 'instructions_issued' }).failedGuards]).toEqual([
      'g_condition_agreed',
    ]);

    // --- Акт датирован будущим ---
    // Он не мог быть совершён позже момента, в который на него ссылаются.
    const fromTheFuture: ConditionAct = {
      ...conditionAct(),
      agreedAt: instant(NOW + DAY_MS),
    };
    const future = patchFacts(opened.world, TRANCHE, { conditionAct: fromTheFuture });
    expect([...rejectTrancheEvent(future, TRANCHE, { type: 'instructions_issued' }).failedGuards]).toEqual([
      'g_condition_agreed',
    ]);

    // --- Акт назначает условие, помеченное в §8 как [открыто] ---
    // `registration_preliminary` не подтверждён как основание расчёта, и акт с
    // ним не принимается: иначе непроверенное условие растворилось бы в
    // конфигурации.
    const unconfirmed = patchFacts(opened.world, TRANCHE, {
      conditionAct: { ...conditionAct(), conditionType: 'registration_preliminary' },
    });
    expect([...rejectTrancheEvent(unconfirmed, TRANCHE, { type: 'instructions_issued' }).failedGuards]).toEqual([
      'g_condition_agreed',
    ]);

    // --- Годный акт: приём средств открывается ---
    const world = applyTrancheEvent(opened.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('collecting');
  });

  it('меняет условие только новой редакцией, принятой обеими сторонами, и ведёт расчёт за ней', async () => {
    const DEAL = 'deal-amended';
    const TRANCHE = 'tranche-amended';

    const collected = await toCollected({ dealId: DEAL, trancheId: TRANCHE });
    let world = collected.world;
    // Пока деньги приняты под старую редакцию, получатель расчёта — продавец.
    expect(recipientOf(trancheOf(world, TRANCHE))).toBe(collected.sellerKey);

    // Новая редакция: получателем становится другое лицо — так бывает при
    // перемене лиц в обязательстве, и именно поэтому редакцию обязаны принять
    // обе стороны, а не одна.
    const amended: ConditionAct = {
      ...conditionAct(partyRef(TWO_ROLE)),
      conditionTextVersion: 'condition.registration_transfer.v2',
    };

    // --- Приняла только одна сторона ---
    const onlyRecipient = rejectTrancheEvent(world, TRANCHE, {
      type: 'condition_act_amended',
      act: amended,
      acceptedBy: [TWO_ROLE.partyId],
    });
    expect([...onlyRecipient.failedGuards]).toEqual(['g_amendment_accepted_by_both']);

    const onlyBuyer = rejectTrancheEvent(world, TRANCHE, {
      type: 'condition_act_amended',
      act: amended,
      acceptedBy: [BUYER.partyId],
    });
    expect([...onlyBuyer.failedGuards]).toEqual(['g_amendment_accepted_by_both']);

    // --- Приняли обе, но новым получателем назначен покупатель ---
    // «Обе стороны» — это покупатель и получатель, а не два любых подписанта;
    // и одно лицо по обе стороны — отказ, а не предупреждение.
    const toSelf = rejectTrancheEvent(world, TRANCHE, {
      type: 'condition_act_amended',
      act: conditionAct(partyRef(BUYER)),
      acceptedBy: [BUYER.partyId, SELLER.partyId],
    });
    expect([...toSelf.failedGuards]).toContain('g_amendment_accepted_by_both');

    // Ни одна из отвергнутых попыток акта не сдвинула: получатель прежний.
    expect(recipientOf(trancheOf(world, TRANCHE))).toBe(collected.sellerKey);

    // --- Приняли обе стороны: редакция перепривязана ---
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'condition_act_amended', act: amended, acceptedBy: [BUYER.partyId, TWO_ROLE.partyId] },
      OPTIONS,
    ).world;
    // Статус, дедлайн и время входа не менялись: изменение условия — не переход.
    expect(trancheStatusOf(world, TRANCHE)).toBe('collected');
    // А получатель расчёта пошёл за актом, потому что второго места, откуда его
    // взять, не существует.
    expect(recipientOf(trancheOf(world, TRANCHE))).toBe(toClientKey(TWO_ROLE.document));
    expect(recipientOf(trancheOf(world, TRANCHE))).not.toBe(collected.sellerKey);
  });

  it('доводит расчёт до того, кого назвал акт, и ни до кого другого', async () => {
    const DEAL = 'deal-act-recipient';
    const TRANCHE = 'tranche-act-recipient';

    const pending = await toReleasePending({ dealId: DEAL, trancheId: TRANCHE });
    let world = approve(pending.world, TRANCHE, STAFF.controller);
    world = approve(world, TRANCHE, STAFF.head);
    world = applyTrancheEvent(world, TRANCHE, { type: 'release_authorized' }, OPTIONS).world;
    world = applyTrancheEvent(world, TRANCHE, { type: 'payout_result', outcome: 'settled' }, SETTLED).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paid_out');

    // Запись расчёта называет получателем ровно того, кого назвал акт, и это
    // теперь **факт журнала**, а не намерение приложения.
    const settlement = world.journal.entries.find((entry) => entry.memoKey === 'ledger.entry.tranche_settled');
    expect(settlement?.settles?.recipient).toBe(pending.sellerKey);
    expect(settlement?.settles?.payer).toBe(pending.buyerKey);
    expect(settlement?.settles?.deal).toEqual({ dealId: DEAL, trancheId: TRANCHE });
    // Деньги за вычетом комиссии — у него, и ни у кого больше.
    expect(accountBalance(world.journal, clientFreeAccount(pending.sellerKey), GEL).minor).toBe(19_700_000n);
    expect(accountBalance(world.journal, clientFreeAccount(toClientKey(TWO_ROLE.document)), GEL).minor).toBe(0n);
  });
});
