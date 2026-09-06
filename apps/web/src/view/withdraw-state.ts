import {
  type WithdrawalArrival,
  type WithdrawalStatus,
  isWithdrawalArrival,
} from '@sdelka/domain';
import type { StateTone } from './money-state';

/**
 * Как называется положение заявки на вывод — проекция домена на язык экрана.
 *
 * ## Что здесь чинится
 *
 * Экран собирал ключ шаблоном `withdraw.state.${status}.*` по шести состояниям
 * машины (`WITHDRAWAL_STATUSES`), и четыре разных положения читались клиентом
 * одинаково:
 *
 * · поручение ушло, ответа ждём;
 * · **ответа банка нет — исход неизвестен** (красная линия №8);
 * · заявку остановила наша проверка;
 * · банк не исполнил поручение.
 *
 * Первые два — один статус `paying_out`, вторые два — один статус `blocked`.
 * Клиенту в «неизвестно» показывалось «Перевод отправлен», то есть утверждение
 * более уверенное, чем то, что мы знаем. Это расхождение с красной линией, а не
 * недостача микрокопи: тексты приняты и лежат в трёх словарях с самого начала.
 *
 * ## Откуда берётся различие
 *
 * Из домена, а не из поля фикстуры: у ребра машины стоит `outcome`
 * (`WithdrawalTransition.outcome`), и перечень «чем можно прийти в это
 * состояние» считается по таблице переходов — `withdrawalArrivals`,
 * `isWithdrawalArrival` в `packages/domain/src/client-account.ts`. Никакого
 * второго перечня положений здесь нет: проекция только **называет** то, что уже
 * посчитано, ровно как `projectMoneyState` рядом.
 *
 * ## Почему исход может быть неизвестен самому экрану
 *
 * `WithdrawalState` помнит статус, срок и момент входа — и **не помнит, чем в
 * него вошли**. Тот, кто ведёт заявку, знает поданное событие; тот, кто прочитал
 * её из хранилища, не знает ничего. Поэтому «исход не записан» — законное
 * четвёртое значение (`undefined`), и в нём экран говорит общими словами
 * («Вывод приостановлен… причину назовём, когда разбор закончится»), а не
 * выдаёт догадку за факт.
 *
 * ⚠ Оставшаяся половина работы, названная, а не спрятанная: чтобы «не записан»
 * исчезло, исход перехода обязан лечь **в состояние** и в хранилище
 * (`WithdrawalState`, `packages/db/src/store/state.ts`, форма строки в миграции
 * `0022`). Это правка домена и базы, а не экрана, и до неё клиент, вернувшийся
 * на страницу заново, видит общую формулировку вместо точной.
 */
export type WithdrawArrival = WithdrawalArrival | undefined;

/**
 * Приёмочный ключ адреса `?outcome=`.
 *
 * `none` — «пришли не с ответом банка» (создали, утвердили, отправили,
 * остановила проверка, отменили); `settled · rejected · unknown` — ответ по
 * поручению. Пара, невозможная в машине (скажем, «отменено после подтверждения
 * банка»), не показывается вовсе: значение отбрасывается, и остаётся «исход не
 * записан». Это тот же приём, что у числа подписей, — мусор в параметре не
 * должен превращаться в положение заявки, которого не бывает.
 *
 * В бою `?outcome=` не существует: исход приходит из данных вместе с состоянием.
 */
export function withdrawArrivalOf(
  status: WithdrawalStatus,
  value: string | undefined,
): WithdrawArrival {
  if (value === undefined) return undefined;
  const arrival: WithdrawalArrival | undefined =
    value === 'none'
      ? null
      : value === 'settled' || value === 'rejected' || value === 'unknown'
        ? value
        : undefined;
  if (arrival === undefined) return undefined;
  return isWithdrawalArrival(status, arrival) ? arrival : undefined;
}

/**
 * Приставка ключей плашки: `badge`, `title`, `body` берутся от неё.
 *
 * Уточнение появляется только там, где статуса не хватает, и только с принятым
 * текстом за ним. Сочинять здесь нечего: все четыре набора строк написаны
 * копирайтером и приняты главредом (`ui/copy.ts`).
 */
export function withdrawStateKey(status: WithdrawalStatus, arrival: WithdrawArrival): string {
  if (status === 'paying_out' && arrival === 'unknown') {
    return 'withdraw.state.paying_out.unknown';
  }
  if (status === 'blocked' && arrival === 'rejected') {
    return 'withdraw.state.blocked.rejected';
  }
  // Остановила **наша** проверка: и `withdrawal_blocked` оператором, и
  // неизвестный счёт-источник (`¬g_source_account_known`) — оба ребра наши, и
  // ни одно из них не ответ банка. `undefined` сюда не попадает намеренно:
  // «кто остановил» мы в этом случае не знаем и утверждать не станем.
  if (status === 'blocked' && arrival === null) {
    return 'withdraw.state.blocked.review';
  }
  return `withdraw.state.${status}`;
}

/**
 * Тон плашки. «Исход неизвестен» — предупреждение, а не «идёт как обычно»: та же
 * величина, что у `payoutUnknown` в `MONEY_STATE_TONE`, и по той же причине —
 * положение требует внимания, но ошибкой клиента не является.
 *
 * Отказ банка тона не меняет: `blocked` уже `warn`, деньги остались на счёте
 * номинального держания, и красным здесь пугать не за что.
 */
const TONE: Readonly<Record<WithdrawalStatus, StateTone>> = Object.freeze({
  requested: 'wait',
  approved: 'info',
  paying_out: 'info',
  paid_out: 'ok',
  blocked: 'warn',
  cancelled: 'wait',
});

export function withdrawStateTone(status: WithdrawalStatus, arrival: WithdrawArrival): StateTone {
  if (status === 'paying_out' && arrival === 'unknown') return 'warn';
  return TONE[status];
}

/**
 * Почему вторую заявку создать нельзя.
 *
 * Красная линия №8, вторая половина: повтор из «неизвестно» запрещён без
 * прохождения через сверку. Машина держит запрет отсутствием ребра
 * (`paying_out --payout_result(unknown)--> paying_out` — единственный выход из
 * «неизвестно», кроме сверки), а экран обязан назвать причину словами: общая
 * строка «пока идёт этот вывод» описывает очередь, а не запрет, и человек,
 * прочитавший её в «неизвестно», решит, что достаточно подождать.
 */
export function withdrawRepeatBlockedKey(
  status: WithdrawalStatus,
  arrival: WithdrawArrival,
): string {
  return status === 'paying_out' && arrival === 'unknown'
    ? 'withdraw.repeat.blocked.unknown'
    : 'withdraw.repeat.blocked';
}
