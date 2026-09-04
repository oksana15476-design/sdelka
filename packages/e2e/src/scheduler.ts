import {
  type EscalationPolicy,
  type Instant,
  type TrancheEvent,
  type TrancheState,
  DEFAULT_ESCALATION_POLICY,
  dueTrancheEvent,
  isEscalated,
  isTerminalTrancheStatus,
  trancheStateAge,
} from '@sdelka/domain';
import { SYSTEM_ACTOR, type TrancheEventOptions, applyTrancheEvent } from './flow';
import { type TrancheRuntime, type World, trancheOf } from './world';

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
    const due = dueTrancheEvent(runtime.state, next.now);
    if (due !== null) {
      const from = runtime.state.status;
      const step = applyTrancheEvent(next, trancheId, due, {
        ...options,
        // Переход по дедлайну совершает система, а не человек: журнал аудита
        // обязан назвать это своим именем, а не именем дежурного оператора.
        actor: SYSTEM_ACTOR,
      });
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
