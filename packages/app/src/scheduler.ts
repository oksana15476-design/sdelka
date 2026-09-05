import type { PolicyVersionId, ReviewTask } from '@sdelka/compliance';
import {
  type EscalationPolicy,
  type Instant,
  type NonTerminalWithdrawalStatus,
  type TrancheEvent,
  type TrancheState,
  DEFAULT_ESCALATION_POLICY,
  dueTrancheEvent,
  isEscalated,
  isTerminalTrancheStatus,
  isTerminalWithdrawalStatus,
  isWithdrawalStalled,
  trancheStateAge,
  withdrawalStateAge,
} from '@sdelka/domain';
import {
  type TrancheEventOptions,
  type TrancheStepResult,
  applyDealEvent,
  applyTrancheEvent,
} from './flow';
import { clockAuthority } from './authority';
import type { WithdrawalRuntime, WithdrawalWorld } from './withdrawal';
import { type TrancheRuntime, type World, sealed, trancheOf } from './world';

/**
 * Планировщик: **вызывающий у часов транша**.
 *
 * Дедлайн лежал в состоянии с самого начала, `dueTrancheEvent` был написан и
 * проверен тестами — и **не вызывался ниоткуда, кроме них**. Семь из девяти
 * остывших статусов получали дедлайн, который никто не превращал в событие:
 * `CABINETS.md` §3.2 блок 6 обещал автоматическое снятие резерва, а исполнять
 * это обещание было некому. Дыра «дедлайн лежит, его никто не читает» просто
 * переехала уровнем выше — из домена в приложение.
 *
 * **Почему тик здесь, а не за портом наружу.** Превращение наступившего срока в
 * событие — решение системы, а не внешний факт: банк, реестр и провайдер о наших
 * дедлайнах ничего не знают и сообщить о них не могут. За портом остаётся ровно
 * то, чего нет у домена и нет у этого слоя: источник времени, запрос «дай
 * транши, у которых часы истекли», транзакция и пятнадцатиминутный интервал
 * (`FUNCTIONAL.md` инвариант 7). Здесь — обход того, что мир уже держит в
 * памяти, и ни одного решения сверх этого.
 *
 * **Планировщик не решает ничего.** Он зовёт две чистые функции домена и
 * передаёт их ответ дальше:
 *
 * - `dueTrancheEvent` — какое событие порождает наступление срока. Событие, а
 *   не состояние: тик проходит ту же дверь, что и человек, — таблицу переходов,
 *   guard'ы и намерения. Отсюда же и то, что `deadline_reached` у замороженного
 *   транша невыразим (у замороженного состояния нет поля дедлайна вовсе);
 * - `isEscalated` — пора ли поднимать транш дежурному. Пять `null` из десяти в
 *   таблице часов закрывает именно она: дедлайн двигает деньги, возраст поднимает
 *   человека, и смешивать их нельзя (`STATE-MACHINES.md` §5).
 */

/**
 * Один шаг часов по одному траншу.
 *
 * Экспортируется, и это не удобство: события `reserve_expired` и
 * `deadline_reached` разрешены **только** происхождением `clock`, а разрешение
 * часов из пакета не выходит. Значит подать их иначе, чем через часы, нельзя
 * вовсе — и это правильно: сегодня их подавал кто угодно, в том числе на
 * траншe, у которого срок ещё не наступил.
 *
 * `null` — часы молчат: срок не наступил либо состояние часов не имеет
 * (`frozen` — у него нет поля дедлайна вовсе). Молчание возвращается значением,
 * а не исключением: «ещё не пора» — это ответ, а не ошибка.
 */
export function tickTranche(
  world: World,
  trancheId: string,
  options: TrancheEventOptions,
): TrancheStepResult | null {
  const runtime = trancheOf(world, trancheId);
  if (isTerminalTrancheStatus(runtime.state.status)) return null;
  const due = dueTrancheEvent(runtime.state, world.now);
  if (due === null) return null;
  return applyTrancheEvent(world, trancheId, due, clockAuthority(world), options);
}

/**
 * Срок сделки истёк — вход часов на автомате сделки.
 *
 * ⚠ **[открыто] и названо, а не спрятано.** У сделки нет часов:
 * `packages/domain/src/schedule.ts` описывает `dueTrancheEvent` и прямо
 * оговаривает, что события называются только для транша. Значит проверить
 * «а наступил ли срок» здесь **нечем** — в отличие от `tickTranche`, где срок
 * лежит в состоянии.
 *
 * Что эта функция всё-таки даёт: событие `deadline_reached` у сделки перестаёт
 * быть доступно человеку. Разрешение — часы, а `clockAuthority` из пакета не
 * выходит; guard `g_no_open_filing` (запрет автооткрата при поданном
 * заявлении) стоит на своём месте и роняет шаг там, где должен. До появления
 * `dueDealEvent` это самое строгое, что выразимо.
 */
export function expireDeal(world: World, dealId: string, options: TrancheEventOptions): World {
  return applyDealEvent(world, dealId, { type: 'deadline_reached' }, clockAuthority(world), options);
}

/** Что тик сделал с одним траншем. Событие — то, которое вернул домен. */
export interface FiredTrancheEvent {
  readonly trancheId: string;
  readonly event: TrancheEvent;
  readonly from: TrancheState['status'];
  readonly to: TrancheState['status'];
}

/** Транш, который часы отдают человеку, а не автомату. */
export interface EscalatedTranche {
  readonly trancheId: string;
  readonly status: TrancheState['status'];
  /** Возраст состояния в миллисекундах — от входа в него, а не от дедлайна. */
  readonly ageMs: number;
}

export interface SchedulerTickResult {
  readonly world: World;
  /** Транши, у которых часы породили событие, в порядке обхода. */
  readonly fired: readonly FiredTrancheEvent[];
  /**
   * Транши, чей возраст превысил норматив. Тик их **не двигает**: эскалация —
   * это задача дежурному, а не переход. Состояния, у которых часы молчат
   * (`release_blocked`, `paying_out`, `refunding`, `refund_pending`,
   * `release_pending`), выходят отсюда и только отсюда.
   */
  readonly escalated: readonly EscalatedTranche[];
}

/**
 * Один проход планировщика по живым траншам мира.
 *
 * Порядок обхода — порядок заведения траншей: детерминированный, потому что
 * иначе один и тот же мир давал бы разные журналы от прогона к прогону.
 *
 * Терминальные транши пропускаются до вызова домена: у них нет ни дедлайна, ни
 * возраста, и спрашивать о них часы нечего.
 *
 * Отказ автомата тик **не глотает**. Событие, которое вернули часы и отвергла
 * таблица, — это расхождение между таблицей переходов и таблицей часов, то есть
 * дефект, который обязан быть виден сразу: молчаливый пропуск означал бы, что
 * планировщик каждые пятнадцать минут безуспешно стучится в закрытую дверь и
 * никто об этом не узнает. `applyTrancheEvent` в таком случае бросает.
 */
export function tick(
  world: World,
  options: TrancheEventOptions,
  escalation: EscalationPolicy = DEFAULT_ESCALATION_POLICY,
): SchedulerTickResult {
  const ids = [...world.tranches.keys()];
  let next = world;
  const fired: FiredTrancheEvent[] = [];
  const escalated: EscalatedTranche[] = [];

  for (const trancheId of ids) {
    const runtime: TrancheRuntime = trancheOf(next, trancheId);
    if (isTerminalTrancheStatus(runtime.state.status)) continue;

    // Часы системы: одно состояние на вызов. Список «у кого истекло» — забота
    // источника, и здесь его роль играет обход карты мира.
    const from = runtime.state.status;
    const due = dueTrancheEvent(runtime.state, next.now);
    const step = tickTranche(next, trancheId, options);
    if (due !== null && step !== null) {
      next = step.world;
      fired.push({ trancheId, event: due, from, to: step.transition.state.status });
    }

    // Возраст считается **после** возможного перехода: транш, только что
    // вошедший в новое состояние, свежий, и поднимать его дежурному не за что.
    const after = trancheOf(next, trancheId).state;
    if (isTerminalTrancheStatus(after.status)) continue;
    if (!isEscalated(after, next.now, escalation)) continue;
    escalated.push({
      trancheId,
      status: after.status,
      ageMs: trancheStateAge(after, next.now) ?? 0,
    });
  }

  return { world: next, fired, escalated };
}

/* ------------------------------------------------------------------------- */
/* Часы заявок на вывод                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Заявка, простоявшая дольше норматива, — и задача, которой она видна дежурному.
 *
 * ⚠ **Тик заявку не двигает ничем.** У машины вывода нет ни одного события,
 * порождаемого сроком (`WITHDRAWAL_CLOCK_EVENTS` — `Record<…, null>`, и это тип,
 * а не значение), поэтому здесь **нет и не может быть** вызова
 * `applyWithdrawalEvent`. Это прямое требование красной линии №8: заявка,
 * стоящая в `paying_out` после `payout_result(unknown)`, не повторяется от того,
 * что прошло время, — из «неизвестно» выводит только сверка
 * (`reconciliation_resolved`), то есть внешний факт и человек.
 */
export interface StalledWithdrawal {
  readonly withdrawalId: string;
  readonly status: NonTerminalWithdrawalStatus;
  /** Возраст состояния в миллисекундах — от входа в него, а не от дедлайна. */
  readonly ageMs: number;
  readonly task: ReviewTask;
}

export interface WithdrawalTickOptions {
  /** Версия политики, под которой задача попала в очередь (`CORE.md` Ф11). */
  readonly policy: PolicyVersionId;
}

export interface WithdrawalTickResult {
  readonly scene: WithdrawalWorld;
  /** Заявки, поднятые дежурному этим проходом. Пустой список — норматив цел. */
  readonly stalled: readonly StalledWithdrawal[];
}

function stallTaskId(withdrawalId: string, enteredAt: Instant): string {
  // Детерминированный ключ, а не счётчик: тот же простой той же заявки обязан
  // давать тот же номер задачи, иначе повтор прохода часов после перезапуска
  // заведёт вторую задачу о том же.
  return `task-withdrawal-${withdrawalId}-${enteredAt}`;
}

function stallTask(
  runtime: WithdrawalRuntime,
  status: NonTerminalWithdrawalStatus,
  enteredAt: Instant,
  now: Instant,
  deadlineAt: Instant,
  options: WithdrawalTickOptions,
): ReviewTask {
  return {
    taskId: stallTaskId(runtime.state.withdrawalId, enteredAt),
    kind: 'withdrawal_stalled',
    // Сделки у вывода нет вовсе — см. `ReviewTask.dealId`.
    dealId: null,
    trancheId: null,
    // У заявки известен **ключ счёта** владельца остатка, а не идентификатор
    // лица; `partyId` здесь был бы ложью типом. Предмет задачи называет
    // `withdrawalId`.
    partyId: null,
    withdrawalId: runtime.state.withdrawalId,
    // Ранжирования по сумме нет: очередь ранжирует в своей валюте, а пересчёт
    // требует официального курса на дату — внешнего факта, которого у часов нет
    // (`ReviewTask.rankAmount`, `FUNCTIONAL.md` §4.3.1). Выдуманный курс в
    // приоритете дежурного хуже отсутствующего.
    rankAmount: null,
    // Возраст задачи — возраст **простоя**, а не момент, когда часы до неё
    // дошли: иначе заявка, простоявшая неделю, попадала бы в очередь свежей и
    // ждала бы норматив второй раз.
    enteredAt,
    // Срок операции двигается (повтор `unknown` его пересчитывает) и в
    // приоритете очереди не участвует — ровно то, для чего это поле заведено.
    deadlineAt,
    // Не `hold` и не `block`: эскалация ничего не удерживает и статуса заявки не
    // меняет — она поднимает заявку человеку. `hold` в задаче читался бы как
    // наложенное удержание, которого машина не накладывала.
    severity: 'review',
    assigneeId: null,
    policyVersionId: options.policy,
  };
}

/**
 * Один проход часов по живым заявкам: кто простоял дольше норматива.
 *
 * **Очередь одна.** Задача кладётся в `world.tasks` — ту же очередь разбора
 * `@sdelka/compliance`, которой живут задачи комплаенса и приёма; второй очереди
 * «для выводов» здесь нет, и ранжирование (`prioritize`) достаётся заявке
 * бесплатно вместе с эскалацией по возрасту.
 *
 * **Ровно один раз на простой.** След о поднятой задаче лежит на самой заявке
 * (`WithdrawalRuntime.stall`) и ключом имеет пару «статус, момент входа». Проход
 * часов идемпотентен: сколько бы раз он ни прошёл по стоящей заявке, задача
 * останется одна. Переход в другое состояние начинает новый простой — и тогда
 * задача будет новая, потому что момент входа другой.
 */
export function tickWithdrawals(
  scene: WithdrawalWorld,
  options: WithdrawalTickOptions,
): WithdrawalTickResult {
  const now = scene.world.now;
  const stalled: StalledWithdrawal[] = [];
  const withdrawals = new Map(scene.withdrawals);
  const tasks: ReviewTask[] = [];

  for (const [withdrawalId, runtime] of scene.withdrawals) {
    const state = runtime.state;
    if (isTerminalWithdrawalStatus(state.status)) continue;
    if (!('enteredAt' in state)) continue;
    if (!isWithdrawalStalled(state, now, scene.clock.escalation)) continue;
    const mark = runtime.stall;
    if (mark !== null && mark.status === state.status && mark.enteredAt === state.enteredAt) {
      continue;
    }
    const task = stallTask(runtime, state.status, state.enteredAt, now, state.deadline.at, options);
    withdrawals.set(withdrawalId, {
      ...runtime,
      stall: { taskId: task.taskId, status: state.status, enteredAt: state.enteredAt },
    });
    tasks.push(task);
    stalled.push({
      withdrawalId,
      status: state.status,
      ageMs: withdrawalStateAge(state, now) ?? 0,
      task,
    });
  }

  if (tasks.length === 0) {
    return { scene, stalled: Object.freeze([]) };
  }
  const world = sealed({
    ...scene.world,
    tasks: [...scene.world.tasks, ...tasks],
    checks: scene.world.checks,
  });
  return {
    scene: { world, withdrawals, clock: scene.clock },
    stalled: Object.freeze(stalled),
  };
}

/**
 * Интервал планировщика — `FUNCTIONAL.md` инвариант 7.
 *
 * Живёт здесь, а не в домене: домен о том, как часто его спрашивают, знать не
 * должен. Значение нужно тестам, чтобы двигать время шагами планировщика, а не
 * произвольными числами.
 */
export const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;

/** Момент, в который планировщик проснётся в следующий раз. */
export function nextTickAt(now: Instant): number {
  return now + SCHEDULER_INTERVAL_MS;
}
