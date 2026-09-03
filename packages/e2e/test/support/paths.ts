import type { ClientKey } from '@sdelka/ledger';
import type { BeneficiaryState, PartyProfile } from '@sdelka/compliance';
import { payerKeyForDomain } from '@sdelka/compliance';
import {
  type World,
  applyDealEvent,
  applyTrancheEvent,
  approve,
  attachRegistryExtract,
  lockFundsForTranche,
  receiveExternalPayment,
  trancheOptions,
} from '../../src/index';
import type { CurrencyCode, Money } from '@sdelka/money';
import { BUYER, DEAL_AMOUNT, POLICY_VERSION, SELLER, extractOf, registryWithTransfer } from './fixtures';
import { openDeal } from './open';

const OPTIONS = trancheOptions(POLICY_VERSION);
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
  let world = applyTrancheEvent(collected.world, options.trancheId, { type: 'reserve_requested' }, OPTIONS).world;
  world = lockFundsForTranche(world, options.trancheId, options.amount ?? DEAL_AMOUNT);
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
export async function toConditionReady(options: PathOptions): Promise<Advanced> {
  const reserved = await toReserved(options);
  let world = applyDealEvent(reserved.world, options.dealId, { type: 'tranches_reserved' }, OPTIONS);
  world = applyDealEvent(world, options.dealId, { type: 'filing_registered', applicationId: `app-${options.trancheId}` }, OPTIONS);
  const extract = extractOf(registryWithTransfer(), 'cadastral');
  world = attachRegistryExtract(world, options.trancheId, extract, `evidence-${options.trancheId}`);
  return { ...reserved, world };
}

export async function toReleasePending(options: PathOptions): Promise<Advanced> {
  const ready = await toConditionReady(options);
  let world = applyTrancheEvent(
    ready.world,
    options.trancheId,
    { type: 'condition_established', evidenceBundleId: `evidence-${options.trancheId}`, conditionType: 'registration_transfer' },
    OPTIONS,
  ).world;
  world = applyDealEvent(world, options.dealId, { type: 'condition_established', conditionType: 'registration_transfer' }, OPTIONS);
  return { ...ready, world };
}

export async function toPayingOut(options: PathOptions): Promise<Advanced> {
  const pending = await toReleasePending(options);
  let world = approve(pending.world, options.trancheId, 'approver-1');
  world = approve(world, options.trancheId, 'approver-2');
  world = applyTrancheEvent(world, options.trancheId, { type: 'release_authorized' }, OPTIONS).world;
  return { ...pending, world };
}
