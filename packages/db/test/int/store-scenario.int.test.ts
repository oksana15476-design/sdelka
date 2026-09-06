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
  RELEASE_CONDITIONS,
  beneficiaryConfirmation,
  dealState,
  initialTrancheState,
  instant,
  participationKey,
  payoutIdempotencyKey,
  reduceTranche,
  refundIdempotencyKey,
  releaseObservation,
} from '@sdelka/domain';
import {
  type DealPartiesAttestation,
  type EntryMeta,
  accrueFee,
  checkLedgerInvariants,
  clientKey,
  clientTopUp,
  feeCeiling,
  lockForTranche,
  receiveFee,
  settleTrancheToClientAccount,
  trancheSettlement,
  unlockToClientAccount,
} from '@sdelka/ledger';
import { isoDate, money, rational } from '@sdelka/money';
import { expect, it } from 'vitest';
import { pgWorldStore } from '../../src/store/pg-store.ts';
import type { JournalScope, WorldStore } from '../../src/store/port.ts';
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
 * **Оба сценария идут под ролью приложения** — той самой, под которой пишет
 * продукт, и с теми правами, которые оставляет инвариант 21. Прежняя редакция
 * шла под ролью владельца, и это был не выбор, а обход дефекта: под
 * `sdelka_app` дописать запись журнала аудита было невозможно вовсе
 * (`assert_audit_chain` брала `SELECT … FOR UPDATE` от имени вызывающего).
 * Починено `0020_audit_append_only.sql`, разбор — в `store-grants.int.test.ts`.
 *
 * Второй сценарий — **расчёт получателю**, и прежде его здесь не было по той
 * же причине: расчёт идёт вместе с начислением комиссии, а колонок под
 * объявления `accrues`, `converts` и `funds` в `sdelka.ledger_entry` не было.
 * Завела `0021_entry_declarations.sql`.
 */

/**
 * Охват чтения — **весь журнал**, и он назван словом.
 *
 * Набор проверяет таблицу целиком: он идёт в откатываемой транзакции, где кроме
 * его же записей ничего нет. Пропуском аргумента этого больше не получить —
 * охват у чтения обязателен (`src/store/port.ts`, `JournalScope`).
 */
const WHOLE_JOURNAL: JournalScope = Object.freeze({
  kind: 'everything',
  reasonKey: 'db.test.whole_journal',
});

const { run, title, pool } = await dbSuite('хранилище: сквозной сценарий');

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

const SELLER_ACCOUNT = clientKey(SELLER.accountKey);

/**
 * Участие получателя в этой сделке. Реквизиты выплаты подтверждаются для него,
 * а не для лица (`@sdelka/domain`, `participation.ts`; ROADMAP.md И13.1).
 */
const SELLER_PARTICIPATION = participationKey(DEAL, SELLER, 'recipient');

/** Комиссия платформы: полтора процента, как у потока P2 (FUNCTIONAL.md §3.4). */
const FEE = money(GEL, 300_000n);
const NET = money(GEL, AMOUNT.minor - FEE.minor);
const TARIFF_VERSION = 'tariff/2026-01.1';

/**
 * Потолок удержания **строже** жёсткого предела учёта: полтора процента вместо
 * двух. Ровно та величина, которую прежде нельзя было записать — потолка в
 * схеме не было, и запись с ним хранилище отвергало.
 */
const CEILING = feeCeiling(rational(15n, 1_000n));

const CADASTRAL_CODE = 'cadastral-scenario';

/**
 * Наблюдение из реестра: платная выписка, все пять полей сошлись, собственник
 * установлен. Без него транш на путь выплаты не выходит ни одной дверью
 * (`g_observation_sufficient`, ORACLE.md §6.4).
 */
const OBSERVATION = releaseObservation({
  level: 'L3',
  conditionType: 'registration_transfer',
  sourceKey: RELEASE_CONDITIONS.registration_transfer.sourceKey,
  cadastralCode: CADASTRAL_CODE,
  fields: {
    cadastralCode: true,
    ownerDocumentNumber: true,
    share: true,
    basis: true,
    noUnexpectedEncumbrances: true,
  },
  ownerCheck: 'established',
  observedAt: instant(START + 3_500),
  rawSourceDigest: 'a'.repeat(64),
});

/**
 * Факты расчётной ветви. Два утверждающих, а не один: сумма транша выше первой
 * ступени `DEFAULT_APPROVAL_POLICY`, и оба отличаются от готовившего операцию —
 * это проверяет сам guard.
 */
const RELEASE_FACTS: Partial<TrancheFacts> = {
  collectedAmount: AMOUNT,
  lockedAmount: AMOUNT,
  observation: OBSERVATION,
  beneficiary: beneficiaryConfirmation({
    participation: SELLER_PARTICIPATION,
    status: 'verified',
    locked: true,
    lastChangedAt: null,
  }),
  approvals: [{ userId: 'approver-a-scenario' }, { userId: 'approver-b-scenario' }],
};

/**
 * Подтверждение сторон домена. `DealPartiesAttestation` держится на
 * ambient-символе: значения этого типа не существует, построить его кодом
 * нельзя, и выдавать его обязан домен. В сценарии домен играет тест — но
 * играет честно: та же пара сторон, что записана в сделке, и та же ссылка на
 * пакет доказательств, что у поручения.
 */
function attest(): DealPartiesAttestation {
  return {
    dealId: DEAL,
    trancheId: TRANCHE,
    payer: BUYER_ACCOUNT,
    recipient: SELLER_ACCOUNT,
    evidenceRef: 'evidence-bundle-scenario',
  } as unknown as DealPartiesAttestation;
}

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
    beneficiary: beneficiaryConfirmation({
      participation: SELLER_PARTICIPATION,
      status: 'verified',
      locked: false,
      lastChangedAt: null,
    }),
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
        journal: await tx.readJournal(WHOLE_JOURNAL),
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

  /**
   * Расчётная ветвь: условие наступило, деньги ушли получателю, комиссия
   * признана и выведена на операционный счёт.
   *
   * Прежде этот путь через базу не проходил вовсе: расчёт идёт вместе с
   * начислением комиссии, а объявление начисления несёт версию тарифного плана,
   * колонки под которую в `sdelka.ledger_entry` не было. Хранилище отвергало
   * такую запись — верно отвергало, — и сценарий обходился возвратом.
   *
   * Здесь проверяются обе половины красной линии №2: комиссия не остаётся на
   * номинальном счёте (`receiveFee` выводит её на операционный), и признана она
   * с версией плана, по которой посчитана (§4.2). Обе половины поднимаются из
   * базы обратно тем же значением.
   */
  it('расчёт получателю проходит целиком через базу и поднимается из неё', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      const store: WorldStore = savepointStore(client);
      const ref = { dealId: DEAL, trancheId: TRANCHE };

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

      /* --- Шаг 2: инструкции выданы --- */
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

      /* --- Шаг 3: деньги пришли --- */
      const topUp = clientTopUp(meta('st-1-top-up', START + 2_000), BUYER_ACCOUNT, AMOUNT);
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

      /* --- Шаг 4: резерв --- */
      const lock = lockForTranche(meta('st-2-lock', START + 3_000), BUYER_ACCOUNT, ref, AMOUNT);
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

      /* --- Шаг 5: условие установлено наблюдением из реестра --- */
      previous = tranche;
      state = step(
        state,
        {
          type: 'condition_established',
          evidenceBundleId: 'evidence-bundle-scenario',
          conditionType: 'registration_transfer',
        },
        START + 4_000,
        RELEASE_FACTS,
      );
      tranche = { ...tranche, state };
      chain = auditStep(chain, 4, START + 4_000, {
        kind: 'state_transition',
        machine: 'tranche',
        from: 'reserved',
        to: 'release_pending',
        eventKey: 'condition_established',
        failedGuards: [],
      });
      await store.transact(async (tx) => {
        await tx.saveTranche(tranche, previous);
        await tx.appendAudit([chain.records[4]!]);
      });
      expect(tranche.state.status).toBe('release_pending');

      /* --- Шаг 6: расчёт разрешён. Комиссия начислена, поручение ушло --- */
      const accrual = accrueFee(meta('st-3-accrual', START + 5_000), ref, FEE, TARIFF_VERSION);
      previous = tranche;
      state = step(state, { type: 'release_authorized' }, START + 5_000, RELEASE_FACTS);
      tranche = { ...tranche, state };
      const payout: PayoutSnapshot = {
        payoutId: 'payout-scenario-release',
        dealId: DEAL,
        state: {
          status: 'submitted',
          idempotencyKey: payoutIdempotencyKey(TRANCHE),
          trancheId: TRANCHE,
          leg: 'release',
        },
        amount: NET,
        beneficiary: SELLER,
        evidenceBundleId: 'evidence-bundle-scenario',
        providerReference: null,
      };
      chain = auditStep(chain, 5, START + 5_000, {
        kind: 'state_transition',
        machine: 'tranche',
        from: 'release_pending',
        to: 'paying_out',
        eventKey: 'release_authorized',
        failedGuards: [],
      });
      await store.transact(async (tx) => {
        await tx.appendJournal([accrual]);
        await tx.saveTranche(tranche, previous);
        await tx.savePayout(payout, null);
        await tx.appendAudit([chain.records[5]!]);
      });
      expect(tranche.state.status).toBe('paying_out');

      /* --- Шаг 7: банк подтвердил. Расчёт записан, комиссия выведена --- */
      const settlement = settleTrancheToClientAccount(
        meta('st-4-settle', START + 6_000),
        trancheSettlement(ref, BUYER_ACCOUNT, SELLER_ACCOUNT, attest(), CEILING),
        AMOUNT,
        accrual,
      );
      // Красная линия №2: комиссия платформы не хранится на номинальном счёте —
      // она выводится на операционный в момент расчёта, в том же журнале.
      const feeReceived = receiveFee(meta('st-5-fee', START + 6_500), ref, FEE);
      previous = tranche;
      state = step(state, { type: 'payout_result', outcome: 'settled' }, START + 6_000, {
        ...RELEASE_FACTS,
        activePayouts: 1,
      });
      tranche = { ...tranche, state };
      const settledPayout: PayoutSnapshot = {
        ...payout,
        state: { ...payout.state, status: 'settled' },
        providerReference: 'psp/2026/03/01/release-1',
      };
      chain = auditStep(chain, 6, START + 6_000, {
        kind: 'payout_result',
        outcome: 'settled',
        response: BANK_RESPONSE,
        reasonKey: null,
      });
      await store.transact(async (tx) => {
        await tx.appendJournal([settlement, feeReceived]);
        await tx.saveTranche(tranche, previous);
        await tx.savePayout(settledPayout, payout);
        await tx.appendAudit([chain.records[6]!]);
      });
      expect(tranche.state.status).toBe('paid_out');

      /* --- Мир поднимается из базы заново --- */
      const reloaded = await store.transact(async (tx) => ({
        journal: await tx.readJournal(WHOLE_JOURNAL),
        chain: await tx.readChain(CHAIN),
        deal: await tx.loadDeal(DEAL),
        tranche: await tx.loadTranche(DEAL, TRANCHE),
        payouts: await tx.loadPayouts(DEAL, TRANCHE),
      }));

      const source = [topUp, lock, accrual, settlement, feeReceived];
      expect(reloaded.journal.entries).toEqual(source);
      expect(checkLedgerInvariants(reloaded.journal)).toEqual([]);
      // Объявления, которых схема не держала: версия тарифного плана и потолок
      // удержания. Оба поднимаются тем же значением, а не умолчанием.
      expect(reloaded.journal.entries[2]?.accrues).toEqual({
        deal: ref,
        fee: FEE,
        tariffVersionId: TARIFF_VERSION,
      });
      expect(reloaded.journal.entries[3]?.settles?.ceiling).toEqual(CEILING);
      expect(verifyChain(reloaded.chain).intact).toBe(true);
      expect(reloaded.chain).toEqual(chain);
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
      const after = await store.transact(async (tx) => tx.readJournal(WHOLE_JOURNAL));
      expect(after.entries).toEqual([]);
    });
  });

  it('настоящее хранилище откатывает шаг целиком: ничего не зафиксировано', async () => {
    if (pool === null) return;
    // Здесь работает `pgWorldStore` с настоящими `BEGIN`/`COMMIT`, а не точки
    // сохранения: проверяется именно его граница транзакции. Зафиксировать шаг
    // этот тест не может по построению — он падает, — поэтому базу он не
    // засоряет, а журнал только дополняется и вычистить его было бы нечем.
    const store = pgWorldStore(pool);
    const entry = clientTopUp(meta('sc-committed', START + 9_000), BUYER_ACCOUNT, AMOUNT);
    const failed = store.transact(async (tx) => {
      await tx.appendJournal([entry]);
      throw new Error('шаг решил, что дальше нельзя');
    });
    await expect(failed).rejects.toThrow('шаг решил, что дальше нельзя');
    const after = await store.transact(async (tx) => tx.readJournal(WHOLE_JOURNAL));
    expect(after.entries.some((item) => item.id === entry.id)).toBe(false);
  });
});
