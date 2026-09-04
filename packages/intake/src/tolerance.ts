import {
  type CurrencyCode,
  type Money,
  isNegative,
  minimum,
  money,
  rational,
  scaleBy,
} from '@sdelka/money';
import { IntakeError, IntakeErrorCode } from './errors';
import { type IntakeReasonKey, INTAKE_REASON_KEYS } from './keys';
import type { IntakePolicy, TolerancePolicy } from './policy';

/**
 * Допуск по сумме — `FUNCTIONAL.md` §4.3.2.
 *
 * «Допуск задаётся политикой в абсолютной величине и в доле, **берётся
 * меньшее**, и раскрывается покупателю до платежа.» Здесь первая половина;
 * вторая — в `disclosure.ts`, и без неё величина отсюда в расчёт не попадает.
 */

/**
 * Разрешение допуска. Размеченное объединение, а не `Money | null`: «допуска нет»
 * и «допуск ноль» — разные факты с разными причинами для оператора, и складывать
 * их в отсутствующее значение значит терять причину ровно там, где она нужна.
 */
export type ToleranceResolution =
  | {
      readonly kind: 'declared';
      readonly amount: Money<CurrencyCode>;
      readonly reasons: readonly IntakeReasonKey[];
    }
  | {
      readonly kind: 'undeclared';
      readonly reasons: readonly IntakeReasonKey[];
    };

/** Величина допуска в разрешении: у неразрешённого она равна нулю в валюте требования. */
export function toleranceAmount(
  resolution: ToleranceResolution,
  currency: CurrencyCode,
): Money<CurrencyCode> {
  return resolution.kind === 'declared' ? resolution.amount : money(currency, 0n);
}

function absoluteFor(
  policy: TolerancePolicy,
  currency: CurrencyCode,
): Money<CurrencyCode> | null {
  return policy.absolute.find((item) => item.currency === currency) ?? null;
}

/**
 * Допуск по политике: меньшее из абсолютной величины и доли.
 *
 * Доля усекается (`trunc`), а не округляется вверх: допуск это послабление, и
 * округлять послабление в пользу послабления нельзя. Направление задано явным
 * аргументом, как требует `FUNCTIONAL.md` §4.3 («значения по умолчанию у
 * операции нет»).
 *
 * Валюта, для которой политика ничего не объявила, даёт `undeclared`, а не
 * пересчёт абсолюта по курсу: курс — внешний факт, а объявленная величина не
 * может ездить вместе с рынком между инструкцией и платежом (`INTAKE.md` §3.2).
 * Это та же форма закрытого отказа, что у `g_amount_sufficient` в домене: другая
 * валюта — не «мало», а «не те деньги».
 */
export function toleranceFor(
  required: Money<CurrencyCode>,
  policy: IntakePolicy,
): ToleranceResolution {
  if (isNegative(required)) {
    throw new IntakeError(IntakeErrorCode.amountNegative, { amount: required.minor.toString() });
  }
  const tolerancePolicy = policy.tolerance;
  if (tolerancePolicy.shareBp < 0 || tolerancePolicy.shareBp > 10_000) {
    throw new IntakeError(IntakeErrorCode.basisPointsOutOfRange, {
      value: String(tolerancePolicy.shareBp),
    });
  }
  const absolute = absoluteFor(tolerancePolicy, required.currency);
  if (absolute === null) {
    return Object.freeze({
      kind: 'undeclared',
      reasons: Object.freeze([INTAKE_REASON_KEYS.toleranceCurrencyNotDeclared]),
    });
  }
  if (isNegative(absolute)) {
    throw new IntakeError(IntakeErrorCode.toleranceNegative, { amount: absolute.minor.toString() });
  }
  const share = scaleBy(required, rational(BigInt(tolerancePolicy.shareBp), 10_000n), 'trunc');
  const amount = minimum(absolute, share);
  return Object.freeze({
    kind: 'declared',
    amount,
    reasons: Object.freeze([
      amount.minor === 0n ? INTAKE_REASON_KEYS.toleranceZero : INTAKE_REASON_KEYS.toleranceApplied,
    ]),
  });
}
