import { ComplianceError, ComplianceErrorCode } from './errors';
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
 * Что здесь **не** живёт: значения порогов (у каждого периметра свои и
 * версионируются политикой) и полномочия (проверяются `Authority` до вызова).
 * Здесь живёт только **множество допустимых** значений порога: какие числа
 * вообще бывают порогом — вопрос самого правила, а не настройки периметра, и
 * ответ на него обязан быть один.
 */

/**
 * Сколько утверждений требует периметр — **1 или 2, и ничего больше**.
 *
 * Ноль здесь был выразим и означал «правило выполнено без единого утверждения»:
 * `distinctApprovers(control).length >= 0` истинно всегда, в том числе когда
 * утверждений нет вовсе, а единственное поступившее — от готовившего операцию
 * (проба на дереве до правки: `dualControlSatisfied` отвечал `true` в обоих
 * случаях). Ноль подтверждений — это не низкий порог, а его отсутствие, то есть
 * операция без второго человека там, где периметр объявил, что второй нужен.
 *
 * Верх — двойка: `packages/auth/src/approval.ts` набирает кворум по **уровням**
 * утверждения, а их всего два, и третью подпись брать неоткуда. Ступень «три
 * подписи» потребует сначала третьего уровня; до тех пор она невыразима.
 *
 * «Второе утверждение не требуется» этим типом не выражается **намеренно**:
 * это не значение порога, а отсутствие самой проверки, и жить оно обязано
 * снаружи (`packages/intake/src/manual-match.ts`, `ManualMatchSecondApproval`).
 */
export const DUAL_CONTROL_REQUIREMENTS = [1, 2] as const;
export type DualControlRequirement = (typeof DUAL_CONTROL_REQUIREMENTS)[number];

/**
 * Разбор порога, пришедшего из-за границы процесса: в настройке, выгрузке или
 * хранилище типов нет.
 *
 * Бросает, а не возвращает отказ, как конструкторы идентификаторов: порог с
 * нулём, тройкой или дробью — это не отказ конкретной операции, а испорченная
 * настройка периметра, и продолжать по ней нельзя. Форма повторяет
 * `approvalRequirement` в `@sdelka/auth`.
 */
export function dualControlRequirement(value: number): DualControlRequirement {
  const known = DUAL_CONTROL_REQUIREMENTS.find((candidate) => candidate === value);
  if (known === undefined) {
    throw new ComplianceError(ComplianceErrorCode.dualControlRequirementInvalid, {
      value: String(value),
    });
  }
  return known;
}

export interface DualControl {
  /** Учётная запись, готовившая операцию. Она не может быть утверждающей. */
  readonly preparedBy: string | null;
  /** Все поступившие утверждения, включая повторные и включая готовившего. */
  readonly approvals: readonly string[];
  /** Сколько годных утверждающих требуется. Ноль невыразим — см. тип. */
  readonly requiredApprovals: DualControlRequirement;
}

/**
 * Участники операции без порога: всё, что нужно для вопроса «кто здесь годный
 * утверждающий».
 *
 * Отдельный тип, потому что различность и достаточность — разные вопросы, и
 * проверке различности порог не нужен. Пока она принимала целый `DualControl`,
 * вызывающему приходилось выдумывать порог, чтобы задать вопрос не о нём
 * (`beneficiary.ts` подставлял ноль), — и в коде появлялся ноль, который никто
 * не имел в виду.
 */
export type ApproverSet = Pick<DualControl, 'preparedBy' | 'approvals'>;

/**
 * Годные утверждающие: различные учётные записи за вычетом готовившей.
 *
 * Множество, а не счётчик: одна и та же учётная запись, нажавшая дважды, — это
 * одно утверждение. Порядок сохраняется — оператору показывается, кто утвердил
 * первым.
 */
export function distinctApprovers(control: ApproverSet): readonly string[] {
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

/**
 * Достаточно ли утверждений.
 *
 * Рантайм-дубль компиляционного рубежа. Тип не переживает границу процесса, а
 * порог приходит сюда всюду, где он не литерал из этого пакета: политика
 * версионируется и однажды будет храниться вне кода, а до тех пор попасть сюда
 * можно приведением. Ноль, тройка и дробь обязаны отказать здесь, а не
 * разойтись по сравнению ниже, где ноль и означал «правило выполнено». Отказ
 * закрытый: испорченная настройка читается как «утверждений не хватает», а не
 * как «утверждения не нужны».
 */
export function dualControlSatisfied(control: DualControl): boolean {
  const required = DUAL_CONTROL_REQUIREMENTS.find(
    (candidate) => candidate === control.requiredApprovals,
  );
  if (required === undefined) return false;
  return distinctApprovers(control).length >= required;
}

/**
 * Может ли эта учётная запись утвердить: не готовила и ещё не утверждала.
 *
 * Порог не читается и не принимается: вопрос здесь про людей, а не про счёт.
 */
export function isDistinctApprover(control: ApproverSet, userId: string): boolean {
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
