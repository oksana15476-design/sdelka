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
import type { PricePolicy } from '../policy';

/**
 * Расхождение суммы через платформу с ценой в договоре — стоп и оценка на подачу
 * отчёта о подозрении (`PRODUCT.md` §10). Предложение указать другую сумму —
 * блок, красная линия (`CCO-compliance.md`: «не участвовать в двух ценах»).
 *
 * Сравниваются две **заявленные** величины, а не полученная с отправленной,
 * поэтому допуск по умолчанию нулевой: срезы корреспондентов относятся к
 * полноте поступления (`FUNCTIONAL.md` §3.6), а не к цене договора.
 */
export interface PriceFacts {
  readonly contractPrice: Money<CurrencyCode> | null;
  readonly platformAmount: Money<CurrencyCode>;
  /** Клиент или агент предложил указать другую сумму. */
  readonly differentAmountRequested: boolean;
  readonly evidence: readonly EvidenceRef[];
}

export interface PriceAssessment extends Decision<DetectorOutcome> {
  /** Фактическое расхождение в минорных единицах. Положительное — платформа выше договора. */
  readonly deltaMinor: bigint | null;
  readonly deltaBp: number | null;
  readonly suspicionAssessmentRequired: boolean;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function assessPrice(
  facts: PriceFacts,
  policy: PolicyVersionId,
  pricePolicy: PricePolicy,
  now: Instant,
): PriceAssessment {
  if (facts.differentAmountRequested) {
    return Object.freeze({
      ...decision<DetectorOutcome>(
        'block',
        policy,
        now,
        [REASON_KEYS.priceSecondAmountRequested, REASON_KEYS.priceSuspicionAssessmentRequired],
        facts.evidence,
      ),
      deltaMinor: null,
      deltaBp: null,
      suspicionAssessmentRequired: true,
    });
  }

  const contract = facts.contractPrice;
  if (contract === null || contract.minor <= 0n) {
    return Object.freeze({
      ...decision<DetectorOutcome>(
        'stop',
        policy,
        now,
        [REASON_KEYS.priceContractMissing],
        facts.evidence,
      ),
      deltaMinor: null,
      deltaBp: null,
      suspicionAssessmentRequired: false,
    });
  }
  if (contract.currency !== facts.platformAmount.currency) {
    // Fail-closed: несравнимые величины — это стоп, а не «наверное совпадает».
    return Object.freeze({
      ...decision<DetectorOutcome>(
        'stop',
        policy,
        now,
        [REASON_KEYS.priceCurrencyMismatch],
        facts.evidence,
      ),
      deltaMinor: null,
      deltaBp: null,
      suspicionAssessmentRequired: false,
    });
  }

  const deltaMinor = facts.platformAmount.minor - contract.minor;
  // Доля считается с округлением вверх по модулю: на границе допуска решение
  // принимается в строгую сторону.
  const deltaBp = Number((abs(deltaMinor) * 10_000n + contract.minor - 1n) / contract.minor);
  if (deltaMinor === 0n || deltaBp <= pricePolicy.toleranceBp) {
    return Object.freeze({
      ...decision<DetectorOutcome>(
        'clear',
        policy,
        now,
        [REASON_KEYS.priceMatchesContract],
        facts.evidence,
      ),
      deltaMinor,
      deltaBp: deltaMinor === 0n ? 0 : deltaBp,
      suspicionAssessmentRequired: false,
    });
  }

  const direction: ReasonKey =
    deltaMinor < 0n ? REASON_KEYS.priceBelowContract : REASON_KEYS.priceAboveContract;
  return Object.freeze({
    ...decision<DetectorOutcome>(
      'stop',
      policy,
      now,
      [direction, REASON_KEYS.priceSuspicionAssessmentRequired],
      facts.evidence,
    ),
    deltaMinor,
    deltaBp,
    suspicionAssessmentRequired: true,
  });
}
