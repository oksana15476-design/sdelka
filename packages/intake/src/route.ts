import type { DetectorOutcome, PayerAssessment, ReviewTaskKind } from '@sdelka/compliance';
import { type IntakeReasonKey, INTAKE_REASON_KEYS } from './keys';
import type { MatchResult } from './matching';

/**
 * Маршрут поступления — куда деньги ложатся до всякого разнесения.
 *
 * **Правило плательщика здесь не пишется заново.** Оно уже написано в
 * `@sdelka/compliance` (`assessPayer`): лестница с четырьмя исключениями —
 * супруг, родитель, ребёнок, контролируемое юрлицо — и отдельной веткой
 * внутреннего движения со своего же остатка. Этот файл только переводит её исход
 * в маршрут денег.
 *
 * ⚠️ **Правило существует в двух редакциях, и вторая сегодня побеждает.**
 * `g_payer_matches` в `@sdelka/domain` — строковое равенство ключей, и стоит оно
 * на ребре автомата. Значит исключения по родству и юрлицу **недостижимы**:
 * комплаенс отвечает `clear`, а транш всё равно уходит в `release_blocked`.
 * Свести правило в одну редакцию — правка домена (`INTAKE.md` §7.1), и она за
 * границей этого пакета.
 */
export const INTAKE_ROUTES = [
  /** Деньги клиента: зачисляются на свободную часть, дальше идёт разнесение. */
  'to_client_account',
  /** `suspense:unidentified`: на сделку не зачисляются ни при какой сумме. */
  'to_suspense',
] as const;
export type IntakeRoute = (typeof INTAKE_ROUTES)[number];

/**
 * Маршрут по исходу детектора плательщика. Таблица тотальная: новый исход не
 * соберётся, пока для него явно не назван маршрут.
 *
 * `review` ведёт на счёт клиента, а не в удержание: по лестнице исходов
 * `@sdelka/compliance` `review` означает «задача в очередь разбора, **операция
 * продолжается**». Удержание начинается с `hold`.
 */
const ROUTE_BY_OUTCOME: Readonly<Record<DetectorOutcome, IntakeRoute>> = Object.freeze({
  clear: 'to_client_account',
  review: 'to_client_account',
  stop: 'to_suspense',
  hold: 'to_suspense',
  block: 'to_suspense',
});

export interface IntakeRouting {
  readonly route: IntakeRoute;
  /** Вид задачи для очереди разбора. `null` — задача не нужна. */
  readonly queueTask: ReviewTaskKind | null;
  readonly reasons: readonly IntakeReasonKey[];
}

/**
 * Маршрут поступления по решению о плательщике.
 *
 * **Чего здесь намеренно нет: ответа на вопрос, блокировать ли транш.**
 * Инвариант 19 (`FUNCTIONAL.md`) говорит «удержание при любой сумме» — про
 * **средства**, и удержание средств этот файл обеспечивает: чужой платёж не
 * зачисляется на сделку ни при какой сумме. Сегодня в коде то же правило
 * означает ещё и блокировку транша, а `release_blocked` выходит только действием
 * человека — то есть один тетри от постороннего останавливает чужую сделку, а
 * референс путешествует через корреспондентов и известен многим.
 *
 * Это развилка владельца (`INTAKE.md` §7.2, §11 п.3), и решать её за него в
 * функции маршрутизации денег было бы подменой. Поэтому маршрут возвращается
 * отдельно от исхода: вызывающий волен и заблокировать транш, и оставить его в
 * `collecting` — но деньги в обоих случаях не попадут на сделку.
 */
export function routeByPayer(assessment: PayerAssessment): IntakeRouting {
  const route = ROUTE_BY_OUTCOME[assessment.outcome];
  if (assessment.outcome === 'clear') {
    return Object.freeze({
      route,
      queueTask: null,
      reasons: Object.freeze([INTAKE_REASON_KEYS.routeToClientAccount]),
    });
  }
  if (assessment.outcome === 'review') {
    return Object.freeze({
      route,
      queueTask: assessment.exceptionApplied === null ? 'payer_hold' : 'payer_exception',
      reasons: Object.freeze([INTAKE_REASON_KEYS.routeToClientAccount]),
    });
  }
  return Object.freeze({
    route,
    queueTask: 'payer_hold',
    reasons: Object.freeze([
      INTAKE_REASON_KEYS.routeToSuspense,
      INTAKE_REASON_KEYS.routePayerHold,
    ]),
  });
}

/**
 * Маршрут по исходу сопоставления. Непознанное **не пропадает и не зачисляется**:
 * `suspense:unidentified` плюс задача оператору (`FUNCTIONAL.md` §3.3, И2.2).
 *
 * `ambiguous` и `unmatched` ведут в одно место, но разными причинами: в первом
 * случае оператору выбирать из двух, во втором — искать. Один ключ на оба случая
 * стоил бы оператору лишнего круга.
 */
export function routeByMatch(match: MatchResult): IntakeRouting {
  if (match.outcome === 'auto_matched') {
    return Object.freeze({
      route: 'to_client_account',
      queueTask: null,
      reasons: Object.freeze([INTAKE_REASON_KEYS.matchAuto]),
    });
  }
  return Object.freeze({
    route: 'to_suspense',
    queueTask: 'intake_unmatched',
    reasons: Object.freeze([
      INTAKE_REASON_KEYS.routeToSuspense,
      match.outcome === 'ambiguous'
        ? INTAKE_REASON_KEYS.matchAmbiguous
        : INTAKE_REASON_KEYS.matchNoCandidate,
    ]),
  });
}

/**
 * Сводный маршрут: удержание по плательщику сильнее любого сопоставления.
 *
 * Порядок именно такой, а не «сначала сопоставили — значит зачисляем»: платёж
 * может быть безошибочно опознан по референсу и при этом прийти от постороннего.
 * Опознание сделки не делает деньги пригодными к зачислению на неё.
 */
export function combineRouting(byMatch: IntakeRouting, byPayer: IntakeRouting): IntakeRouting {
  const route: IntakeRoute =
    byMatch.route === 'to_suspense' || byPayer.route === 'to_suspense'
      ? 'to_suspense'
      : 'to_client_account';
  const queueTask = byPayer.queueTask ?? byMatch.queueTask;
  const reasons: IntakeReasonKey[] = [];
  for (const reason of [...byMatch.reasons, ...byPayer.reasons]) {
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return Object.freeze({ route, queueTask, reasons: Object.freeze(reasons) });
}
