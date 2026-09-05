import { expect, it } from 'vitest';
import {
  type Run,
  REFUND_SCOPE,
  collectedPath,
  newDeal,
  newTranche,
  openPath,
  payoutKeysOf,
  refundPath,
  settlementPath,
} from '../support/store-path';
import {
  type World,
  type WorldStore,
  dealStatusOf,
  restoreWorld,
  restoredViolations,
  stepResult,
  stepWorld,
  toClientKey,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import { DbErrorCode, pgWorldStore } from '@sdelka/db';
import { payoutIdempotencyKey, refundIdempotencyKey } from '@sdelka/domain';
import { accountBalance, bankNominal, bankOperating, clientFreeAccount } from '@sdelka/ledger';
import { applyTrancheEvent } from '../support/acting';
import {
  DEAL_AMOUNT,
  GEL,
  POLICY_VERSION,
  SELLER,
  THIRD_PARTY,
  partyRef,
} from '../support/fixtures';
import { dbSuite, sqlState, withRollback } from '../../../db/test/int/support/pg';
import { assertNoForeignWorld, resetDealState } from './support/reset';

/**
 * Шаги мира против **живого** Postgres: круг «мир → база → мир» на той самой
 * реализации порта, которая пойдёт в продукт, и под той самой ролью.
 *
 * **Что здесь закрывается.** Круг был замкнут только на реализации порта в
 * памяти (`support/memory-store.ts`): схему сторожили интеграционные тесты
 * `packages/db`, форму порта — типы (`store-port.test.ts`), а вместе они не
 * работали ни разу. Сценарий тот же самый, что идёт в памяти
 * (`support/store-path.ts`, один текст на оба прогона), — иначе сравнивались бы
 * не хранилища, а два текста сценария.
 *
 * **Роль — `sdelka_app`, умолчание `pgWorldStore`.** Прогон под владельцем
 * схемы обошёл бы гранты целиком, и инвариант «роль приложения не правит журнал
 * аудита» перестал бы существовать, не оставив следа. Что роль, которая эти
 * записи **сделала**, не может их изменить, проверяется здесь же — на строках
 * сценария, а не на синтетических.
 *
 * **Обе ветви.** Возвратная (красная линия №7) и расчётная. Вторая на живой
 * базе не проводилась никогда: до `0021_entry_declarations.sql` запись расчёта
 * несла объявление начисления с версией тарифного плана, а колонок под него не
 * было — хранилище отвергало такую запись, и боевой путь денег заканчивался на
 * возврате.
 *
 * ⚠ **Порядок ветвей — расчёт, потом возврат, и это не вкусовщина.** Возврат
 * двигает часы мира на сутки (`reserve_expired`, `deadline_reached`), а платная
 * выписка расчётной ветви наблюдена в `NOW`: после суток она перестаёт быть
 * свежей по политике, наблюдение даёт `insufficient`, и транш до
 * `release_pending` не доходит. Это свойство домена, а не хранилища, — но
 * сценарий, поставленный наоборот, падал бы здесь и читался бы как отказ базы.
 *
 * ⚠ **Все сценарии набора идут по ОДНОМУ миру, и тесты продолжают друг друга.**
 * Это не стиль, а следствие находки. Идентификатор записи журнала учёта —
 * счётчик мира: `entry-${seq}-${label}` (`app/src/flow.ts`, `nextMeta`). В
 * памяти каждый тест берёт своё хранилище, и счётчики не встречаются; живая
 * база одна и переживает прогон, поэтому **два разных мира сталкиваются на
 * `entry-<seq>-…`**. Проверено тестом «второй мир в той же базе». То же
 * ограничение бьёт и по перезапуску процесса: `seq` начинается с нуля заново.
 * Помечено **[открыто]** — идентификатор, уникальный только внутри мира, для
 * общей и вечной таблицы недостаточен, но выбор области имён (цепочка? отдельная
 * последовательность базы?) — решение владельца, а не наше.
 *
 * ⚠ **Набору нужна своя база, и после него она непригодна для
 * `pnpm --filter @sdelka/db test:int`.** Тот набор пишет в откатываемых
 * транзакциях и потому ничего за собой не оставляет; этот пишет настоящим
 * `COMMIT` — иначе он не проверял бы того, ради чего заведён. Убрать записанное
 * нечем: журнал учёта и журнал аудита только дополняются, и `DELETE` по ним
 * запрещён и грантами, и триггерами (красная линия №11) — в том числе владельцу
 * схемы. А проверки `packages/db/test/int/store-journal.int.test.ts` сравнивают
 * с записанным **весь** журнал: `readJournal()` области видимости не имеет
 * вовсе. Значит после этого набора те проверки красные, и лечится это чистой
 * базой, а не правкой здесь. Помечено **[открыто]**.
 *
 * Предусловие проверяется до первого шага (`./support/reset.ts`,
 * `assertNoForeignWorld`): чужая цепочка аудита в базе означает чужой мир, а с
 * ним занятые номера записей журнала, и отказ обязан назвать это по имени, а не
 * всплыть отказом `db.step.conflict` на девятом шаге.
 *
 * ⚠ **Повторный прогон.** Изменяемое состояние сделок снимается перед прогоном
 * (`./support/reset.ts`, роль владельца, мимо хранилища): мир из базы сегодня не
 * продолжается — `restoreWorld` отдаёт `RestoredWorld`, и это намеренно **не**
 * `World`. Журналы не снимаются и сниматься не могут, поэтому второй прогон
 * встречает свои же строки и опознаёт их повтором. Отсюда форма утверждений
 * ниже: считается `written + repeated`, а не `written`, — потому что первый
 * прогон пишет, а второй повторяет, и оба обязаны дать одно и то же число.
 */

/**
 * Пропуск, когда базы нет, — из `packages/db/test/int/support/pg.ts`: граница
 * там уже проведена (базы нет — пропуск с причиной; база есть, а что-то упало —
 * падение), и второй такой границы быть не должно. Оттуда же миграции: набор
 * применяет их сам, потому что схема, на которой он идёт, — часть проверяемого.
 *
 * Метка `[@sdelka/db]` в сообщении о пропуске — цена переиспользования.
 */
const { run, title, pool } = await dbSuite('шаги мира против живого Postgres');

/** Мир один на весь набор: см. заголовок. */
const CHAIN = 'chain-int-e2e';
const SETTLE = Object.freeze({
  ...REFUND_SCOPE,
  chainId: CHAIN,
  dealId: 'deal-int-settle',
  trancheId: 'tranche-int-settle',
});
const REFUND = Object.freeze({
  ...REFUND_SCOPE,
  chainId: CHAIN,
  dealId: 'deal-int-refund',
  trancheId: 'tranche-int-refund',
});
/** Отдельная сделка под повтор шага: он обязан лечь дважды и не задвоиться. */
const REPEAT = Object.freeze({
  ...REFUND_SCOPE,
  chainId: CHAIN,
  dealId: 'deal-int-repeat',
  trancheId: 'tranche-int-repeat',
});
/** Отдельная сделка под расхождение состояний. */
const CONFLICT = Object.freeze({
  ...REFUND_SCOPE,
  chainId: CHAIN,
  dealId: 'deal-int-conflict',
  trancheId: 'tranche-int-conflict',
});
/**
 * Второй мир: своя цепочка, свои сделка и транш и **другой покупатель**. Другой
 * покупатель здесь работает: столкновение на `entry-<seq>-top-up` перестаёт
 * быть повтором и становится подменой, то есть именно тем, о чём хранилище
 * обязано сказать вслух.
 */
const OTHER_WORLD = Object.freeze({
  ...REFUND_SCOPE,
  chainId: 'chain-int-other',
  dealId: 'deal-int-other',
  trancheId: 'tranche-int-other',
  buyer: THIRD_PARTY,
});

const ALL_DEALS = [
  SETTLE.dealId,
  REFUND.dealId,
  REPEAT.dealId,
  CONFLICT.dealId,
  OTHER_WORLD.dealId,
];

const OPTIONS = trancheOptions(POLICY_VERSION);
const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });

if (pool !== null) {
  // Сначала предусловие, потом снятие состояния: снимать чужое незачем, а
  // отказ обязан назвать причину до первого шага, а не на девятом.
  await assertNoForeignWorld(pool, [CHAIN, OTHER_WORLD.chainId]);
  await resetDealState(pool, ALL_DEALS);
}

function store(): WorldStore {
  if (pool === null) {
    // Недостижимо: при `pool === null` набор пропущен целиком. Броском, а не
    // `!`, потому что «недостижимо» обязано падать по имени, если однажды
    // оказалось достижимым.
    throw new Error('e2e.int.no_pool');
  }
  // Роль не передаётся: умолчание `pgWorldStore` — `sdelka_app`, и именно оно
  // здесь проверяется.
  return pgWorldStore(pool);
}

/** Курсор мира: каждый тест продолжает предыдущий. */
let cursor: Run | null = null;

function laid(run: Run): number {
  return run.log.reduce((sum, item) => sum + item.outcome.written + item.outcome.repeated, 0);
}

function at(): Run {
  if (cursor === null) throw new Error('e2e.int.no_cursor');
  return cursor;
}

run(title, () => {
  it('расчёт получателю проходит через живую базу целиком', async () => {
    const opened = await openPath(store(), CHAIN);
    const settled = await settlementPath(store(), SETTLE, opened);
    cursor = settled;

    expect(trancheStatusOf(settled.world, SETTLE.trancheId)).toBe('paid_out');
    expect(dealStatusOf(settled.world, SETTLE.dealId)).toBe('settled');

    // Красная линия №2: комиссия ушла с номинального счёта на операционный той
    // же цепочкой шагов, а не отдельной кнопкой.
    expect(accountBalance(settled.world.journal, bankOperating(GEL), GEL).minor).toBe(300_000n);
    expect(
      accountBalance(settled.world.journal, clientFreeAccount(toClientKey(SELLER.document)), GEL)
        .minor,
    ).toBe(19_700_000n);

    /*
     * Строки названы числом, а не «больше нуля»: последнее прошло бы и на одной
     * записи, а путь обязан положить в базу **всё**, что произвёл.
     *
     * 5 записей журнала учёта — зачисление, запирание, начисление комиссии,
     * расчёт получателю, получение комиссии на операционный счёт;
     * 19 записей журнала аудита — вся цепочка вместе с открытием мира;
     * 8 состояний сделки, 8 состояний транша, 2 состояния поручения — выпуск и
     * ответ банка.
     */
    expect(settled.world.journal.entries).toHaveLength(5);
    expect(settled.world.chain.records).toHaveLength(19);
    expect(laid(settled)).toBe(5 + 19 + 8 + 8 + 2);
  });

  it('возврат покупателю проходит через живую базу целиком', async () => {
    const before = at();
    const refunded = await refundPath(store(), REFUND, before);
    cursor = refunded;

    expect(trancheStatusOf(refunded.world, REFUND.trancheId)).toBe('refunded');
    expect(dealStatusOf(refunded.world, REFUND.dealId)).toBe('unwound');
    // Деньги покупателя ушли с номинального счёта; на нём остались только
    // деньги получателя по расчётной ветви — они лежат на его счёте клиента.
    expect(accountBalance(refunded.world.journal, bankNominal(GEL), GEL).minor).toBe(19_700_000n);

    /*
     * Возвратная ветвь добавляет 4 записи журнала учёта — зачисление,
     * запирание, распирание, уход возврата, — 18 записей журнала аудита
     * (открытие мира сюда уже не входит: мир общий), 9 состояний сделки и 8
     * состояний транша.
     */
    expect(refunded.world.journal.entries).toHaveLength(5 + 4);
    expect(refunded.world.chain.records.length - before.world.chain.records.length).toBe(18);
    expect(laid(refunded) - laid(before)).toBe(4 + 18 + 9 + 8);

    // Оба поручения существуют в мире: расчётное и возвратное.
    expect(payoutKeysOf(refunded.world, SETTLE.trancheId)).toEqual([
      payoutIdempotencyKey(SETTLE.trancheId),
    ]);
    expect(payoutKeysOf(refunded.world, REFUND.trancheId)).toEqual([
      refundIdempotencyKey(REFUND.trancheId),
    ]);
  });

  it('несохранимые части названы теми же ключами, что и на хранилище в памяти', () => {
    const reasons = at().log.flatMap((item) => item.unmapped.map((part) => part.reasonKey));
    // Сделка без транша: покупателя называет транш, продавца — акт.
    expect(reasons).toContain('deal.parties_unknown');
    // Красная линия №5 в схеме против возвратной ноги: пакета доказательств у
    // возврата собственных денег нет и быть не обязано.
    expect(reasons).toContain('payout.evidence_bundle_missing');
    // Собранное, подписи, реквизиты, наблюдение — колонок нет.
    expect(reasons).toContain('tranche.facts_not_storable');
    // Сессии и следы «кто готовил» у порта метода не имеют вовсе.
    expect(reasons).toContain('port.no_method');
  });

  it('повтор шага не задваивает: те же строки опознаются повтором', async () => {
    const before = (await stepWorld(store(), at().world, newDeal(REPEAT))).world;

    const step = newTranche(REPEAT);
    const first = await stepWorld(store(), before, step);
    const rows = first.outcome.written + first.outcome.repeated;
    expect(rows).toBeGreaterThan(0);

    /*
     * Тот же шаг из **того же** мира: идентификаторы записей и хеши цепочки
     * детерминированы, поэтому база видит то же самое, а не второе. Здесь
     * `written` обязан быть нулём при любом состоянии базы — в отличие от
     * первого шага, у которого исход зависит от того, шёл ли набор раньше.
     */
    const again = await stepWorld(store(), before, step);
    expect(again.outcome.written).toBe(0);
    expect(again.outcome.repeated).toBe(rows);

    cursor = { world: first.world, log: [...at().log, first] };
  });

  it('чужой шаг не затирается молча: разошедшееся состояние — отказ с именем', async () => {
    const collected = await collectedPath(store(), CONFLICT, at());
    const world = collected.world;

    // Первый шаг из `collected`: резерв. Он ложится.
    const reserved = await stepResult(store(), world, (now: World) =>
      applyTrancheEvent(now, CONFLICT.trancheId, { type: 'reserve_requested' }, OPTIONS),
    );
    expect(trancheStatusOf(reserved.world, CONFLICT.trancheId)).toBe('reserved');

    /*
     * Второй шаг из **того же** мира: срок истёк, транш идёт в возврат. В памяти
     * он проходит — мир тот, из которого он делается, — а в базе лежит уже
     * другое состояние. Слепой `UPDATE` выиграл бы последним записавшим и
     * потерял бы резерв молча; сверка «из чего уходим» (`WHERE … IS NOT DISTINCT
     * FROM …`) превращает это в отказ с именем и с обеими сторонами расхождения.
     */
    await expect(
      stepResult(store(), world, (now: World) =>
        applyTrancheEvent(now, CONFLICT.trancheId, { type: 'deadline_reached' }, ROLLBACK),
      ),
    ).rejects.toMatchObject({
      code: DbErrorCode.stepStateConflict,
      details: { relation: 'tranche', expected: 'refund_pending', actual: 'reserved' },
    });

    /*
     * В базе остался резерв, а не половина второго шага. Проверка не формальная:
     * порядок записи внутри шага — сделка, транш, проводки, поручения, журнал
     * аудита (`app/src/store.ts`, `writeDelta`), — то есть отказ пришёл со
     * **второй** позиции, а `ROLLBACK` обязан снять и первую.
     */
    const restored = await restoreWorld(store(), {
      chainId: CHAIN,
      deals: [{ dealId: CONFLICT.dealId, trancheIds: [CONFLICT.trancheId] }],
    });
    expect(restored.deals[0]?.tranches[0]?.snapshot.state.status).toBe('reserved');
    expect(restored.chain).toEqual(reserved.world.chain);

    cursor = { world: reserved.world, log: [...collected.log, reserved] };
  });

  /**
   * Находка, ради которой стоило гонять сценарий против базы, а не против карты
   * в памяти. Помечено **[открыто]**: см. заголовок файла.
   */
  it('второй мир в той же базе сталкивается на идентификаторе записи журнала', async () => {
    const known = new Set(at().world.journal.entries.map((entry) => entry.id));

    /*
     * Второй мир — своя цепочка аудита, свои сделка и транш, другой покупатель.
     * Он доходит до первой **денежной** записи и там останавливается: её
     * идентификатор — счётчик его собственного мира, и такой уже занят миром
     * первым.
     */
    const failure = await collectedPath(store(), OTHER_WORLD, null).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).not.toBeNull();
    expect(failure).toMatchObject({
      code: DbErrorCode.stepConflict,
      details: { relation: 'ledger_entry' },
    });
    // Идентификатор, на котором столкнулись, — не выдуманный: он уже лежит в
    // базе от первого мира. Именно это и делает находку находкой.
    const collidedOn = (failure as { details: { id: string } }).details.id;
    expect(known.has(collidedOn)).toBe(true);
  });

  it('мир поднимается из живой базы с теми же инвариантами', async () => {
    const world = at().world;
    const restored = await restoreWorld(store(), {
      chainId: CHAIN,
      deals: [
        { dealId: SETTLE.dealId, trancheIds: [SETTLE.trancheId] },
        { dealId: REFUND.dealId, trancheIds: [REFUND.trancheId] },
        { dealId: REPEAT.dealId, trancheIds: [REPEAT.trancheId] },
        { dealId: CONFLICT.dealId, trancheIds: [CONFLICT.trancheId] },
      ],
    });

    // Инварианты на поднятом — **та же функция**, что и на мире в памяти
    // (`surfaceViolations`), а не её похожая копия.
    expect(restoredViolations(restored)).toEqual([]);
    /*
     * Журнал учёта поднялся целиком и в том же порядке — вместе с объявлениями
     * записи расчёта (`accrues`, версия тарифного плана), ради которых
     * заводилась `0021`. Сравнение полное: `JournalEntry` собирается на чтении
     * тем же `createJournalEntry`, что и на записи, поэтому потерянное поле
     * видно здесь, а не в отчётности через месяц.
     */
    expect(restored.journal.entries).toEqual(world.journal.entries);
    expect(restored.chain).toEqual(world.chain);

    const settle = restored.deals[0];
    expect(settle?.deal.state.status).toBe('settled');
    expect(settle?.deal.buyer).toEqual(partyRef(SETTLE.buyer));
    expect(settle?.deal.seller).toEqual(partyRef(SETTLE.seller));
    expect(settle?.tranches[0]?.snapshot.state).toEqual(trancheOf(world, SETTLE.trancheId).state);
    expect(settle?.tranches[0]?.snapshot.required).toEqual(DEAL_AMOUNT);

    /*
     * Поручение расчёта в базе **есть** — с пакетом доказательств, суммой нетто
     * и ссылкой на ответ провайдера. Это и есть то, чего возвратная ветвь
     * показать не может.
     */
    const releasePayout = settle?.tranches[0]?.payouts[0];
    expect(releasePayout?.state.leg).toBe('release');
    expect(releasePayout?.state.status).toBe('settled');
    expect(releasePayout?.amount.minor).toBe(19_700_000n);
    expect(releasePayout?.beneficiary).toEqual(partyRef(SETTLE.seller));
    expect(releasePayout?.evidenceBundleId).toBe(`evidence-${SETTLE.trancheId}`);
    expect(releasePayout?.providerReference).not.toBeNull();

    const refund = restored.deals[1];
    expect(refund?.deal.state.status).toBe('unwound');
    expect(refund?.tranches[0]?.snapshot.state.status).toBe('refunded');
    /*
     * А возвратного поручения в базе нет вовсе, и на живой базе это ровно то же,
     * что было названо на реализации в памяти: `payout.evidence_bundle_id NOT
     * NULL` (красная линия №5 в схеме), а у возврата покупателю пакета
     * доказательств нет и быть не обязано. Следствие: частичный уникальный
     * индекс `payout_one_active_per_tranche` возвратную ногу не сторожит.
     */
    expect(refund?.tranches[0]?.payouts).toEqual([]);

    // Чего у хранилища нет вовсе — списком, а не примечанием в отчёте.
    const missing = restored.missing.map((part) => part.reasonKey);
    expect(missing).toContain('port.no_listing');
    expect(missing).toContain('invariant.not_checkable');
  });

  /**
   * Инвариант 21: роль приложения не имеет прав на изменение и удаление журнала
   * аудита. Проверяется **на строках, которые записал этот же прогон** и той же
   * ролью, под которой он шёл: список грантов и то, что роль может на самом
   * деле, — разные вещи (`0020_audit_append_only.sql`).
   */
  it('роль приложения не может править журнал аудита, который сама записала', async () => {
    if (pool === null) throw new Error('e2e.int.no_pool');
    await withRollback(pool, async (client) => {
      await client.query('SET LOCAL ROLE sdelka_app');
      const rows = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM sdelka.audit_record WHERE chain_id = $1',
        [CHAIN],
      );
      // Записи цепочки в базе есть — иначе запрет ниже проверял бы пустоту.
      expect(Number(rows.rows[0]?.count ?? '0')).toBeGreaterThan(0);

      /*
       * Каждая попытка — под своей точкой сохранения. Отказ базы обрывает
       * транзакцию целиком (`25P02` на всё последующее), и без отката к точке
       * вторая проверка меряла бы не запрет, а обломки первой.
       */
      const denied = async (sql: string): Promise<unknown> => {
        await client.query('SAVEPOINT attempt');
        try {
          await client.query(sql, [CHAIN]);
          return null;
        } catch (error: unknown) {
          return error;
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT attempt');
        }
      };

      expect(
        sqlState(await denied('UPDATE sdelka.audit_record SET seq = seq WHERE chain_id = $1')),
      ).toBe('42501');
      expect(sqlState(await denied('DELETE FROM sdelka.audit_record WHERE chain_id = $1'))).toBe(
        '42501',
      );
    });
  });
});
