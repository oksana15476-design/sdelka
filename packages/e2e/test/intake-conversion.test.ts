import { describe, expect, it } from 'vitest';
import { payerKeyForDomain } from '@sdelka/compliance';
import { type Instant, instant } from '@sdelka/domain';
import {
  type ClientConfirmation,
  PROPOSED_INTAKE_POLICY,
  decideConversion,
  disclosedMarkupBp,
  marketDriftBp,
  quote,
  quoteStatus,
} from '@sdelka/intake';
import { accountBalance, bankNominal, bankOperating, clientFreeAccount, coverage } from '@sdelka/ledger';
import { money, rational } from '@sdelka/money';
import {
  rejectTrancheEvent,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyTrancheEvent,
  convertBalance,
  receiveExternalPayment,
} from './support/acting';
import {
  BUYER,
  CREATED_ON,
  DEAL_AMOUNT,
  DEAL_AMOUNT_USD,
  FX_RATES,
  GEL,
  NOW,
  POLICY_VERSION,
  SELLER,
  USD,
} from './support/fixtures';
import { openDeal } from './support/open';

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на свободной части счёта: конвертация — отдельное событие. */
const ATTACHED = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });

const POLICY = PROPOSED_INTAKE_POLICY;
const DEAL = 'deal-fx-quote';
const TRANCHE = 'tranche-fx-quote';

/** Рынок ушёл вверх на 7 тетри за доллар от эталонных 2,55 — это 274 б. п. */
const MARKET_MOVED = rational(262n, 100n);

/**
 * Наблюдённый рынок — голая дробь: у котировки и у наблюдения `@sdelka/intake`
 * сравнивает **множители** одной и той же пары, а пару держит сам курс
 * (`FX_RATES.reference.base`/`.quote`). Отсюда `.value` на границе с котировкой.
 */
const REFERENCE_RATE = FX_RATES.reference.value;

/**
 * Сценарий — конвертация с сорванной котировкой.
 *
 * Разрыв, ради которого он написан, лежит между двумя обещаниями: экран
 * показывает клиенту сумму в лари, а деньги приходят в долларах, и между
 * показом и приходом рынок движется. `FUNCTIONAL.md` §4.5 и `CORE.md` Ф5
 * требуют показывать три курса и наценку и запрещают молчаливый пересчёт —
 * согласие, данное на один курс, не переносится на другой.
 *
 * Что проверяется сквозным контуром, а не в пакете: пока котировка не тверда и
 * не подтверждена **именно она**, в журнале не появляется ни одной записи, а
 * автомат транша продолжает считать деньги «не теми». Валюта здесь не «мало» —
 * это закрытый отказ, тот же, что у `g_amount_sufficient` на чужой валюте.
 */
describe('конвертация с сорванной котировкой', () => {
  it('не двигает ни тетри, пока котировка не тверда и не подтверждена', async () => {
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = applyTrancheEvent(opened.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;

    // Деньги пришли в долларах и легли на свободную часть счёта клиента в своей
    // валюте: зачисление и конвертация — разные события (`INTAKE.md` §4.2).
    world = receiveExternalPayment(world, opened.buyerKey, DEAL_AMOUNT_USD);
    const afterArrival = world.journal.entries.length;
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), USD).minor).toBe(8_000_000n);
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(0n);

    const first = quote(
      {
        quoteId: 'quote-1',
        source: DEAL_AMOUNT_USD,
        targetCurrency: GEL,
        rates: FX_RATES,
        asOf: CREATED_ON,
        issuedAt: NOW,
      },
      POLICY,
    );
    // Наценка раскрывается стороне вместе с тремя курсами и **не является** ни
    // спредом в деньгах, ни учётной курсовой разницей: это доля, и складывать
    // её с деньгами нечем (И2.3).
    expect(disclosedMarkupBp(FX_RATES)).toBeGreaterThan(0);

    // --- Рынок ушёл ---
    expect(marketDriftBp(REFERENCE_RATE, MARKET_MOVED)).toBeGreaterThanOrEqual(
      POLICY.quote.driftThreshold.valueBp,
    );
    const voided = quoteStatus(first, MARKET_MOVED, NOW);
    // Аннулирование проверяется раньше истечения: срок ещё не вышел, а причина
    // уже другая, и клиенту показывается существо дела, а не часы.
    expect(voided.status).toBe('voided_by_market_move');
    expect(NOW).toBeLessThan(voided.expiresAt);

    const confirmationForFirst: ClientConfirmation = {
      quoteId: 'quote-1',
      confirmedAt: NOW,
      partyId: BUYER.partyId,
    };
    const refused = decideConversion(first, MARKET_MOVED, confirmationForFirst, NOW, 'trunc');
    expect(refused.allowed).toBe(false);
    expect(refused.converted).toBeNull();

    // Ни одной записи: отказ конвертации — это отсутствие движения, а не
    // движение с откатом.
    expect(world.journal.entries).toHaveLength(afterArrival);
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(0n);

    // Транш при этом стоит в `collecting`, и полная сумма в долларах его не
    // открывает: другая валюта — не «мало», а «не те деньги».
    const wrongCurrency = rejectTrancheEvent(world, TRANCHE, {
      type: 'funds_received',
      amount: DEAL_AMOUNT_USD,
      sender: payerKeyForDomain(BUYER.document),
      reference: 'payment-usd',
    });
    expect([...wrongCurrency.failedGuards]).toEqual(['g_amount_sufficient']);
    expect(trancheStatusOf(world, TRANCHE)).toBe('collecting');

    // --- Новая котировка. Согласие на прежнюю к ней не относится ---
    const later: Instant = instant(NOW + 10 * 60 * 1000);
    const second = quote(
      {
        quoteId: 'quote-2',
        source: DEAL_AMOUNT_USD,
        targetCurrency: GEL,
        rates: FX_RATES,
        asOf: CREATED_ON,
        issuedAt: later,
      },
      POLICY,
    );
    const staleConsent = decideConversion(second, REFERENCE_RATE, confirmationForFirst, later, 'trunc');
    // Ровно тот молчаливый пересчёт, который §4.5 называет прямым путём к спору:
    // согласие «вообще» позволило бы применить прежний ответ к новому курсу.
    expect(staleConsent.allowed).toBe(false);
    expect(staleConsent.status).toBe('firm');

    const decision = decideConversion(
      second,
      REFERENCE_RATE,
      { quoteId: 'quote-2', confirmedAt: later, partyId: BUYER.partyId },
      later,
      'trunc',
    );
    expect(decision.allowed).toBe(true);
    expect(decision.converted?.target.minor).toBe(20_000_000n);

    // --- Только теперь деньги двигаются ---
    // Целевой валюты в аргументах нет: её несёт курс. И это **три шага мира**,
    // а не один: между ними деньги клиента лежат на `fx:settlement:{k}` — у
    // валютного контрагента, — и каждый промежуток обязан проходить инварианты.
    // Ключ конверсии обязателен: без него позиции разных обменов нетятся в
    // общем пуле, и «сколько нам не поставили по этому обмену» перестаёт быть
    // величиной.
    const converted = convertBalance(
      world,
      opened.buyerKey,
      'fx-intake-1',
      DEAL_AMOUNT_USD,
      FX_RATES,
      CREATED_ON,
    );
    world = converted.world;
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), USD).minor).toBe(0n);
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(20_000_000n);
    // Наш спред ушёл на операционный счёт в тот же момент, а не осел на
    // номинальном: чужой счёт не место для наших денег (красная линия №2).
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(converted.spread.amount.minor);
    expect(converted.spread.amount.minor).toBeGreaterThan(0n);

    world = applyTrancheEvent(
      world,
      TRANCHE,
      {
        type: 'funds_received',
        amount: DEAL_AMOUNT,
        sender: payerKeyForDomain(BUYER.document),
        reference: 'payment-converted',
      },
      ATTACHED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('collected');

    // Покрытие клиентских средств равно единице по **обеим** валютам: доллары
    // ушли целиком, лари пришли целиком, и на номинальном счёте не осталось ни
    // тетри нашего дохода.
    expect(accountBalance(world.journal, bankNominal(USD), USD).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
    for (const currency of [GEL, USD]) {
      expect(coverage(world.journal).find((item) => item.currency === currency)?.difference.minor ?? 0n).toBe(
        0n,
      );
    }
  });
});
