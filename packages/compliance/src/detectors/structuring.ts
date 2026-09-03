import type { Instant } from '@sdelka/domain';
import type { CurrencyCode, Money } from '@sdelka/money';
import {
  type Decision,
  type DetectorOutcome,
  type EvidenceRef,
  type PolicyVersionId,
  decision,
} from '../decision';
import { REASON_KEYS } from '../keys';
import type { StructuringPolicy } from '../policy';

/**
 * Разбиение платежа (`PRODUCT.md` §10, `CCO-compliance.md`).
 *
 * Признак не в том, что платежей несколько: добор после недоплаты — штатный
 * сценарий (`FUNCTIONAL.md` §3.6). Признак — **три и более платежа от одного
 * плательщика в окне, каждый строго ниже порога, а в сумме порог перекрыт**.
 * Числа — в политике; они помечены как рабочая гипотеза, документ их не задаёт.
 */
export interface InboundPayment {
  readonly paymentId: string;
  readonly amount: Money<CurrencyCode>;
  readonly receivedAt: Instant;
  /** Ключ плательщика — ключ личности, а не имя. */
  readonly payerKey: string;
}

export interface StructuringCluster {
  readonly payerKey: string;
  readonly currency: CurrencyCode;
  readonly paymentIds: readonly string[];
  readonly totalMinor: bigint;
  readonly firstAt: Instant;
  readonly lastAt: Instant;
}

export interface StructuringAssessment extends Decision<DetectorOutcome> {
  readonly clusters: readonly StructuringCluster[];
}

export interface StructuringFacts {
  readonly payments: readonly InboundPayment[];
  readonly evidence: readonly EvidenceRef[];
}

export function findStructuringClusters(
  facts: StructuringFacts,
  policy: StructuringPolicy,
): readonly StructuringCluster[] {
  const groups = new Map<string, InboundPayment[]>();
  for (const payment of facts.payments) {
    // Платежи крупнее порога дроблением не являются по определению.
    if (payment.amount.minor >= policy.threshold.minor) continue;
    if (payment.amount.currency !== policy.threshold.currency) continue;
    const key = `${payment.payerKey}|${payment.amount.currency}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [payment]);
    else bucket.push(payment);
  }

  const clusters: StructuringCluster[] = [];
  for (const bucket of groups.values()) {
    const sorted = [...bucket].sort((left, right) => left.receivedAt - right.receivedAt);
    let start = 0;
    for (let end = 0; end < sorted.length; end += 1) {
      const last = sorted[end];
      if (last === undefined) continue;
      while (start <= end) {
        const first = sorted[start];
        if (first === undefined) break;
        if (last.receivedAt - first.receivedAt <= policy.window) break;
        start += 1;
      }
      const window = sorted.slice(start, end + 1);
      if (window.length < policy.minPaymentCount) continue;
      const total = window.reduce((sum, item) => sum + item.amount.minor, 0n);
      if (total < policy.threshold.minor) continue;
      const first = window[0];
      if (first === undefined) continue;
      clusters.push(
        Object.freeze({
          payerKey: first.payerKey,
          currency: first.amount.currency,
          paymentIds: Object.freeze(window.map((item) => item.paymentId)),
          totalMinor: total,
          firstAt: first.receivedAt,
          lastAt: last.receivedAt,
        }),
      );
      // Один кластер на плательщика: повторные окна — тот же факт.
      break;
    }
  }
  return Object.freeze(clusters);
}

export function assessStructuring(
  facts: StructuringFacts,
  policyVersion: PolicyVersionId,
  structuring: StructuringPolicy,
  now: Instant,
): StructuringAssessment {
  const clusters = findStructuringClusters(facts, structuring);
  const detected = clusters.length > 0;
  return Object.freeze({
    ...decision<DetectorOutcome>(
      detected ? 'review' : 'clear',
      policyVersion,
      now,
      [detected ? REASON_KEYS.structuringPatternDetected : REASON_KEYS.structuringNoPattern],
      facts.evidence,
    ),
    clusters,
  });
}
