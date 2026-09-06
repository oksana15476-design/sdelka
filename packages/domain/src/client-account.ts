import { type CurrencyCode, type Money, compare, isPositive, money } from '@sdelka/money';
import type { Approval } from './guards';
import { withdrawalIdempotencyKey } from './ids';
import {
  type Deadline,
  type DurationMs,
  type Instant,
  DAY,
  HOUR,
  deadline,
  plus,
} from './instant';
import { type Rejection, type Result, RejectionCode, failure, ok, rejection } from './result';
import type { PayoutOutcome, ReconciliationOutcome } from './tranche-events';

/**
 * Счёт клиента со стороны домена — CORE.md Ф14, ROADMAP.md И12.1–И12.4.
 *
 * Домен остатки **не считает**: их считает `@sdelka/ledger`
 * (`freeBalance`, `clientStatement`), домен читает готовое — ровно как с
 * `facts.coverageOk`. Здесь живут только решения: можно ли вывести и в каком
 * состоянии вывод.
 *
 * Внутреннее движение «свободные деньги на свою сделку» (И12.4) вынесено в
 * `allocation.ts`: наружу оно не уходит, машины у него нет, исполняет его
 * автомат транша получающей сделки — общего с выводом у них только проверка
 * свободного остатка.
 */

/**
 * Счёт-источник **движения**, а не личности (ROADMAP.md И12.2, крайний случай).
 *
 * Для денег, пришедших от расчёта по сделке, где клиент был получателем,
 * «счёт-источник» — это реквизиты выплаты того участия, а не карта, с которой он
 * когда-то платил как покупатель. Поэтому источник — свойство движения и
 * приходит в фактах вывода, а не выводится из профиля.
 */
export interface SourceAccountRef {
  /** Непрозрачный ключ реквизитов. Номера счёта в домене нет и быть не должно. */
  readonly accountRef: string;
  /**
   * Имя владельца счёта-источника совпадает с плательщиком.
   * FUNCTIONAL.md инвариант 20: возврат только на счёт-источник **на имя
   * плательщика**. Совпадения счёта недостаточно — счёт может быть чужим.
   */
  readonly holderIsPayer: boolean;
}

/** Часть остатка, запертая под конкретный транш, и до какого момента. */
export interface LockedPortion {
  readonly dealId: string;
  readonly trancheId: string;
  readonly amount: Money<CurrencyCode>;
  /** Отсечка **этой** сделки, а не «до расчёта» вообще (И12.1). */
  readonly until: Instant;
}

/**
 * Порог утверждений для вывода: две подписи (ROADMAP.md И12.2 — «поручение на
 * возврат через тот же ручной контур, что и выплата, две подписи»).
 *
 * ⚠ **[открыто]** Лестница `DEFAULT_APPROVAL_POLICY` привязана к сумме
 * **сделки**; у вывода сделки нет. Применяется ли лестница к сумме вывода или у
 * вывода фиксированные две подписи независимо от суммы — документом не задано.
 * Здесь выбрано фиксированное значение: оно строже лестницы на малых суммах и
 * никогда не мягче, то есть ошибка в эту сторону не стоит денег.
 */
export const WITHDRAWAL_REQUIRED_APPROVALS = 2;

export interface ClientAccountFacts {
  /**
   * Чей это остаток — ключ счёта клиента (`client:{клиент}:free` в учёте).
   *
   * Выводу поле не нужно: заявка уже привязана к клиенту тем, что её завели, и
   * второго ответа на вопрос «чей вывод» в машине нет. Нужно оно внутреннему
   * движению (`allocation.ts`, И12.4): разрешение обязано называть владельца
   * остатка, который проверили, иначе транш примет разрешение, выданное по
   * чужому счёту, и спишет с того, кого назвал вызывающий.
   *
   * ⚠ Поле необязательное **только ради вызывающих вне домена**, собиравших
   * факты до появления внутреннего движения. Без него разрешение не выдаётся
   * вовсе (`RejectionCode.allocationOwnerUnknown`), поэтому пропуск не
   * ослабляет правило, а закрывает дорогу. Когда `packages/app` начнёт называть
   * владельца, поле обязано стать обязательным.
   */
  readonly clientKey?: string;
  /** Свободная часть остатка. Считает ledger (`freeBalance`), домен читает. */
  readonly free: Money<CurrencyCode>;
  /** Запертые части: у каждой свой транш и своя отсечка. */
  readonly locked: readonly LockedPortion[];
  /** Сумма, которую просят вывести или направить на сделку. */
  readonly requestedAmount: Money<CurrencyCode>;
  /** `null` — счёт-источник неизвестен. Отказ закрытый, а не «куда-нибудь». */
  readonly sourceAccount: SourceAccountRef | null;
  /** Учётная запись, готовившая вывод: она не может быть утверждающей. */
  readonly preparedBy: string | null;
  readonly approvals: readonly Approval[];
  /** Число выводов этого клиента в активных статусах. */
  readonly activeWithdrawals: number;
}

/* ------------------------------------------------------------------------- */
/* Guard'ы вывода                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Guard'ы вывода — свой перечень, а не перечень транша: события и факты другие.
 * Имена совпадают там, где совпадает правило (`g_source_account_known` — это
 * тот же инвариант 20), и это намеренно: §9 требует единого словаря.
 *
 * ⚠ **`g_coverage_ok` здесь нет и не должно быть.** ROADMAP.md И12.2: при
 * остановке приёма новых сделок стоп-краном вывод и возвраты **продолжают
 * исполняться**, иначе стоп-кран превращается в удержание чужих денег (красная
 * линия №7). Это ровно то место, где guard однажды поставят «за компанию» —
 * `withdrawal.test.ts` держит на этом тест-надгробие.
 */
export const WITHDRAWAL_GUARD_IDS = [
  'g_free_balance_sufficient',
  'g_source_account_known',
  'g_approvals_sufficient',
  'g_withdrawal_approvers_distinct',
  'g_no_active_withdrawal',
] as const;

export type WithdrawalGuardId = (typeof WITHDRAWAL_GUARD_IDS)[number];

function distinctApprovers(facts: ClientAccountFacts): number {
  const approvers = new Set<string>();
  for (const approval of facts.approvals) {
    if (approval.userId !== facts.preparedBy) {
      approvers.add(approval.userId);
    }
  }
  return approvers.size;
}

export const WITHDRAWAL_GUARDS: Readonly<
  Record<WithdrawalGuardId, (facts: ClientAccountFacts) => boolean>
> = Object.freeze({
  /**
   * Свободного остатка хватает. Запертая часть в сравнении не участвует вовсе:
   * она лежит на другом счёте (`client:{клиент}:tranche:{сделка}:{транш}`), и
   * красная линия №1 держится этим, а не проверкой. Сравнение — в одной валюте:
   * остаток в другой валюте это не «мало», а «несравнимо», отказ закрытый.
   */
  g_free_balance_sufficient: (facts) => {
    if (facts.free.currency !== facts.requestedAmount.currency) return false;
    if (!isPositive(facts.requestedAmount)) return false;
    return compare(facts.free, facts.requestedAmount) >= 0;
  },
  // Инвариант 20: возврат только на счёт-источник, на имя плательщика.
  g_source_account_known: (facts) =>
    facts.sourceAccount !== null &&
    facts.sourceAccount.accountRef.length > 0 &&
    facts.sourceAccount.holderIsPayer,
  g_approvals_sufficient: (facts) => distinctApprovers(facts) >= WITHDRAWAL_REQUIRED_APPROVALS,
  g_withdrawal_approvers_distinct: (facts) => distinctApprovers(facts) === facts.approvals.length,
  g_no_active_withdrawal: (facts) => facts.activeWithdrawals === 0,
});

export function evaluateWithdrawalGuard(
  guard: WithdrawalGuardId,
  facts: ClientAccountFacts,
): boolean {
  return WITHDRAWAL_GUARDS[guard](facts);
}

/* ------------------------------------------------------------------------- */
/* Машина вывода                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Состояния вывода со счёта клиента.
 *
 * Исходящая нога не переизобретается: `paying_out` здесь означает ровно то же,
 * что у транша, — поручение ушло, исход ведёт машина «Выплата» (`payout.ts`) с
 * её легальным `unknown` и запретом повтора без сверки (§2.2). У вывода только
 * своё начало: остаток, источник и две подписи.
 */
export const WITHDRAWAL_STATUSES = [
  'requested',
  'approved',
  'paying_out',
  'paid_out',
  'blocked',
  'cancelled',
] as const;

export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

export const TERMINAL_WITHDRAWAL_STATUSES = ['paid_out', 'cancelled'] as const;

export type TerminalWithdrawalStatus = (typeof TERMINAL_WITHDRAWAL_STATUSES)[number];

export function isTerminalWithdrawalStatus(
  status: WithdrawalStatus,
): status is TerminalWithdrawalStatus {
  return (TERMINAL_WITHDRAWAL_STATUSES as readonly string[]).includes(status);
}

export type NonTerminalWithdrawalStatus = Exclude<WithdrawalStatus, TerminalWithdrawalStatus>;

/**
 * Нетерминальные статусы перечнем — **выведены** из двух уже существующих, а не
 * набраны третьим списком. Третий список это третье место, где перечень
 * расходится: у транша ровно так и разъехались таблица часов и таблица
 * переходов.
 */
export const NON_TERMINAL_WITHDRAWAL_STATUSES: readonly NonTerminalWithdrawalStatus[] =
  Object.freeze(
    WITHDRAWAL_STATUSES.filter(
      (status): status is NonTerminalWithdrawalStatus => !isTerminalWithdrawalStatus(status),
    ),
  );

export type WithdrawalEvent =
  | { readonly type: 'withdrawal_approved' }
  | { readonly type: 'withdrawal_blocked'; readonly reason: string }
  | { readonly type: 'withdrawal_dispatched' }
  | { readonly type: 'withdrawal_cancelled' }
  | { readonly type: 'payout_result'; readonly outcome: PayoutOutcome }
  | { readonly type: 'reconciliation_resolved'; readonly outcome: ReconciliationOutcome };

export type WithdrawalEventType = WithdrawalEvent['type'];

export interface WithdrawalTransition {
  readonly from: WithdrawalStatus;
  readonly to: WithdrawalStatus;
  readonly event: WithdrawalEventType;
  readonly guards: readonly WithdrawalGuardId[];
  readonly negatedGuards: readonly WithdrawalGuardId[];
  readonly outcome: PayoutOutcome | null;
}

function transition(
  from: WithdrawalStatus,
  event: WithdrawalEventType,
  to: WithdrawalStatus,
  guards: readonly WithdrawalGuardId[] = [],
  negatedGuards: readonly WithdrawalGuardId[] = [],
  outcome: PayoutOutcome | null = null,
): WithdrawalTransition {
  return Object.freeze({ from, to, event, guards, negatedGuards, outcome });
}

const APPROVAL_GUARDS: readonly WithdrawalGuardId[] = [
  'g_free_balance_sufficient',
  'g_source_account_known',
  'g_approvals_sufficient',
  'g_withdrawal_approvers_distinct',
];

export const WITHDRAWAL_TRANSITIONS: readonly WithdrawalTransition[] = Object.freeze([
  transition('requested', 'withdrawal_approved', 'approved', APPROVAL_GUARDS),
  // Счёт-источник неизвестен — вывод не создаётся, задача уходит оператору с
  // причиной (И12.2). Та же форма, что у `refund_pending → release_blocked` у
  // транша: неизвестный источник это не отказ клиенту, а работа человека.
  transition('requested', 'withdrawal_approved', 'blocked', [], ['g_source_account_known']),
  transition('requested', 'withdrawal_blocked', 'blocked'),
  transition('requested', 'withdrawal_cancelled', 'cancelled'),

  transition('approved', 'withdrawal_dispatched', 'paying_out', ['g_no_active_withdrawal']),
  /**
   * Из `approved` отмены нет, и это **отсутствие ребра, а не проверка**.
   *
   * Ребро было, и оно расходилось с принятым текстом интерфейса, который
   * утверждает о машине прямо: «перехода из утверждённой в отменённую в системе
   * нет» (`withdraw.cancel.blocked`, `withdraw.review.note`). Две стороны
   * говорили разное об одном автомате; сведено к строгой — к той, что уже
   * обещана клиенту.
   *
   * Дорога к отмене при этом не пропадает: `approved --withdrawal_blocked-->
   * blocked --withdrawal_cancelled--> cancelled`. Разница в том, что
   * терминальную отмену утверждённого поручения теперь нельзя совершить молча —
   * `withdrawal_blocked` несёт `reason`, а `withdrawal_cancelled` не несёт
   * ничего. Деньги при этом не двигаются ни в одном из двух вариантов: до
   * `paying_out` они лежат в свободной части счёта клиента, поэтому строгая
   * сторона ничего у клиента не удерживает (красная линия №7).
   *
   * ⚠ **[открыто]** владельцу: может ли клиент отозвать **уже утверждённое**
   * поручение сам, из кабинета. Если да — ребро возвращается вместе с событием,
   * называющим отзывающего (у `withdrawal_cancelled` актора нет, и «отменил
   * клиент» от «отменил оператор» машина сегодня не отличает), а принятый текст
   * переписывается. Пока ответа нет, выбран строгий вариант: он никогда не
   * мягче, и ошибка в эту сторону не стоит клиенту денег.
   */
  transition('approved', 'withdrawal_blocked', 'blocked'),

  transition('paying_out', 'payout_result', 'paid_out', [], [], 'settled'),
  transition('paying_out', 'payout_result', 'blocked', [], [], 'rejected'),
  // «Неизвестно» оставляет вывод здесь: повтор запрещён без сверки (§2.2).
  transition('paying_out', 'payout_result', 'paying_out', [], [], 'unknown'),
  transition('paying_out', 'reconciliation_resolved', 'paid_out', [], [], 'settled'),
  transition('paying_out', 'reconciliation_resolved', 'blocked', [], [], 'rejected'),

  transition('blocked', 'withdrawal_approved', 'approved', APPROVAL_GUARDS),
  transition('blocked', 'withdrawal_cancelled', 'cancelled'),
]);

/* ------------------------------------------------------------------------- */
/* Чем заявка пришла в состояние                                             */
/* ------------------------------------------------------------------------- */

/**
 * Исход поручения, с которым заявка **пришла** в состояние.
 *
 * `null` — пришла не с ответом банка: заявку создали, утвердили, отправили,
 * остановила наша проверка, отменили. Остальные три — ответ по поручению, и
 * `unknown` среди них **законный** (красная линия №8): банк не ответил, и это не
 * ошибка, а положение, о котором обязаны сказать вслух.
 *
 * Почему величина отдельная, а не оттенок статуса: один статус достигается
 * разными рёбрами, и для клиента они означают разное.
 *
 * - `paying_out` ← `withdrawal_dispatched` (`null`) — поручение ушло, ответа
 *   ждём; ← `payout_result('unknown')` — ответа банка нет, исход неизвестен;
 * - `blocked` ← `withdrawal_blocked` и ← `withdrawal_approved` при неизвестном
 *   счёте-источнике (оба `null`) — остановила **наша** проверка;
 *   ← `payout_result('rejected')` — банк не исполнил поручение.
 *
 * Перечень **выведен из таблицы переходов**, а не набран вторым списком:
 * `outcome` уже стоит у ребра, и второй список разошёлся бы с ним на первом же
 * новом ребре — ровно так разъезжались таблица часов и таблица переходов у
 * транша.
 *
 * ⚠ В `WithdrawalState` исхода **нет**: состояние помнит статус, срок и момент
 * входа, но не помнит, чем в него вошли. Кто ведёт заявку — знает событие,
 * которое подал; кто прочитал её из хранилища — не знает ничего, и «чем пришли»
 * для него законно неизвестно. Поэтому исход передаётся **рядом** с состоянием,
 * а не достаётся из него, и «неизвестно, чем пришли» остаётся выразимым.
 */
export type WithdrawalArrival = PayoutOutcome | null;

/**
 * Состояние созданной заявки. Входящих рёбер у него нет вовсе: в него попадают
 * `createWithdrawal`, а не переходом, — поэтому в перечне «чем пришли» оно
 * названо здесь, а не найдено в таблице.
 */
export const WITHDRAWAL_INITIAL_STATUS = 'requested' as const satisfies NonTerminalWithdrawalStatus;

/**
 * Чем можно прийти в состояние — спрашивается у таблицы переходов.
 *
 * Порядок значений — порядок рёбер: `null` (если такое ребро есть) стоит первым,
 * потому что первым описан обычный ход заявки, а ответы банка идут за ним.
 */
export function withdrawalArrivals(status: WithdrawalStatus): readonly WithdrawalArrival[] {
  const found: WithdrawalArrival[] = status === WITHDRAWAL_INITIAL_STATUS ? [null] : [];
  for (const item of WITHDRAWAL_TRANSITIONS) {
    if (item.to !== status || found.includes(item.outcome)) continue;
    found.push(item.outcome);
  }
  return Object.freeze(found);
}

/** Мог ли вывод прийти в это состояние с таким исходом. */
export function isWithdrawalArrival(
  status: WithdrawalStatus,
  arrival: WithdrawalArrival,
): boolean {
  return withdrawalArrivals(status).includes(arrival);
}

/**
 * Состояние заявки на вывод.
 *
 * **Дедлайн лежит внутри нетерминального варианта** — тем же приёмом, что у
 * транша (`tranche.ts`, `FUNCTIONAL.md` инвариант 7): «нетерминальная заявка без
 * дедлайна» не собирается, потому что такого варианта союза нет. До сих пор его
 * не было вовсе: заявка могла стоять сколько угодно, и никто об этом не узнавал
 * (`DECISIONS-REVIEW.md` §H4).
 *
 * Отметок времени две, и смешивать их нельзя (`STATE-MACHINES.md` §5):
 *
 * - `deadline` — **срок операции**. Двигается: повторный `payout_result(unknown)`
 *   пересчитывает его, потому что банк ответил и отсчёт пошёл заново.
 * - `enteredAt` — момент входа в состояние. **Не двигается** внутренним
 *   самопереходом, и именно по нему считается возраст и эскалация. Считай
 *   возраст по дедлайну — застрявшая в «неизвестно» заявка выглядела бы вечно
 *   свежей и не попадала бы в очередь разбора никогда.
 */
export type WithdrawalState =
  | {
      readonly status: NonTerminalWithdrawalStatus;
      readonly withdrawalId: string;
      /** Ключ детерминирован по выводу: ни попытки, ни времени в нём нет. */
      readonly idempotencyKey: string;
      readonly deadline: Deadline;
      readonly enteredAt: Instant;
    }
  | {
      readonly status: TerminalWithdrawalStatus;
      readonly withdrawalId: string;
      readonly idempotencyKey: string;
    };

export function nonTerminalWithdrawalState(
  status: NonTerminalWithdrawalStatus,
  withdrawalId: string,
  at: Deadline,
  enteredAt: Instant,
): WithdrawalState {
  return Object.freeze({
    status,
    withdrawalId,
    idempotencyKey: withdrawalIdempotencyKey(withdrawalId),
    deadline: at,
    enteredAt,
  });
}

/**
 * Терминальная заявка часов не имеет вовсе: ни дедлайна, ни возраста. Выплаченный
 * и отменённый вывод не эскалируют, и спрашивать о них часы нечего.
 */
export function terminalWithdrawalState(
  status: TerminalWithdrawalStatus,
  withdrawalId: string,
): WithdrawalState {
  return Object.freeze({
    status,
    withdrawalId,
    idempotencyKey: withdrawalIdempotencyKey(withdrawalId),
  });
}

/* ------------------------------------------------------------------------- */
/* Часы заявки                                                               */
/* ------------------------------------------------------------------------- */

/** Сроки операции по нетерминальным состояниям заявки. */
export type WithdrawalDeadlinePolicy = Readonly<
  Record<NonTerminalWithdrawalStatus, DurationMs>
>;

/** Нормативы простоя: после какого возраста заявку поднимают человеку. */
export type WithdrawalEscalationPolicy = Readonly<
  Record<NonTerminalWithdrawalStatus, DurationMs>
>;

/**
 * Часы заявки целиком: срок операции и норматив простоя.
 *
 * Две таблицы, а не одна, и по той же причине, по которой их две у транша:
 * дедлайн двигается ответом банка, норматив — нет. Одно число на обе роли
 * означало бы, что каждый неответ банка обнуляет и норматив тоже.
 */
export interface WithdrawalClockPolicy {
  readonly deadline: WithdrawalDeadlinePolicy;
  readonly escalation: WithdrawalEscalationPolicy;
}

/**
 * ⚠ **ВРЕМЕННОЕ ЗНАЧЕНИЕ, НЕ РЕШЕНИЕ ВЛАДЕЛЬЦА.**
 *
 * Ни одного из этих восьми чисел нет ни в одном документе проекта: `H4` в
 * `DECISIONS-REVIEW.md` прямо называет норматив вывода **числом владельца** и
 * оставляет его открытым, `CABINETS-REDESIGN.md` §6.5 — тоже. Значения взяты
 * **по аналогии** с таблицами транша (`DEFAULT_DEADLINE_POLICY`,
 * `DEFAULT_ESCALATION_POLICY`) — то есть это перенос чужого умолчания, а не
 * выбор:
 *
 * - `requested` — сутки, как `pending` у транша: заявка заведена, денег никуда
 *   не двигали;
 * - `approved` — четыре часа на отправку поручения, как `release_pending`:
 *   подписи собраны, дальше дело человека, и это самое дорогое ожидание для
 *   клиента — деньги уже обещаны;
 * - `paying_out` — сутки на ответ банка, эскалация на вторые: выход отсюда
 *   гарантирует ежедневная сверка, и в норматив попадает ровно та заявка,
 *   которая застряла между повторами `unknown`;
 * - `blocked` — четыре часа, как `release_blocked`: выход зависит **только** от
 *   человека, поэтому норматив самый короткий.
 *
 * Пока владелец не ответил, значение живёт версией настройки
 * (`@sdelka/settings`), а не константой в коде: подставленное сюда число —
 * временное умолчание, и всякий, кто его читает, обязан видеть это слово.
 *
 * Вопрос — `DECISIONS-REVIEW.md` §H4 **[открыто]**.
 */
export const PROVISIONAL_WITHDRAWAL_CLOCK: WithdrawalClockPolicy = Object.freeze({
  deadline: Object.freeze({
    requested: DAY,
    approved: (4 * HOUR) as DurationMs,
    paying_out: DAY,
    blocked: DAY,
  }),
  escalation: Object.freeze({
    requested: DAY,
    approved: (4 * HOUR) as DurationMs,
    paying_out: (2 * DAY) as DurationMs,
    blocked: (4 * HOUR) as DurationMs,
  }),
});

/**
 * **Часы заявки не двигают деньги ни из одного состояния — и это выражено
 * типом, а не значением.**
 *
 * У транша таблица часов частичная: три состояния наступление срока уводит
 * дальше автоматически. У вывода таких состояний нет **ни одного**, и тип
 * `Record<…, null>` не даёт их появиться правкой значения:
 *
 * - `requested` и `approved` — деньги клиента лежат в свободной части его же
 *   счёта, и автоматический выход отсюда был бы либо выпуском поручения без
 *   человека, либо отменой заявки без основания;
 * - `paying_out` — красная линия №8: «неизвестно» у выплаты легально, и повтор
 *   из него запрещён без прохождения через сверку. Событие по сроку здесь и
 *   есть тот автоматический повтор, ради запрета которого правило написано;
 * - `blocked` — то же, что `release_blocked` у транша: автоматический выход из
 *   разбора — дефект, ради запрета которого состояние существует.
 *
 * Наступление срока поднимает **человека** (`isWithdrawalStalled` → очередь
 * разбора `@sdelka/compliance`), и другого исхода у часов вывода нет.
 */
export const WITHDRAWAL_CLOCK_EVENTS: Readonly<Record<NonTerminalWithdrawalStatus, null>> =
  Object.freeze({
    requested: null,
    approved: null,
    paying_out: null,
    blocked: null,
  });

/**
 * Возраст состояния заявки в миллисекундах — от входа в него, а не от дедлайна.
 * `null` у терминальной: у закрытой заявки возраста нет, её не эскалируют.
 *
 * Число, а не `DurationMs`: ноль и отрицательное — законные значения (заявка
 * только что вошла в состояние; часы дежурного разошлись с записью), а
 * `DurationMs` строго положителен по построению.
 */
export function withdrawalStateAge(state: WithdrawalState, now: Instant): number | null {
  return 'enteredAt' in state ? now - state.enteredAt : null;
}

/**
 * Простояла ли заявка дольше норматива. Отдельно от дедлайна: дедлайн — срок
 * операции, норматив — часы внимания дежурного (`STATE-MACHINES.md` §5).
 */
export function isWithdrawalStalled(
  state: WithdrawalState,
  now: Instant,
  policy: WithdrawalEscalationPolicy,
): boolean {
  if (!('enteredAt' in state)) return false;
  return now - state.enteredAt >= policy[state.status];
}

/**
 * Заявка на вывод. Дедлайн ставится сразу: состояния без него не существует.
 */
export function createWithdrawal(
  withdrawalId: string,
  now: Instant,
  policy: WithdrawalDeadlinePolicy,
): WithdrawalState {
  return nonTerminalWithdrawalState(
    WITHDRAWAL_INITIAL_STATUS,
    withdrawalId,
    deadline(plus(now, policy[WITHDRAWAL_INITIAL_STATUS])),
    now,
  );
}

export interface WithdrawalTransitionResult {
  readonly state: WithdrawalState;
  readonly failedGuards: readonly WithdrawalGuardId[];
}

function eventOutcome(event: WithdrawalEvent): PayoutOutcome | null {
  if (event.type === 'payout_result') return event.outcome;
  if (event.type === 'reconciliation_resolved') return event.outcome;
  return null;
}

/**
 * Что нужно шагу сверх фактов: **момент и таблица сроков**.
 *
 * Отдельный аргумент, а не поле фактов: факты отвечают на вопрос «можно ли»
 * (остаток, счёт-источник, подписи), контекст — «когда». Смешать их значило бы
 * разрешить вызывающему подать вместе с остатком и своё «сейчас».
 */
export interface WithdrawalContext {
  readonly now: Instant;
  readonly deadlinePolicy: WithdrawalDeadlinePolicy;
}

/**
 * Состояние после перехода: часы переставляются здесь и только здесь.
 *
 * **Самопереход — внутренний переход, а не выход и повторный вход.** Такой у
 * машины вывода ровно один: `paying_out --payout_result(unknown)--> paying_out`.
 * Дедлайн он пересчитывает — банк ответил, отсчёт пошёл заново, — а `enteredAt`
 * оставляет прежним: иначе каждый неответ банка обнулял бы возраст, и заявка,
 * застрявшая в «неизвестно», не попадала бы в очередь разбора никогда. Это то же
 * правило, что у транша, и то же, что в `queue.ts` комплаенса.
 */
function nextWithdrawalState(
  state: WithdrawalState,
  to: WithdrawalStatus,
  context: WithdrawalContext,
): WithdrawalState {
  if (isTerminalWithdrawalStatus(to)) {
    return terminalWithdrawalState(to, state.withdrawalId);
  }
  const internal = to === state.status;
  const enteredAt = internal && 'enteredAt' in state ? state.enteredAt : context.now;
  return nonTerminalWithdrawalState(
    to,
    state.withdrawalId,
    deadline(plus(context.now, context.deadlinePolicy[to])),
    enteredAt,
  );
}

export function reduceWithdrawal(
  state: WithdrawalState,
  event: WithdrawalEvent,
  facts: ClientAccountFacts,
  context: WithdrawalContext,
): Result<WithdrawalTransitionResult, Rejection> {
  if (isTerminalWithdrawalStatus(state.status)) {
    return failure(rejection(RejectionCode.terminalState, [], { status: state.status }));
  }
  const outcome = eventOutcome(event);
  const candidates = WITHDRAWAL_TRANSITIONS.filter(
    (item) =>
      item.from === state.status && item.event === event.type && item.outcome === outcome,
  );
  if (candidates.length === 0) {
    return failure(
      rejection(RejectionCode.transitionNotAllowed, [], {
        status: state.status,
        event: event.type,
      }),
    );
  }
  let firstFailure: readonly WithdrawalGuardId[] = [];
  for (const candidate of candidates) {
    const failed: WithdrawalGuardId[] = [];
    for (const guard of candidate.guards) {
      if (!evaluateWithdrawalGuard(guard, facts)) failed.push(guard);
    }
    for (const guard of candidate.negatedGuards) {
      if (evaluateWithdrawalGuard(guard, facts)) failed.push(guard);
    }
    if (failed.length > 0) {
      if (firstFailure.length === 0) firstFailure = failed;
      continue;
    }
    return ok({
      state: nextWithdrawalState(state, candidate.to, context),
      failedGuards: Object.freeze([]),
    });
  }
  return failure(
    rejection(RejectionCode.guardFailed, firstFailure, {
      status: state.status,
      event: event.type,
    }),
  );
}

/**
 * Сумма запертого по одной валюте. Пересчёта между валютами здесь нет: И12.1
 * требует показывать обе величины, а не приводить одну к другой «для удобства».
 */
export function lockedTotal(
  facts: ClientAccountFacts,
  currency: CurrencyCode,
): Money<CurrencyCode> {
  const minor = facts.locked
    .filter((portion) => portion.amount.currency === currency)
    .reduce((total, portion) => total + portion.amount.minor, 0n);
  return money(currency, minor);
}
