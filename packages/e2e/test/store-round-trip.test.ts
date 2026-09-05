import { describe, expect, it } from 'vitest';
import {
  WITHOUT_STORE,
  dealStatusOf,
  emptyWorld,
  invariantViolations,
  openWorld,
  restoreWorld,
  restoredViolations,
  stepResult,
  stepWorld,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import { refundIdempotencyKey } from '@sdelka/domain';
import { accountBalance, balanceByCurrency, bankNominal, bankOperating } from '@sdelka/ledger';
import { applyTrancheEvent, createDeal } from './support/acting';
import {
  BUYER,
  DEAL_AMOUNT,
  GEL,
  NOW,
  POLICY_VERSION,
  SELLER,
  THIRD_PARTY,
  conditionAct,
  partyRef,
} from './support/fixtures';
import {
  REFUND_SCOPE,
  collectedPath,
  newDeal,
  newTranche,
  payoutKeysOf,
  refundPath,
  settlementPath,
} from './support/store-path';
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
 * **Путь — возвратный** (красная линия №7: состояние по умолчанию при
 * бездействии есть возврат покупателю), и он же идёт против живого Postgres в
 * `test/int/store-round-trip.int.test.ts`. Сам сценарий здесь больше не живёт:
 * он вынесен в `support/store-path.ts` и один на оба прогона. Второй текст того
 * же пути сравнивал бы не хранилища, а два текста сценария.
 *
 * **Чего этот файл не доказывает.** Что то же самое проходит в Postgres:
 * реализация порта здесь — `memoryWorldStore`, и почему она не мок, написано у
 * неё же. Это доказывает интеграционный набор
 * (`pnpm --filter @sdelka/e2e test:int`), и расхождения, которые он вскрыл,
 * названы там же.
 */

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на свободной части счёта клиента: откат резерва их не зачисляет заново. */
const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const SCOPE = REFUND_SCOPE;
const DEAL = SCOPE.dealId;
const TRANCHE = SCOPE.trancheId;
const CHAIN = SCOPE.chainId;

/** Область имён расчётной ветви: тот же мир не годится, деньги идут иначе. */
const SETTLE_SCOPE = Object.freeze({
  ...REFUND_SCOPE,
  dealId: 'deal-store-settle',
  trancheId: 'tranche-store-settle',
  chainId: 'chain-store-settle',
});

/**
 * Второй мир: своя цепочка аудита, свои сделка и транш и **другой покупатель**.
 *
 * Другой покупатель здесь работает: столкновение на идентификаторе записи
 * журнала перестало бы быть повтором и стало бы подменой, то есть отказом
 * хранилища с именем, а не молчаливым `repeated`.
 */
const OTHER_SCOPE = Object.freeze({
  ...REFUND_SCOPE,
  dealId: 'deal-store-other',
  trancheId: 'tranche-store-other',
  chainId: 'chain-store-other',
  buyer: THIRD_PARTY,
});

describe('хранилище: расчёт получателю проходит через базу и поднимается из неё', () => {
  it('запись расчёта вместе с начислением комиссии ложится в базу целиком', async () => {
    const store = memoryWorldStore();
    const { world, log } = await settlementPath(store, SETTLE_SCOPE);
    const tranche = SETTLE_SCOPE.trancheId;

    expect(trancheStatusOf(world, tranche)).toBe('paid_out');
    expect(dealStatusOf(world, SETTLE_SCOPE.dealId)).toBe('settled');
    expect(invariantViolations(world)).toEqual([]);
    // Красная линия №2: комиссия не осталась на номинальном счёте.
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(300_000n);

    /*
     * 5 записей журнала учёта — зачисление, запирание, начисление комиссии,
     * расчёт получателю, получение комиссии на операционный счёт;
     * 19 записей журнала аудита — вся цепочка вместе с открытием;
     * 8 состояний сделки, 8 состояний транша, 2 состояния поручения.
     */
    const written = log.reduce((sum, item) => sum + item.outcome.written, 0);
    expect(world.journal.entries).toHaveLength(5);
    expect(world.chain.records).toHaveLength(19);
    expect(written).toBe(5 + 19 + 8 + 8 + 2);
    expect(store.committed).toBe(log.length);

    const restored = await restoreWorld(store, {
      chainId: SETTLE_SCOPE.chainId,
      deals: [{ dealId: SETTLE_SCOPE.dealId, trancheIds: [tranche] }],
    });
    expect(restoredViolations(restored)).toEqual([]);
    expect(restored.journal.entries).toEqual(world.journal.entries);
    expect(restored.chain).toEqual(world.chain);

    /*
     * Поручение расчёта в базу **ложится** — в отличие от возвратного: пакет
     * доказательств у него есть (`payout.evidence_bundle_id NOT NULL`, красная
     * линия №5 в схеме). Сумма — нетто получателя, а не брутто: комиссия ушла
     * платформе той же записью.
     */
    const payout = restored.deals[0]?.tranches[0]?.payouts[0];
    expect(payout?.state.leg).toBe('release');
    expect(payout?.state.status).toBe('settled');
    expect(payout?.amount.minor).toBe(19_700_000n);
    expect(payout?.evidenceBundleId).toBe(`evidence-${tranche}`);
  });
});

describe('хранилище: возврат покупателю проходит через базу и поднимается из неё', () => {
  it('шаг мира ложится в базу, а мир поднимается из неё с теми же инвариантами', async () => {
    const store = memoryWorldStore();
    const { world, log } = await refundPath(store, SCOPE);

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
    const { log } = await refundPath(store, SCOPE);
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
    const { world } = await refundPath(store2, SCOPE);
    const restored = await restoreWorld(store2, {
      chainId: CHAIN,
      deals: [{ dealId: DEAL, trancheIds: [TRANCHE] }],
    });
    // Поручение есть в мире и отсутствует в базе. Отсутствие названо.
    expect(payoutKeysOf(world, TRANCHE)).toEqual([refundIdempotencyKey(TRANCHE)]);
    expect(restored.deals[0]?.tranches[0]?.payouts).toEqual([]);
    expect(restored.missing.map((part) => part.reasonKey)).toContain('invariant.not_checkable');
    expect(restored.missing.map((part) => part.reasonKey)).toContain('port.no_listing');
  });

  it('мир без хранилища идёт тем же путём и приходит к тому же состоянию', async () => {
    const stored = await refundPath(memoryWorldStore(), SCOPE);
    const plain = await refundPath(WITHOUT_STORE, SCOPE);

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

/**
 * Два мира в одном хранилище.
 *
 * **Почему этого набора раньше не было и почему он нужен.** Каждый сценарий
 * выше берёт своё хранилище, и до живого Postgres дефект дожил именно поэтому:
 * идентификатор записи журнала учёта был счётчиком **мира**
 * (`entry-${seq}-${label}`), а счётчик начинается с нуля в каждом новом мире.
 * У карты в памяти на тест — своя, и встретиться двум мирам было негде. Таблица
 * в базе одна и вечная, и второй мир падал на `db.step.conflict` по
 * `ledger_entry` на первой же денежной записи, не дойдя ни до одного расчёта.
 *
 * Здесь хранилище **одно на два мира** — то же условие, что в живой базе, и
 * поэтому та же проверка стоит и в интеграционном наборе
 * (`test/int/store-round-trip.int.test.ts`). Идентификатор теперь несёт цепочку
 * (`app/src/ids.ts`), как всегда нёс идентификатор записи журнала аудита.
 */
describe('хранилище: два мира в одной базе', () => {
  it('второй мир проходит целиком и не сталкивается с первым', async () => {
    const store = memoryWorldStore();

    const first = await refundPath(store, SCOPE);
    const second = await refundPath(store, OTHER_SCOPE);

    // Оба мира дошли до конца: возврат покупателю в каждом.
    expect(trancheStatusOf(first.world, SCOPE.trancheId)).toBe('refunded');
    expect(trancheStatusOf(second.world, OTHER_SCOPE.trancheId)).toBe('refunded');
    expect(invariantViolations(first.world)).toEqual([]);
    expect(invariantViolations(second.world)).toEqual([]);
    // Ни один шаг не отказал и ни один не прошёл мимо базы.
    expect(store.committed).toBe(first.log.length + second.log.length);

    /*
     * Ни одной строки, опознанной повтором: миры разные, и записи у них разные.
     * Без этого утверждения тест прошёл бы и на идентификаторах, совпавших
     * дословно, — второй мир просто получил бы `repeated` на чужие строки.
     *
     * Считается только второй мир: первый пишет в пустое хранилище по
     * построению.
     */
    expect(second.log.every((item) => item.outcome.repeated === 0)).toBe(true);

    /*
     * Область имён — цепочка аудита, а не порядок вызова: у каждой записи
     * журнала учёта в идентификаторе стоит цепочка своего мира. Именно это и
     * делает два мира в одной таблице возможными.
     */
    const idsOf = (run: typeof first): readonly string[] =>
      run.world.journal.entries.map((entry) => entry.id);
    expect(idsOf(first).every((id) => id.startsWith(`${SCOPE.chainId}:`))).toBe(true);
    expect(idsOf(second).every((id) => id.startsWith(`${OTHER_SCOPE.chainId}:`))).toBe(true);
    const shared = idsOf(first).filter((id) => idsOf(second).includes(id));
    expect(shared).toEqual([]);

    /*
     * В хранилище лежат записи **обоих** миров, а поднимается ровно свой.
     *
     * Прежде `readJournal` охвата не имел вовсе, и поднятый журнал был общим:
     * покрытие клиентских средств у поднятого мира считалось по чужим деньгам,
     * а отбор «своих» строк делал каждый вызывающий сам. Теперь охват —
     * обязательный аргумент чтения (`app/src/store.ts`, `JournalScope`), и
     * подъём берёт его по своей цепочке.
     */
    const restored = await restoreWorld(store, {
      chainId: OTHER_SCOPE.chainId,
      deals: [{ dealId: OTHER_SCOPE.dealId, trancheIds: [OTHER_SCOPE.trancheId] }],
    });
    expect(restoredViolations(restored)).toEqual([]);
    // Журнал одного мира не видит проводок другого — ни одной, а не «в
    // основном своих»: сравнение полное и по значению.
    expect(restored.journal.entries).toEqual(second.world.journal.entries);
    expect(restored.journal.entries.filter((entry) => idsOf(first).includes(entry.id))).toEqual([]);
    // Цепочка аудита областью видимости обладала всегда: поднимается своя.
    expect(restored.chain).toEqual(second.world.chain);
    expect(restored.deals[0]?.deal.state.status).toBe('unwound');

    // Первый мир из хранилища никуда не делся: его журнал поднимается своим
    // охватом и целиком. Отбор — не потеря записей, а вопрос, кому они.
    const restoredFirst = await restoreWorld(store, {
      chainId: SCOPE.chainId,
      deals: [{ dealId: SCOPE.dealId, trancheIds: [SCOPE.trancheId] }],
    });
    expect(restoredFirst.journal.entries).toEqual(first.world.journal.entries);
    expect(restoredViolations(restoredFirst)).toEqual([]);

    /*
     * Сумма проводок в прочитанном охвате равна нулю по каждой валюте —
     * инвариант 1 (`CLAUDE.md`), проверенный не по одной записи, а по охвату
     * целиком: охват, отдающий половину парной записи, дал бы здесь остаток.
     */
    for (const scoped of [restored, restoredFirst]) {
      const postings = scoped.journal.entries.flatMap((entry) => entry.postings);
      for (const [, total] of balanceByCurrency(postings)) expect(total).toBe(0n);
    }
  });
});

describe('хранилище: отказ базы и повтор шага', () => {
  it('повтор шага не задваивает: те же строки опознаются повтором', async () => {
    const store = memoryWorldStore();
    let world = (await openWorld(store, emptyWorld({ now: NOW, chainId: CHAIN }))).world;
    world = (
      await stepWorld(store, world, newDeal(SCOPE))
    ).world;

    const step = newTranche(SCOPE);

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
      await stepWorld(store, world, newDeal(SCOPE))
    ).world;
    const before = world;

    const step = newTranche(SCOPE);

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
    const collected = await collectedPath(store, SCOPE);
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
          dealId: `${DEAL}-no-object`,
          conditionAct: conditionAct(partyRef(SCOPE.seller)),
          objectCadastralCode: '',
        }),
      ),
    ).rejects.toThrow('app.deal.object_cadastral_code_required');
    expect(store.committed).toBe(committed);
  });
});
