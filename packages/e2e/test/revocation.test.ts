import { describe, expect, it } from 'vitest';
import { money } from '@sdelka/money';
import { payerKeyForDomain } from '@sdelka/compliance';
import { accountBalance, bankOperating, clientFreeAccount } from '@sdelka/ledger';
import {
  type World,
  applyDealEvent,
  applyTrancheEvent,
  approve,
  attachObservation,
  dealStatusOf,
  feeForTranche,
  receiveTrancheFee,
  receiveExternalPayment,
  rejectTrancheEvent,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  BANK_RESPONSE_SOURCE,
  BUYER,
  DEAL_AMOUNT,
  GEL,
  POLICY_VERSION,
  SELLER,
  CADASTRAL_CODE,
  POLICY,
  registryWithTransfer,
} from './support/fixtures';
import { openDeal } from './support/open';

const OPTIONS = trancheOptions(POLICY_VERSION);
const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });

interface Started {
  readonly world: World;
  readonly buyerKey: import('@sdelka/ledger').ClientKey;
  readonly sellerKey: import('@sdelka/ledger').ClientKey;
}

async function toCollected(dealId: string, trancheId: string): Promise<Started> {
  const opened = await openDeal({ dealId, trancheId, buyer: BUYER, seller: SELLER });
  let world = applyTrancheEvent(opened.world, trancheId, { type: 'instructions_issued' }, OPTIONS).world;
  world = receiveExternalPayment(world, opened.buyerKey, DEAL_AMOUNT);
  world = applyTrancheEvent(
    world,
    trancheId,
    { type: 'funds_received', amount: DEAL_AMOUNT, sender: payerKeyForDomain(BUYER.document), reference: 'payment-1' },
    ROLLBACK,
  ).world;
  world = applyDealEvent(world, dealId, { type: 'funds_received' }, OPTIONS);
  return { world, buyerKey: opened.buyerKey, sellerKey: opened.sellerKey };
}

async function toReserved(dealId: string, trancheId: string): Promise<Started> {
  const started = await toCollected(dealId, trancheId);
  const world = applyTrancheEvent(started.world, trancheId, { type: 'reserve_requested' }, OPTIONS).world;
  return { ...started, world };
}

/**
 * Сценарий 3 — отзыв средств покупателем.
 *
 * ⚠ Граница отзыва — **установление условия**, а не резерв.
 * `STATE-MACHINES.md` §1.4 [решение]: отзыв принимается из `collecting`,
 * `collected` и `reserved`; из `release_pending`, `release_blocked` и
 * `paying_out` — не принимается. Обоснование там же: после наступления
 * обстоятельства платёж считается исполненным в пользу продавца, и у отзыва
 * нет предмета. Постановка задачи говорила «после резерва — отказ»; проверяется
 * документ, потому что расхождение документа и кода трактуется как ошибка кода
 * (§9), а формулировка задачи не является ни тем, ни другим.
 */
describe('отзыв средств покупателем', () => {
  it('принимается до резерва и доводит транш до возврата', async () => {
    const started = await toCollected('deal-revoke-a', 'tranche-revoke-a');
    let world = started.world;
    expect(trancheStatusOf(world, 'tranche-revoke-a')).toBe('collected');

    world = applyTrancheEvent(
      world,
      'tranche-revoke-a',
      { type: 'revocation_requested', actor: 'buyer', reason: 'buyer.changed_mind' },
      ROLLBACK,
    ).world;
    expect(trancheStatusOf(world, 'tranche-revoke-a')).toBe('refund_pending');

    world = applyDealEvent(world, 'deal-revoke-a', { type: 'revocation_requested' }, OPTIONS);
    expect(dealStatusOf(world, 'deal-revoke-a')).toBe('unwinding');

    world = applyTrancheEvent(world, 'tranche-revoke-a', { type: 'refund_initiated' }, ROLLBACK).world;
    world = applyTrancheEvent(world, 'tranche-revoke-a', { type: 'payout_result', outcome: 'settled' }, ROLLBACK).world;
    expect(trancheStatusOf(world, 'tranche-revoke-a')).toBe('refunded');
    world = applyDealEvent(world, 'deal-revoke-a', { type: 'tranches_refunded' }, OPTIONS);
    expect(dealStatusOf(world, 'deal-revoke-a')).toBe('unwound');
    expect(accountBalance(world.journal, clientFreeAccount(started.buyerKey), GEL).minor).toBe(0n);
  });

  it('принимается из резерва: границей служит установление условия, а не резерв', async () => {
    const started = await toReserved('deal-revoke-b', 'tranche-revoke-b');
    let world = started.world;
    expect(trancheStatusOf(world, 'tranche-revoke-b')).toBe('reserved');

    world = applyTrancheEvent(
      world,
      'tranche-revoke-b',
      { type: 'revocation_requested', actor: 'buyer', reason: 'buyer.changed_mind' },
      ROLLBACK,
    ).world;
    expect(trancheStatusOf(world, 'tranche-revoke-b')).toBe('refund_pending');

    world = applyDealEvent(world, 'deal-revoke-b', { type: 'revocation_requested' }, OPTIONS);
    world = applyTrancheEvent(world, 'tranche-revoke-b', { type: 'refund_initiated' }, ROLLBACK).world;
    world = applyTrancheEvent(world, 'tranche-revoke-b', { type: 'payout_result', outcome: 'settled' }, ROLLBACK).world;
    expect(trancheStatusOf(world, 'tranche-revoke-b')).toBe('refunded');
    world = applyDealEvent(world, 'deal-revoke-b', { type: 'tranches_refunded' }, OPTIONS);
    expect(dealStatusOf(world, 'deal-revoke-b')).toBe('unwound');
  });

  it('отвергается после установления условия и не мешает расчёту', async () => {
    const started = await toReserved('deal-revoke-c', 'tranche-revoke-c');
    let world = started.world;
    world = applyDealEvent(world, 'deal-revoke-c', { type: 'tranches_reserved' }, OPTIONS);
    world = applyDealEvent(
      world,
      'deal-revoke-c',
      { type: 'filing_registered', applicationId: 'app-3', source: 'application_card' },
      OPTIONS,
    );

    const answer = registryWithTransfer().paidExtract(CADASTRAL_CODE);
    if (answer.kind !== 'found') throw new Error('unreachable');
    world = attachObservation(world, 'tranche-revoke-c', answer.value, 'evidence-bundle-3', POLICY);
    world = applyTrancheEvent(
      world,
      'tranche-revoke-c',
      { type: 'condition_established', evidenceBundleId: 'evidence-bundle-3', conditionType: 'registration_transfer' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, 'tranche-revoke-c')).toBe('release_pending');

    // Отзыв после установления условия не принимается: у него нет предмета.
    const refused = rejectTrancheEvent(world, 'tranche-revoke-c', {
      type: 'revocation_requested',
      actor: 'buyer',
      reason: 'buyer.changed_mind',
    });
    expect(refused.code).toBe('domain.transition.not_allowed');

    world = applyDealEvent(world, 'deal-revoke-c', { type: 'condition_established', conditionType: 'registration_transfer' }, OPTIONS);
    world = approve(world, 'tranche-revoke-c', 'approver-1');
    world = approve(world, 'tranche-revoke-c', 'approver-2');
    world = applyTrancheEvent(world, 'tranche-revoke-c', { type: 'release_authorized' }, OPTIONS).world;
    world = applyTrancheEvent(
      world,
      'tranche-revoke-c',
      { type: 'payout_result', outcome: 'settled' },
      trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE }),
    ).world;
    expect(trancheStatusOf(world, 'tranche-revoke-c')).toBe('paid_out');

    world = applyDealEvent(world, 'deal-revoke-c', { type: 'tranches_settled' }, OPTIONS);
    expect(dealStatusOf(world, 'deal-revoke-c')).toBe('settled');
    expect(accountBalance(world.journal, clientFreeAccount(started.sellerKey), GEL).minor).toBe(19_700_000n);
    // Комиссия ушла с номинального счёта той же записью расчёта — в транзит.
    // На операционном счёте её ещё нет, и это не забытый шаг, а факт: перевод
    // между банками идёт день-два (`FUNCTIONAL.md` §3.1).
    expect(feeForTranche(world, 'tranche-revoke-c', DEAL_AMOUNT).minor).toBe(300_000n);
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(0n);
    world = receiveTrancheFee(world, 'deal-revoke-c', 'tranche-revoke-c', money(GEL, 300_000n));
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(300_000n);
  });
});
