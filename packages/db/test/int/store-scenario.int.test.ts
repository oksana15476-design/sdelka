import {
  type AuditChain,
  type AuditRecord,
  appendRecord,
  auditActor,
  auditAmount,
  auditInstant,
  auditRef,
  genesisChain,
  rawSourceRef,
  verifyChain,
} from '@sdelka/audit';
import {
  type ConditionAct,
  type PartyRef,
  type TrancheEvent,
  type TrancheFacts,
  type TrancheState,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_DEADLINE_POLICY,
  DEFAULT_OBSERVATION_POLICY,
  dealState,
  initialTrancheState,
  instant,
  reduceTranche,
  refundIdempotencyKey,
} from '@sdelka/domain';
import {
  type EntryMeta,
  checkLedgerInvariants,
  clientKey,
  clientTopUp,
  lockForTranche,
  unlockToClientAccount,
} from '@sdelka/ledger';
import { isoDate, money } from '@sdelka/money';
import { expect, it } from 'vitest';
import type { WorldStore } from '../../src/store/port.ts';
import type {
  DealSnapshot,
  PayoutSnapshot,
  TrancheSnapshot,
} from '../../src/store/port.ts';
import { dbSuite, withRollback } from './support/pg.ts';
import { savepointStore } from './support/store.ts';

/**
 * Сквозной сценарий: шаги идут **через хранилище**, а не только в памяти.
 *
 * Путь — красная линия №7: состояние по умолчанию при бездействии есть возврат
 * покупателю. Сделка заводится, транш собирает деньги, резервирует их и
 * возвращает; на каждом шаге в базу ложатся **вместе** проводки, состояние и
 * запись журнала аудита, и шаг либо ложится целиком, либо не ложится вовсе.
 *
 * Переходы считает настоящий редьюсер домена (`reduceTranche`), а не тест:
 * сценарий, в котором статусы расставлены руками, проверяет не автомат, а
 * аккуратность автора.
 *
 * В конце мир **поднимается из базы заново**, и на поднятом журнале
 * `checkLedgerInvariants` обязан дать то же, что на исходном. Пока хранилища не
 * было, эта проверка не могла существовать: мир жил в памяти и умирал вместе с
 * процессом.
 *
 * ⚠ Расчёт получателю в этот сценарий не входит, и это не выбор пути поудобнее.
 * Расчёт идёт двумя записями, вторая из которых — начисление комиссии с
 * версией тарифного плана, а колонки под неё в `sdelka.ledger_entry` нет.
 * Хранилище такую запись отвергает (`db.entry.declaration_not_storable`), и
 * сценарий, который бы её обошёл, скрыл бы дыру схемы вместо того, чтобы её
 * назвать. Дыра названа там же, где отказ.
 */
const { run, title, pool } = await dbSuite('хранилище: сквозной сценарий возврата');

const GEL = 'GEL' as const;
const DEAL = 'deal-scenario';
const TRANCHE = 'tranche-scenario';
const CHAIN = 'chain-scenario';
const AMOUNT = money(GEL, 20_000_000n);

const BUYER: PartyRef = { partyId: 'party-buyer-scenario', accountKey: 'buyer.scenario' };
const SELLER: PartyRef = { partyId: 'party-seller-scenario', accountKey: 'seller.scenario' };
const BUYER_ACCOUNT = clientKey(BUYER.accountKey);

const START = Date.UTC(2026, 2, 1, 9, 0, 0);
const ACTOR = auditActor('operator-scenario', 'operator', 'tranche.prepare');

const BANK_RESPONSE = rawSourceRef({
  sourceKind: 'payment_provider_response',
  storageRef: 'documents/psp/2026/03/01/refund-1',
  mediaType: 'application/json',
  byteLength: 256,
  digest: 'd'.repeat(64),
  receivedAt: auditInstant(START + 6_000),
  provider: 'psp.acme',
});

const ACT: ConditionAct = Object.freeze({
  recipient: SELLER,
  agreedAt: instant(START),
  conditionTextVersion: 'condition/2026-01-01.1',
  conditionType: 'registration_transfer',
});

function facts(overrides: Partial<TrancheFacts> = {}): TrancheFacts {
  return {
    requiredAmount: AMOUNT,
    collectedAmount: null,
    lockedAmount: null,
    buyerPayerKey: BUYER.partyId,
    buyer: BUYER,
    conditionAct: ACT,
    evidenceBundleId: 'evidence-bundle-scenario',
    observation: null,
    expectedCadastralCode: 'cadastral-scenario',
    observationPolicy: DEFAULT_OBSERVATION_POLICY,
    beneficiary: { status: 'verified', locked: false, lastChangedAt: null },
    preparedBy: 'operator-scenario',
    approvals: [],
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
    createdOn: isoDate('2026-03-01'),
    officialRateAtCreation: null,
    activePayouts: 0,
    coverageOk: true,
    sourceAccountKnown: true,
    mismatchResolved: true,
    ...overrides,
  };
}

function step(
  state: TrancheState,
  event: TrancheEvent,
  now: number,
  overrides: Partial<TrancheFacts> = {},
): TrancheState {
  const result = reduceTranche(state, event, {
    now: instant(now),
    dealId: DEAL,
    trancheId: TRANCHE,
    facts: facts(overrides),
    deadlinePolicy: DEFAULT_DEADLINE_POLICY,
  });
  if (!result.ok) {
    throw new Error(`переход отвергнут: ${result.error.code} ${result.error.failedGuards.join(',')}`);
  }
  return result.value.state;
}

function meta(id: string, at: number): EntryMeta {
  return { id, occurredAt: new Date(at).toISOString() };
}

function auditStep(chain: AuditChain, seq: number, at: number, body: AuditRecord['body']): AuditChain {
  return appendRecord(chain, {
    recordId: `${CHAIN}:${seq}`,
    recordedAt: auditInstant(at),
    actor: ACTOR,
    subject: auditRef('tranche', TRANCHE),
    related: [auditRef('deal', DEAL)],
    body,
  });
}

run(title, () => {
  it('возврат покупателю проходит целиком через базу и поднимается из неё', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      const store: WorldStore = savepointStore(client);

      /* --- Шаг 1: сделка и транш заведены --- */
      let chain = genesisChain(CHAIN, auditInstant(START), ACTOR);
      let state = initialTrancheState(instant(START), DEFAULT_DEADLINE_POLICY);
      let tranche: TrancheSnapshot = { dealId: DEAL, trancheId: TRANCHE, state, required: AMOUNT };
      const deal: DealSnapshot = {
        dealId: DEAL,
        state: dealState('ready'),
        buyer: BUYER,
        seller: SELLER,
      };
      await store.transact(async (tx) => {
        await tx.saveDeal(deal);
        await tx.saveTranche(tranche, null);
        await tx.appendAudit(chain.records);
      });

      /* --- Шаг 2: выданы инструкции, приём средств открыт актом --- */
      let previous = tranche;
      state = step(state, { type: 'instructions_issued' }, START + 1_000);
      tranche = { ...tranche, state };
      chain = auditStep(chain, 1, START + 1_000, {
        kind: 'state_transition',
        machine: 'tranche',
        from: 'pending',
        to: 'collecting',
        eventKey: 'instructions_issued',
        failedGuards: [],
      });
      await store.transact(async (tx) => {
        await tx.saveTranche(tranche, previous);
        await tx.appendAudit([chain.records[1]!]);
      });
      expect(tranche.state.status).toBe('collecting');

      /* --- Шаг 3: деньги пришли. Проводка и состояние одной транзакцией --- */
      const topUp = clientTopUp(meta('sc-1-top-up', START + 2_000), BUYER_ACCOUNT, AMOUNT);
      previous = tranche;
      state = step(
        state,
        { type: 'funds_received', amount: AMOUNT, sender: BUYER.partyId, reference: 'payment-1' },
        START + 2_000,
        { collectedAmount: AMOUNT },
      );
      tranche = { ...tranche, state };
      chain = auditStep(chain, 2, START + 2_000, {
        kind: 'state_transition',
        machine: 'tranche',
        from: 'collecting',
        to: 'collected',
        eventKey: 'funds_received',
        failedGuards: [],
      });
      await store.transact(async (tx) => {
        await tx.appendJournal([topUp]);
        await tx.saveTranche(tranche, previous);
        await tx.appendAudit([chain.records[2]!]);
      });
      expect(tranche.state.status).toBe('collected');

      /* --- Шаг 4: резерв. Деньги заперты под транш --- */
      const lock = lockForTranche(
        meta('sc-2-lock', START + 3_000),
        BUYER_ACCOUNT,
        { dealId: DEAL, trancheId: TRANCHE },
        AMOUNT,
      );
      previous = tranche;
      state = step(state, { type: 'reserve_requested' }, START + 3_000, {
        collectedAmount: AMOUNT,
      });
      tranche = { ...tranche, state };
      chain = auditStep(chain, 3, START + 3_000, {
        kind: 'state_transition',
        machine: 'tranche',
        from: 'collected',
        to: 'reserved',
        eventKey: 'reserve_requested',
        failedGuards: [],
      });
      await store.transact(async (tx) => {
        await tx.appendJournal([lock]);
        await tx.saveTranche(tranche, previous);
        await tx.appendAudit([chain.records[3]!]);
      });
      expect(tranche.state.status).toBe('reserved');

      /* --- Шаг 5: условие не наступило, открыт возврат --- */
      previous = tranche;
      state = step(state, { type: 'condition_failed' }, START + 4_000, {
        collectedAmount: AMOUNT,
        lockedAmount: AMOUNT,
      });
      tranche = { ...tranche, state };
      chain = auditStep(chain, 4, START + 4_000, {
        kind: 'state_transition',
        machine: 'tranche',
        from: 'reserved',
        to: 'refund_pending',
        eventKey: 'condition_failed',
        failedGuards: [],
      });
      await store.transact(async (tx) => {
        await tx.saveTranche(tranche, previous);
        await tx.appendAudit([chain.records[4]!]);
      });
      expect(tranche.state.status).toBe('refund_pending');

      /* --- Шаг 6: поручение на возврат ушло --- */
      previous = tranche;
      state = step(state, { type: 'refund_initiated' }, START + 5_000, {
        collectedAmount: AMOUNT,
        lockedAmount: AMOUNT,
      });
      tranche = { ...tranche, state };
      const payout: PayoutSnapshot = {
        payoutId: 'payout-scenario-refund',
        dealId: DEAL,
        state: {
          status: 'submitted',
          idempotencyKey: refundIdempotencyKey(TRANCHE),
          trancheId: TRANCHE,
          leg: 'refund',
        },
        amount: AMOUNT,
        // Красная линия №9: возврат только на счёт-источник, на имя плательщика.
        beneficiary: BUYER,
        evidenceBundleId: 'evidence-bundle-scenario',
        providerReference: null,
      };
      chain = auditStep(chain, 5, START + 5_000, {
        kind: 'state_transition',
        machine: 'tranche',
        from: 'refund_pending',
        to: 'refunding',
        eventKey: 'refund_initiated',
        failedGuards: [],
      });
      await store.transact(async (tx) => {
        await tx.saveTranche(tranche, previous);
        await tx.savePayout(payout, null);
        await tx.appendAudit([chain.records[5]!]);
      });
      expect(tranche.state.status).toBe('refunding');

      /* --- Шаг 7: банк подтвердил. Деньги распёрты и вернулись клиенту --- */
      const unlock = unlockToClientAccount(
        meta('sc-3-unlock', START + 6_000),
        BUYER_ACCOUNT,
        { dealId: DEAL, trancheId: TRANCHE },
        AMOUNT,
      );
      previous = tranche;
      state = step(
        state,
        { type: 'payout_result', outcome: 'settled' },
        START + 6_000,
        { collectedAmount: AMOUNT, lockedAmount: AMOUNT, activePayouts: 1 },
      );
      tranche = { ...tranche, state };
      const settledPayout: PayoutSnapshot = {
        ...payout,
        state: { ...payout.state, status: 'settled' },
        providerReference: 'psp/2026/03/01/refund-1',
      };
      chain = auditStep(chain, 6, START + 6_000, {
        kind: 'payout_result',
        outcome: 'settled',
        // У ответившего провайдера ссылка на ответ обязательна: `unknown` —
        // единственный исход, у которого её может не быть (§2.2).
        response: BANK_RESPONSE,
        reasonKey: null,
      });
      await store.transact(async (tx) => {
        await tx.appendJournal([unlock]);
        await tx.saveTranche(tranche, previous);
        await tx.savePayout(settledPayout, payout);
        await tx.appendAudit([chain.records[6]!]);
      });
      expect(tranche.state.status).toBe('refunded');

      /* --- Мир поднимается из базы заново --- */
      const reloaded = await store.transact(async (tx) => ({
        journal: await tx.readJournal(),
        chain: await tx.readChain(CHAIN),
        deal: await tx.loadDeal(DEAL),
        tranche: await tx.loadTranche(DEAL, TRANCHE),
        payouts: await tx.loadPayouts(DEAL, TRANCHE),
      }));

      // Инварианты учёта на поднятом журнале — те же, что на исходном.
      const source = [topUp, lock, unlock];
      expect(reloaded.journal.entries).toEqual(source);
      expect(checkLedgerInvariants(reloaded.journal)).toEqual([]);
      // Цепочка аудита цела и той же длины.
      expect(verifyChain(reloaded.chain).intact).toBe(true);
      expect(reloaded.chain.records).toHaveLength(7);
      expect(reloaded.chain).toEqual(chain);
      // Состояние — то же самое значение домена, включая акт получателя,
      // который терминальный вариант союза не несёт, а база хранит как историю.
      expect(reloaded.deal).toEqual(deal);
      expect(reloaded.tranche).toEqual(tranche);
      expect(reloaded.payouts).toEqual([settledPayout]);
    });
  });

  it('шаг ложится целиком или не ложится вовсе', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      const store: WorldStore = savepointStore(client);
      await store.transact(async (tx) => {
        await tx.saveDeal({
          dealId: DEAL,
          state: dealState('ready'),
          buyer: BUYER,
          seller: SELLER,
        });
      });
      const topUp = clientTopUp(meta('sc-atomic', START + 2_000), BUYER_ACCOUNT, AMOUNT);
      // Шаг кладёт проводки, а потом спотыкается о состояние: транш уходит из
      // состояния, которого в базе нет вовсе. Проводки обязаны уйти вместе с ним.
      const doomed = store.transact(async (tx) => {
        await tx.appendJournal([topUp]);
        await tx.saveTranche(
          {
            dealId: DEAL,
            trancheId: 'tranche-ghost',
            state: initialTrancheState(instant(START), DEFAULT_DEADLINE_POLICY),
            required: AMOUNT,
          },
          {
            dealId: DEAL,
            trancheId: 'tranche-ghost',
            state: initialTrancheState(instant(START + 999), DEFAULT_DEADLINE_POLICY),
            required: AMOUNT,
          },
        );
      });
      await expect(doomed).rejects.toThrow();
      const after = await store.transact(async (tx) => tx.readJournal());
      expect(after.entries).toEqual([]);
    });
  });
});
