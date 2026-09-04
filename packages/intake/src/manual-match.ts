import { type DualControl, dualControlFailures } from '@sdelka/compliance';
import { type CurrencyCode, type Money, compare } from '@sdelka/money';
import { type IntakeReasonKey, INTAKE_REASON_KEYS } from './keys';
import type { IntakePolicy } from './policy';

/**
 * Ручное сопоставление поступления со сделкой — `ROADMAP.md` И2.2, критерий 2:
 * «действие требует подтверждения второго человека, если сумма выше порога, и
 * оставляет запись с основанием».
 *
 * Механика второго утверждения **не пишется здесь**: она вынесена в
 * `@sdelka/compliance` (`dual-control.ts`) и до этого существовала в проекте
 * трижды порознь. Здесь только порог, свои ключи причин и обязательность
 * основания.
 */

export interface ManualMatchRequest {
  readonly incomingPaymentId: string;
  readonly dealId: string;
  readonly trancheId: string;
  readonly amount: Money<CurrencyCode>;
  /** Оператор, подготовивший сопоставление. Утверждать его он не может. */
  readonly preparedBy: string;
  readonly approvals: readonly string[];
  /**
   * Ссылка на основание: документ, письмо банка, запись разговора. Технический
   * идентификатор, не текст для клиента. Пустое значение равносильно отсутствию.
   */
  readonly justificationRef: string;
}

/**
 * Нужен ли второй человек. Порог задан по валютам, как и допуск: пересчёта по
 * курсу здесь нет по той же причине — число утверждающих не может зависеть от
 * курса доллара в течение дня (`FUNCTIONAL.md` §4.3.1).
 *
 * Валюта, для которой порог не объявлен, требует второго утверждения **всегда**.
 * Отказ закрытый: неизвестный порог не означает «порога нет».
 */
export function requiresSecondApproval(
  amount: Money<CurrencyCode>,
  policy: IntakePolicy,
): boolean {
  const threshold = policy.manualMatch.secondApprovalAbove.find(
    (item) => item.currency === amount.currency,
  );
  if (threshold === undefined) return true;
  return compare(amount, threshold) > 0;
}

export interface ManualMatchAssessment {
  readonly allowed: boolean;
  readonly requiresSecondApproval: boolean;
  readonly failures: readonly IntakeReasonKey[];
  /** Утверждающие, зачтённые правилом: различные записи за вычетом готовившего. */
  readonly control: DualControl;
}

const MANUAL_MATCH_REASONS = Object.freeze({
  awaits: INTAKE_REASON_KEYS.matchManualAwaitsSecondApproval,
  notDistinct: INTAKE_REASON_KEYS.matchManualApproverNotDistinct,
});

/**
 * Можно ли применить ручное сопоставление.
 *
 * Три условия, и первое из них — основание: сопоставление без ссылки на
 * основание не отличается от угадывания, а И2.2 требует «отнести деньги к
 * сделке или вернуть их, **не угадывая**».
 */
export function assessManualMatch(
  request: ManualMatchRequest,
  policy: IntakePolicy,
): ManualMatchAssessment {
  const needsSecond = requiresSecondApproval(request.amount, policy);
  const control: DualControl = Object.freeze({
    preparedBy: request.preparedBy,
    approvals: Object.freeze([...request.approvals]),
    requiredApprovals: needsSecond ? policy.manualMatch.requiredApprovals : 0,
  });

  const failures: IntakeReasonKey[] = [];
  if (request.justificationRef.trim() === '') {
    failures.push(INTAKE_REASON_KEYS.matchManualJustificationMissing);
  }
  // Актор не передаётся: готовивший отфильтрован из утверждающих самим правилом
  // (`distinctApprovers`), и подставлять его сюда значило бы вернуть отказ
  // «утвердил тот же, кто готовил» на каждой заявке без единого утверждения.
  failures.push(...dualControlFailures<IntakeReasonKey>(control, MANUAL_MATCH_REASONS));

  return Object.freeze({
    allowed: failures.length === 0,
    requiresSecondApproval: needsSecond,
    failures: Object.freeze(failures),
    control,
  });
}
