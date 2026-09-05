import type { Instant } from '@sdelka/domain';
import type { CurrencyCode, Money } from '@sdelka/money';
import { type DetectorOutcome, type PolicyVersionId, outcomeSeverity } from './decision';
import type { QueuePolicy } from './policy';

/**
 * Очередь разбора комплаенса (`BACKLOG.md` E6-7, `STATE-MACHINES.md` §5).
 *
 * **Возраст задачи считается от момента постановки, а не от дедлайна.** Это то же
 * правило, что в §5: повторный неответ банка двигает дедлайн, и по дедлайну
 * застрявшая задача выглядит вечно свежей, никогда не попадая в эскалацию.
 * Поэтому у задачи две отметки: `enteredAt` — не двигается и определяет возраст,
 * `deadlineAt` — двигается и в приоритете не участвует вовсе.
 */
export const REVIEW_TASK_KINDS = [
  'sanctions_possible_match',
  'sanctions_unavailable',
  'payer_hold',
  'payer_exception',
  'price_mismatch',
  'structuring',
  'linkage',
  'flipping',
  /** Связанные лица по обе стороны одной сделки — усиленная проверка, не отказ (И6.4). */
  'related_parties',
  'beneficiary_change',
  'source_of_funds',
  /**
   * Непознанное поступление: референса нет, либо кандидатов больше одного
   * (`ROADMAP.md` И2.2). Собственный вид, а не `payer_hold`: там удержание по
   * плательщику, здесь неизвестна сама сделка, и норматив разбора у них разный.
   */
  'intake_unmatched',
  /**
   * Недоплата сверх допуска: транш остаётся в `collecting`, стороне показана
   * недостающая сумма, **оператор видит задачу** (И2.1, критерий 3).
   */
  'intake_underpayment',
  /**
   * Заявка на вывод простояла дольше норматива (`DECISIONS-REVIEW.md` §H4).
   *
   * Собственный вид, а не `payer_hold` и не `source_of_funds`: там речь о
   * плательщике и происхождении денег, здесь — о **нашем** бездействии. Показать
   * оператору чужую очередь ради того, чтобы тип сошёлся, значило бы соврать в
   * интерфейсе.
   *
   * ⚠ Задача не меняет состояние заявки **ничем**: у машины вывода нет ни одного
   * события, порождаемого сроком (`WITHDRAWAL_CLOCK_EVENTS`), и повтор из
   * «неизвестно» остаётся невозможным без сверки (красная линия №8).
   */
  'withdrawal_stalled',
] as const;
export type ReviewTaskKind = (typeof REVIEW_TASK_KINDS)[number];

export interface ReviewTask {
  readonly taskId: string;
  readonly kind: ReviewTaskKind;
  /**
   * `null` — задача не о сделке.
   *
   * Обнуляемым поле стало вместе с `withdrawal_stalled`: вывод со счёта клиента
   * сделки не имеет вовсе (`domain/src/client-account.ts` — «у вывода транша нет
   * вовсе»), и подставить сюда любой номер значило бы показать оператору задачу,
   * прицепленную к чужой сделке. Ни один порядок разбора этого поля не читает:
   * `prioritize` ранжирует по эскалации, важности, сумме и возрасту.
   */
  readonly dealId: string | null;
  readonly trancheId: string | null;
  readonly partyId: string | null;
  /**
   * Заявка на вывод, о которой задача. `null` — задача не о выводе.
   *
   * Без этого поля задача `withdrawal_stalled` не называла бы свой предмет:
   * `partyId` здесь не годится — у заявки известен **ключ счёта** владельца
   * остатка (`ClientKey`), а не идентификатор лица, и класть ключ счёта в поле с
   * именем `partyId` значит соврать типом.
   */
  readonly withdrawalId: string | null;
  /**
   * Сумма для ранжирования, пересчитанная в валюту политики по **официальному**
   * курсу на дату создания задачи (`FUNCTIONAL.md` §4.3.1). Пересчёт делает
   * вызывающий: курс — внешний факт, в чистом пакете его нет.
   */
  readonly rankAmount: Money<CurrencyCode> | null;
  /** Момент постановки в очередь. Не двигается. */
  readonly enteredAt: Instant;
  /** Дедлайн операции. Двигается; в приоритете не участвует. */
  readonly deadlineAt: Instant | null;
  readonly severity: DetectorOutcome;
  readonly assigneeId: string | null;
  readonly policyVersionId: PolicyVersionId;
}

export function taskAgeMs(task: ReviewTask, now: Instant): number {
  return Math.max(0, now - task.enteredAt);
}

/**
 * Уровень эскалации по возрасту. Ноль — норматив не превышен; дальше по одному
 * уровню на каждый пройденный порог из политики.
 */
export function escalationLevel(task: ReviewTask, now: Instant, policy: QueuePolicy): number {
  const age = taskAgeMs(task, now);
  let level = 0;
  for (const threshold of policy.escalationAfter) {
    if (age >= threshold) level += 1;
  }
  return level;
}

export interface RankedTask {
  readonly task: ReviewTask;
  readonly ageMs: number;
  readonly escalation: number;
  /** Сумма ранжирования в минорных единицах валюты политики. `null` — не пересчитана. */
  readonly rankMinor: bigint | null;
}

/**
 * Порядок разбора: сначала эскалация, затем сумма, затем возраст, затем
 * идентификатор для устойчивости.
 *
 * Эскалация впереди суммы намеренно: иначе мелкая задача не поднимется никогда и
 * очередь получит голодание — а `release_blocked` выходит только действием
 * человека и другого выхода у неё нет.
 */
export function prioritize(
  tasks: readonly ReviewTask[],
  policy: QueuePolicy,
  now: Instant,
): readonly RankedTask[] {
  const ranked: RankedTask[] = tasks.map((task) =>
    Object.freeze({
      task,
      ageMs: taskAgeMs(task, now),
      escalation: escalationLevel(task, now, policy),
      rankMinor:
        task.rankAmount !== null && task.rankAmount.currency === policy.rankCurrency
          ? task.rankAmount.minor
          : null,
    }),
  );

  return Object.freeze(
    ranked.sort((left, right) => {
      if (left.escalation !== right.escalation) return right.escalation - left.escalation;
      const severity = outcomeSeverity(right.task.severity) - outcomeSeverity(left.task.severity);
      if (severity !== 0) return severity;
      const leftRank = left.rankMinor ?? 0n;
      const rightRank = right.rankMinor ?? 0n;
      if (leftRank !== rightRank) return rightRank > leftRank ? 1 : -1;
      if (left.ageMs !== right.ageMs) return right.ageMs - left.ageMs;
      return left.task.taskId < right.task.taskId ? -1 : left.task.taskId > right.task.taskId ? 1 : 0;
    }),
  );
}

/** Метрика дежурного дашборда: возраст самой старой задачи. */
export function oldestTaskAgeMs(tasks: readonly ReviewTask[], now: Instant): number | null {
  let oldest: number | null = null;
  for (const task of tasks) {
    const age = taskAgeMs(task, now);
    if (oldest === null || age > oldest) oldest = age;
  }
  return oldest;
}

/** Задачи, перешагнувшие норматив: то, о чём алертит дежурный дашборд. */
export function escalatedTasks(
  tasks: readonly ReviewTask[],
  policy: QueuePolicy,
  now: Instant,
): readonly ReviewTask[] {
  return Object.freeze(tasks.filter((task) => escalationLevel(task, now, policy) > 0));
}
