import type { Instant } from '@sdelka/domain';
import {
  type Decision,
  type DetectorOutcome,
  type PolicyVersionId,
  combineOutcomes,
} from '../decision';
import type { ReasonKey } from '../keys';
import type { CompliancePolicy } from '../policy';
import { type FlippingFacts, assessFlipping } from './flipping';
import { type LinkageFacts, assessLinkage } from './linkage';
import { type PayerFacts, assessPayer } from './payer';
import { type PriceFacts, assessPrice } from './price';
import { type RefundFacts, assessRefundDestination } from './refund';
import { type StructuringFacts, assessStructuring } from './structuring';

/**
 * Детекторы, встроенные в поток. Прогон — чистая функция над фактами: ни сети,
 * ни базы, ни вызовов провайдера. Всё, что нужно решению, уже в аргументах.
 */
export const DETECTOR_IDS = [
  'payer',
  'refund',
  'price',
  'structuring',
  'linkage',
  'flipping',
] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

/**
 * Факты по каждому детектору. `null` — детектор неприменим к событию (возврата
 * нет, договора ещё нет). Запись тотальная: новый детектор не соберётся, пока
 * для него не назван вход.
 */
export type DetectorFacts = {
  readonly payer: PayerFacts | null;
  readonly refund: RefundFacts | null;
  readonly price: PriceFacts | null;
  readonly structuring: StructuringFacts | null;
  readonly linkage: LinkageFacts | null;
  readonly flipping: FlippingFacts | null;
};

export interface DetectorResult {
  readonly id: DetectorId;
  readonly decision: Decision<DetectorOutcome>;
}

export interface DetectorReport {
  /** Сводный исход — максимум по лестнице, а не большинство голосов. */
  readonly outcome: DetectorOutcome;
  readonly policyVersionId: PolicyVersionId;
  readonly decidedAt: Instant;
  readonly results: readonly DetectorResult[];
  readonly reasons: readonly ReasonKey[];
}

export function runDetectors(
  facts: DetectorFacts,
  policy: CompliancePolicy,
  now: Instant,
): DetectorReport {
  const results: DetectorResult[] = [];
  const version = policy.version;

  if (facts.payer !== null) {
    results.push({ id: 'payer', decision: assessPayer(facts.payer, version, now) });
  }
  if (facts.refund !== null) {
    results.push({ id: 'refund', decision: assessRefundDestination(facts.refund, version, now) });
  }
  if (facts.price !== null) {
    results.push({ id: 'price', decision: assessPrice(facts.price, version, policy.price, now) });
  }
  if (facts.structuring !== null) {
    results.push({
      id: 'structuring',
      decision: assessStructuring(facts.structuring, version, policy.structuring, now),
    });
  }
  if (facts.linkage !== null) {
    results.push({ id: 'linkage', decision: assessLinkage(facts.linkage, version, now) });
  }
  if (facts.flipping !== null) {
    results.push({
      id: 'flipping',
      decision: assessFlipping(facts.flipping, version, policy.flipping, now),
    });
  }

  const reasons: ReasonKey[] = [];
  for (const result of results) {
    for (const reason of result.decision.reasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }

  return Object.freeze({
    outcome: combineOutcomes(results.map((result) => result.decision.outcome)),
    policyVersionId: version,
    decidedAt: now,
    results: Object.freeze(results),
    reasons: Object.freeze(reasons),
  });
}
