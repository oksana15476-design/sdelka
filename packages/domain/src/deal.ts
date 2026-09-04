import { type ConditionAct, isConditionActValid } from './condition-act';
import type { ComplianceFreezeReason, FreezeReason, UnfreezeTarget } from './freeze';
import type { Instant } from './instant';
import type { Intent } from './intents';
import {
  type FilingSource,
  type ReleaseObservation,
  OBSERVATION_REQUIREMENTS,
  observationLevelAtLeast,
} from './observation';
import { RELEASE_CONDITIONS } from './release-condition';
import { type Rejection, type Result, RejectionCode, failure, ok, rejection } from './result';
import type { ReleaseConditionType } from './release-condition';
import { type TrancheStatus, isTerminalTrancheStatus } from './tranche';

/** Состояния сделки — STATE-MACHINES.md §3.1, включая `funding` между `ready` и `funded`. */
export const DEAL_STATUSES = [
  'draft',
  'parties_pending',
  'property_pending',
  'ready',
  'funding',
  'funded',
  'filed',
  'settling',
  'settled',
  'unwinding',
  'unwound',
  'cancelled',
  'frozen',
] as const;

export type DealStatus = (typeof DEAL_STATUSES)[number];

export const TERMINAL_DEAL_STATUSES = ['settled', 'unwound', 'cancelled'] as const;

export type TerminalDealStatus = (typeof TERMINAL_DEAL_STATUSES)[number];

export function isTerminalDealStatus(status: DealStatus): status is TerminalDealStatus {
  return (TERMINAL_DEAL_STATUSES as readonly string[]).includes(status);
}

/**
 * События сделки. §3.2 задаёт большинство переходов условием в скобках и не
 * называет события; имена ниже введены кодом и вынесены в отчёт.
 */
export type DealEvent =
  | { readonly type: 'parties_check_started' }
  | { readonly type: 'parties_verified' }
  | { readonly type: 'property_verified' }
  | { readonly type: 'funds_received' }
  | { readonly type: 'tranches_reserved' }
  /**
   * Подача зарегистрирована. `source` обязателен (E3-2, `ROADMAP.md` И3.2,
   * задача «источник факта как атрибут события, а не bool»): номер, названный
   * стороной, и номер, подтверждённый карточкой заявления, — два разных факта,
   * и от разницы зависит, запрещён ли автооткат (`g_no_open_filing`).
   */
  | {
      readonly type: 'filing_registered';
      readonly applicationId: string;
      readonly source: FilingSource;
    }
  | { readonly type: 'condition_established'; readonly conditionType: ReleaseConditionType }
  | { readonly type: 'condition_failed' }
  | { readonly type: 'deadline_reached' }
  | { readonly type: 'revocation_requested' }
  | { readonly type: 'tranches_settled' }
  | { readonly type: 'tranches_refunded' }
  /**
   * Основание заморозки — закрытый перечень, а не строка (CORE.md Ф17). От
   * основания зависит, какие исходы разморозки законны, и строковое основание
   * означает, что этот выбор делается в момент инцидента. `dispute_raised`
   * основания не несёт: оно у него одно по построению.
   */
  | {
      readonly type: 'compliance_hold';
      readonly reason: ComplianceFreezeReason;
      readonly frozenBy: string;
    }
  | { readonly type: 'dispute_raised'; readonly frozenBy: string }
  | {
      readonly type: 'unfreeze';
      readonly userIds: readonly string[];
      readonly resume: 'settling' | 'unwinding';
    }
  | { readonly type: 'cancellation_requested' };

export type DealEventType = DealEvent['type'];

export const DEAL_GUARD_IDS = [
  /**
   * Акт получателя об условии совершён — CORE.md Ф13. Стоит на `ready →
   * funding`: сделка не открывает приём средств, пока получатель не определил
   * обстоятельство. Тот же guard стоит на `pending → collecting` у транша —
   * деньги приходят по траншу, а состояние сделки двигается первым поступлением,
   * и закрыть нужно оба входа.
   */
  'g_condition_agreed',
  'g_all_tranches_reserved',
  'g_all_tranches_paid_out',
  'g_all_tranches_refunded',
  'g_no_live_tranche',
  /**
   * введено E3-2 (`CORE.md` Ф9, `ROADMAP.md` И3.2, `ORACLE.md` §9):
   * **автооткат запрещён, если заявление подано и не завершено.**
   *
   * До этого батча запрета не было **вовсе**: ребро
   * `filed --deadline_reached--> unwinding` стояло без единого guard'а, то есть
   * сделка, по которой заявление уже подано и принято реестром, откатывалась по
   * нашей отсечке автоматически. Это ровно тот сценарий, который Ф9 называет
   * производящим конфликт: «резерв снят, деньги у покупателя, объект тоже у
   * покупателя».
   *
   * Открытым считается заявление, подтверждённое **карточкой** и не разрешённое
   * платной выпиской. Номер, названный стороной, автооткрата не запрещает —
   * иначе сторона управляет нашим дедлайном одним сообщением (И3.2, критерий 1).
   */
  'g_no_open_filing',
  'g_unfreeze_approvers_distinct',
] as const;

export type DealGuardId = (typeof DEAL_GUARD_IDS)[number];

/**
 * Заявление о регистрации, поданное по этой сделке (E3-2, `ORACLE.md` §9).
 *
 * Не булево «заявление подано»: от источника зависит, запрещает ли оно
 * автооткат, а от наличия выписки — закрыто ли оно. Оба ответа обязаны лежать
 * при самом заявлении, иначе их складывает в одно вызывающий.
 */
export interface DealFiling {
  readonly applicationId: string;
  readonly source: FilingSource;
  /**
   * Наблюдение, которым заявление разрешено. `null` — не разрешено.
   *
   * **Статус карточки сюда не попадает никогда.** По `CORE.md` Ф7 статус
   * «завершено» не значит ничего: заявление может быть закрыто отказом.
   * Разрешает заявление только платная выписка — и **любым** своим вердиктом:
   * после расхождения автооткат снова законен, потому что дальше держать деньги
   * не на чем.
   */
  readonly resolution: ReleaseObservation | null;
}

export interface DealFacts {
  readonly trancheStatuses: readonly TrancheStatus[];
  /** Учётная запись, готовившая заморозку: разморозка невозможна ею же. */
  readonly preparedBy: string | null;
  /** Акт получателя об условии (CORE.md Ф13). `null` — приём средств закрыт. */
  readonly conditionAct: ConditionAct | null;
  /** Заявления по этой сделке. Пустой список — не подавали. */
  readonly filings: readonly DealFiling[];
  /**
   * Кадастровый код объекта сделки. Сверяется с кодом наблюдения, разрешающего
   * заявление: выписка по чужому объекту нашего заявления не закрывает
   * (И3.2, крайний случай «сторона называет чужой номер»).
   */
  readonly objectCadastralCode: string;
}

/**
 * Разрешено ли заявление платной выпиской.
 *
 * Возраст наблюдения здесь **не проверяется намеренно**, в отличие от
 * `g_observation_sufficient` (`ORACLE.md` §6.3). Свежесть — требование к
 * основанию для движения денег: устаревшая выписка не утверждает ничего о
 * сегодняшних обременениях. А «заявление закрыто» — исторический факт: выписка,
 * полученная неделю назад, не перестаёт свидетельствовать, что регистрация уже
 * разобрана. Смешать эти два вопроса значило бы снова открывать закрытое
 * заявление по истечении времени и откатывать сделку после регистрации.
 */
function resolvedByPaidExtract(filing: DealFiling, facts: DealFacts): boolean {
  const resolution = filing.resolution;
  if (resolution === null) {
    return false;
  }
  const required = OBSERVATION_REQUIREMENTS.registration_transfer;
  if (resolution.sourceKey !== required.sourceKey) {
    return false;
  }
  if (!observationLevelAtLeast(resolution.level, required.minLevel)) {
    return false;
  }
  // Пустой ожидаемый код — не «совпало с чем угодно», а отсутствие объекта, с
  // которым сверяться: отказ закрытый, заявление остаётся открытым.
  if (facts.objectCadastralCode.length === 0) {
    return false;
  }
  return resolution.cadastralCode === facts.objectCadastralCode;
}

export interface DealContext {
  readonly dealId: string;
  readonly facts: DealFacts;
  /** Нужен для проверки акта: акт, датированный будущим, не принимается. */
  readonly now: Instant;
}

const DEAL_GUARDS: Readonly<
  Record<DealGuardId, (facts: DealFacts, event: DealEvent, now: Instant) => boolean>
> = Object.freeze({
  g_condition_agreed: (facts, _event, now) => isConditionActValid(facts.conditionAct, now),
  g_all_tranches_reserved: (facts) =>
    facts.trancheStatuses.length > 0 &&
    facts.trancheStatuses.every((status) => status === 'reserved'),
  g_all_tranches_paid_out: (facts) =>
    facts.trancheStatuses.length > 0 &&
    facts.trancheStatuses.every((status) => status === 'paid_out'),
  g_all_tranches_refunded: (facts) =>
    facts.trancheStatuses.length > 0 &&
    facts.trancheStatuses.every((status) => status === 'refunded'),
  // §3.3: сделка не закрывается, пока жив хотя бы один транш.
  g_no_live_tranche: (facts) => facts.trancheStatuses.every(isTerminalTrancheStatus),
  /**
   * Нет ни одного открытого заявления — CORE.md Ф9, ORACLE.md §9.
   *
   * Заявления, названного стороной (`party_claim`), здесь как бы нет: он не
   * проверен, и признать его основанием для удержания денег значит отдать наш
   * дедлайн стороне (И3.2). Подтверждённое карточкой держит откат до тех пор,
   * пока его не разрешит платная выписка — любым вердиктом.
   */
  g_no_open_filing: (facts) =>
    facts.filings.every(
      (filing) => filing.source !== 'application_card' || resolvedByPaidExtract(filing, facts),
    ),
  g_unfreeze_approvers_distinct: (facts, event) => {
    if (event.type !== 'unfreeze') return false;
    const approvers = new Set(event.userIds.filter((userId) => userId !== facts.preparedBy));
    return approvers.size >= 2;
  },
});

export interface DealTransition {
  readonly from: DealStatus;
  readonly to: DealStatus;
  readonly event: DealEventType;
  readonly guards: readonly DealGuardId[];
  /** Различитель для `unfreeze`: документ разрешает два исхода. */
  readonly resume: 'settling' | 'unwinding' | null;
}

function transition(
  from: DealStatus,
  event: DealEventType,
  to: DealStatus,
  guards: readonly DealGuardId[] = [],
  resume: 'settling' | 'unwinding' | null = null,
): DealTransition {
  return Object.freeze({ from, to, event, guards, resume });
}

const NON_TERMINAL_DEAL_STATUSES = DEAL_STATUSES.filter(
  (status) => !isTerminalDealStatus(status) && status !== 'frozen',
);

/**
 * Отмена разрешена только до внесения денег.
 *
 * Расхождение внутри документа: §3.2 пишет «любое до funded → cancelled», что
 * включает `funding`, а §3.1 определяет `cancelled` как «отменена до внесения
 * денег». В `funding` деньги уже внесены. Выбрана формулировка §3.1: из
 * `funding` выход — `unwinding` с возвратом покупателю (красная линия №7).
 */
const CANCELLABLE_DEAL_STATUSES: readonly DealStatus[] = [
  'draft',
  'parties_pending',
  'property_pending',
  'ready',
];

export const DEAL_TRANSITIONS: readonly DealTransition[] = Object.freeze([
  transition('draft', 'parties_check_started', 'parties_pending'),
  transition('parties_pending', 'parties_verified', 'property_pending'),
  transition('property_pending', 'property_verified', 'ready'),
  transition('ready', 'funds_received', 'funding', ['g_condition_agreed']),
  transition('funding', 'tranches_reserved', 'funded', ['g_all_tranches_reserved']),
  /**
   * Тот же guard, что и на отсечке из `filed`, — на **обоих** автоматических
   * входах в откат, а не на одном (§1.4, §4: guard, стоящий на одной двери,
   * состояние не защищает). Подтверждённое заявление у сделки в `funding` — это
   * рассогласование данных, и уж точно не повод вернуть деньги молча.
   *
   * `revocation_requested` guard'а не несёт: отзыв — явное волеизъявление
   * покупателя (§1.4), а Ф9 запрещает **автоматический** откат.
   */
  transition('funding', 'deadline_reached', 'unwinding', ['g_no_open_filing']),
  transition('funding', 'revocation_requested', 'unwinding'),
  transition('funded', 'filing_registered', 'filed'),
  transition('filed', 'condition_established', 'settling'),
  transition('filed', 'condition_failed', 'unwinding'),
  /**
   * Автооткат по отсечке — **только если нет открытого заявления** (E3-2,
   * `CORE.md` Ф9). Раньше это ребро не несло ни одного guard'а, и сделка, по
   * которой заявление уже подано и принято реестром, откатывалась автоматически:
   * деньги возвращались покупателю, а объект наутро регистрировался на него же.
   *
   * `condition_failed` guard'а не получает: это явный внешний факт «условие не
   * наступило», а не течение времени, и держать деньги после него не на чем.
   */
  transition('filed', 'deadline_reached', 'unwinding', ['g_no_open_filing']),
  transition('settling', 'tranches_settled', 'settled', ['g_all_tranches_paid_out', 'g_no_live_tranche']),
  transition('unwinding', 'tranches_refunded', 'unwound', ['g_all_tranches_refunded', 'g_no_live_tranche']),
  ...NON_TERMINAL_DEAL_STATUSES.map((status) => transition(status, 'compliance_hold', 'frozen')),
  ...NON_TERMINAL_DEAL_STATUSES.map((status) => transition(status, 'dispute_raised', 'frozen')),
  transition('frozen', 'unfreeze', 'settling', ['g_unfreeze_approvers_distinct'], 'settling'),
  transition('frozen', 'unfreeze', 'unwinding', ['g_unfreeze_approvers_distinct'], 'unwinding'),
  ...CANCELLABLE_DEAL_STATUSES.map((status) =>
    transition(status, 'cancellation_requested', 'cancelled'),
  ),
]);

export interface DealState {
  readonly status: DealStatus;
}

export function dealState(status: DealStatus): DealState {
  return Object.freeze({ status });
}

export const initialDealState: DealState = dealState('draft');

export interface DealTransitionResult {
  readonly state: DealState;
  readonly intents: readonly Intent[];
}

/**
 * Каскад сделка → транши (CORE.md Ф17, E9-9).
 *
 * Без него заморозка сделки не останавливает её транши: комплаенс замораживает
 * сделку, а транш продолжает идти к автовозврату по дедлайну — то есть
 * заморозка не делает ровно того, ради чего существует. Раньше `reduceDeal` не
 * возвращал намерений вообще.
 */
function dealIntents(event: DealEvent): readonly Intent[] {
  switch (event.type) {
    case 'compliance_hold':
      return Object.freeze([
        { type: 'freeze_tranches' as const, reason: event.reason, frozenBy: event.frozenBy },
      ]);
    case 'dispute_raised':
      return Object.freeze([
        {
          type: 'freeze_tranches' as const,
          reason: 'dispute' as FreezeReason,
          frozenBy: event.frozenBy,
        },
      ]);
    case 'unfreeze': {
      // Целевые состояния у сделки и у транша разные, и отображение между ними
      // записано здесь, а не выведено в приложении: `settling` — «продолжаем как
      // шли», то есть транш возвращается в свой приостановленный статус;
      // `unwinding` — «откатываем», то есть транш идёт в возврат.
      //
      // Транш, замороженный в `paying_out` или `refunding`, это отображение не
      // примет: у него законен только `release_blocked`, и редьюсер транша
      // ответит `unfreezeTargetNotAllowed`. Так и задумано — исход поручения,
      // ушедшего в банк, разбирает человек по каждому траншу отдельно.
      const resume: UnfreezeTarget =
        event.resume === 'settling' ? 'suspended_from' : 'refund_pending';
      return Object.freeze([
        { type: 'unfreeze_tranches' as const, userIds: event.userIds, resume },
      ]);
    }
    default:
      return Object.freeze([]);
  }
}

export function reduceDeal(
  state: DealState,
  event: DealEvent,
  context: DealContext,
): Result<DealTransitionResult, Rejection> {
  if (isTerminalDealStatus(state.status)) {
    return failure(rejection(RejectionCode.terminalState, [], { status: state.status }));
  }
  if (event.type === 'condition_established') {
    const meta = RELEASE_CONDITIONS[event.conditionType];
    if (meta === undefined) {
      return failure(
        rejection(RejectionCode.releaseConditionUnknown, [], { conditionType: event.conditionType }),
      );
    }
    if (meta.requiresConfirmation) {
      return failure(
        rejection(RejectionCode.releaseConditionRequiresConfirmation, [], {
          conditionType: event.conditionType,
        }),
      );
    }
  }
  const resume = event.type === 'unfreeze' ? event.resume : null;
  const candidates = DEAL_TRANSITIONS.filter(
    (item) => item.from === state.status && item.event === event.type && item.resume === resume,
  );
  if (candidates.length === 0) {
    return failure(
      rejection(RejectionCode.transitionNotAllowed, [], {
        status: state.status,
        event: event.type,
      }),
    );
  }
  let firstFailure: readonly DealGuardId[] = [];
  for (const candidate of candidates) {
    const failed = candidate.guards.filter(
      (guard) => !DEAL_GUARDS[guard](context.facts, event, context.now),
    );
    if (failed.length > 0) {
      if (firstFailure.length === 0) firstFailure = failed;
      continue;
    }
    return ok({ state: dealState(candidate.to), intents: dealIntents(event) });
  }
  return failure(
    rejection(RejectionCode.guardFailed, firstFailure, {
      status: state.status,
      event: event.type,
    }),
  );
}
