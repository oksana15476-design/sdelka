import type { Instant } from '@sdelka/domain';
import {
  type Decision,
  type DetectorOutcome,
  type EvidenceRef,
  type PolicyVersionId,
  decision,
} from '../decision';
import { type IdentityDocument, sameIdentity } from '../identity';
import { type ReasonKey, REASON_KEYS } from '../keys';
import type { AccountFingerprint } from '../pii';

/**
 * Возврат — только на счёт-источник, на имя плательщика. **Без исключений**
 * (красная линия №9, `PRODUCT.md` §10, `CCO-compliance.md`).
 *
 * Отсутствие исключений выражено формой типа: у `RefundFacts` нет ни поля
 * основания, ни поля утверждающего, ни поля вида отношений. Исключение здесь
 * невозможно передать — не потому, что оно отвергается, а потому, что нечем.
 * «Клиент закрыл счёт» разбирается процедурой вне возврата, а не флагом.
 */
export interface RefundFacts {
  /** Счёт, с которого пришли деньги. `null` — поступление не опознано. */
  readonly sourceAccount: AccountFingerprint | null;
  /** Владелец счёта-источника по данным банка. */
  readonly sourceHolder: IdentityDocument | null;
  readonly requestedAccount: AccountFingerprint;
  readonly requestedHolder: IdentityDocument | null;
  /**
   * Санкционная заморозка. `CORE.md` Ф17 [решение]: заморозка имеет приоритет
   * над возвратом по умолчанию — замороженные средства исполнять запрещено.
   */
  readonly sanctionsFrozen: boolean;
  readonly evidence: readonly EvidenceRef[];
}

export type RefundDecision = Decision<DetectorOutcome>;

export function assessRefundDestination(
  facts: RefundFacts,
  policy: PolicyVersionId,
  now: Instant,
): RefundDecision {
  const reasons: ReasonKey[] = [];

  if (facts.sanctionsFrozen) {
    reasons.push(REASON_KEYS.refundSanctionsFreezePrecedence);
    return decision<DetectorOutcome>('block', policy, now, reasons, facts.evidence);
  }
  if (facts.sourceAccount === null || facts.sourceHolder === null) {
    reasons.push(REASON_KEYS.refundSourceAccountUnknown);
    return decision<DetectorOutcome>('block', policy, now, reasons, facts.evidence);
  }
  if (facts.requestedAccount !== facts.sourceAccount) {
    reasons.push(REASON_KEYS.refundAccountDiffers);
  }
  if (facts.requestedHolder === null || !sameIdentity(facts.requestedHolder, facts.sourceHolder)) {
    reasons.push(REASON_KEYS.refundHolderDiffers);
  }
  if (reasons.length > 0) {
    return decision<DetectorOutcome>('block', policy, now, reasons, facts.evidence);
  }
  return decision<DetectorOutcome>(
    'clear',
    policy,
    now,
    [REASON_KEYS.refundToSourceAccount],
    facts.evidence,
  );
}
