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
          payerDocument: document(6),
          relationship: { kind: 'intermediary' },
          senderNameMatch: compareNames(BUYER_NAMES, BUYER_NAMES, strong),
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

  it('перечень детекторов совпадает с реализованными', () => {
    expect([...DETECTOR_IDS]).toEqual([
      'payer',
      'refund',
      'price',
      'structuring',
      'linkage',
      'flipping',
    ]);
  });
});
