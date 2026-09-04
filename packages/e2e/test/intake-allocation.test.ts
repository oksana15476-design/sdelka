import { describe, expect, it } from 'vitest';
import { assessPayer, compareNames, payerKeyForDomain } from '@sdelka/compliance';
import { type Instant, instant } from '@sdelka/domain';
import {
  type AllocationInput,
  type ToleranceDisclosure,
  PROPOSED_INTAKE_POLICY,
  allocateIncoming,
  allocationBalances,
  combineRouting,
  effectiveTolerance,
  matchIncoming,
  matchReference,
  paymentReference,
  routeByMatch,
  routeByPayer,
} from '@sdelka/intake';
import { accountBalance, bankNominal, clientFreeAccount, clientLockedAccount, coverage } from '@sdelka/ledger';
import { money } from '@sdelka/money';
import {
  E2eInvariantError,
  absorbIncomingShortfall,
  applyDealEvent,
  applyTrancheEvent,
  fundIncomingShortfall,
  receiveExternalPayment,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '../src/index';
import { BUYER, DEAL_AMOUNT, GEL, NOW, POLICY_VERSION, SELLER, THIRD_PARTY } from './support/fixtures';
import { openDeal } from './support/open';

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на свободной части счёта: зачисление сделано отдельным событием. */
const ATTACHED = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });

const POLICY = PROPOSED_INTAKE_POLICY;
const HOUR_MS = 60 * 60 * 1000;
const AN_HOUR_AGO: Instant = instant(NOW - HOUR_MS);

/**
 * Факт раскрытия допуска. Его порождает приложение в момент выдачи инструкции на
 * перевод — здесь эту роль играет тест, и это единственная его роль: величину
 * считает политика, а не он.
 */
function disclosureFor(dealId: string, trancheId: string, disclosedAt: Instant): ToleranceDisclosure {
  const byPolicy = effectiveTolerance(DEAL_AMOUNT, POLICY, null, NOW).byPolicy;
  if (byPolicy.kind !== 'declared') throw new Error('unreachable: политика молчит о GEL');
  return {
    dealId,
    trancheId,
    requiredAmount: DEAL_AMOUNT,
    tolerance: byPolicy.amount,
    policyVersionId: POLICY.version,
    disclosedAt,
  };
}

function allocation(overrides: Partial<AllocationInput>): AllocationInput {
  return {
    required: DEAL_AMOUNT,
    freeBefore: money(GEL, 0n),
    incoming: money(GEL, 0n),
    tolerance: money(GEL, 0n),
    chargesBearer: 'shared',
    ...overrides,
  };
}

/**
 * Приём средств из конца в конец: разнесение поступления против транша.
 *
 * Приём — не тонкая прослойка перед `funds_received`. Между «деньги упали на
 * номинальный счёт» и «транш собран» стоят четыре решения, и каждое из них уже
 * ошибалось в проекте по-своему: сколько прощаем (допуск), кому это было
 * обещано (раскрытие), чья это недостача (отнесение расходов), и на какую
 * сделку это вообще относится (сопоставление). Здесь они проверяются вместе с
 * автоматом и учётом, а не поодиночке.
 *
 * Что этот файл **не** делает: не изобретает величин. Допуск приходит из
 * `PROPOSED_INTAKE_POLICY` и помечен там предложением, а не решением владельца
 * (`INTAKE.md` §11). Это безопасно ровно потому, что без факта раскрытия
 * действующий допуск равен нулю — что первый же сценарий и показывает.
 */
describe('приём средств', () => {
  it('не применяет допуск, о котором стороне не сказали', async () => {
    const DEAL = 'deal-intake-undisclosed';
    const TRANCHE = 'tranche-intake-undisclosed';
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = applyTrancheEvent(opened.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;

    // Недостача 50 ₾ — ровно та, которую политика прощать разрешает.
    const short = money(GEL, 19_995_000n);

    // --- Раскрытия нет ---
    const withoutDisclosure = effectiveTolerance(DEAL_AMOUNT, POLICY, null, NOW);
    expect(withoutDisclosure.amount.minor).toBe(0n);
    // Величина по политике при этом есть, и оператор её видит: «допуска нет» и
    // «допуск ноль» — разные факты, и вторая половина объясняет первую.
    expect(withoutDisclosure.byPolicy.kind).toBe('declared');

    const undisclosed = allocateIncoming(
      allocation({ incoming: short, tolerance: withoutDisclosure.amount }),
    );
    expect(undisclosed.kind).toBe('insufficient');
    expect(undisclosed.missing.minor).toBe(5_000n);

    // --- Раскрытие задним числом ---
    // A2 требует ноль случаев выхода за **объявленный** допуск, и объявить его
    // после платежа — это и есть выход за объявленный.
    const late = effectiveTolerance(
      DEAL_AMOUNT,
      POLICY,
      disclosureFor(DEAL, TRANCHE, instant(NOW + HOUR_MS)),
      NOW,
    );
    expect(late.amount.minor).toBe(0n);

    // --- Деньги при этом никуда не деваются ---
    world = receiveExternalPayment(world, opened.buyerKey, short);
    const refused = rejectTrancheEvent(world, TRANCHE, {
      type: 'funds_received',
      amount: short,
      sender: payerKeyForDomain(BUYER.document),
      reference: 'payment-undisclosed',
    });
    expect([...refused.failedGuards]).toEqual(['g_amount_sufficient']);
    expect(trancheStatusOf(world, TRANCHE)).toBe('collecting');
    // Отзывные и на своём месте: недоплата накапливается на счёте клиента, а не
    // на транше (`FUNCTIONAL.md` §4.3.2).
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(19_995_000n);
    expect(accountBalance(world.journal, clientLockedAccount(opened.buyerKey, DEAL, TRANCHE), GEL).minor).toBe(0n);
  });

  it('признаёт недостачу корреспондента отдельной величиной, а не молчанием', async () => {
    const DEAL = 'deal-intake-absorbed';
    const TRANCHE = 'tranche-intake-absorbed';
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = applyTrancheEvent(opened.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;

    const tolerance = effectiveTolerance(
      DEAL_AMOUNT,
      POLICY,
      disclosureFor(DEAL, TRANCHE, AN_HOUR_AGO),
      NOW,
    );
    expect(tolerance.amount.minor).toBe(5_000n);

    const short = money(GEL, 19_995_000n);

    // --- Причина недостачи решает, а не её размер ---
    // `OUR` — все расходы на отправителе, срезу взяться неоткуда: та же
    // недостача той же величины становится ошибкой клиента, и допуск её не
    // покрывает (`FUNCTIONAL.md` §4.3.2: различать «по реквизитам, а не по
    // сумме»).
    const senderPays = allocateIncoming(
      allocation({ incoming: short, tolerance: tolerance.amount, chargesBearer: 'sender_pays_all' }),
    );
    expect(senderPays.kind).toBe('insufficient');

    const plan = allocateIncoming(
      allocation({ incoming: short, tolerance: tolerance.amount, chargesBearer: 'shared' }),
    );
    expect(plan.kind).toBe('shortfall_absorbed');
    // Недостача — **отдельное поле**, а не слагаемое в сумме транша: до второй
    // записи транш не обеспечен, и это обязано быть видно.
    expect(plan.toTranche.minor).toBe(20_000_000n);
    expect(plan.shortfall.minor).toBe(5_000n);
    expect(plan.freeAfter.minor).toBe(0n);
    expect(allocationBalances(allocation({ incoming: short, tolerance: tolerance.amount }), plan)).toBe(true);

    // --- А теперь то, ради чего этот сценарий сквозной ---
    // Зачесть план как есть — то есть положить клиенту пришедшее, а траншу
    // объявить полную сумму — значит оплатить недостачу платформы деньгами
    // клиента. Отказ наступает **на том шаге, где сумма объявлена**: собранное
    // приложение держит само, и обеспеченность притязания учётом проверяется
    // на каждом шаге.
    const naive = receiveExternalPayment(world, opened.buyerKey, short);
    let violation: unknown = null;
    try {
      applyTrancheEvent(
        naive,
        TRANCHE,
        {
          type: 'funds_received',
          amount: plan.toTranche,
          sender: payerKeyForDomain(BUYER.document),
          reference: 'payment-absorbed',
        },
        ATTACHED,
      );
    } catch (error) {
      violation = error;
    }
    expect(violation).toBeInstanceOf(E2eInvariantError);
    expect((violation as E2eInvariantError).violations.map((item) => item.invariant)).toContain(
      'collected_not_backed',
    );
    expect(trancheStatusOf(naive, TRANCHE)).toBe('collecting');

    // --- Как это делается правильно: две записи, а не одна ---
    // Здесь стояло надгробие «конструктора нет в словаре». Конструкторы
    // появились (`absorbShortfall`, `fundShortfall`), и надгробие заменено тем,
    // ради чего стояло: недостача признаётся расходом **в момент поступления**,
    // обязательство перед клиентом доводится до полной суммы, — и на этом
    // первый момент кончается.
    let uncovered: unknown = null;
    try {
      absorbIncomingShortfall(world, opened.buyerKey, short, plan.shortfall);
    } catch (error) {
      uncovered = error;
    }
    // Ровно то, что обещает §3.1: «до второй записи транш не обеспечен, и это
    // видно в системе как расхождение, а не как норма». В сквозном мире
    // «видно» выражается единственным способом, который у него есть: шаг не
    // запечатывается, приём остановлен, и расхождение названо поимённо.
    expect(uncovered).toBeInstanceOf(E2eInvariantError);
    const uncoveredNames = (uncovered as E2eInvariantError).violations.map((item) => item.invariant);
    expect(uncoveredNames).toContain('funds_source_uncovered');
    expect(uncoveredNames).toContain('coverage_below_one');
    // И это **не** отрицательный остаток клиента: обязательство доведено до
    // полной суммы честно, не хватает денег под ним, а не денег у клиента.
    expect(uncoveredNames).not.toContain('negative_client_balance');

    // Второй момент — довнесение с операционного счёта, межбанковский перевод.
    // В этом мире операционный счёт пуст: платформа никогда ничего не
    // зарабатывала, и закрыть дыру ей нечем. Довнесение с пустого счёта
    // восстанавливает пофайловое обеспечение — и ловится отрицательным
    // остатком банковского счёта, то есть обещанием, за которым ничего нет.
    let promised: unknown = null;
    try {
      fundIncomingShortfall(world, opened.buyerKey, plan.shortfall);
    } catch (error) {
      promised = error;
    }
    expect(promised).toBeInstanceOf(E2eInvariantError);
    expect(
      (promised as E2eInvariantError).violations.map((item) => item.detail),
    ).toContain('ledger.invariant.negative_bank_balance');

    // Что из этого следует и кому. Недостачу закрывают **наши** деньги, а
    // единственный способ их появления в сквозном мире — заработанная
    // комиссия: операционного остатка платформы этот мир не заводит вовсе, и
    // взяться ему неоткуда. Пока это так, случай А исполним только в мире, где
    // хотя бы одна сделка уже расчитана. Владельцу: источник операционных
    // средств (взнос капитала) в плане счетов §3.1 не назван — а без него
    // «платформа доплачивает» держится на пустом счёте.
  });

  it('накапливает дробные платежи и применяет допуск один раз к итогу', async () => {
    const DEAL = 'deal-intake-instalments';
    const TRANCHE = 'tranche-intake-instalments';
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = applyTrancheEvent(opened.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;

    const tolerance = effectiveTolerance(
      DEAL_AMOUNT,
      POLICY,
      disclosureFor(DEAL, TRANCHE, AN_HOUR_AGO),
      NOW,
    ).amount;

    // Три платежа по трети, каждый на 5 000 тетри меньше своей трети. По
    // отдельности каждый укладывается в допуск; вместе они не укладываются.
    const parts = [money(GEL, 6_661_667n), money(GEL, 6_661_666n), money(GEL, 6_661_667n)];
    let free = money(GEL, 0n);
    for (const part of parts) {
      const input = allocation({ freeBefore: free, incoming: part, tolerance });
      const plan = allocateIncoming(input);
      // Дробный платёж не имеет отдельной ветки: это тот же расчёт с непустым
      // `freeBefore`. Именно поэтому допуск применяется **один раз к итогу**, а
      // не по разу на платёж: иначе три платежа дали бы тройное послабление,
      // которого никто никогда не объявлял.
      expect(plan.kind).toBe('insufficient');
      expect(allocationBalances(input, plan)).toBe(true);
      free = plan.freeAfter;
      world = receiveExternalPayment(world, opened.buyerKey, part);
    }
    // Накоплено 199 850 ₾ при допуске 50 ₾: суммарная недостача 150 ₾ — втрое
    // больше объявленного, и допуск её не закрывает.
    expect(free.minor).toBe(19_985_000n);

    // Транш всё это время в `collecting`: деньги клиента, отзывные.
    expect(trancheStatusOf(world, TRANCHE)).toBe('collecting');
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(19_985_000n);

    // --- Довнесение до полной суммы ---
    const rest = money(GEL, 15_000n);
    const closing = allocation({ freeBefore: free, incoming: rest, tolerance });
    const closingPlan = allocateIncoming(closing);
    expect(closingPlan.kind).toBe('exact');
    expect(closingPlan.toTranche.minor).toBe(20_000_000n);
    expect(closingPlan.freeAfter.minor).toBe(0n);
    expect(allocationBalances(closing, closingPlan)).toBe(true);

    world = receiveExternalPayment(world, opened.buyerKey, rest);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      {
        type: 'funds_received',
        amount: closingPlan.toTranche,
        sender: payerKeyForDomain(BUYER.document),
        reference: 'payment-instalment-4',
      },
      ATTACHED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('collected');
    world = applyDealEvent(world, DEAL, { type: 'funds_received' }, OPTIONS);
    world = applyTrancheEvent(world, TRANCHE, { type: 'reserve_requested' }, OPTIONS).world;

    // Четыре платежа — одно обязательство: файл транша покрывает требуемое, на
    // номинальном счёте ровно оно же, покрытие единица.
    expect(accountBalance(world.journal, clientLockedAccount(opened.buyerKey, DEAL, TRANCHE), GEL).minor).toBe(
      20_000_000n,
    );
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
    expect(coverage(world.journal).find((item) => item.currency === GEL)?.difference.minor).toBe(0n);
  });

  it('оставляет переплату отзывной сразу, а не после закрытия сделки', async () => {
    const DEAL = 'deal-intake-overpaid';
    const TRANCHE = 'tranche-intake-overpaid';
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = applyTrancheEvent(opened.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;

    const incoming = money(GEL, 20_500_000n);
    const input = allocation({ incoming, tolerance: money(GEL, 0n) });
    const plan = allocateIncoming(input);
    expect(plan.kind).toBe('overpayment');
    expect(plan.toTranche.minor).toBe(20_000_000n);
    // Излишек в свободной части **немедленно**: деньги, не попавшие под условие
    // расчёта, обязаны остаться отзывными (красная линия №7). `ROADMAP.md` И2.1
    // критерий 4 и `SCREENS.md` `M-08` до сих пор обещают обратное — «излишек
    // возвращается только после закрытия», — и подлежат правке владельцем
    // (`INTAKE.md` §9.1). Реализована редакция §4.3.2 как более поздняя и
    // помеченная как исправляющая.
    expect(plan.freeAfter.minor).toBe(500_000n);
    expect(allocationBalances(input, plan)).toBe(true);

    world = receiveExternalPayment(world, opened.buyerKey, incoming);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      {
        type: 'funds_received',
        amount: plan.toTranche,
        sender: payerKeyForDomain(BUYER.document),
        reference: 'payment-overpaid',
      },
      ATTACHED,
    ).world;
    world = applyDealEvent(world, DEAL, { type: 'funds_received' }, OPTIONS);
    world = applyTrancheEvent(world, TRANCHE, { type: 'reserve_requested' }, OPTIONS).world;

    // Запирается требуемое, а не пришедшее: излишек остаётся свободным даже
    // после резервирования, и именно на этом различии стоит экран «Мой счёт».
    expect(accountBalance(world.journal, clientLockedAccount(opened.buyerKey, DEAL, TRANCHE), GEL).minor).toBe(
      20_000_000n,
    );
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(500_000n);
    expect(coverage(world.journal).find((item) => item.currency === GEL)?.difference.minor).toBe(0n);
  });

  it('не зачисляет на сделку опознанный платёж, пришедший от постороннего', async () => {
    const DEAL = 'deal-intake-routing';
    const TRANCHE = 'tranche-intake-routing';

    // Референс безошибочный: сделку платёж называет сам.
    const reference = paymentReference({ dealCode: DEAL, trancheCode: 'T1' });
    const byReference = matchReference(reference, reference, POLICY);
    expect(byReference.degree).toBe('exact');

    const match = matchIncoming(
      [
        {
          dealId: DEAL,
          trancheId: TRANCHE,
          reference: byReference,
          amountFits: true,
          sourceAccountSeen: true,
          currencyMatches: true,
          senderName: null,
        },
      ],
      POLICY,
    );
    expect(match.outcome).toBe('auto_matched');
    expect(routeByMatch(match).route).toBe('to_client_account');

    // А плательщик — посторонний. Исход считает комплаенс, а не фикстура: ключ
    // личности, а не имя — латинизация грузинского необратима, и совпадение
    // имени не является достаточным основанием ни для чего.
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
    const byPayer = routeByPayer(assessment);
    expect(byPayer.route).toBe('to_suspense');

    // Сводный маршрут: удержание по плательщику сильнее любого сопоставления.
    // Опознание сделки не делает деньги пригодными к зачислению на неё — и это
    // единственный порядок, при котором безошибочный референс от постороннего
    // не открывает чужую сделку.
    const combined = combineRouting(routeByMatch(match), byPayer);
    expect(combined.route).toBe('to_suspense');
    expect(combined.queueTask).toBe('payer_hold');

    // И то же самое с другой стороны — в автомате: чужой платёж уводит транш в
    // блокировку, на сделку не зачисляясь ни при какой сумме (инвариант 19).
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = applyTrancheEvent(opened.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;
    world = applyTrancheEvent(
      world,
      TRANCHE,
      {
        type: 'funds_received',
        amount: DEAL_AMOUNT,
        sender: payerKeyForDomain(THIRD_PARTY.document),
        reference,
      },
      trancheOptions(POLICY_VERSION, { taskKind: 'payer_hold' }),
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_blocked');
    expect(accountBalance(world.journal, clientLockedAccount(opened.buyerKey, DEAL, TRANCHE), GEL).minor).toBe(0n);
    expect(trancheOf(world, TRANCHE).facts.collectedAmount).toBeNull();
  });
});
