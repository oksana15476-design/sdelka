import { describe, expect, it } from 'vitest';
import { assessPayer, compareNames, payerKeyForDomain } from '@sdelka/compliance';
import { planAllocationToDeal } from '@sdelka/domain';
import { STAFF } from './support/actors';
import {
  clientLockedAccount,
  clientStatement,
  createJournalEntry,
  credit,
  debit,
  freeBalance,
} from '@sdelka/ledger';
import { money } from '@sdelka/money';
import {
  type World,
  dealStatusOf,
  feeForTranche,
  toClientKey,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyDealEvent,
  applyTrancheEvent,
  approve,
  receiveExternalPayment,
} from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  BUYER,
  DEAL_AMOUNT,
  GEL,
  NOW,
  POLICY_VERSION,
  SELLER,
  SMALL_AMOUNT,
  TWO_ROLE,
  beneficiaryFor,
  CADASTRAL_CODE,
  registryWithTransfer,
} from './support/fixtures';
import { openDeal } from './support/open';
import { establishCondition, toPayingOut } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);
const ATTACHED = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const SETTLED = trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE });

const DEAL_A = 'deal-sell';
const TRANCHE_A = 'tranche-sell';
const DEAL_B = 'deal-buy';
const TRANCHE_B = 'tranche-buy';

/**
 * Сценарий 7 — один клиент в двух ролях.
 *
 * Продаёт по одной сделке, покупает по другой, счёт у него один
 * (`FUNCTIONAL.md` §2.1, `ROADMAP.md` И12.1), и средства, запертые под одну
 * сделку, на другую не идут — не потому, что стоит проверка, а потому, что
 * лежат на другом счёте (красная линия №1).
 */
describe('один клиент в двух ролях', () => {
  it('держит один счёт и не пускает запертые под сделку деньги на другую сделку', async () => {
    // --- Сделка А: клиент продаёт ---
    const sell = await toPayingOut({ dealId: DEAL_A, trancheId: TRANCHE_A, buyer: BUYER, seller: TWO_ROLE });
    let world: World = applyTrancheEvent(
      sell.world,
      TRANCHE_A,
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    ).world;
    expect(feeForTranche(world, TRANCHE_A, DEAL_AMOUNT).minor).toBe(300_000n);
    world = applyDealEvent(world, DEAL_A, { type: 'tranches_settled' }, OPTIONS);
    expect(dealStatusOf(world, DEAL_A)).toBe('settled');

    const clientKey = toClientKey(TWO_ROLE.document);
    expect(clientKey).toBe(sell.sellerKey);
    // Деньги от продажи попали в **свободную** часть его счёта.
    expect(freeBalance(world.journal, clientKey, GEL).minor).toBe(19_700_000n);

    // --- Сделка Б: тот же клиент покупает ---
    const opened = await openDeal({
      dealId: DEAL_B,
      trancheId: TRANCHE_B,
      buyer: TWO_ROLE,
      seller: SELLER,
      amount: SMALL_AMOUNT,
      beneficiary: beneficiaryFor(SELLER, 501),
      world,
    });
    world = opened.world;
    // Ключ счёта тот же: роль — свойство участия в сделке, а не человека.
    expect(opened.buyerKey).toBe(clientKey);

    world = applyTrancheEvent(world, TRANCHE_B, { type: 'instructions_issued' }, OPTIONS).world;

    // Плательщик и покупатель — одно лицо по ключу документа, деньги идут с его
    // собственного остатка: удержания нет, имя не спрашивается вовсе.
    const internal = assessPayer(
      {
        buyerDocument: TWO_ROLE.document,
        origin: { kind: 'internal_balance', accountHolder: TWO_ROLE.document },
        relationship: { kind: 'self' },
        evidence: [],
      },
      POLICY_VERSION,
      NOW,
    );
    expect(internal.outcome).toBe('clear');
    expect(internal.reasons).toContain('compliance.payer.internal_own_balance');

    world = applyTrancheEvent(
      world,
      TRANCHE_B,
      {
        type: 'funds_received',
        amount: SMALL_AMOUNT,
        sender: payerKeyForDomain(TWO_ROLE.document),
        reference: 'internal-1',
      },
      ATTACHED,
    ).world;
    world = applyDealEvent(world, DEAL_B, { type: 'funds_received' }, OPTIONS);
    world = applyTrancheEvent(world, TRANCHE_B, { type: 'reserve_requested' }, OPTIONS).world;

    // --- Один счёт, две части ---
    const statement = clientStatement(world.journal, clientKey);
    expect(statement.free).toEqual([{ currency: GEL, amount: money(GEL, 9_700_000n) }]);
    expect(statement.lockedTotal).toEqual([{ currency: GEL, amount: money(GEL, 10_000_000n) }]);
    expect(statement.locked).toEqual([
      { deal: { dealId: DEAL_B, trancheId: TRANCHE_B }, currency: GEL, amount: money(GEL, 10_000_000n) },
    ]);

    // --- Запертое под сделку Б на третью сделку не идёт ---
    // Первый контур — свободный остаток: в сравнение входит только он, хотя
    // всего у клиента 19 700 000 тетри.
    const overFreeBalance = money(GEL, 15_000_000n);
    const allocation = planAllocationToDeal(
      {
        free: freeBalance(world.journal, clientKey, GEL),
        locked: [],
        requestedAmount: overFreeBalance,
        preparedBy: 'operator-1',
        sourceAccount: null,
        approvals: [],
        activeWithdrawals: 0,
      },
      { dealId: 'deal-third', trancheId: 'tranche-third', amount: overFreeBalance },
    );
    expect(allocation.ok).toBe(false);
    if (!allocation.ok) {
      expect(allocation.error.failedGuards).toContain('g_free_balance_sufficient');
    }

    // Второй контур — сам журнал: перенос из запертой части одной сделки в
    // запертую часть другой невыразим даже низкоуровневой дверью.
    expect(() =>
      createJournalEntry({
        id: 'illegal-transfer',
        occurredAt: new Date(world.now).toISOString(),
        kind: 'settlement',
        memoKey: 'ledger.entry.illegal',
        postings: [
          debit(clientLockedAccount(clientKey, DEAL_B, TRANCHE_B), SMALL_AMOUNT, {
            dealId: DEAL_B,
            trancheId: TRANCHE_B,
          }),
          credit(clientLockedAccount(clientKey, 'deal-third', 'tranche-third'), SMALL_AMOUNT, {
            dealId: 'deal-third',
            trancheId: 'tranche-third',
          }),
        ],
      }),
    ).toThrow('ledger.entry.locked_to_locked');

    // И свободные деньги одного клиента не становятся обязательством перед другим.
    expect(() =>
      createJournalEntry({
        id: 'illegal-owner-move',
        occurredAt: new Date(world.now).toISOString(),
        kind: 'settlement',
        memoKey: 'ledger.entry.illegal',
        postings: [
          debit({ kind: 'client_free', clientKey }, SMALL_AMOUNT, { clientKey }),
          credit({ kind: 'client_free', clientKey: sell.buyerKey }, SMALL_AMOUNT, {
            clientKey: sell.buyerKey,
          }),
        ],
      }),
    ).toThrow('ledger.entry.client_owner_mismatch');

    // --- Сделка Б доходит до терминального состояния ---
    world = applyDealEvent(world, DEAL_B, { type: 'tranches_reserved' }, OPTIONS);
    world = applyDealEvent(
      world,
      DEAL_B,
      { type: 'filing_registered', applicationId: 'app-b', source: 'application_card' },
      OPTIONS,
    );
    const answer = registryWithTransfer().paidExtract(CADASTRAL_CODE);
    if (answer.kind !== 'found') throw new Error('unreachable');
    expect(
      compareNames(TWO_ROLE.names, TWO_ROLE.names, { strongThresholdBp: 9_500 }).sufficientAlone,
    ).toBe(false);
    world = establishCondition(world, TRANCHE_B, answer.value, 'evidence-b');
    world = applyDealEvent(world, DEAL_B, { type: 'condition_established', conditionType: 'registration_transfer' }, OPTIONS);
    // 100 000 ₾ — первая ступень: одна подпись, но не ноль.
    world = approve(world, TRANCHE_B, STAFF.controller);
    world = applyTrancheEvent(world, TRANCHE_B, { type: 'release_authorized' }, OPTIONS).world;
    world = applyTrancheEvent(world, TRANCHE_B, { type: 'payout_result', outcome: 'settled' }, SETTLED).world;
    expect(trancheStatusOf(world, TRANCHE_B)).toBe('paid_out');
    expect(feeForTranche(world, TRANCHE_B, SMALL_AMOUNT).minor).toBe(150_000n);
    world = applyDealEvent(world, DEAL_B, { type: 'tranches_settled' }, OPTIONS);
    expect(dealStatusOf(world, DEAL_B)).toBe('settled');

    // Итог: у клиента остался свободный остаток от продажи за вычетом покупки,
    // обе сделки закрыты, и ни одна копейка не перешла между их файлами.
    expect(freeBalance(world.journal, clientKey, GEL).minor).toBe(9_700_000n);
    expect(receiveExternalPayment).toBeTypeOf('function');
  });
});
