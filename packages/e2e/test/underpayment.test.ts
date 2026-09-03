import { describe, expect, it } from 'vitest';
import { payerKeyForDomain } from '@sdelka/compliance';
import { accountBalance, bankNominal, clientFreeAccount, clientLockedAccount, coverage } from '@sdelka/ledger';
import { money } from '@sdelka/money';
import {
  advance,
  applyTrancheEvent,
  receiveExternalPayment,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '../src/index';
import {
  BUYER,
  DAY_MS,
  DEAL_AMOUNT,
  DEAL_AMOUNT_USD,
  GEL,
  POLICY_VERSION,
  SELLER,
} from './support/fixtures';
import { openDeal } from './support/open';

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на свободной части счёта: зачисление сделано отдельным событием. */
const ATTACHED = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const DEAL = 'deal-underpaid';
const TRANCHE = 'tranche-underpaid';

/** 199 000 ₾ вместо 200 000: недоплата сверх допуска (`FUNCTIONAL.md` §4.3.2). */
const SHORT = money(GEL, 19_900_000n);
/** Доплата ровно до требуемой суммы. */
const TOP_UP = money(GEL, 100_000n);

/**
 * Сценарий 11 — покупатель недоплатил.
 *
 * `g_amount_sufficient` в жизни срабатывает не на выдуманной сумме, а на самом
 * частом происшествии приёма средств: перевели меньше, чем нужно. Комиссия
 * банка-отправителя, ошибка в сумме, платёж двумя частями — деньги пришли, но
 * условие расчёта они не покрывают.
 *
 * Важно, что при этом происходит с деньгами. Они **не отвергаются**: чужой
 * перевод уже у нас, и вернуть его молча — тоже распоряжение чужими деньгами.
 * Они лежат в свободной части счёта покупателя, отзывные (красная линия №7), а
 * транш остаётся в `collecting` — то есть ждёт доплаты, а не считается
 * оплаченным. Ровно это §4.3.2 и предписывает: недоплата накапливается на
 * счёте клиента, а не на транше.
 */
describe('недоплата', () => {
  it('не открывает транш неполной суммой, оставляет деньги отзывными и принимает доплату', async () => {
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = applyTrancheEvent(opened.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('collecting');

    // Деньги пришли и зачислены на счёт клиента: это отдельное событие от
    // привязки к сделке (И12.1), и оно происходит независимо от того, хватило
    // ли суммы.
    world = receiveExternalPayment(world, opened.buyerKey, SHORT);
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(19_900_000n);

    // --- Транш неполной суммой не открывается ---
    const short = rejectTrancheEvent(world, TRANCHE, {
      type: 'funds_received',
      amount: SHORT,
      sender: payerKeyForDomain(BUYER.document),
      reference: 'payment-short',
    });
    // Отправитель тот самый — отказ вызван только суммой. Ребро на удержание
    // (`¬g_payer_matches`) при этом тоже не проходит, поэтому переход
    // отвергается целиком, а не уводит транш в блокировку.
    expect([...short.failedGuards]).toEqual(['g_amount_sufficient']);
    expect(trancheStatusOf(world, TRANCHE)).toBe('collecting');
    expect(trancheOf(world, TRANCHE).facts.collectedAmount).toBeNull();
    // Файл транша пуст: за сделкой не стоит ни тетри.
    expect(accountBalance(world.journal, clientLockedAccount(opened.buyerKey, DEAL, TRANCHE), GEL).minor).toBe(0n);

    // --- Полная сумма в другой валюте — это не «мало», а «не те деньги» ---
    // Отказ такой же закрытый: пересчёт по курсу — отдельное событие, и
    // подставлять его в сравнение сумм значит решать за клиента, по какому
    // курсу считать его платёж.
    const wrongCurrency = rejectTrancheEvent(world, TRANCHE, {
      type: 'funds_received',
      amount: DEAL_AMOUNT_USD,
      sender: payerKeyForDomain(BUYER.document),
      reference: 'payment-usd',
    });
    expect([...wrongCurrency.failedGuards]).toEqual(['g_amount_sufficient']);

    // --- Время идёт: недоплаченный транш уходит в возврат по дедлайну ---
    // Проверяется на копии мира: основной сценарий продолжается доплатой.
    const expiring = advance(world, DAY_MS);
    const expired = applyTrancheEvent(expiring, TRANCHE, { type: 'deadline_reached' }, ATTACHED).world;
    expect(trancheStatusOf(expired, TRANCHE)).toBe('refund_pending');
    // Проводок у этого возврата нет вовсе: на транш ничего не зачислялось, и
    // деньги как лежали в свободной части счёта покупателя, так и лежат.
    expect(expired.journal.entries).toHaveLength(world.journal.entries.length);
    expect(accountBalance(expired.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(19_900_000n);

    // --- Доплата: та же дверь открывается полной суммой ---
    world = receiveExternalPayment(world, opened.buyerKey, TOP_UP);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      {
        type: 'funds_received',
        amount: DEAL_AMOUNT,
        sender: payerKeyForDomain(BUYER.document),
        reference: 'payment-topped-up',
      },
      ATTACHED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('collected');
    expect(trancheOf(world, TRANCHE).facts.collectedAmount?.minor).toBe(20_000_000n);
    // Два платежа — одно обязательство: на номинальном счёте ровно требуемая
    // сумма, покрытие единица.
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
    expect(coverage(world.journal).find((item) => item.currency === GEL)?.difference.minor).toBe(0n);
  });
});
