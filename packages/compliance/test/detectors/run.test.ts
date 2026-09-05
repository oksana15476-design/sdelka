import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type DetectorFacts,
  combineOutcomes,
  compareNames,
  DETECTOR_IDS,
  runDetectors,
} from '../../src/index';
import {
  ACCOUNT_OTHER,
  ACCOUNT_SOURCE,
  BUYER_DOCUMENT,
  BUYER_NAMES,
  document,
  evidence,
  NOW,
  POLICY,
} from '../support/fixtures';

const strong = { strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp };

const empty: DetectorFacts = {
  payer: null,
  refund: null,
  price: null,
  structuring: null,
  linkage: null,
  flipping: null,
  counterparty: null,
};

describe('прогон детекторов', () => {
  it('без фактов — пусто и чисто', () => {
    const report = runDetectors(empty, POLICY, NOW);
    expect(report.outcome).toBe('clear');
    expect(report.results).toHaveLength(0);
    expect(report.policyVersionId).toBe(POLICY.version);
  });

  it('сводный исход — максимум по лестнице, а не большинство', () => {
    const report = runDetectors(
      {
        ...empty,
        payer: {
          buyerDocument: BUYER_DOCUMENT,
          origin: {
            kind: 'external_transfer',
            payerDocument: document(6),
            senderNameMatch: compareNames(BUYER_NAMES, BUYER_NAMES, strong),
          },
          relationship: { kind: 'intermediary' },
          evidence: [],
        },
        price: {
          contractPrice: money('GEL', 24_000_000n),
          platformAmount: money('GEL', 24_000_000n),
          differentAmountRequested: false,
          evidence: [evidence(1, 'contract')],
        },
      },
      POLICY,
      NOW,
    );
    expect(report.results.map((item) => item.id)).toEqual(['payer', 'price']);
    expect(report.outcome).toBe('block');
  });

  it('лестница исходов упорядочена', () => {
    expect(combineOutcomes([])).toBe('clear');
    expect(combineOutcomes(['clear', 'review'])).toBe('review');
    expect(combineOutcomes(['review', 'stop'])).toBe('stop');
    expect(combineOutcomes(['stop', 'hold'])).toBe('hold');
    expect(combineOutcomes(['hold', 'block'])).toBe('block');
  });

  it('возврат на чужой счёт блокирует сводный исход', () => {
    const report = runDetectors(
      {
        ...empty,
        refund: {
          sourceAccount: ACCOUNT_SOURCE,
          sourceHolder: BUYER_DOCUMENT,
          requestedAccount: ACCOUNT_OTHER,
          requestedHolder: BUYER_DOCUMENT,
          sanctionsFrozen: false,
          evidence: [],
        },
      },
      POLICY,
      NOW,
    );
    expect(report.outcome).toBe('block');
  });

  it('одна личность на обеих сторонах поднимает сводный исход до отказа', () => {
    const report = runDetectors(
      {
        ...empty,
        counterparty: {
          participations: [
            { partyId: 'p', role: 'payer', document: BUYER_DOCUMENT },
            { partyId: 'r', role: 'recipient', document: BUYER_DOCUMENT },
          ],
          relation: { kind: 'unrelated' },
          nameMatch: null,
          evidence: [],
        },
      },
      POLICY,
      NOW,
    );
    expect(report.outcome).toBe('block');
    expect(report.reasons).toContain('compliance.counterparty.same_identity');
  });

  /**
   * Детектор, который перестал запускаться, не выглядит как поломка: прогон
   * возвращает решение, сводный исход считается, отчёт собирается — просто одна
   * типология больше не проверяется. Перечень `DETECTOR_IDS` при этом остаётся
   * прежним, поэтому сверка перечня с самим собой такого не ловит: ловит только
   * прогон со всеми фактами сразу.
   */
  it('со всеми фактами прогоняются все объявленные детекторы', () => {
    const report = runDetectors(
      {
        payer: {
          buyerDocument: BUYER_DOCUMENT,
          origin: {
            kind: 'external_transfer',
            payerDocument: BUYER_DOCUMENT,
            senderNameMatch: compareNames(BUYER_NAMES, BUYER_NAMES, strong),
          },
          relationship: { kind: 'self' },
          evidence: [],
        },
        refund: {
          sourceAccount: ACCOUNT_SOURCE,
          sourceHolder: BUYER_DOCUMENT,
          requestedAccount: ACCOUNT_SOURCE,
          requestedHolder: BUYER_DOCUMENT,
          sanctionsFrozen: false,
          evidence: [],
        },
        price: {
          contractPrice: money('GEL', 24_000_000n),
          platformAmount: money('GEL', 24_000_000n),
          differentAmountRequested: false,
          evidence: [evidence(1, 'contract')],
        },
        structuring: { payments: [], evidence: [] },
        linkage: { parties: [], declaredRelationships: [], evidence: [] },
        flipping: {
          cadastralCode: 'code-1',
          currentPrice: money('GEL', 24_000_000n),
          priorTransfers: [],
          evidence: [],
        },
        counterparty: {
          participations: [
            { partyId: 'p', role: 'payer', document: BUYER_DOCUMENT },
            { partyId: 'r', role: 'recipient', document: document(6) },
          ],
          relation: { kind: 'unrelated' },
          nameMatch: null,
          evidence: [],
        },
      },
      POLICY,
      NOW,
    );
    expect(report.results.map((item) => item.id)).toEqual([...DETECTOR_IDS]);
    expect(report.outcome).toBe('clear');
    // Причины сводятся без повторов, но каждый детектор приносит свою.
    expect(report.reasons).toHaveLength(DETECTOR_IDS.length);
  });

  it('перечень детекторов совпадает с реализованными', () => {
    expect([...DETECTOR_IDS]).toEqual([
      'payer',
      'refund',
      'price',
      'structuring',
      'linkage',
      'flipping',
      'counterparty',
    ]);
  });
});
