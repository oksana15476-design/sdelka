import { describe, expect, it } from 'vitest';
import {
  type StoreOption,
  type World,
  type Written,
  WITHOUT_STORE,
  advance,
  emptyWorld,
  invariantViolations,
  openWorld,
  restoreWorld,
  restoredViolations,
  stepResult,
  stepWorld,
  toClientKey,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
  dealStatusOf,
} from '@sdelka/app';
import { payerKeyForDomain } from '@sdelka/compliance';
import { refundIdempotencyKey } from '@sdelka/domain';
import { accountBalance, bankNominal, clientFreeAccount } from '@sdelka/ledger';
import {
  applyDealEvent,
  applyTrancheEvent,
  createDeal,
  createTranche,
  receiveExternalPayment,
  recordConditionAct,
} from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  BUYER,
  CADASTRAL_CODE,
  CONDITION_ACT_SOURCE,
  CREATED_ON,
  DEAL_AMOUNT,
  GEL,
  NOW,
  PLATFORM_FEE,
  POLICY_VERSION,
  SELLER,
  TARIFF_VERSION,
  beneficiaryFor,
  conditionAct,
  partyRef,
} from './support/fixtures';
import { STORE_ERROR, memoryWorldStore } from './support/memory-store';

/**
 * Круг замкнут: шаг мира → база → новый процесс → мир → те же инварианты.
 *
 * **Что здесь проверяется и чего до этого не проверял никто.** Порт хранилища
 * существовал без потребителя: `packages/db` сторожил схему, в которую в
 * рантайме никто не писал, а мир приложения жил в памяти и умирал вместе с
 * процессом. Здесь шаги идут **через** хранилище, и после них состояние
 * поднимается заново — как его поднял бы перезапущенный процесс.
 *
 * **Путь — возвратный, и это не выбор пути поудобнее.** Расчёт получателю идёт
 * двумя записями, вторая из которых — начисление комиссии с версией тарифного
 * плана, а колонки под неё в `sdelka.ledger_entry` нет: хранилище отвергает
 * такую запись ключом `db.entry.declaration_not_storable`
 * (`packages/db/src/store/journal.ts`). Сценарий, который бы это обошёл, скрыл
 * бы дыру схемы вместо того, чтобы её назвать. Возвратная ветвь — красная линия
 * №7 («состояние по умолчанию при бездействии — возврат покупателю») — ложится
 * целиком.
 *
 * **Чего сценарий не доказывает.** Что то же самое проходит в Postgres:
 * реализация порта здесь — `memoryWorldStore`, и почему она не мок, написано у
 * неё же. Схему сторожат интеграционные тесты `packages/db`, форму порта —
 * `store-port.test.ts`, а прогон этого сценария против кластера назван в отчёте
 * как несделанное.
 */

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на свободной части счёта клиента: откат резерва их не зачисляет заново. */
const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const DEAL = 'deal-store-refund';
const TRANCHE = 'tranche-store-refund';
const CHAIN = 'chain-store-refund';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Run {
  readonly world: World;
  readonly log: readonly Written[];
}

/**
 * Возвратный путь целиком, шаг за шагом.
 *
 * Каждый шаг проходит через `stepWorld`/`stepResult`: сначала полномочие,
 * автомат и `sealed`, потом транзакция. Один и тот же сценарий гоняется дважды
 * — с хранилищем и без (`WITHOUT_STORE`), — и это и есть проверка того, что
 * хранилище остаётся портом: миры обязаны совпасть до последнего поля.
 */
async function collectedPath(store: StoreOption): Promise<Run> {
  const log: Written[] = [];
  const record = (written: Written): World => {
    log.push(written);
    return written.world;
  };

  let world = emptyWorld({ now: NOW, chainId: CHAIN });
  world = record(await openWorld(store, world));

  world = record(
    await stepWorld(store, world, (now) =>
      createDeal(now, {
        dealId: DEAL,
        conditionAct: conditionAct(partyRef(SELLER)),
        objectCadastralCode: CADASTRAL_CODE,
      }),
    ),
  );

  world = record(
    await stepWorld(store, world, (now) =>
      createTranche(now, {
        dealId: DEAL,
        trancheId: TRANCHE,
        buyer: partyRef(BUYER),
        buyerPayerKey: payerKeyForDomain(BUYER.document),
        buyerNames: BUYER.names,
        requiredAmount: DEAL_AMOUNT,
        conditionAct: conditionAct(partyRef(SELLER)),
        createdOn: CREATED_ON,
        deductions: PLATFORM_FEE,
        tariffVersionId: TARIFF_VERSION,
        beneficiary: beneficiaryFor(SELLER, 500),
        sourceAccountKnown: true,
      }),
    ),
  );

  world = record(
    await stepWorld(store, world, (now) =>
      recordConditionAct(
        now,
        DEAL,
        TRANCHE,
        conditionAct(partyRef(SELLER)),
        CONDITION_ACT_SOURCE,
        POLICY_VERSION,
      ),
    ),
  );

  for (const event of ['parties_check_started', 'parties_verified', 'property_verified'] as const) {
    world = record(
      await stepWorld(store, world, (now) => applyDealEvent(now, DEAL, { type: event }, OPTIONS)),
    );
  }

  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, TRANCHE, { type: 'instructions_issued' }, OPTIONS),
    ),
  );

  world = record(
    await stepWorld(store, world, (now) =>
      receiveExternalPayment(now, toClientKey(BUYER.document), DEAL_AMOUNT),
    ),
  );

  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(
        now,
        TRANCHE,
        {
          type: 'funds_received',
          amount: DEAL_AMOUNT,
          sender: payerKeyForDomain(BUYER.document),
          reference: `payment-${TRANCHE}`,
        },
        ROLLBACK,
      ),
    ),
  );

  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(now, DEAL, { type: 'funds_received' }, OPTIONS),
    ),
  );
  return { world, log };
}

/**
 * Дальше — резерв, истёкший срок и возврат покупателю. Продолжение отдельной
 * функцией потому, что точка `collected` нужна ещё одному сценарию: из неё
 * расходятся два разных шага, и на них проверяется, что потерянный шаг
 * называется конфликтом, а не выигрывается последним записавшим.
 */
async function refundPath(store: StoreOption): Promise<Run> {
  const collected = await collectedPath(store);
  const log: Written[] = [...collected.log];
  const record = (written: Written): World => {
    log.push(written);
    return written.world;
  };
  let world = collected.world;

  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, TRANCHE, { type: 'reserve_requested' }, OPTIONS),
    ),
  );
  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(now, DEAL, { type: 'tranches_reserved' }, OPTIONS),
    ),
  );

  // Заявление подано стороной: без него сделка не выходит из `funded`, и
  // `condition_failed` отвергается таблицей переходов (`deal.ts`, §1.4).
  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(
        now,
        DEAL,
        { type: 'filing_registered', applicationId: 'app-store-refund', source: 'party_claim' },
        OPTIONS,
      ),
    ),
  );

  // Часы. Шаг мира, у которого в базе следа нет вовсе: время не состояние.
  world = record(await stepWorld(store, world, (now) => advance(now, DAY_MS)));

  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, TRANCHE, { type: 'reserve_expired' }, ROLLBACK),
    ),
  );
  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, TRANCHE, { type: 'deadline_reached' }, ROLLBACK),
    ),
  );
  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(now, DEAL, { type: 'condition_failed' }, OPTIONS),
    ),
  );
  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, TRANCHE, { type: 'refund_initiated' }, ROLLBACK),
    ),
  );
  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(
        now,
        TRANCHE,
        { type: 'payout_result', outcome: 'settled' },
        { ...ROLLBACK, payoutResponse: BANK_RESPONSE_SOURCE },
      ),
    ),
  );
  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(now, DEAL, { type: 'tranches_refunded' }, OPTIONS),
    ),
  );

  return { world, log };
}

describe('хранилище: возврат покупателю проходит через базу и поднимается из неё', () => {
  it('шаг мира ложится в базу, а мир поднимается из неё с теми же инвариантами', async () => {
    const store = memoryWorldStore();
    const { world, log } = await refundPath(store);

    expect(trancheStatusOf(world, TRANCHE)).toBe('refunded');
    expect(dealStatusOf(world, DEAL)).toBe('unwound');
    expect(invariantViolations(world)).toEqual([]);
    // Деньги ушли с номинального счёта, обязательства перед покупателем нет.
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(0n);

    // Каждый шаг — своя транзакция. Ни одного шага мимо базы.
    expect(store.committed).toBe(log.length);
    /*
     * Строки названы поимённо, а не «больше нуля»: последнее прошло бы и на
     * одной записи, а сценарий обязан положить в базу **всё**, что произвёл.
     *
     * 4 проводки — зачисление, запирание, распирание, уход возврата;
     * 19 записей журнала аудита — вся цепочка вместе с открытием;
     * 9 состояний сделки — заведение и восемь переходов;
     * 8 состояний транша — заведение и семь переходов.
     */
    const written = log.reduce((sum, item) => sum + item.outcome.written, 0);
    expect(world.journal.entries).toHaveLength(4);
    expect(world.chain.records).toHaveLength(19);
    expect(written).toBe(4 + 19 + 9 + 8);
    // Повторов при первом прогоне быть не может: каждая строка новая.
    expect(log.every((item) => item.outcome.repeated === 0)).toBe(true);

    /* --- Новый процесс: о мире в памяти он не знает ничего --- */
    const restored = await restoreWorld(store, {
      chainId: CHAIN,
      deals: [{ dealId: DEAL, trancheIds: [TRANCHE] }],
    });

    // Инварианты на поднятом — **та же функция**, что и на мире в памяти
    // (`surfaceViolations`), а не её похожая копия.
    expect(restoredViolations(restored)).toEqual([]);
    // Журнал учёта поднялся до последней записи и в том же порядке.
    expect(restored.journal.entries).toEqual(world.journal.entries);
    // Цепочка аудита цела и совпадает со своей памятью.
    expect(restored.chain).toEqual(world.chain);
    expect(restored.chain.records.length).toBe(world.chain.records.length);
    // Состояние автоматов — то же значение домена.
    const deal = restored.deals[0];
    expect(deal?.deal.state.status).toBe('unwound');
    expect(deal?.deal.buyer).toEqual(partyRef(BUYER));
    expect(deal?.deal.seller).toEqual(partyRef(SELLER));
    expect(deal?.tranches[0]?.snapshot.state).toEqual(trancheOf(world, TRANCHE).state);
    expect(deal?.tranches[0]?.snapshot.required).toEqual(DEAL_AMOUNT);
  });

  it('называет то, что в базу не легло, вместо того чтобы промолчать', async () => {
    const store = memoryWorldStore();
    const { log } = await refundPath(store);
    const reasons = log.flatMap((item) => item.unmapped.map((part) => part.reasonKey));

    /*
     * Сделка, у которой ещё нет транша, в базу не ложится: покупателя называет
     * транш, продавца — акт, а у схемы обе стороны `NOT NULL` и различны. Это
     * не обходится подстановкой: сделка в `draft` действительно ещё не знает,
     * между кем она.
     */
    expect(reasons).toContain('deal.parties_unknown');
    /*
     * Поручение на возврат в базу не легло вовсе, и это находка, а не
     * особенность сценария. `payout.evidence_bundle_id NOT NULL` — красная
     * линия №5 в схеме, — а у возврата покупателю пакета доказательств нет и
     * быть не обязано: возвращаются собственные деньги плательщика
     * (`flow.ts`, `enqueue_outbound_refund`). Следствие серьёзное: частичный
     * уникальный индекс `payout_one_active_per_tranche`, то есть инвариант 9 в
     * базе, возвратную ногу не сторожит — сторожить нечего.
     */
    expect(reasons).toContain('payout.evidence_bundle_missing');
    /*
     * Факты приложения — собранное, подписи, реквизиты, наблюдение — колонок не
     * имеют. Шаг, который меняет только их, в базе следа не оставляет.
     */
    expect(reasons).toContain('tranche.facts_not_storable');
    /* Сессии и следы «кто готовил» у порта метода не имеют вовсе. */
    expect(reasons).toContain('port.no_method');

    const store2 = memoryWorldStore();
    const { world } = await refundPath(store2);
    const restored = await restoreWorld(store2, {
      chainId: CHAIN,
      deals: [{ dealId: DEAL, trancheIds: [TRANCHE] }],
    });
    // Поручение есть в мире и отсутствует в базе. Отсутствие названо.
    expect(trancheOf(world, TRANCHE).payouts.map((payout) => payout.idempotencyKey)).toEqual([
      refundIdempotencyKey(TRANCHE),
    ]);
    expect(restored.deals[0]?.tranches[0]?.payouts).toEqual([]);
    expect(restored.missing.map((part) => part.reasonKey)).toContain('invariant.not_checkable');
    expect(restored.missing.map((part) => part.reasonKey)).toContain('port.no_listing');
  });

  it('мир без хранилища идёт тем же путём и приходит к тому же состоянию', async () => {
    const stored = await refundPath(memoryWorldStore());
    const plain = await refundPath(WITHOUT_STORE);

    // Хранилище — порт: мир от него не зависит ни одним полем.
    expect(plain.world.journal.entries).toEqual(stored.world.journal.entries);
    expect(plain.world.chain).toEqual(stored.world.chain);
    expect(trancheOf(plain.world, TRANCHE).state).toEqual(trancheOf(stored.world, TRANCHE).state);
    expect(invariantViolations(plain.world)).toEqual([]);
    // Несохранимые части называются одинаково в обоих режимах: сценарий без
    // базы видит тот же список, что и сценарий с базой.
    expect(plain.log.map((item) => item.unmapped)).toEqual(stored.log.map((item) => item.unmapped));
    expect(plain.log.every((item) => item.outcome.written === 0)).toBe(true);
  });
});

describe('хранилище: отказ базы и повтор шага', () => {
  it('повтор шага не задваивает: те же строки опознаются повтором', async () => {
    const store = memoryWorldStore();
    let world = (await openWorld(store, emptyWorld({ now: NOW, chainId: CHAIN }))).world;
    world = (
      await stepWorld(store, world, (now) =>
        createDeal(now, {
          dealId: DEAL,
          conditionAct: conditionAct(partyRef(SELLER)),
          objectCadastralCode: CADASTRAL_CODE,
        }),
      )
    ).world;

    const step = (now: World): World =>
      createTranche(now, {
        dealId: DEAL,
        trancheId: TRANCHE,
        buyer: partyRef(BUYER),
        buyerPayerKey: payerKeyForDomain(BUYER.document),
        buyerNames: BUYER.names,
        requiredAmount: DEAL_AMOUNT,
        conditionAct: conditionAct(partyRef(SELLER)),
        createdOn: CREATED_ON,
        deductions: PLATFORM_FEE,
        tariffVersionId: TARIFF_VERSION,
        beneficiary: beneficiaryFor(SELLER, 500),
        sourceAccountKnown: true,
      });

    const first = await stepWorld(store, world, step);
    expect(first.outcome.written).toBeGreaterThan(0);
    expect(first.outcome.repeated).toBe(0);

    // Тот же шаг из того же мира: идентификаторы записей и хеши цепочки
    // детерминированы, поэтому база видит **то же самое**, а не второе.
    const again = await stepWorld(store, world, step);
    expect(again.outcome.written).toBe(0);
    expect(again.outcome.repeated).toBe(first.outcome.written);
  });

  it('отказ базы — остановка шага: в базе не остаётся ни половины', async () => {
    const store = memoryWorldStore();
    let world = (await openWorld(store, emptyWorld({ now: NOW, chainId: CHAIN }))).world;
    world = (
      await stepWorld(store, world, (now) =>
        createDeal(now, {
          dealId: DEAL,
          conditionAct: conditionAct(partyRef(SELLER)),
          objectCadastralCode: CADASTRAL_CODE,
        }),
      )
    ).world;
    const before = world;

    const step = (now: World): World =>
      createTranche(now, {
        dealId: DEAL,
        trancheId: TRANCHE,
        buyer: partyRef(BUYER),
        buyerPayerKey: payerKeyForDomain(BUYER.document),
        buyerNames: BUYER.names,
        requiredAmount: DEAL_AMOUNT,
        conditionAct: conditionAct(partyRef(SELLER)),
        createdOn: CREATED_ON,
        deductions: PLATFORM_FEE,
        tariffVersionId: TARIFF_VERSION,
        beneficiary: beneficiaryFor(SELLER, 500),
        sourceAccountKnown: true,
      });

    store.failOnce(STORE_ERROR.conflict);
    const committedBefore = store.committed;
    await expect(stepWorld(store, before, step)).rejects.toMatchObject({
      code: STORE_ERROR.conflict,
    });
    // Транзакция не доехала: ни сделки, ни транша, ни записи журнала аудита.
    expect(store.committed).toBe(committedBefore);
    const empty = await restoreWorld(store, {
      chainId: CHAIN,
      deals: [{ dealId: DEAL, trancheIds: [TRANCHE] }],
    });
    // Сделки в базе нет вовсе: до транша её стороны неизвестны, и первым
    // шагом, который её кладёт, был бы как раз этот — тот, что отказал.
    expect(empty.deals).toEqual([]);

    // Повтор после сбоя проходит начисто: строк от неудавшегося шага не
    // осталось, поэтому это первая запись, а не вторая.
    const retried = await stepWorld(store, before, step);
    expect(retried.outcome.repeated).toBe(0);
    expect(retried.outcome.written).toBeGreaterThan(0);
    const restored = await restoreWorld(store, {
      chainId: CHAIN,
      deals: [{ dealId: DEAL, trancheIds: [TRANCHE] }],
    });
    expect(restored.deals[0]?.tranches[0]?.snapshot.trancheId).toBe(TRANCHE);
    expect(restoredViolations(restored)).toEqual([]);
  });

  it('чужой шаг не затирается молча: разошедшееся состояние — отказ с именем', async () => {
    const store = memoryWorldStore();
    const collected = await collectedPath(store);
    const world = collected.world;

    // Первый шаг из `collected`: резерв. Он ложится.
    const reserved = await stepResult(store, world, (now) =>
      applyTrancheEvent(now, TRANCHE, { type: 'reserve_requested' }, OPTIONS),
    );
    expect(trancheStatusOf(reserved.world, TRANCHE)).toBe('reserved');

    /*
     * Второй шаг из **того же** мира: срок истёк, транш идёт в возврат. В
     * памяти он проходит — мир тот, из которого он делается, — а в базе лежит
     * уже другое состояние. Слепой `UPDATE` выиграл бы последним записавшим и
     * потерял бы резерв молча; сверка «из чего уходим» превращает это в отказ с
     * именем и с обеими сторонами расхождения в подробностях.
     */
    await expect(
      stepResult(store, world, (now) =>
        applyTrancheEvent(now, TRANCHE, { type: 'deadline_reached' }, ROLLBACK),
      ),
    ).rejects.toMatchObject({
      code: STORE_ERROR.stateConflict,
      details: { relation: 'tranche', expected: 'refund_pending', actual: 'reserved' },
    });

    // В базе остался резерв, а не половина второго шага.
    const restored = await restoreWorld(store, {
      chainId: CHAIN,
      deals: [{ dealId: DEAL, trancheIds: [TRANCHE] }],
    });
    expect(restored.deals[0]?.tranches[0]?.snapshot.state.status).toBe('reserved');
    expect(restoredViolations(restored)).toEqual([]);
  });

  it('нарушение инварианта останавливает шаг **до** базы', async () => {
    const store = memoryWorldStore();
    const world = (await openWorld(store, emptyWorld({ now: NOW, chainId: CHAIN }))).world;
    const committed = store.committed;
    // Шаг, который не запечатывается: сделка без объекта. База при этом не
    // открывает транзакции вовсе — писать нечего, пока шаг не прошёл `sealed`.
    await expect(
      stepWorld(store, world, (now) =>
        createDeal(now, {
          dealId: 'deal-no-object',
          conditionAct: conditionAct(partyRef(SELLER)),
          objectCadastralCode: '',
        }),
      ),
    ).rejects.toThrow('app.deal.object_cadastral_code_required');
    expect(store.committed).toBe(committed);
  });
});
