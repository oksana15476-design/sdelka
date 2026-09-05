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

/**
 * Нужно ли здесь второе утверждение — **признак, а не число**.
 *
 * Раньше «второе утверждение не требуется» выражалось порогом `0`, и два разных
 * факта становились неразличимы: «проверки нет» и «проверка пройдена» давали
 * один и тот же ответ `dualControlSatisfied === true`. Разница между ними —
 * вся суть правила: в первом случае спрашивать не о чем, во втором второй
 * человек обязан существовать и быть найден.
 *
 * Кворум лежит **внутри** ветки `required` и только там: у ветки
 * `not_required` его нет вовсе, поэтому вопрос «набран ли он» задать не к чему —
 * ни в коде, ни в кабинете оператора. Ноль в порог не подставляется, потому что
 * порога здесь нет.
 */
export type ManualMatchSecondApproval =
  /** Сумма ниже порога: второго человека правило не требует. */
  | { readonly kind: 'not_required' }
  /**
   * Сумма выше порога: требуется столько утверждений, сколько объявила политика.
   * Утверждающие считаются множеством за вычетом готовившего (`dual-control.ts`).
   */
  | { readonly kind: 'required'; readonly control: DualControl };

export interface ManualMatchAssessment {
  readonly allowed: boolean;
  /**
   * Требуется ли второе утверждение и, если требуется, его кворум. Заменяет
   * прежнюю пару «булев признак рядом с `DualControl`, у которого порог ноль».
   */
  readonly secondApproval: ManualMatchSecondApproval;
  readonly failures: readonly IntakeReasonKey[];
}

// Только `awaits`: актор в правило не передаётся (см. вызов ниже), а без актора
// причины «утвердил тот же, кто готовил» у двухаргументной формы правила нет ни
// в типе, ни в ответе. Ключ `intake.match.manual_approver_not_distinct` жил в
// реестре и не мог появиться ни в одном ответе пакета — мёртвая проводка,
// найденная мутационным прогоном; она удалена вместе с ключом.
const MANUAL_MATCH_REASONS = Object.freeze({
  awaits: INTAKE_REASON_KEYS.matchManualAwaitsSecondApproval,
});

/**
 * Можно ли применить ручное сопоставление.
 *
 * Три условия, и первое из них — основание: сопоставление без ссылки на
 * основание не отличается от угадывания, а И2.2 требует «отнести деньги к
 * сделке или вернуть их, **не угадывая**».
 */
function manualMatchControl(request: ManualMatchRequest, policy: IntakePolicy): DualControl {
  return Object.freeze({
    preparedBy: request.preparedBy,
    approvals: Object.freeze([...request.approvals]),
    requiredApprovals: policy.manualMatch.requiredApprovals,
  });
}

export function assessManualMatch(
  request: ManualMatchRequest,
  policy: IntakePolicy,
): ManualMatchAssessment {
  // Кворум собирается только там, где он есть: ниже порога собирать нечего, и
  // объекта с порогом ноль в этой ветке больше не существует.
  const secondApproval: ManualMatchSecondApproval = requiresSecondApproval(request.amount, policy)
    ? Object.freeze({ kind: 'required' as const, control: manualMatchControl(request, policy) })
    : Object.freeze({ kind: 'not_required' as const });

  const failures: IntakeReasonKey[] = [];
  if (request.justificationRef.trim() === '') {
    failures.push(INTAKE_REASON_KEYS.matchManualJustificationMissing);
  }
  // Правило второго утверждения спрашивается только там, где оно требуется.
  // Прежде оно спрашивалось всегда, а «не требуется» изображалось порогом ноль
  // — и ответ «правило выполнено» приходил на операцию, у которой правила не
  // было. Актор не передаётся: готовивший отфильтрован из утверждающих самим
  // правилом (`distinctApprovers`), и подставлять его сюда значило бы вернуть
  // отказ «утвердил тот же, кто готовил» на каждой заявке без утверждений.
  if (secondApproval.kind === 'required') {
    failures.push(
      ...dualControlFailures<IntakeReasonKey>(secondApproval.control, MANUAL_MATCH_REASONS),
    );
  }

  return Object.freeze({
    allowed: failures.length === 0,
    secondApproval,
    failures: Object.freeze(failures),
  });
}
