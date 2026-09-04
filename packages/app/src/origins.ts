import type { DealEvent, DealEventType, TrancheEvent, TrancheEventType, WithdrawalEvent, WithdrawalEventType } from '@sdelka/domain';
import type { ObservationEvent, ObservationEventType } from '@sdelka/oracle';
import type { StepOrigin } from './authority';

/**
 * Что каким полномочием разрешается — **разбор, обязанный быть полным**.
 *
 * Каждая карта объявлена как `Record<…EventType, …>`: событие, добавленное в
 * домен и не названное здесь, ломает компиляцию. Это то же правило, по которому
 * `separationRulesFor` в `@sdelka/auth` требует ответить за каждое полномочие, и
 * по той же причине: умолчание здесь означает «разрешено всем и всегда».
 *
 * Значение — **перечень** допустимых происхождений, а не одно: часть событий
 * законно порождается и человеком, и машиной (`condition_established` приходит
 * от машины наблюдения; `filing_registered` — от неё же либо от оператора
 * оракула). Перечень из двух — это факт о событии, а не поблажка: там, где
 * машины быть не может, в перечне её нет.
 *
 * ## ⚠ Что здесь **[открыто]**
 *
 * Перечень полномочий `ACTORS.md` §5.1 закрыт (28 значений) и **не покрывает
 * операционную механику расчёта**: «выдать инструкции на оплату», «отнести
 * поступление на транш», «внести исход провайдера», «зачислить по банковской
 * выписке», «запросить вывод остатка» — таких полномочий в документе нет.
 * Добавить их здесь нельзя: перечень зеркалится в `sdelka.capability`
 * (`packages/db`, `0010`), и односторонняя правда развалила бы гранты базы.
 *
 * Поэтому такие шаги разрешены **самым узким из существующих** полномочий —
 * `create_deal`: им владеет ровно одна роль (`operator`), он класса `prepare`
 * (готовит, не разрешает движение), и никакая несовместимость его не
 * связывает — то есть шире, чем «оператор ведёт сделку», он ничего не
 * открывает. Развилка названа в отчёте: полномочие «вести расчёт» нужно
 * завести в `ACTORS.md` §5.1 и в `sdelka.capability` одним изменением.
 */

/** Оператор ведёт сделку. См. оговорку [открыто] в заголовке файла. */
const CONDUCT = ['create_deal'] as const;
/** Проверка стороны и разбор расхождения: оператор, аналитик, офицер. */
const CHECK = ['run_screening'] as const;
/** Утверждение с денежным эффектом: только ФК (уровень 1) и РО (уровень 2). */
const APPROVE = ['approve_payout'] as const;
/** Снятие удержания: Н5 — тот, кто вызвал расхождение, его не снимает. */
const LIFT = ['lift_block'] as const;
/** Сторона распоряжается своим участием (`ACTORS.md` §7.3). */
const PARTY_ACT = ['freeze_participation'] as const;
/** Часы приложения. Человеку это происхождение недоступно. */
const CLOCK = ['clock'] as const;
/** Оператор оракула вносит наблюдение. */
const OBSERVE = ['record_observation'] as const;

/* ------------------------------------------------------------------------- */
/* Транш                                                                     */
/* ------------------------------------------------------------------------- */

export const TRANCHE_EVENT_ORIGINS = {
  /** Инструкции на оплату выдаёт оператор. [открыто] — см. заголовок. */
  instructions_issued: CONDUCT,
  /**
   * Отнесение поступления на транш. Деньги в учёт зачисляет отдельный шаг; это
   * событие связывает их со сделкой. [открыто] — см. заголовок.
   */
  funds_received: CONDUCT,
  reserve_requested: CONDUCT,
  /** Срок резерва истёк. Породить это может только `tick`. */
  reserve_expired: CLOCK,
  /**
   * Отзыв покупателем — действие **стороны**, а не наши. Полномочие
   * «распорядиться своим участием» у роли `party` есть, и шаг дополнительно
   * сверяет, что действующее лицо и есть покупатель этого транша.
   */
  revocation_requested: PARTY_ACT,
  /**
   * Условие установлено (или провалено) — **только машиной наблюдения**.
   *
   * Ровно то, что `ORACLE.md` §8 и `STATE-MACHINES.md` §8 и говорят: вердикт
   * выводит машина из полученного документа, а не человек из своего мнения.
   * Человеческого происхождения у этого события нет вовсе, и сценарии,
   * подававшие его руками после `attachObservation`, переведены на машину —
   * прежде они проверяли контур, которого в продукте нет.
   *
   * Это же и единственное движение денег, которое человек не разрешает: дальше
   * стоит `release_authorized` с кворумом, и вот он уже человеческий.
   */
  condition_established: ['oracle_source'],
  condition_failed: ['oracle_source'],
  /**
   * Расхождение выявлено: либо машиной наблюдения по полям выписки, либо
   * человеком при проверке.
   */
  mismatch_detected: ['run_screening', 'oracle_source'],
  approval_added: APPROVE,
  operator_blocked: CHECK,
  release_authorized: APPROVE,
  refund_initiated: CONDUCT,
  /** Исход провайдера вносится в мир человеком по ответу банка. [открыто] */
  payout_result: CONDUCT,
  reconciliation_resolved: CONDUCT,
  deadline_reached: CLOCK,
  refund_requested: CONDUCT,
  /** Списание невостребованного — утверждение с денежным эффектом. */
  write_off_approved: APPROVE,
  /** Новая редакция акта об условии — акт сторон, полномочие стороны. */
  condition_act_amended: ['record_condition_act'],
  compliance_hold: CHECK,
  dispute_raised: CHECK,
  unfreeze: LIFT,
} as const satisfies Record<TrancheEventType, readonly StepOrigin[]>;

export type TrancheOrigin<E extends TrancheEvent> =
  (typeof TRANCHE_EVENT_ORIGINS)[E['type']][number];

export function trancheOriginsOf(event: TrancheEvent): readonly StepOrigin[] {
  return TRANCHE_EVENT_ORIGINS[event.type];
}

/* ------------------------------------------------------------------------- */
/* Сделка                                                                    */
/* ------------------------------------------------------------------------- */

export const DEAL_EVENT_ORIGINS = {
  parties_check_started: CHECK,
  parties_verified: CHECK,
  /** Проверка объекта — своё полномочие, `ACTORS.md` §5.1 (Ф3). */
  property_verified: ['verify_property'],
  funds_received: CONDUCT,
  tranches_reserved: CONDUCT,
  /**
   * Регистрация заявления и отметка сделки об условии.
   *
   * Первое происхождение — машина наблюдения (единственное место, где источник
   * подачи известен достоверно). Второе — **оператор**, а не оператор оракула, и
   * это [открыто], а не выбор.
   *
   * ⚠ `record_observation` здесь стоять не может, хотя по смыслу должно:
   * полномочие принадлежит только роли `oracle_operator`, а у неё **нет
   * соответствия в `AUDIT_ROLES`** (`ACTORS.md` §13: восемь значений журнала
   * против двенадцати ролей доступа). Шаг сделки пишет в журнал запись о
   * переходе, актор записи обязателен, подставить похожую роль нельзя —
   * журнал не редактируется. То есть под полномочием оператора оракула шаг
   * сделки сегодня **непроводим вовсе**, и это расхождение перечней, а не
   * решение о правах. Чинится строкой в `packages/audit` плюс миграцией
   * `sdelka.audit_role`; до тех пор отметку сделки ставит оператор, ведущий её.
   *
   * Деньги при этом не двигаются: движение стоит на событии **транша**, и оно
   * принадлежит машине наблюдения (`condition_established` у транша).
   */
  filing_registered: ['oracle_source', 'create_deal'],
  condition_established: ['oracle_source', 'create_deal'],
  condition_failed: ['oracle_source', 'create_deal'],
  /**
   * Срок сделки истёк.
   *
   * ⚠ **[открыто]** Часов у сделки нет: `packages/domain/src/schedule.ts`
   * называет события только для транша, и `dueDealEvent` не существует. То
   * есть **когда** срок наступил, продукт сегодня не решает нигде — решает
   * вызывающий. Происхождение при этом оставлено машинным: человеку это
   * событие не принадлежит ни в каком прочтении (Ф9 запрещает автооткат по
   * воле, а не по времени), и подать его можно только через `expireDeal`, чьё
   * разрешение из пакета не выходит.
   */
  deadline_reached: CLOCK,
  revocation_requested: PARTY_ACT,
  /**
   * Откат утверждён людьми. `approve_lift_block` — «вторая подпись» §5.3,
   * связана Н1, Н4, Н5 и Н6 сразу: утверждающий не готовил разбор, не заявлял
   * реквизиты и не вызывал расхождение.
   */
  unwind_authorized: ['approve_lift_block'],
  tranches_settled: CONDUCT,
  tranches_refunded: CONDUCT,
  compliance_hold: CHECK,
  dispute_raised: CHECK,
  unfreeze: LIFT,
  cancellation_requested: CONDUCT,
} as const satisfies Record<DealEventType, readonly StepOrigin[]>;

export type DealOrigin<E extends DealEvent> = (typeof DEAL_EVENT_ORIGINS)[E['type']][number];

export function dealOriginsOf(event: DealEvent): readonly StepOrigin[] {
  return DEAL_EVENT_ORIGINS[event.type];
}

/* ------------------------------------------------------------------------- */
/* Наблюдение                                                                */
/* ------------------------------------------------------------------------- */

export const OBSERVATION_EVENT_ORIGINS = {
  observation_started: OBSERVE,
  filing_claimed: OBSERVE,
  filing_card_observed: OBSERVE,
  statutory_term_elapsed: OBSERVE,
  /** Заказ платной выписки — расход, у него обязан быть автор (§5.1, Ф7). */
  extract_ordered: ['order_extract'],
  extract_received: OBSERVE,
  registry_unavailable: OBSERVE,
  registry_recovered: OBSERVE,
  observation_abandoned: OBSERVE,
} as const satisfies Record<ObservationEventType, readonly StepOrigin[]>;

export type ObservationOrigin<E extends ObservationEvent> =
  (typeof OBSERVATION_EVENT_ORIGINS)[E['type']][number];

export function observationOriginsOf(event: ObservationEvent): readonly StepOrigin[] {
  return OBSERVATION_EVENT_ORIGINS[event.type];
}

/* ------------------------------------------------------------------------- */
/* Вывод со счёта клиента                                                    */
/* ------------------------------------------------------------------------- */

export const WITHDRAWAL_EVENT_ORIGINS = {
  /** Подпись под выводом — то же утверждение с денежным эффектом, что у транша. */
  withdrawal_approved: APPROVE,
  withdrawal_blocked: CHECK,
  withdrawal_dispatched: CONDUCT,
  withdrawal_cancelled: CONDUCT,
  payout_result: CONDUCT,
  reconciliation_resolved: CONDUCT,
} as const satisfies Record<WithdrawalEventType, readonly StepOrigin[]>;

export type WithdrawalOrigin<E extends WithdrawalEvent> =
  (typeof WITHDRAWAL_EVENT_ORIGINS)[E['type']][number];

export function withdrawalOriginsOf(event: WithdrawalEvent): readonly StepOrigin[] {
  return WITHDRAWAL_EVENT_ORIGINS[event.type];
}
