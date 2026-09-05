import {
  type StoreOption,
  type World,
  type Written,
  advance,
  emptyWorld,
  feeForTranche,
  openWorld,
  stepResult,
  stepWorld,
  toClientKey,
  trancheOf,
  trancheOptions,
} from '@sdelka/app';
import { type PartyProfile, payerKeyForDomain } from '@sdelka/compliance';
import { money } from '@sdelka/money';
import {
  applyDealEvent,
  applyObservationEvent,
  applyTrancheEvent,
  approve,
  createDeal,
  createTranche,
  receiveExternalPayment,
  receivePaidExtract,
  receiveTrancheFee,
  recordConditionAct,
} from './acting';
import { STAFF } from './actors';
import {
  APPLICATION_ID,
  BANK_RESPONSE_SOURCE,
  BUYER,
  CADASTRAL_CODE,
  CONDITION_ACT_SOURCE,
  CREATED_ON,
  DEAL_AMOUNT,
  GEL,
  NOW,
  PLATFORM_FEE,
  POLICY,
  POLICY_VERSION,
  SELLER,
  TARIFF_VERSION,
  beneficiaryFor,
  cardOf,
  conditionAct,
  extractOf,
  partyRef,
  registryWithApplicationCard,
  registryWithTransfer,
} from './fixtures';

/**
 * Два пути денег, записанные **через порт хранилища**, — один текст на оба
 * прогона: на реализации в памяти и на живом Postgres.
 *
 * **Зачем отдельный модуль.** Сценарий, переписанный второй раз ради второй
 * реализации порта, сравнивал бы не хранилища, а два текста сценария: любое
 * расхождение читалось бы как «в базе иначе», хотя иначе — в тесте. Здесь путь
 * один, а `StoreOption` — параметр, поэтому «в памяти прошло, а в базе нет»
 * означает ровно то, что написано.
 *
 * **Почему путей два.** Возвратный (красная линия №7: состояние по умолчанию
 * при бездействии — возврат покупателю) и расчётный (деньги уходят получателю,
 * комиссия — на операционный счёт, красная линия №2). До миграций 0020 и 0021
 * второй в базу не ложился вовсе: запись расчёта несёт объявление начисления с
 * версией тарифного плана, а колонок под него не было — хранилище отвергало
 * такую запись ключом `db.entry.declaration_not_storable`. Гонять один
 * возвратный путь означало бы проверять половину продукта.
 *
 * **Область имён — параметр, а не константа.** Идентификаторы сделки, транша и
 * сторон приходят из `PathScope`, потому что живая база переживает прогон и
 * второй путь встретил бы в ней строки первого.
 *
 * **Начало пути — тоже параметр** (`start`). Два пути умеют идти по одному и
 * тому же миру, и на живой базе это не удобство, а необходимость:
 * идентификатор записи журнала учёта — счётчик мира (`entry-<seq>-<label>`,
 * `app/src/flow.ts`, `nextMeta`), областью имён он не покрывается, и два разных
 * мира в одной базе сталкиваются на `entry-1-…`. Разбор — в
 * `test/int/store-round-trip.int.test.ts`, там же это проверяется тестом.
 */

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на свободной части счёта клиента: откат резерва их не зачисляет заново. */
const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Стоимость платной выписки. Намерение `recognise_oracle_cost` приложением
 * сегодня не исполняется (шаблона учёта под расход оракула в словаре нет), но
 * величина обязана быть целой минорной единицей уже сейчас — красная линия №4.
 */
const EXTRACT_COST = money(GEL, 1_000n);

/** Кто участвует и под какими именами. Всё, что попадает в базу ключами. */
export interface PathScope {
  readonly dealId: string;
  readonly trancheId: string;
  readonly chainId: string;
  readonly buyer: PartyProfile;
  readonly seller: PartyProfile;
  /** Зерно реквизитов получателя: см. `beneficiaryFor`. */
  readonly beneficiarySeed: number;
}

/** Область имён возвратного пути. Та же, что была у сценария в памяти. */
export const REFUND_SCOPE: PathScope = Object.freeze({
  dealId: 'deal-store-refund',
  trancheId: 'tranche-store-refund',
  chainId: 'chain-store-refund',
  buyer: BUYER,
  seller: SELLER,
  beneficiarySeed: 500,
});

export interface Run {
  readonly world: World;
  readonly log: readonly Written[];
}

/**
 * Открытие мира: пустой мир вместе с записью открытия цепочки аудита.
 *
 * Отдельным шагом потому, что у первого мира нет предыдущего, и потому, что
 * несколько путей могут продолжать **один** мир — см. заголовок файла.
 */
export async function openPath(store: StoreOption, chainId: string): Promise<Run> {
  const { log, record } = recorder();
  const world = record(await openWorld(store, emptyWorld({ now: NOW, chainId })));
  return { world, log };
}

interface Recorder {
  readonly log: Written[];
  record: (written: Written) => World;
}

function recorder(previous: readonly Written[] = []): Recorder {
  const log: Written[] = [...previous];
  return {
    log,
    record(written: Written): World {
      log.push(written);
      return written.world;
    },
  };
}

/** Спецификация транша — одна на оба пути: расходятся они позже. */
function trancheSpec(scope: PathScope): Parameters<typeof createTranche>[1] {
  return {
    dealId: scope.dealId,
    trancheId: scope.trancheId,
    buyer: partyRef(scope.buyer),
    buyerPayerKey: payerKeyForDomain(scope.buyer.document),
    buyerNames: scope.buyer.names,
    requiredAmount: DEAL_AMOUNT,
    conditionAct: conditionAct(partyRef(scope.seller)),
    createdOn: CREATED_ON,
    deductions: PLATFORM_FEE,
    tariffVersionId: TARIFF_VERSION,
    beneficiary: beneficiaryFor(scope.seller, scope.beneficiarySeed),
    sourceAccountKnown: true,
  };
}

export function newTranche(scope: PathScope): (world: World) => World {
  return (world: World): World => createTranche(world, trancheSpec(scope));
}

export function newDeal(scope: PathScope): (world: World) => World {
  return (world: World): World =>
    createDeal(world, {
      dealId: scope.dealId,
      conditionAct: conditionAct(partyRef(scope.seller)),
      objectCadastralCode: CADASTRAL_CODE,
    });
}

/**
 * До собранных денег: сделка, транш, акт об условии, проверки сторон, выдача
 * инструкций, поступление и его отнесение на транш.
 *
 * Каждый шаг проходит через `stepWorld`/`stepResult`: сначала полномочие,
 * автомат и `sealed`, потом транзакция.
 */
export async function collectedPath(
  store: StoreOption,
  scope: PathScope,
  start: Run | null = null,
): Promise<Run> {
  const from = start ?? (await openPath(store, scope.chainId));
  const { log, record } = recorder(from.log);
  let world = from.world;

  world = record(await stepWorld(store, world, newDeal(scope)));
  world = record(await stepWorld(store, world, newTranche(scope)));

  world = record(
    await stepWorld(store, world, (now) =>
      recordConditionAct(
        now,
        scope.dealId,
        scope.trancheId,
        conditionAct(partyRef(scope.seller)),
        CONDITION_ACT_SOURCE,
        POLICY_VERSION,
      ),
    ),
  );

  for (const event of ['parties_check_started', 'parties_verified', 'property_verified'] as const) {
    world = record(
      await stepWorld(store, world, (now) =>
        applyDealEvent(now, scope.dealId, { type: event }, OPTIONS),
      ),
    );
  }

  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, scope.trancheId, { type: 'instructions_issued' }, OPTIONS),
    ),
  );

  world = record(
    await stepWorld(store, world, (now) =>
      receiveExternalPayment(now, toClientKey(scope.buyer.document), DEAL_AMOUNT),
    ),
  );

  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(
        now,
        scope.trancheId,
        {
          type: 'funds_received',
          amount: DEAL_AMOUNT,
          sender: payerKeyForDomain(scope.buyer.document),
          reference: `payment-${scope.trancheId}`,
        },
        ROLLBACK,
      ),
    ),
  );

  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(now, scope.dealId, { type: 'funds_received' }, OPTIONS),
    ),
  );
  return { world, log };
}

/**
 * Резерв, истёкший срок и возврат покупателю.
 *
 * Продолжение отдельной функцией потому, что точка `collected` нужна ещё одному
 * сценарию: из неё расходятся два разных шага, и на них проверяется, что
 * потерянный шаг называется конфликтом, а не выигрывается последним записавшим.
 */
export async function refundPath(
  store: StoreOption,
  scope: PathScope,
  start: Run | null = null,
): Promise<Run> {
  const collected = await collectedPath(store, scope, start);
  const { log, record } = recorder(collected.log);
  let world = collected.world;

  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, scope.trancheId, { type: 'reserve_requested' }, OPTIONS),
    ),
  );
  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(now, scope.dealId, { type: 'tranches_reserved' }, OPTIONS),
    ),
  );

  // Заявление подано стороной: без него сделка не выходит из `funded`, и
  // `condition_failed` отвергается таблицей переходов (`deal.ts`, §1.4).
  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(
        now,
        scope.dealId,
        {
          type: 'filing_registered',
          applicationId: `app-${scope.trancheId}`,
          source: 'party_claim',
        },
        OPTIONS,
      ),
    ),
  );

  // Часы. Шаг мира, у которого в базе следа нет вовсе: время не состояние.
  world = record(await stepWorld(store, world, (now) => advance(now, DAY_MS)));

  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, scope.trancheId, { type: 'reserve_expired' }, ROLLBACK),
    ),
  );
  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, scope.trancheId, { type: 'deadline_reached' }, ROLLBACK),
    ),
  );
  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(now, scope.dealId, { type: 'condition_failed' }, OPTIONS),
    ),
  );
  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, scope.trancheId, { type: 'refund_initiated' }, ROLLBACK),
    ),
  );
  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(
        now,
        scope.trancheId,
        { type: 'payout_result', outcome: 'settled' },
        { ...ROLLBACK, payoutResponse: BANK_RESPONSE_SOURCE },
      ),
    ),
  );
  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(now, scope.dealId, { type: 'tranches_refunded' }, OPTIONS),
    ),
  );

  return { world, log };
}

/**
 * Расчёт получателю: резерв, наблюдение реестра, установленное условие, две
 * подписи разных уровней, поручение в банк, ответ банка, вывод комиссии на
 * операционный счёт и закрытие сделки.
 *
 * Условие устанавливает **машина наблюдения** полученной выпиской, а не тест
 * событием: подать `condition_established` мимо неё значит проверять контур,
 * которого в продукте нет (`ORACLE.md` §8).
 */
export async function settlementPath(
  store: StoreOption,
  scope: PathScope,
  start: Run | null = null,
): Promise<Run> {
  const collected = await collectedPath(store, scope, start);
  const { log, record } = recorder(collected.log);
  let world = collected.world;

  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, scope.trancheId, { type: 'reserve_requested' }, OPTIONS),
    ),
  );
  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(now, scope.dealId, { type: 'tranches_reserved' }, OPTIONS),
    ),
  );

  world = record(
    await stepResult(store, world, (now) =>
      applyObservationEvent(now, scope.trancheId, { type: 'observation_started' }, OPTIONS),
    ),
  );
  world = record(
    await stepResult(store, world, (now) =>
      applyObservationEvent(
        now,
        scope.trancheId,
        { type: 'filing_claimed', applicationId: APPLICATION_ID, byParty: scope.buyer.partyId },
        OPTIONS,
      ),
    ),
  );
  const card = cardOf(registryWithApplicationCard(), APPLICATION_ID);
  world = record(
    await stepResult(store, world, (now) =>
      applyObservationEvent(
        now,
        scope.trancheId,
        {
          type: 'filing_card_observed',
          applicationId: card.applicationId,
          cadastralCode: card.cadastralCode,
          applicationStatus: card.applicationStatus,
        },
        OPTIONS,
      ),
    ),
  );
  world = record(
    await stepResult(store, world, (now) =>
      applyObservationEvent(now, scope.trancheId, { type: 'statutory_term_elapsed' }, OPTIONS),
    ),
  );
  world = record(
    await stepResult(store, world, (now) =>
      applyObservationEvent(
        now,
        scope.trancheId,
        { type: 'extract_ordered', cost: EXTRACT_COST },
        OPTIONS,
      ),
    ),
  );

  const extract = extractOf(registryWithTransfer(), CADASTRAL_CODE);
  world = record(
    await stepResult(store, world, (now) =>
      receivePaidExtract(
        now,
        scope.trancheId,
        extract,
        `evidence-${scope.trancheId}`,
        POLICY,
        OPTIONS,
      ),
    ),
  );
  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(
        now,
        scope.dealId,
        { type: 'condition_established', conditionType: 'registration_transfer' },
        OPTIONS,
      ),
    ),
  );

  // Две подписи **разных уровней**: ФК даёт уровень 1, РО — уровень 2.
  world = record(
    await stepWorld(store, world, (now) => approve(now, scope.trancheId, STAFF.controller)),
  );
  world = record(await stepWorld(store, world, (now) => approve(now, scope.trancheId, STAFF.head)));

  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(now, scope.trancheId, { type: 'release_authorized' }, OPTIONS),
    ),
  );
  world = record(
    await stepResult(store, world, (now) =>
      applyTrancheEvent(
        now,
        scope.trancheId,
        { type: 'payout_result', outcome: 'settled' },
        trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE }),
      ),
    ),
  );

  // Красная линия №2: комиссия уходит с номинального счёта на операционный.
  const fee = feeForTranche(world, scope.trancheId, DEAL_AMOUNT);
  world = record(
    await stepWorld(store, world, (now) =>
      receiveTrancheFee(now, scope.dealId, scope.trancheId, fee),
    ),
  );
  world = record(
    await stepWorld(store, world, (now) =>
      applyDealEvent(now, scope.dealId, { type: 'tranches_settled' }, OPTIONS),
    ),
  );

  return { world, log };
}

/** Ключи идемпотентности поручений транша — в порядке появления. */
export function payoutKeysOf(world: World, trancheId: string): readonly string[] {
  return trancheOf(world, trancheId).payouts.map((payout) => payout.idempotencyKey);
}
