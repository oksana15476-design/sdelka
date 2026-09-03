import {
  type Journal,
  appendEntries,
  balanceByCurrency,
  coverage,
  coverageByTranche,
  emptyJournal,
  isEveryTrancheCovered,
  isFullyCovered,
  negativeClientBalances,
} from '@sdelka/ledger';
import { type Money, money, rational, rationalFromDecimalString, split, splitPartsTotal } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type TrancheContext,
  type TrancheEvent,
  type TrancheFacts,
  type TrancheState,
  type TrancheStatus,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_DEADLINE_POLICY,
  initialTrancheState,
  isTerminalTrancheStatus,
  reduceTranche,
} from '../src/index';
import {
  BUYER_PARTY_ID,
  CONDITION_ACT,
  CREATED_ON,
  MATCHING_STATEMENT,
  NOW,
} from './support/facts';
import { projectIntents } from './support/ledger-projection';

/**
 * Тест на свойствах: генератор написан здесь, потому что зависимость ради
 * случайных чисел в денежном ядре не нужна. Псевдослучайность детерминирована
 * seed'ом — упавший прогон воспроизводится.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) {
    throw new Error('empty pool');
  }
  return item;
}

const FEE_RATE = rationalFromDecimalString('0.005');

/**
 * Пул событий со смещением к денежному пути: без смещения случайное блуждание
 * почти не доходит до выплаты, и свойство проверялось бы на пустом журнале.
 * Смещение — в частоте событий, не в разрешениях: guard'ы не ослаблены.
 */
const EVENT_POOL = [
  'instructions_issued',
  'instructions_issued',
  'funds_received',
  'funds_received',
  'funds_received',
  'reserve_requested',
  'reserve_requested',
  'condition_established',
  'condition_established',
  'release_authorized',
  'release_authorized',
  'payout_result',
  'payout_result',
  'refund_initiated',
  'refund_initiated',
  'reserve_expired',
  'revocation_requested',
  'condition_failed',
  'mismatch_detected',
  'approval_added',
  'operator_blocked',
  'reconciliation_resolved',
  'deadline_reached',
  'refund_requested',
] as const;

function randomEvent(random: () => number, required: Money<'GEL'>): TrancheEvent {
  const choice = pick(random, EVENT_POOL);
  switch (choice) {
    case 'funds_received':
      return {
        type: 'funds_received',
        amount: random() < 0.8 ? required : money('GEL', required.minor - BigInt(Math.floor(random() * 1000) + 1)),
        sender: random() < 0.7 ? 'buyer-1' : 'third-party',
        reference: 'ref',
      };
    case 'revocation_requested':
      return { type: 'revocation_requested', actor: 'buyer' };
    case 'condition_established':
      return {
        type: 'condition_established',
        evidenceBundleId: 'evidence-1',
        // registration_preliminary попадает в поток намеренно: редьюсер обязан
        // отказать по нему, а не тихо его принять (STATE-MACHINES.md §8).
        conditionType: pick(random, [
          'registration_transfer',
          'calendar_date',
          'registration_preliminary',
        ] as const),
      };
    case 'mismatch_detected':
      return { type: 'mismatch_detected', field: 'share' };
    case 'approval_added':
      return { type: 'approval_added', userId: `operator-${Math.floor(random() * 3) + 2}` };
    case 'operator_blocked':
      return { type: 'operator_blocked', reason: 'reason' };
    case 'payout_result':
      return { type: 'payout_result', outcome: pick(random, ['settled', 'rejected', 'unknown'] as const) };
    case 'reconciliation_resolved':
      return {
        type: 'reconciliation_resolved',
        outcome: pick(random, ['settled', 'rejected'] as const),
      };
    case 'refund_requested':
      return { type: 'refund_requested', reason: 'reason' };
    default:
      return { type: choice };
  }
}

/**
 * Половина шагов берётся из «денежного» направления для текущего состояния,
 * половина — из общего пула. Без направления случайное блуждание почти всегда
 * заканчивается возвратом, и путь выплаты оставался бы непроверенным.
 * Направление меняет только частоту событий: ни один guard не ослаблен.
 */
function guidedEvent(random: () => number, status: TrancheStatus, required: Money<'GEL'>): TrancheEvent | null {
  switch (status) {
    case 'pending':
      return { type: 'instructions_issued' };
    case 'collecting':
      return { type: 'funds_received', amount: required, sender: 'buyer-1', reference: 'ref' };
    case 'collected':
      return { type: 'reserve_requested' };
    case 'reserved':
      return {
        type: 'condition_established',
        evidenceBundleId: 'evidence-1',
        conditionType: 'registration_transfer',
      };
    case 'release_pending':
      return { type: 'release_authorized' };
    case 'release_blocked':
      return { type: 'approval_added', userId: 'operator-2' };
    case 'paying_out':
      return { type: 'payout_result', outcome: random() < 0.8 ? 'settled' : 'unknown' };
    case 'refund_pending':
      return { type: 'refund_initiated' };
    case 'refunding':
      return { type: 'payout_result', outcome: 'settled' };
    default:
      return null;
  }
}

function assertLedgerInvariants(journal: Journal): void {
  for (const entry of journal.entries) {
    for (const total of balanceByCurrency(entry.postings).values()) {
      // Сумма проводок равна нулю на каждом переходе с деньгами.
      expect(total).toBe(0n);
    }
  }
  // Покрытие клиентских средств никогда не опускается ниже единицы...
  expect(isFullyCovered(journal)).toBe(true);
  // ...и не сходится «в целом» при расхождении внутри сделки.
  expect(isEveryTrancheCovered(journal)).toBe(true);
  // Остаток клиентского счёта никогда не отрицателен.
  expect(negativeClientBalances(journal)).toEqual([]);
}

describe('свойства на случайных последовательностях событий', () => {
  it('keeps client funds coverage at or above one and client balances non-negative', () => {
    let journal = emptyJournal;
    const terminals = new Map<string, number>();
    for (let run = 0; run < 300; run += 1) {
      const random = makeRandom(run + 1);
      const dealId = `deal-${run}`;
      const trancheId = `tranche-${run}`;
      const required = money('GEL', BigInt(Math.floor(random() * 5_000_000) + 10_000));
      let collected: Money<'GEL'> | null = null;
      // Инварианты проверяются на журнале прогона на каждом шаге, а на общем
      // журнале — по завершении прогона: общий журнал ловит ровно то, ради чего
      // он общий, — финансирование одной сделки средствами другой.
      let runJournal = emptyJournal;
      let state: TrancheState = initialTrancheState(NOW, DEFAULT_DEADLINE_POLICY);

      for (let step = 0; step < 24 && !isTerminalTrancheStatus(state.status); step += 1) {
        const facts: TrancheFacts = {
          requiredAmount: required,
          collectedAmount: collected,
          buyerPayerKey: 'buyer-1',
          buyerPartyId: BUYER_PARTY_ID,
          conditionAct: CONDITION_ACT,
          evidenceBundleId: random() < 0.9 ? 'evidence-1' : null,
          statementFields: MATCHING_STATEMENT,
          registryOwnerIsBuyer: true,
          beneficiary: { locked: true, lastChangedAt: null },
          preparedBy: 'operator-1',
          approvals: [{ userId: 'operator-2' }, { userId: 'operator-3' }],
          approvalPolicy: DEFAULT_APPROVAL_POLICY,
          createdOn: CREATED_ON,
          officialRateAtCreation: null,
          activePayouts: 0,
          coverageOk: true,
          sourceAccountKnown: random() < 0.8,
          mismatchResolved: random() < 0.5,
        };
        const context: TrancheContext = {
          now: NOW,
          dealId,
          trancheId,
          facts,
          deadlinePolicy: DEFAULT_DEADLINE_POLICY,
        };
        const guided = random() < 0.5 ? guidedEvent(random, state.status, required) : null;
        const event = guided ?? randomEvent(random, required);
        const result = reduceTranche(state, event, context);
        if (!result.ok) {
          continue;
        }
        runJournal = projectIntents(runJournal, result.value.intents, { feeRate: FEE_RATE });
        if (result.value.state.status === 'collected' && event.type === 'funds_received') {
          collected = event.amount as Money<'GEL'>;
        }
        state = result.value.state;
        assertLedgerInvariants(runJournal);
      }
      journal = appendEntries(journal, runJournal.entries);
      assertLedgerInvariants(journal);
      if (isTerminalTrancheStatus(state.status)) {
        terminals.set(state.status, (terminals.get(state.status) ?? 0) + 1);
      }
    }
    // Прогон должен был действительно двигать деньги, иначе свойство пустое.
    expect(journal.entries.length).toBeGreaterThan(300);
    expect(coverage(journal).length).toBeGreaterThan(0);
    expect(coverageByTranche(journal).length).toBeGreaterThan(200);
    expect(terminals.get('paid_out') ?? 0).toBeGreaterThan(100);
    expect(terminals.get('refunded') ?? 0).toBeGreaterThan(20);
  });

  it('split always adds up to the original amount', () => {
    const random = makeRandom(42);
    for (let run = 0; run < 500; run += 1) {
      const total = money('GEL', BigInt(Math.floor(random() * 10_000_000)));
      const deductions = [
        { key: 'fee:income', rate: rational(BigInt(Math.floor(random() * 100)), 10_000n) },
        { key: 'partner:fee', rate: rational(BigInt(Math.floor(random() * 50)), 10_000n) },
        { key: 'psp:fee:expense', fixed: BigInt(Math.floor(random() * 100)) },
      ];
      const result = split(total, deductions);
      expect(splitPartsTotal(result).minor).toBe(total.minor);
      expect(result.recipient.minor).toBeGreaterThanOrEqual(0n);
      for (const part of result.deductions) {
        expect(part.amount.minor).toBeGreaterThanOrEqual(0n);
      }
    }
  });
});
