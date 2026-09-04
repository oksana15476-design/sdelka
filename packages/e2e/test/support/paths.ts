import type { ClientKey } from '@sdelka/ledger';
import type { BeneficiaryState, PartyProfile } from '@sdelka/compliance';
import { payerKeyForDomain } from '@sdelka/compliance';
import {
  type World,
  applyDealEvent,
  applyTrancheEvent,
  approve,
  applyObservationEvent,
  attachObservation,
  receiveExternalPayment,
  receivePaidExtract,
  trancheOptions,
} from '@sdelka/app';
import { type CurrencyCode, type Money, money } from '@sdelka/money';
import {
  APPLICATION_ID,
  BUYER,
  CADASTRAL_CODE,
  DEAL_AMOUNT,
  POLICY,
  POLICY_VERSION,
  SELLER,
  cardOf,
  extractOf,
  registryWithApplicationCard,
  registryWithTransfer,
} from './fixtures';
import { openDeal } from './open';

const OPTIONS = trancheOptions(POLICY_VERSION);
/**
 * Стоимость платной выписки. Намерение `recognise_oracle_cost` приложением
 * сегодня **не исполняется** — шаблона учёта под расход оракула в словаре нет
 * (`ORACLE.md` §11), — но величина обязана быть целой минорной единицей уже
 * сейчас: красная линия №4 не знает о том, что проводки ещё нет.
 */
const EXTRACT_COST = money('GEL', 1_000n);
/** Деньги уже на свободной части счёта: зачисление сделано отдельным событием. */
const ATTACHED = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });

export interface Advanced {
  readonly world: World;
  readonly dealId: string;
  readonly trancheId: string;
  readonly buyerKey: ClientKey;
  readonly sellerKey: ClientKey;
}

export interface PathOptions {
  readonly dealId: string;
  readonly trancheId: string;
  readonly buyer?: PartyProfile;
  readonly seller?: PartyProfile;
  /**
   * Реквизиты выплаты. По умолчанию — с доказательством владения счётом; путь
   * с одной лишь сверкой имени подставляет `nameConsistentBeneficiary` и на
   * `condition_established` останавливается (`g_beneficiary_verified`).
   */
  readonly beneficiary?: BeneficiaryState;
  /** Сумма транша. По умолчанию 200 000 ₾ — вторая ступень утверждений. */
  readonly amount?: Money<CurrencyCode>;
  readonly world?: World;
}

export async function toCollected(options: PathOptions): Promise<Advanced> {
  const buyer = options.buyer ?? BUYER;
  const seller = options.seller ?? SELLER;
  const amount = options.amount ?? DEAL_AMOUNT;
  const opened = await openDeal({
    dealId: options.dealId,
    trancheId: options.trancheId,
    buyer,
    seller,
    amount,
    ...(options.beneficiary === undefined ? {} : { beneficiary: options.beneficiary }),
    ...(options.world === undefined ? {} : { world: options.world }),
  });
  let world = applyTrancheEvent(opened.world, options.trancheId, { type: 'instructions_issued' }, OPTIONS).world;
  world = receiveExternalPayment(world, opened.buyerKey, amount);
  world = applyTrancheEvent(
    world,
    options.trancheId,
    {
      type: 'funds_received',
      amount,
      sender: payerKeyForDomain(buyer.document),
      reference: `payment-${options.trancheId}`,
    },
    ATTACHED,
  ).world;
  world = applyDealEvent(world, options.dealId, { type: 'funds_received' }, OPTIONS);
  return { world, dealId: options.dealId, trancheId: options.trancheId, buyerKey: opened.buyerKey, sellerKey: opened.sellerKey };
}

export async function toReserved(options: PathOptions): Promise<Advanced> {
  const collected = await toCollected(options);
  // Резерв запирает средства сам: намерение `lock_funds` на входе в `reserved`.
  const world = applyTrancheEvent(collected.world, options.trancheId, { type: 'reserve_requested' }, OPTIONS).world;
  return { ...collected, world };
}

/**
 * Транш зарезервирован, заявка подана, платная выписка приложена — всё, кроме
 * самого события `condition_established`.
 *
 * Точка остановки выбрана не для красоты: ровно здесь стоит первое из двух
 * рёбер пути выплаты, и сценарий с реквизитами, прошедшими одну сверку имени,
 * дальше не проходит. Слить эту функцию с `toReleasePending` значило бы лишить
 * такой сценарий начала.
 */
/**
 * Наблюдение доведено до момента «выписка заказана»: сторона назвала номер,
 * карточка заявления его подтвердила, регламентный срок истёк, выписка заказана.
 *
 * Все четыре шага идут через машину наблюдения (`@sdelka/oracle`), а не
 * подставляются фактами. До этого батча заявление и наблюдение приходили в мир
 * присваиванием, и `g_no_open_filing` со `g_observation_sufficient` не звались
 * ни из одного сквозного сценария — то есть проверялись ровно нигде.
 */
export async function toExtractOrdered(options: PathOptions): Promise<Advanced> {
  const reserved = await toReserved(options);
  let world = applyDealEvent(reserved.world, options.dealId, { type: 'tranches_reserved' }, OPTIONS);
  world = applyObservationEvent(world, options.trancheId, { type: 'observation_started' }, OPTIONS).world;
  world = applyObservationEvent(
    world,
    options.trancheId,
    { type: 'filing_claimed', applicationId: APPLICATION_ID, byParty: BUYER.partyId },
    OPTIONS,
  ).world;
  const card = cardOf(registryWithApplicationCard(), APPLICATION_ID);
  world = applyObservationEvent(
    world,
    options.trancheId,
    {
      type: 'filing_card_observed',
      applicationId: card.applicationId,
      cadastralCode: card.cadastralCode,
      applicationStatus: card.applicationStatus,
    },
    OPTIONS,
  ).world;
  world = applyObservationEvent(world, options.trancheId, { type: 'statutory_term_elapsed' }, OPTIONS).world;
  world = applyObservationEvent(
    world,
    options.trancheId,
    { type: 'extract_ordered', cost: EXTRACT_COST },
    OPTIONS,
  ).world;
  return { ...reserved, world };
}

/**
 * Транш зарезервирован, заявка подана и подтверждена, платная выписка
 * приложена — всё, кроме самого события `condition_established`.
 *
 * Точка остановки выбрана не для красоты: ровно здесь стоит первое из двух
 * рёбер пути выплаты, и сценарий с реквизитами, прошедшими одну сверку имени,
 * дальше не проходит.
 *
 * ⚠ Выписка здесь **прикладывается, но не подаётся машине**: подача — это уже
 * `condition_established`, а нам нужна остановка до него. Поэтому используется
 * `attachObservation`, а не `receivePaidExtract`.
 */
export async function toConditionReady(options: PathOptions): Promise<Advanced> {
  const ordered = await toExtractOrdered(options);
  const extract = extractOf(registryWithTransfer(), CADASTRAL_CODE);
  const world = attachObservation(
    ordered.world,
    options.trancheId,
    extract,
    `evidence-${options.trancheId}`,
    POLICY,
  );
  return { ...ordered, world };
}

export async function toReleasePending(options: PathOptions): Promise<Advanced> {
  const ordered = await toExtractOrdered(options);
  const extract = extractOf(registryWithTransfer(), CADASTRAL_CODE);
  // Условие устанавливает **оракул** полученной выпиской, а не тест событием:
  // `condition_established` порождается намерением машины наблюдения
  // (`STATE-MACHINES.md` §8), и подать его мимо неё значит проверять контур,
  // которого в продукте нет.
  let world = receivePaidExtract(
    ordered.world,
    options.trancheId,
    extract,
    `evidence-${options.trancheId}`,
    POLICY,
    OPTIONS,
  ).world;
  world = applyDealEvent(world, options.dealId, { type: 'condition_established', conditionType: 'registration_transfer' }, OPTIONS);
  return { ...ordered, world };
}

export async function toPayingOut(options: PathOptions): Promise<Advanced> {
  const pending = await toReleasePending(options);
  let world = approve(pending.world, options.trancheId, 'approver-1');
  world = approve(world, options.trancheId, 'approver-2');
  world = applyTrancheEvent(world, options.trancheId, { type: 'release_authorized' }, OPTIONS).world;
  return { ...pending, world };
}
