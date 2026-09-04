import type { Instant } from '@sdelka/domain';
import { type CurrencyCode, type Money, equals, minimum, money } from '@sdelka/money';
import { type IntakeReasonKey, INTAKE_REASON_KEYS } from './keys';
import type { IntakePolicy, IntakePolicyVersionId } from './policy';
import { type ToleranceResolution, toleranceFor } from './tolerance';

/**
 * Раскрытие допуска как **записанный факт**, а не как свойство экрана.
 *
 * `ROADMAP.md` критерий A2 требует ноль случаев выхода **за объявленный** допуск,
 * а необъявленный допуск объявить задним числом нельзя (`FUNCTIONAL.md` §4.3.2).
 * Значит объявление обязано быть фактом с моментом и версией политики — по
 * образцу `policyVersionId` в решениях комплаенса и акта об условии в состоянии
 * транша. Без этого критерий A2 недоказуем в принципе: доказывать нечем.
 *
 * Факт порождает приложение в момент выдачи инструкции на перевод (`INTAKE.md`
 * §2.1). Пакет его только читает и никогда не изготавливает — иначе «объявили»
 * означало бы «посчитали», то есть ничего.
 */
export interface ToleranceDisclosure {
  readonly dealId: string;
  readonly trancheId: string;
  /** Требуемая сумма, под которую допуск был объявлен. Сумма изменилась — факт устарел. */
  readonly requiredAmount: Money<CurrencyCode>;
  /** Объявленная величина. Именно она показана стороне, и больше неё применить нельзя. */
  readonly tolerance: Money<CurrencyCode>;
  readonly policyVersionId: IntakePolicyVersionId;
  /** Момент раскрытия. Позже поступления — то же, что отсутствие раскрытия. */
  readonly disclosedAt: Instant;
}

export interface EffectiveTolerance {
  readonly amount: Money<CurrencyCode>;
  readonly reasons: readonly IntakeReasonKey[];
  /** Величина по действующей политике, до сверки с объявленным. Для оператора. */
  readonly byPolicy: ToleranceResolution;
}

function zeroTolerance(
  required: Money<CurrencyCode>,
  byPolicy: ToleranceResolution,
  reasons: readonly IntakeReasonKey[],
): EffectiveTolerance {
  return Object.freeze({
    amount: money(required.currency, 0n),
    reasons: Object.freeze([...reasons]),
    byPolicy,
  });
}

/**
 * Действующий допуск на момент поступления.
 *
 * Четыре правила, каждое проверяется отдельно (`INTAKE.md` §3.3):
 *  1. факта раскрытия нет — допуск ноль;
 *  2. раскрыто позже поступления — допуск ноль (задним числом объявить нельзя);
 *  3. раскрыто под другую требуемую сумму или валюту — допуск ноль (факт устарел);
 *  4. раскрыто под другую версию политики — **меньшее** из объявленного и текущего.
 *
 * Четвёртое правило удовлетворяет обоим обязательствам сразу: больше объявленного
 * применить нельзя (обещание стороне), больше разрешённого действующей политикой
 * — тоже (правило дома). Смена политики при этом не расширяет допуск задним
 * числом ни в одном направлении.
 */
export function effectiveTolerance(
  required: Money<CurrencyCode>,
  policy: IntakePolicy,
  disclosure: ToleranceDisclosure | null,
  receivedAt: Instant,
): EffectiveTolerance {
  const byPolicy = toleranceFor(required, policy);

  if (disclosure === null) {
    return zeroTolerance(required, byPolicy, [INTAKE_REASON_KEYS.toleranceNotDisclosed]);
  }
  if (disclosure.disclosedAt > receivedAt) {
    return zeroTolerance(required, byPolicy, [INTAKE_REASON_KEYS.toleranceDisclosedAfterPayment]);
  }
  if (!equals(disclosure.requiredAmount, required)) {
    return zeroTolerance(required, byPolicy, [INTAKE_REASON_KEYS.toleranceDisclosureStale]);
  }
  if (disclosure.tolerance.currency !== required.currency) {
    return zeroTolerance(required, byPolicy, [INTAKE_REASON_KEYS.toleranceDisclosureStale]);
  }
  if (byPolicy.kind === 'undeclared') {
    // Политика перестала объявлять допуск для этой валюты после раскрытия.
    // Применяется меньшее из двух, и меньшее здесь — ноль.
    return zeroTolerance(required, byPolicy, [
      ...byPolicy.reasons,
      INTAKE_REASON_KEYS.toleranceDisclosureOlderPolicy,
    ]);
  }

  // Минимум берётся всегда, а не только при расхождении версий: при совпадении
  // версий обе величины равны, и отдельная ветка «версии те же — берём
  // объявленное» была бы вторым ответом на тот же вопрос. Расхождение версий
  // меняет не расчёт, а причину, которую увидит оператор.
  const sameVersion = disclosure.policyVersionId === policy.version;
  const amount = minimum(disclosure.tolerance, byPolicy.amount);
  const reasons: IntakeReasonKey[] = [
    amount.minor === 0n ? INTAKE_REASON_KEYS.toleranceZero : INTAKE_REASON_KEYS.toleranceApplied,
  ];
  if (!sameVersion) reasons.push(INTAKE_REASON_KEYS.toleranceDisclosureOlderPolicy);

  return Object.freeze({ amount, reasons: Object.freeze(reasons), byPolicy });
}
