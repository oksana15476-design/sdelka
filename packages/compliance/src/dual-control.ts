import { type ReasonKey, REASON_KEYS } from './keys';

/**
 * Второе утверждение — общий примитив.
 *
 * Правило «две различные учётные записи, и ни одна из них не готовила операцию»
 * к этому моменту написано в проекте трижды независимо: у изменения реквизитов
 * выплаты (`beneficiary.ts`), у утверждений выплаты (`g_approvals_sufficient` в
 * `@sdelka/domain`) и у разморозки. `ROADMAP.md` И2.2 требует его в четвёртый раз
 * — для ручного сопоставления поступления.
 *
 * Четвёртая независимая копия одного правила — это четвёртое место, где его
 * можно ослабить незаметно, и четвёртый набор тестов, который надо не забыть
 * написать. Поэтому здесь оно одно, а вызывающие приносят свои ключи причин:
 * причина у каждого периметра своя («реквизиты ждут второго утверждения» и
 * «сопоставление ждёт второго утверждения» — разные строки для оператора), а
 * правило одно.
 *
 * Что здесь **не** живёт: пороги (у каждого периметра свои и версионируются
 * политикой) и полномочия (проверяются `Authority` до вызова).
 */
export interface DualControl {
  /** Учётная запись, готовившая операцию. Она не может быть утверждающей. */
  readonly preparedBy: string | null;
  /** Все поступившие утверждения, включая повторные и включая готовившего. */
  readonly approvals: readonly string[];
  readonly requiredApprovals: number;
}

/**
 * Годные утверждающие: различные учётные записи за вычетом готовившей.
 *
 * Множество, а не счётчик: одна и та же учётная запись, нажавшая дважды, — это
 * одно утверждение. Порядок сохраняется — оператору показывается, кто утвердил
 * первым.
 */
export function distinctApprovers(control: DualControl): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const userId of control.approvals) {
    if (userId === control.preparedBy) continue;
    if (seen.has(userId)) continue;
    seen.add(userId);
    result.push(userId);
  }
  return Object.freeze(result);
}

/** Достаточно ли утверждений. Ноль требуемых — законное значение. */
export function dualControlSatisfied(control: DualControl): boolean {
  return distinctApprovers(control).length >= control.requiredApprovals;
}

/** Может ли эта учётная запись утвердить: не готовила и ещё не утверждала. */
export function isDistinctApprover(control: DualControl, userId: string): boolean {
  if (userId === control.preparedBy) return false;
  return !control.approvals.includes(userId);
}

/**
 * Причины отказа для конкретного периметра.
 *
 * Параметр типа — не украшение: ключи причин у периметров из **разных пакетов**
 * (`compliance.*` и `intake.*`), и правило обязано быть общим, не притягивая при
 * этом чужой реестр ключей. Без параметра типа единственным способом
 * переиспользовать правило было бы завести ключи приёма в реестре комплаенса,
 * то есть переехать границе пакета вслед за одной функцией.
 */
export interface DualControlReasons<K extends string = ReasonKey> {
  /** Причина «ждём второго утверждения». */
  readonly awaits: K;
  /** Причина «утверждающий не отличается от готовившего». */
  readonly notDistinct: K;
}

/**
 * Причины отказа для конкретного периметра. Пустой перечень — правило выполнено.
 *
 * Обе причины могут вернуться вместе, и это не дублирование: «утвердил тот же,
 * кто готовил» и «утверждений всё ещё не хватает» — два разных факта, и оператор
 * обязан видеть оба, иначе он исправит первый и снова упрётся во второй.
 */
export function dualControlFailures<K extends string = ReasonKey>(
  control: DualControl,
  reasons: DualControlReasons<K>,
  actorId: string | null = null,
): readonly K[] {
  const failures: K[] = [];
  if (actorId !== null && actorId === control.preparedBy) {
    failures.push(reasons.notDistinct);
  }
  if (!dualControlSatisfied(control)) {
    failures.push(reasons.awaits);
  }
  return Object.freeze(failures);
}

/** Причины по умолчанию для периметров, у которых своих строк нет. */
export const GENERIC_DUAL_CONTROL_REASONS: DualControlReasons = Object.freeze({
  awaits: REASON_KEYS.dualControlAwaitsSecondApproval,
  notDistinct: REASON_KEYS.dualControlApproverNotDistinct,
});
