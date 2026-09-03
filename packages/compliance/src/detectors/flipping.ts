import type { Instant } from '@sdelka/domain';
import type { CurrencyCode, Money } from '@sdelka/money';
import {
  type Decision,
  type DetectorOutcome,
  type EvidenceRef,
  type PolicyVersionId,
  decision,
} from '../decision';
import { type ReasonKey, REASON_KEYS } from '../keys';
import type { FlippingPolicy } from '../policy';

/**
 * Быстрая перепродажа одного объекта (`PRODUCT.md` §10, `CCO-compliance.md`).
 *
 * Считается по кадастровому коду, а не по сторонам: смысл типологии в том, что
 * стороны каждый раз новые. Скачок цены между переходами поднимает исход со
 * «в очередь» до «стоп»: именно ценовой скачок отличает перепродажу от отмывания.
 */
export interface PropertyTransfer {
  readonly transferId: string;
  readonly cadastralCode: string;
  readonly registeredAt: Instant;
  readonly price: Money<CurrencyCode> | null;
}

export interface FlippingFacts {
  readonly cadastralCode: string;
  readonly currentPrice: Money<CurrencyCode> | null;
  readonly priorTransfers: readonly PropertyTransfer[];
  readonly evidence: readonly EvidenceRef[];
}

export interface FlippingAssessment extends Decision<DetectorOutcome> {
  /** Переходы того же объекта внутри окна, от самого свежего. */
  readonly recentTransfers: readonly PropertyTransfer[];
  /** Сколько прошло с последнего перехода, миллисекунды. `null` — переходов нет. */
  readonly sinceLastTransferMs: number | null;
  /** Скачок цены к последнему переходу в базисных пунктах. `null` — не считается. */
  readonly priceJumpBp: number | null;
}

export function assessFlipping(
  facts: FlippingFacts,
  policyVersion: PolicyVersionId,
  flipping: FlippingPolicy,
  now: Instant,
): FlippingAssessment {
  const recent = facts.priorTransfers
    .filter(
      (transfer) =>
        transfer.cadastralCode === facts.cadastralCode &&
        transfer.registeredAt <= now &&
        now - transfer.registeredAt <= flipping.window,
    )
    .sort((left, right) => right.registeredAt - left.registeredAt);

  const latest = recent[0];
  if (latest === undefined) {
    return Object.freeze({
      ...decision<DetectorOutcome>(
        'clear',
        policyVersion,
        now,
        [REASON_KEYS.flippingNone],
        facts.evidence,
      ),
      recentTransfers: Object.freeze(recent),
      sinceLastTransferMs: null,
      priceJumpBp: null,
    });
  }

  const reasons: ReasonKey[] = [REASON_KEYS.flippingRecentTransfer];
  let priceJumpBp: number | null = null;
  const previous = latest.price;
  const current = facts.currentPrice;
  if (
    previous !== null &&
    current !== null &&
    previous.currency === current.currency &&
    previous.minor > 0n
  ) {
    const delta = current.minor - previous.minor;
    priceJumpBp = Number((delta * 10_000n) / previous.minor);
  }
  const escalate = priceJumpBp !== null && priceJumpBp >= flipping.priceJumpBp;
  if (escalate) reasons.push(REASON_KEYS.flippingPriceJump);

  return Object.freeze({
    ...decision<DetectorOutcome>(
      escalate ? 'stop' : 'review',
      policyVersion,
      now,
      reasons,
      facts.evidence,
    ),
    recentTransfers: Object.freeze(recent),
    sinceLastTransferMs: now - latest.registeredAt,
    priceJumpBp,
  });
}
