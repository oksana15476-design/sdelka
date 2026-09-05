/**
 * Тип, и только тип. Импорт стирается компиляцией: рантаймовой зависимости
 * домена от учёта нет и после этого не появляется.
 *
 * Зависимость по типу — сознательный разворот прежнего решения («домен не
 * зависит от `@sdelka/ledger`, брендирование ключа — забота учёта»). Прежнее
 * решение стоило красной линии №1: пока подтверждение сторон изготавливалось
 * не здесь, его изготавливал тот же вызывающий, который строил проводки, то
 * есть оно ничего не подтверждало. Учёт знать состав сторон не может — стороны
 * живут здесь; значит и приведение типа обязано стоять здесь, в одном месте.
 * Направление зависимости при этом не разворачивается: учёт домена не знает.
 */
import type { DealPartiesAttestation } from '@sdelka/ledger';
import type { CurrencyCode, Money } from '@sdelka/money';
import { type ConditionAct, conditionActsEqual } from './condition-act';
import type { FreezeReason, UnfreezeTarget } from './freeze';
import { type GuardId, type GuardInput, type TrancheFacts, evaluateGuard } from './guards';
import { payoutIdempotencyKey, refundIdempotencyKey } from './ids';
import {
  type Deadline,
  type DurationMs,
  type Instant,
  DAY,
  HOUR,
  deadline,
  duration,
  plus,
} from './instant';
import type { Intent, LedgerTemplate } from './intents';
import { RELEASE_CONDITIONS } from './release-condition';
import { DEFAULT_FEE_CEILING_POLICY } from './tariff';
import {
  type Rejection,
  type Result,
  DomainError,
  RejectionCode,
  failure,
  ok,
  rejection,
} from './result';
import type { PayoutOutcome, TrancheEvent, TrancheEventType } from './tranche-events';

/** Состояния транша — STATE-MACHINES.md §1.1. */
export const TRANCHE_STATUSES = [
  'pending',
  'collecting',
  'collected',
  'reserved',
  'release_pending',
  'release_blocked',
  'paying_out',
  'paid_out',
  'refund_pending',
  'refunding',
  'refunded',
  'written_off',
  /**
   * Заморожен комплаенсом или спором — CORE.md Ф17, E9-9. У сделки это
   * состояние было с самого начала, у транша его не было, и поэтому конфликт
   * красной линии №7 (по умолчанию возвращаем) с Ф17 (замороженное исполнять
   * запрещено) разрешался в пользу возврата молча.
   */
  'frozen',
] as const;

export type TrancheStatus = (typeof TRANCHE_STATUSES)[number];

export const TERMINAL_TRANCHE_STATUSES = ['paid_out', 'refunded', 'written_off'] as const;

export type TerminalTrancheStatus = (typeof TERMINAL_TRANCHE_STATUSES)[number];
export type NonTerminalTrancheStatus = Exclude<TrancheStatus, TerminalTrancheStatus>;

/**
 * Нетерминальный статус с идущими часами. Различение «остывший / замороженный»
 * поднято на уровень типа: у замороженного дедлайна нет поля вовсе, а у
 * остальных оно обязательно. Политика дедлайнов индексируется этим типом —
 * замороженному состоянию политике нечего дать.
 */
export type ThawedTrancheStatus = Exclude<NonTerminalTrancheStatus, 'frozen'>;

export const THAWED_TRANCHE_STATUSES: readonly ThawedTrancheStatus[] = Object.freeze(
  TRANCHE_STATUSES.filter(
    (status): status is ThawedTrancheStatus =>
      !(TERMINAL_TRANCHE_STATUSES as readonly string[]).includes(status) && status !== 'frozen',
  ),
);

/**
 * Из каких статусов транш можно заморозить.
 *
 * Все остывшие, кроме `pending`. В `pending` денег ещё нет — замораживать
 * нечего, а обратный переход из заморозки открыл бы вход в `pending` заново,
 * то есть транш, у которого деньги уже были, снова назывался бы «создан, денег
 * нет». Гарантия §5 «стартовое состояние не переоткрывается» держится этим
 * списком, и обход графа в `reachability.test.ts` её проверяет.
 */
export const FREEZABLE_TRANCHE_STATUSES: readonly ThawedTrancheStatus[] = Object.freeze(
  THAWED_TRANCHE_STATUSES.filter((status) => status !== 'pending'),
);

/**
 * Статусы, из которых поручение **уже ушло наружу**: банк его получил, и исход
 * нам неизвестен, пока не ответит выписка.
 *
 * Список один на два места — таблицу переходов и редьюсер, — потому что это одно
 * правило. Разъехавшись, они дали бы ровно то, что было до E9-11: ребро в
 * таблице есть, редьюсер его не пускает, обход графа считает проходимым.
 */
export const DISPATCHED_TRANCHE_STATUSES: readonly ThawedTrancheStatus[] = Object.freeze([
  'paying_out',
  'refunding',
]);

/**
 * Куда разморозка возвращает транш «туда, откуда заморозили».
 *
 * Из `paying_out` и `refunding` — **никогда**: вернуться в «поручение
 * отправлено» значит выпустить его второй раз (§2.2, красная линия №8). Запрет
 * выражен **отсутствием строки** в таблице, тем же приёмом, что приоритет
 * заморозки над возвратом и запрет повтора из `unknown`. Раньше строки были, а
 * запрет стоял только в редьюсере: обход графа в `reachability.test.ts` считал
 * `frozen → paying_out` и `frozen → refunding` проходимыми, и снятие проверки в
 * редьюсере правкой в другом месте обход бы не заметил.
 */
export const RESUMABLE_TRANCHE_STATUSES: readonly ThawedTrancheStatus[] = Object.freeze(
  FREEZABLE_TRANCHE_STATUSES.filter((status) => !DISPATCHED_TRANCHE_STATUSES.includes(status)),
);

export function isTerminalTrancheStatus(status: TrancheStatus): status is TerminalTrancheStatus {
  return (TERMINAL_TRANCHE_STATUSES as readonly string[]).includes(status);
}

/**
 * Состояние транша. Дедлайн лежит внутри нетерминального варианта, поэтому
 * «нетерминальное состояние без дедлайна» невозможно собрать — это структура,
 * а не проверка (FUNCTIONAL.md инвариант 7, STATE-MACHINES.md §4).
 *
 * Отметок времени две, и смешивать их нельзя (STATE-MACHINES.md §5):
 * `deadline` — по нему наступает автоматический переход, он двигается;
 * `enteredAt` — момент входа в состояние, по нему считается возраст и работает
 * эскалация, он не двигается. Повторный `payout_result(unknown)` отодвигает
 * дедлайн, и если бы возраст считался по дедлайну, застрявшая выплата выглядела
 * бы вечно свежей и никогда не попадала в эскалацию.
 *
 * `conditionAct` — акт получателя, под которым транш принял деньги (CORE.md
 * Ф13). Он лежит **в состоянии**, а не только в фактах: факты приходят снаружи
 * на каждый вызов, и без записанной в состоянии привязки условие у транша с
 * деньгами можно было бы подменить, просто передав другой акт.
 */
export type TrancheState =
  | {
      readonly status: ThawedTrancheStatus;
      readonly deadline: Deadline;
      readonly enteredAt: Instant;
      /** `null` допустим только в `pending`: до выдачи инструкций денег нет. */
      readonly conditionAct: ConditionAct | null;
    }
  /**
   * Замороженное состояние (CORE.md Ф17). **Отсутствие поля `deadline` и есть
   * приостановка**: дедлайн не отменён — остаток хранится в `remaining`, — но и
   * не тикает, потому что момента срабатывания нет. Флаг «заморожен» рядом с
   * живым дедлайном можно забыть проверить, отсутствующее поле — нельзя.
   *
   * `enteredAt` есть и здесь: возраст состояния — часы внимания дежурного, и
   * §5 требует «обязательный срок разбора» именно для `frozen`. Дедлайн и
   * возраст здесь окончательно разведены: первый приостановлен, второй идёт.
   */
  | {
      readonly status: 'frozen';
      readonly enteredAt: Instant;
      readonly conditionAct: ConditionAct | null;
      /** Статус, часы которого приостановлены. */
      readonly suspendedFrom: ThawedTrancheStatus;
      /** Неистёкшая часть дедлайна на момент заморозки. */
      readonly remaining: DurationMs;
      readonly reason: FreezeReason;
      /** Кто заморозил: он же не может утвердить разморозку. */
      readonly frozenBy: string;
    }
  | { readonly status: TerminalTrancheStatus };

function assertConditionAct(status: TrancheStatus, conditionAct: ConditionAct | null): void {
  if (status !== 'pending' && conditionAct === null) {
    // Состояние после `pending` без акта собрать нельзя: приём средств
    // открывается только актом получателя (CORE.md Ф13). Это ошибка сборки
    // состояния, а не отказ автомата, поэтому исключение, а не Rejection.
    throw new DomainError(RejectionCode.conditionActMissing, status);
  }
}

export function nonTerminalTrancheState(
  status: ThawedTrancheStatus,
  at: Deadline,
  enteredAt: Instant,
  conditionAct: ConditionAct | null,
): TrancheState {
  assertConditionAct(status, conditionAct);
  return Object.freeze({ status, deadline: at, enteredAt, conditionAct });
}

export function frozenTrancheState(
  suspendedFrom: ThawedTrancheStatus,
  remaining: DurationMs,
  enteredAt: Instant,
  conditionAct: ConditionAct | null,
  reason: FreezeReason,
  frozenBy: string,
): TrancheState {
  assertConditionAct(suspendedFrom, conditionAct);
  return Object.freeze({
    status: 'frozen',
    enteredAt,
    conditionAct,
    suspendedFrom,
    remaining,
    reason,
    frozenBy,
  });
}

export function terminalTrancheState(status: TerminalTrancheStatus): TrancheState {
  return Object.freeze({ status });
}

/**
 * Остаток дедлайна на момент заморозки.
 *
 * Планировщик ходит раз в пятнадцать минут (FUNCTIONAL.md инвариант 7), поэтому
 * существует окно, где дедлайн уже прошёл, а перехода ещё не было. `DurationMs`
 * по построению строго положителен, и остаток в этом окне зажимается в минимум:
 * сразу после разморозки отсечка срабатывает. **Заморозка не дарит времени** —
 * это выбор в пользу красной линии №7, а не арифметическая мелочь.
 */
export function remainingUntil(at: Deadline, now: Instant): DurationMs {
  return duration(Math.max(1, at.at - now));
}

/**
 * Сроки жизни остывших состояний. `frozen` здесь нет по типу: у замороженного
 * дедлайна не существует, и политике нечего ему дать.
 */
export type DeadlinePolicy = Readonly<Record<ThawedTrancheStatus, DurationMs>>;

/**
 * Сроки жизни нетерминальных состояний. Значения — рабочее умолчание, не норма:
 * продуктовые окна (отсечка рабочего дня, ежедневная сверка) задаются политикой,
 * а не зашиты в автомат.
 */
export const DEFAULT_DEADLINE_POLICY: DeadlinePolicy = Object.freeze({
  pending: DAY,
  collecting: (3 * DAY) as DurationMs,
  collected: DAY,
  reserved: DAY,
  release_pending: (4 * HOUR) as DurationMs,
  release_blocked: DAY,
  // paying_out и refunding выходят по ответу провайдера или по ежедневной
  // сверке — не позднее следующего дня (STATE-MACHINES.md §5).
  paying_out: DAY,
  refunding: DAY,
  refund_pending: DAY,
});

export type EscalationPolicy = Readonly<Record<NonTerminalTrancheStatus, DurationMs>>;

/**
 * Пороги эскалации по возрасту состояния — STATE-MACHINES.md §5.
 *
 * Значения — рабочее умолчание, не норма: норматив дежурного документом не
 * задан [открыто]. Смысл у них другой, чем у дедлайнов, поэтому и таблица
 * другая: дедлайн — когда сработает автоматический переход, порог эскалации —
 * когда транш поднимают дежурному.
 *
 * `paying_out` и `refunding` отпущены до двух суток: выход из них гарантирован
 * ежедневной сверкой, а `payout_result(unknown)` двигает дедлайн — сюда
 * попадает ровно та выплата, которая застряла между повторами.
 *
 * `release_blocked` — единственное состояние, выход из которого зависит от
 * человека, поэтому порог у него самый короткий.
 */
export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = Object.freeze({
  pending: DAY,
  collecting: (3 * DAY) as DurationMs,
  collected: DAY,
  reserved: DAY,
  release_pending: (4 * HOUR) as DurationMs,
  release_blocked: (4 * HOUR) as DurationMs,
  paying_out: (2 * DAY) as DurationMs,
  refunding: (2 * DAY) as DurationMs,
  refund_pending: DAY,
  // §5 требует у `frozen` «обязательный срок разбора». Дедлайна у замороженного
  // нет — значит, единственное, что вообще поднимает его дежурному, это возраст,
  // и порог обязан быть. Строка держится типом `Record`: без неё не соберётся.
  frozen: DAY,
});

/**
 * Возраст состояния в миллисекундах — от входа в состояние, а не от дедлайна
 * (STATE-MACHINES.md §5). `null` у терминального состояния: у закрытого транша
 * возраста нет, его не эскалируют.
 *
 * Возвращается число, а не `DurationMs`: нулевой и отрицательный возраст —
 * законные значения (транш только что вошёл в состояние; часы дежурного
 * разошлись с записью), а `DurationMs` по построению строго положителен.
 */
export function trancheStateAge(state: TrancheState, now: Instant): number | null {
  return 'enteredAt' in state ? now - state.enteredAt : null;
}

/**
 * Пора ли поднимать транш дежурному. Отдельно от дедлайна: дедлайн отвечает за
 * автоматический переход, эскалация — за человека (STATE-MACHINES.md §5).
 */
export function isEscalated(
  state: TrancheState,
  now: Instant,
  policy: EscalationPolicy,
): boolean {
  if (!('enteredAt' in state)) {
    return false;
  }
  const age = now - state.enteredAt;
  return age >= policy[state.status];
}

export interface TrancheContext {
  readonly now: Instant;
  readonly dealId: string;
  readonly trancheId: string;
  readonly facts: TrancheFacts;
  readonly deadlinePolicy: DeadlinePolicy;
}

/**
 * Ключ счёта плательщика. Отдельного поля контекста у него больше нет:
 * плательщик по траншу — это покупатель, а покупатель уже назван в фактах
 * одним значением вместе со своим счётом (`TrancheFacts.buyer`).
 *
 * Раньше полей было два — `TrancheContext.payerClientKey` и
 * `TrancheFacts.buyerPartyId`, — и ни одна проверка их не сопоставляла:
 * приложение могло назвать стороной одного человека, а дебетовать счёт
 * другого. Это тот же дефект, что свободный получатель, только на стороне
 * плательщика, и закрывается он тем же приёмом — не сверкой, а отсутствием
 * второго места, откуда взять ответ.
 */
function payerAccountKey(context: TrancheContext): string {
  return context.facts.buyer.accountKey;
}

export interface TrancheTransition {
  readonly from: TrancheStatus;
  readonly to: TrancheStatus;
  readonly event: TrancheEventType;
  readonly guards: readonly GuardId[];
  /** Guard'ы, которые обязаны НЕ выполниться: «¬g_payer_matches» из §1.4. */
  readonly negatedGuards: readonly GuardId[];
  /** Различитель исхода для `payout_result` и `reconciliation_resolved`. */
  readonly outcome: PayoutOutcome | null;
  /** Различитель целевого состояния для `unfreeze` — как `resume` у сделки. */
  readonly resume: UnfreezeTarget | null;
}

function transition(
  from: TrancheStatus,
  event: TrancheEventType,
  to: TrancheStatus,
  guards: readonly GuardId[] = [],
  negatedGuards: readonly GuardId[] = [],
  outcome: PayoutOutcome | null = null,
  resume: UnfreezeTarget | null = null,
): TrancheTransition {
  return Object.freeze({ from, to, event, guards, negatedGuards, outcome, resume });
}

/**
 * Guard'ы доказательств. `g_beneficiary_verified` стоит рядом с
 * `g_beneficiary_locked`, а не вместо него: «реквизиты заперты и не менялись в
 * запретном окне» и «владение счётом доказано» — два условия, и оба обязательны
 * (ROADMAP.md И13.1, E13-2). Оба ребра — `reserved → release_pending` и
 * `release_pending → paying_out` — несут этот список целиком по той же причине,
 * по которой продублированы остальные guard'ы доказательств: вход через
 * `release_blocked` обходит проверку, стоящую на одном входе.
 */
const EVIDENCE_GUARDS: readonly GuardId[] = [
  'g_evidence_present',
  /**
   * Наблюдение оракула годно как основание — E3-1, `ORACLE.md` §6.4.
   *
   * Стоит рядом с `g_fields_match` и `g_owner_is_buyer`, а не вместо них: те
   * проверяют **содержимое** документа, этот — сам документ (существует, о том
   * же условии, от требуемого источника, уровня L3+, про наш объект, не
   * протух). Без него пять сошедшихся полей без единой выписки открывали дверь
   * к выплате — и открывали законно, потому что полей без документа не бывает
   * только с этого батча.
   *
   * На **обоих** рёбрах пути выплаты по той же причине, что и остальные:
   * guard, стоящий на одной двери, состояние не защищает (§1.4, §4).
   */
  'g_observation_sufficient',
  'g_fields_match',
  'g_owner_is_buyer',
  'g_beneficiary_locked',
  'g_beneficiary_verified',
];

/**
 * Guard'ы пути выплаты: доказательства плюс наличие собранных средств.
 *
 * `g_funds_collected` стоит рядом с ними на **каждой** двери пути, а не в
 * начале, по той же причине, что и они: путь
 * `collecting → release_blocked → release_pending → paying_out` в `collected`
 * не заходит вовсе. Платёж третьего лица уводится в блокировку, оттуда
 * выходит утверждением оператора, и транш, за которым нет ни лари, доходил до
 * `paid_out`. Проводки при этом не возникало — сумма берётся из собранных
 * средств, и без них намерение просто не порождалось, — так что в учёте не
 * оставалось даже следа.
 */
const RELEASE_PATH_GUARDS: readonly GuardId[] = [
  ...EVIDENCE_GUARDS,
  'g_funds_collected',
  /**
   * `g_funds_locked` стоит рядом с `g_funds_collected`, а не вместо него, и по
   * той же причине, что и все guard'ы этого списка: после того как запирание
   * стало намерением автомата (вход в `reserved`), путь
   * `collected → refund_pending → refunding → release_blocked →
   * release_pending → paying_out` в `reserved` не заходит вовсе. Средства
   * собраны, guard собранных проходит, а файл транша пуст — и расчёт списывает
   * с него сумму, которой там нет, то есть берёт её у других сделок
   * (красная линия №1).
   */
  'g_funds_locked',
];

/**
 * Таблица переходов — STATE-MACHINES.md §1.4.
 *
 * Guard'ы доказательств продублированы на `release_pending → paying_out`
 * намеренно. Без этого существует путь `collecting → release_blocked →
 * release_pending → paying_out`: платёж третьего лица уходит в блокировку и
 * выходит оттуда по утверждению оператора мимо проверки пакета доказательств,
 * совпадения полей и сверки собственника. Guard, стоящий только на одном входе
 * в состояние, не защищает состояние (§1.4, §4).
 */
export const TRANCHE_TRANSITIONS: readonly TrancheTransition[] = Object.freeze([
  // Ф13: приём средств открывается только актом получателя об условии. Без
  // guard'а деньги принимались бы раньше, чем условие определено, и у
  // отложенного платежа не было бы основания.
  transition('pending', 'instructions_issued', 'collecting', ['g_condition_agreed']),

  transition('collecting', 'funds_received', 'collected', ['g_amount_sufficient', 'g_payer_matches']),
  // Платёж третьего лица: деньги не зачисляются на сделку, разбор комплаенсом.
  transition('collecting', 'funds_received', 'release_blocked', [], ['g_payer_matches']),
  transition('collecting', 'deadline_reached', 'refund_pending'),
  // [решение] §1.4: отзыв принимается из collecting, collected, reserved.
  transition('collecting', 'revocation_requested', 'refund_pending'),

  transition('collected', 'reserve_requested', 'reserved'),
  transition('collected', 'refund_requested', 'refund_pending'),
  transition('collected', 'deadline_reached', 'refund_pending'),
  transition('collected', 'revocation_requested', 'refund_pending'),

  transition('reserved', 'condition_established', 'release_pending', RELEASE_PATH_GUARDS),
  transition('reserved', 'mismatch_detected', 'release_blocked'),
  transition('reserved', 'reserve_expired', 'collected'),
  transition('reserved', 'condition_failed', 'refund_pending'),
  transition('reserved', 'revocation_requested', 'refund_pending'),

  transition('release_pending', 'release_authorized', 'paying_out', [
    ...RELEASE_PATH_GUARDS,
    'g_approvals_sufficient',
    'g_no_active_payout',
    'g_coverage_ok',
  ]),
  transition('release_pending', 'operator_blocked', 'release_blocked'),

  transition('release_blocked', 'approval_added', 'release_pending', ['g_mismatch_resolved']),
  transition('release_blocked', 'refund_requested', 'refund_pending'),
  transition('release_blocked', 'reserve_expired', 'collected'),
  /**
   * Списание — **два утверждения и полный файл**, а не одни утверждения.
   *
   * `g_write_off_covers_collected` — то же утверждение, что несёт запись
   * списания: закрывается ровно то обязательство, которое дебетуется. Запись
   * (`writeOffUnclaimed`, FUNCTIONAL.md §3.1, случай Б) дебетует **файл
   * транша** и сумму берёт из него же, поэтому перебрать его не может — и
   * пустой файл не ловит никак: намерения проводки не возникает вовсе, и транш
   * уходит в `written_off` **бесследно**.
   *
   * Проба: `collected --refund_requested--> refund_pending --refund_initiated-->
   * refunding --payout_result(rejected)--> release_blocked`. В `reserved` этот
   * путь не заходит, деньги лежат в свободной части счёта покупателя, файл
   * транша пуст. Двое утверждающих переводят транш в `written_off`, журнал не
   * меняется ни на одну запись, и терминальный статус утверждает «обязательство
   * закрыто, деньги ушли с номинального счёта» — при том что обязательство
   * перед клиентом стоит целиком, а деньги на номинальном счёте.
   *
   * Списывать невостребованными можно только то, что под траншем действительно
   * заперто. Деньги, лежащие в свободной части счёта клиента, — не
   * невостребованные средства этого транша: они его собственные и отзывные
   * (красная линия №7), и закрывать их списанием транша нельзя. Выход из
   * `release_blocked` для такого транша — возврат, а не списание.
   *
   * `g_funds_locked` здесь не подошёл бы: он требует непустого собранного и
   * отказал бы **и** траншу, до которого деньги не дошли вовсе (платёж
   * третьего лица), — а такому траншу закрывать нечего, и списание о его
   * деньгах ничего не утверждает.
   */
  transition('release_blocked', 'write_off_approved', 'written_off', [
    'g_write_off_approvers_distinct',
    'g_write_off_covers_collected',
  ]),

  /**
   * ⚠ `g_evidence_present` стоит и здесь — на третьем входе, — по той же
   * причине, по которой продублирован на двух предыдущих: guard, стоящий
   * только на одном входе, не защищает состояние (§1.4, §4).
   *
   * Раньше на этом ребре guard'ов не было вовсе, и это была дыра не только
   * теоретическая. Именно здесь пишется запись расчёта, и именно она несёт
   * ссылку на пакет доказательств (`evidenceRef` в `settles`, красная линия
   * №5). Факты приходят снаружи на каждый вызов: транш, дошедший до
   * `paying_out` с доказательствами, мог получить `payout_result(settled)` уже
   * без них — и расчёт записался бы со ссылкой в никуда. Отказ оставляет транш
   * в `paying_out`, то есть в состоянии, из которого выход идёт через сверку
   * человеком, — это и есть безопасная сторона (§2.2).
   */
  transition(
    'paying_out',
    'payout_result',
    'paid_out',
    ['g_evidence_present', 'g_funds_collected', 'g_funds_locked'],
    [],
    'settled',
  ),
  transition('paying_out', 'payout_result', 'release_blocked', [], [], 'rejected'),
  // «Неизвестно» оставляет транш здесь: повтор запрещён без сверки (§2.2).
  transition('paying_out', 'payout_result', 'paying_out', [], [], 'unknown'),
  // Событие сверки есть в §1.2, но отсутствует в таблице §1.4. Без него
  // обещание §5 «выход гарантирован не позднее следующего дня» не выполняется.
  transition(
    'paying_out',
    'reconciliation_resolved',
    'paid_out',
    ['g_evidence_present', 'g_funds_collected', 'g_funds_locked'],
    [],
    'settled',
  ),
  transition('paying_out', 'reconciliation_resolved', 'release_blocked', [], [], 'rejected'),

  /**
   * ⚠ `g_no_active_payout` стоит здесь по той же причине, по которой стоит на
   * `release_pending → paying_out`: **второго поручения в полёте не бывает**
   * (красная линия №8, §2.2).
   *
   * Случай не выдуман. Ответ банка по расчёту потерян — выплата в `unknown`,
   * то есть деньги, возможно, уже у получателя. Транш вытаскивают из
   * `paying_out` заморозкой (единственный выход оттуда мимо ответа), разморозка
   * приводит его в `release_blocked`, оттуда — `refund_requested`. Без guard'а
   * возврат уходил бы в банк поверх невыясненного расчёта: на номинальном
   * счёте одни и те же деньги ушли бы дважды, и обнаружилось бы это только
   * покрытием на конец дня (красная линия №3).
   *
   * Отказ оставляет транш в `refund_pending` — состоянии с часами эскалации, а
   * не в тупике: сначала сверка закрывает расчёт, потом открывается возврат.
   * Чем закрывается расчёт у транша, уже покинувшего `paying_out`, — см.
   * пометку [открыто] в `STATE-MACHINES.md` §2.2.
   */
  transition('refund_pending', 'refund_initiated', 'refunding', [
    'g_source_account_known',
    'g_no_active_payout',
  ]),
  transition('refund_pending', 'refund_initiated', 'release_blocked', [], ['g_source_account_known']),

  transition('refunding', 'payout_result', 'refunded', [], [], 'settled'),
  transition('refunding', 'payout_result', 'release_blocked', [], [], 'rejected'),
  transition('refunding', 'payout_result', 'refunding', [], [], 'unknown'),
  transition('refunding', 'reconciliation_resolved', 'refunded', [], [], 'settled'),
  transition('refunding', 'reconciliation_resolved', 'release_blocked', [], [], 'rejected'),

  // Заморозка — CORE.md Ф17, E9-9. Из каждого статуса с деньгами, по образцу
  // сделки (`deal.ts`: те же два события на все нетерминальные состояния).
  ...FREEZABLE_TRANCHE_STATUSES.map((status) => transition(status, 'compliance_hold', 'frozen')),
  ...FREEZABLE_TRANCHE_STATUSES.map((status) => transition(status, 'dispute_raised', 'frozen')),

  // ⚠ Из `frozen` нет строки ни на `deadline_reached`, ни на `refund_initiated`,
  // ни на `payout_result` — ни на что автоматическое. **Приоритет заморозки над
  // возвратом реализован отсутствием перехода**, тем же приёмом, что запрет
  // повтора выплаты из `unknown` (§2.2: «реализуется отсутствием перехода в
  // автомате, а не проверкой в коде обработчика»). Проверку в редьюсере можно
  // обойти новой веткой, таблицу — нет.
  //
  // `RESUMABLE_TRANCHE_STATUSES`, а не `FREEZABLE_TRANCHE_STATUSES`: из
  // заморозки, взятой в `paying_out` или `refunding`, возврата «туда, откуда
  // заморозили», нет вовсе — и это тоже отсутствие строки, а не проверка.
  ...RESUMABLE_TRANCHE_STATUSES.map((status) =>
    transition('frozen', 'unfreeze', status, ['g_unfreeze_approvers_distinct'], [], null, 'suspended_from'),
  ),
  transition('frozen', 'unfreeze', 'refund_pending', ['g_unfreeze_approvers_distinct'], [], null, 'refund_pending'),
  transition('frozen', 'unfreeze', 'release_blocked', ['g_unfreeze_approvers_distinct'], [], null, 'release_blocked'),
]);

export interface TrancheTransitionResult {
  readonly state: TrancheState;
  readonly intents: readonly Intent[];
}

function eventOutcome(event: TrancheEvent): PayoutOutcome | null {
  if (event.type === 'payout_result') return event.outcome;
  if (event.type === 'reconciliation_resolved') return event.outcome;
  return null;
}

/**
 * Сумма, которой распоряжается проводка. Разводится **по шаблону явно**, а не
 * одним «собранным» на всё: собранное и запертое — две разные величины, и
 * склейка стоила симметричной дыры.
 *
 * - зачисление — сумма события;
 * - запирание — собранное: запирается ровно то, что пришло под этот транш;
 * - расфиксация, отвязка при возврате, списание — **запертое**. Дебетуется
 *   счёт `client:{клиент}:tranche:{...}`, и брать сумму откуда-то, кроме его
 *   остатка, значит дебетовать одну величину, а называть другую;
 * - внешняя нога возврата — собранное: к этому моменту деньги лежат в
 *   свободной части счёта покупателя независимо от того, запирались они
 *   когда-нибудь или нет (возврат из `collecting`, из `collected` до резерва,
 *   после отката резерва).
 *
 * `null` означает, что двигать нечего: транш из `collecting` уходит в возврат
 * по дедлайну, возвращать нечего. Проводки в этом случае нет вовсе — «возврат
 * нуля» это запись с нулевой суммой, а такие записи журнал не принимает.
 */
function moneyForTemplate(
  template: LedgerTemplate,
  event: TrancheEvent,
  facts: TrancheFacts,
): Money<CurrencyCode> | null {
  switch (template) {
    case 'funds_received':
      return event.type === 'funds_received' ? event.amount : null;
    case 'lock_funds':
      return facts.collectedAmount;
    case 'unlock_funds':
    case 'refund_unlock':
    case 'write_off':
      return facts.lockedAmount;
    case 'refund_external':
      return facts.collectedAmount;
  }
}

/**
 * **Периметр резерва** — состояния, в которых реквизиты получателя заперты
 * (`CORE.md` Ф15, STATE-MACHINES.md §1.5).
 *
 * Правило одно и выражено **принадлежностью периметру**, а не перечнем
 * разрешённых целей у одного ребра: блокировка ставится на входе в `reserved`
 * и снимается ровно тогда, когда резерв кончается, — то есть когда транш
 * уходит из периметра наружу.
 *
 * `frozen` внутри периметра с самого начала и намеренно: заморозка — не уход
 * из резерва, а его приостановка, и без этого `reserved → frozen` снимал бы
 * блокировку на всё время расследования — заморозка стала бы способом сбросить
 * периметр Ф15, то есть защита превратилась бы в дыру.
 *
 * **`release_blocked` внутри периметра по той же причине, и это исправление.**
 * Прежде правило звучало «снимаем, если уходим не в выплату и не в заморозку»
 * (STATE-MACHINES.md §1.5), и разбор расхождения снимал блокировку. Разбор —
 * такая же приостановка резерва, как заморозка: деньги остаются запертыми в
 * файле транша (расфиксации на этом ребре нет), транш остаётся на пути
 * выплаты и возвращается с него в `release_pending` штатным
 * `approval_added ∧ расхождение снято` (§1.4). Снятие блокировки стоило двух
 * бед сразу:
 *
 *  1. **Задокументированный выход становился недостижимым.** На ребре
 *     `release_pending --release_authorized--> paying_out` стоит
 *     `g_beneficiary_locked`, а запереть реквизиты обратно нечем: единственное
 *     намерение `lock_beneficiary` — вход в `reserved`, а вернуться туда из
 *     `release_blocked` можно только через `collected` по `reserve_expired`,
 *     чьи часы для `release_blocked` молчат (`schedule.ts`,
 *     `DUE_TRANCHE_EVENTS.release_blocked = null`). Транш с полным файлом
 *     доказательств и снятым расхождением упирался в один-единственный
 *     провалившийся guard, и довести его до выплаты можно было только
 *     `patchFacts` — чёрным ходом, который `ACTORS.md` §5.1 требует убрать.
 *  2. **Периметр Ф15 открывался на всё время разбора.** Пока реквизиты не
 *     заперты, `applyBeneficiaryChange` (`packages/compliance`) не требует ни
 *     охлаждения, ни уведомления сторон, ни второго утверждения — то есть
 *     разбор расхождения оказывался самым дешёвым способом сменить реквизиты
 *     профинансированной сделки. Это ровно та же дыра, которую §1.5 уже
 *     закрыл у заморозки.
 *
 * Обратная сторона правила: уход из `release_blocked` **наружу** периметра —
 * в `collected` по откату резерва, в `refund_pending`, в `written_off` — теперь
 * блокировку снимает, чего прежде не делал ни один из этих переходов. Резерва
 * после них нет, держать периметр не за что.
 */
const BENEFICIARY_LOCK_PERIMETER: readonly TrancheStatus[] = Object.freeze([
  'reserved',
  'release_blocked',
  'release_pending',
  'paying_out',
  'paid_out',
  'frozen',
]);

function exitIntents(from: TrancheStatus, to: TrancheStatus): readonly Intent[] {
  // ⚠ Разморозка сюда не доходит: её ветка в редьюсере возвращает одно
  // намерение восстановления часов и намерения перехода отбрасывает (§1.4.1,
  // «разморозка не порождает намерений входа целевого состояния»). Поэтому
  // выход `frozen → refund_pending` блокировку не снимает — как и до этой
  // правки. Оставшаяся запертой блокировка ужесточает, а не ослабляет, и
  // менять поведение разморозки этим батчем мы не стали.
  if (BENEFICIARY_LOCK_PERIMETER.includes(from) && !BENEFICIARY_LOCK_PERIMETER.includes(to)) {
    return [{ type: 'unlock_beneficiary' }];
  }
  return [];
}

/**
 * **Единственное место во всём домене, где изготавливается подтверждение
 * сторон.** Функция не экспортируется — ни из модуля, ни тем более из пакета:
 * подтверждение, которое можно выписать снаружи, не подтверждает ничего.
 *
 * Приведение типа здесь неизбежно и намеренно. `DealPartiesAttestation`
 * устроен учётом так, что построить его кодом нельзя (ambient-ключ, значения
 * которого не существует), и единственный способ получить значение — привести
 * тип ровно там, где живёт знание о составе сторон. В `src/` учёта такого
 * приведения нет ни одного; здесь оно одно, и на это стоит тест.
 *
 * Ни один аргумент не приходит от вызывающего свободным параметром:
 *
 * - сделка и транш — из контекста, того же, по которому собирается вся запись;
 * - плательщик — покупатель из фактов, чья запертая часть и дебетуется;
 * - получатель — **из акта об условии, записанного в состоянии транша**.
 *   Не из фактов: факты приходят снаружи на каждый вызов, а акт в состоянии
 *   привязан на выходе из `pending` и меняется только амендментом обеих
 *   сторон. Это и есть требуемая связь «получатель ↔ сделка»: получателем
 *   расчёта не может оказаться никто, кроме того, кто определил условие
 *   (ст. 27(2), CORE.md Ф13);
 * - ссылка на доказательства — `evidenceBundleId`, тот же, под которым
 *   выпущено поручение (красная линия №5).
 */
function trancheSettlementAttestation(
  context: TrancheContext,
  act: ConditionAct,
  evidenceRef: string,
): DealPartiesAttestation {
  return {
    dealId: context.dealId,
    trancheId: context.trancheId,
    payer: payerAccountKey(context),
    recipient: act.recipient.accountKey,
    evidenceRef,
  } as unknown as DealPartiesAttestation;
}

function entryIntents(
  to: TrancheStatus,
  event: TrancheEvent,
  context: TrancheContext,
  act: ConditionAct | null,
): readonly Intent[] {
  const ledger = (template: LedgerTemplate): readonly Intent[] => {
    const amount = moneyForTemplate(template, event, context.facts);
    // Ноль здесь наравне с `null`: пустой файл транша возвращает не `null`, а
    // ноль в валюте (`accountBalance`), и запись на ноль журнал отвергает.
    // Раньше этот разбор стоял в каждой проекции по-своему — в приложении по
    // остатку, в интерфейсе по флагу, в проекции домена не стоял вовсе.
    return amount === null || amount.minor === 0n
      ? []
      : [
          {
            type: 'post_journal_entry',
            template,
            dealId: context.dealId,
            trancheId: context.trancheId,
            clientKey: payerAccountKey(context),
            amount,
          },
        ];
  };
  switch (to) {
    case 'collected':
      return [
        // Проводка зачисления принадлежит **событию поступления**, а не статусу
        // `collected`. В `collected` возвращаются и из `reserved`
        // (`reserve_expired`), и из `release_blocked`: деньги при этом уже лежат
        // в файле транша, и вторая проводка придумала бы поступление, которого
        // не было, — удвоив и обязательство перед клиентом, и отнесение
        // кастодиана. Обеспечение при этом сходится с обеих сторон, поэтому ни
        // один инвариант учёта такую запись не поймал бы.
        ...(event.type === 'funds_received' ? ledger('funds_received') : []),
        /**
         * Расфиксация — по **событию**, а не по статусу, тем же приёмом, что
         * зачисление строкой выше. `reserve_expired` — единственное событие,
         * которым в `collected` возвращаются, и оно ведёт сюда с **двух**
         * рёбер: `reserved → collected` и `release_blocked → collected`. Ключ
         * по событию закрывает оба одним правилом; ключ по статусу породил бы
         * расфиксацию ещё и на приходе денег из `collecting`, где запирать
         * ещё нечего.
         *
         * Симметричной половины запирания не было ни у одной проекции: при
         * `reserve_expired` деньги оставались запертыми под траншем, который в
         * интерфейсе уже считал их свободными (`CABINETS.md` §3.2 блок 6:
         * «резерв будет снят автоматически и деньги останутся у вас»).
         */
        ...(event.type === 'reserve_expired' ? ledger('unlock_funds') : []),
        { type: 'notify', audience: 'buyer', messageKey: 'tranche.collected.buyer' },
      ];
    case 'reserved':
      return [
        /**
         * Запирание средств под транш — намерение автомата, а не шаг
         * приложения. Раньше намерения не было вовсе, и три проекции запирали
         * в трёх разных моментах; на этой же границе стоит весь экран «Мой
         * счёт» (`CABINETS.md` §3.4: «вывод доступен, пока средства не
         * зарезервированы»), то есть расхождение было видно клиенту.
         *
         * Момент — вход в `reserved`: FUNCTIONAL.md §3.1 описывает проводку
         * привязки, но не называет переход, а STATE-MACHINES.md §6 и
         * `ROADMAP.md` И12.2 определяют `collected` как деньги, которые можно
         * забрать. Запирание на статус раньше делало оба обещания ложными.
         */
        ...ledger('lock_funds'),
        { type: 'lock_beneficiary' },
        { type: 'notify', audience: 'seller', messageKey: 'tranche.reserved.seller' },
      ];
    case 'release_pending':
      return [
        { type: 'build_payout_instruction', idempotencyKey: payoutIdempotencyKey(context.trancheId) },
      ];
    case 'paying_out': {
      const evidenceBundleId = context.facts.evidenceBundleId;
      // Ветка `null` недостижима, пока на переходе стоит `g_evidence_present`,
      // и написана так, чтобы удаление guard'а не превратилось в выплату без
      // ссылки на доказательства, а остановило её (красная линия №5).
      return evidenceBundleId === null
        ? []
        : [
            {
              type: 'enqueue_outbound_payout',
              idempotencyKey: payoutIdempotencyKey(context.trancheId),
              evidenceBundleId,
            },
          ];
    }
    case 'paid_out': {
      const evidenceRef = context.facts.evidenceBundleId;
      // Расчёт двигает **собранное**: запись дебетует файл транша на брутто и
      // расщепляет его на нетто получателю и комиссию. Запертое здесь читать
      // нельзя — оно и есть то, что расчёт обнуляет, а не то, чем он меряется;
      // равенство двух величин на этом пути держит `g_funds_collected` вместе с
      // инвариантом отрицательного остатка, а не подстановка одной вместо другой.
      const amount = context.facts.collectedAmount;
      if (act === null || evidenceRef === null || evidenceRef.length === 0 || amount === null) {
        // Сюда не попасть: акт привязан у всего, что вышло из `pending`, а
        // `g_evidence_present` стоит на обоих рёбрах пути выплаты. Ветка
        // написана исключением, а не пустым списком, потому что деньги к этой
        // секунде уже ушли из банка: «не записали расчёт» — хуже, чем
        // «остановились в `paying_out` и разбираем руками». Пустой список
        // молча оставил бы номинальный счёт с чужими деньгами и без
        // обязательства (красные линии №1 и №5).
        throw new DomainError(RejectionCode.conditionActMissing, 'paid_out');
      }
      return [
        // Выплата и комиссия — в одном журнале (красная линия №2, §1.5).
        // Получатель здесь не параметр: он взят из акта, и подтверждение для
        // учёта собрано тут же, из состояния транша.
        {
          type: 'post_settlement_entry',
          dealId: context.dealId,
          trancheId: context.trancheId,
          payerClientKey: payerAccountKey(context),
          recipientClientKey: act.recipient.accountKey,
          amount,
          /**
           * Потолок удержания едет вместе с суммой (`tariff.ts`, эпик E16) —
           * **политикой, а не посчитанной суммой**: запрет на записи меряет
           * удержание долей от брутто, и сумма на входе ему не предел. Берётся
           * из фактов транша, а не из сегодняшней настройки: `CORE.md` Ф11 —
           * решение хранит политику, действовавшую в момент принятия.
           */
          feeCeiling: context.facts.feeCeilingPolicy ?? DEFAULT_FEE_CEILING_POLICY,
          attestation: trancheSettlementAttestation(context, act, evidenceRef),
        },
        { type: 'notify', audience: 'both', messageKey: 'tranche.paid_out.both' },
        { type: 'close_tranche' },
      ];
    }
    /**
     * Возврат отправлен в банк — и у него, как у расчёта, есть **своё
     * поручение со своим ключом**.
     *
     * Ветки здесь не было вовсе, и это была не забытая мелочь, а отсутствие
     * дороги к уже построенному механизму. Таблица переходов ребро
     * `refunding --payout_result(settled)--> refunded` требует, `STATE-MACHINES.md`
     * §2.2 требует буквально, а положить ответ банка приложению было некуда:
     * записи поручения у возврата не существовало, и исход уезжал последней
     * выплате транша. Если та уже терминальна (банк отклонил расчёт — ровно тот
     * путь, которым транш и попадает в возврат), подтверждение возврата
     * отвергалось как `domain.state.terminal`, и транш оставался в `refunding`
     * навсегда: деньги покупателя не уходили ни ему, ни куда-либо ещё.
     *
     * Ключ — `refundIdempotencyKey`, а не `payoutIdempotencyKey`: это другой
     * перевод другому получателю, и общий с расчётом ключ дал бы банку право
     * погасить его как повтор (`ids.ts`).
     *
     * Само движение денег остаётся на входе в `refunded`, двумя записями
     * (`refund_unlock` и `refund_external`): до ответа банка неизвестно, ушли
     * ли деньги, и отвергнутый возврат не оставляет в журнале ничего.
     */
    case 'refunding':
      return [
        { type: 'enqueue_outbound_refund', idempotencyKey: refundIdempotencyKey(context.trancheId) },
      ];
    case 'refunded':
      return [
        /**
         * Возврат — **две записи, а не одна** (§3.1, по образцу списания):
         *
         * 1. `refund_unlock` — отвязка от транша: обязательство по траншу
         *    гасится, деньги возвращаются в свободную часть счёта покупателя,
         *    отзывными (красная линия №7). Деньги при этом никуда не уходили —
         *    они на номинальном счёте, просто больше не заперты.
         * 2. `refund_external` — уход с номинального счёта на счёт-источник, на
         *    имя плательщика (красная линия №9, инвариант 20). Это внешний
         *    межбанковский перевод, а не внутреннее движение.
         *
         * Раньше шаблон был один, и каждая проекция выбирала, какой из двух
         * моментов он значит: домен записывал отвязку, приложение — внешний
         * вывод. Тест на свойствах гонял при этом не ту модель, которой
         * пользуется приложение, — то есть возврат не проверялся ни в одной из
         * двух форм целиком.
         *
         * **Почему обе записи в терминальном состоянии, а не по разным
         * переходам.** Отвязка просится в `refunding` («возврат отправлен»), но
         * из `refunding` есть ребро в `release_blocked` по отказу банка, а
         * оттуда — обратно в `refund_pending` и снова в `refunding`. Отвязка,
         * стоящая на нетерминальном входе, повторилась бы на каждой попытке и
         * увела бы запертую часть в минус; терминальное состояние по
         * построению входится один раз. Идемпотентность здесь взята
         * структурой, а не проверкой «уже отвязывали».
         *
         * И это честнее по существу: до подтверждения банка неизвестно, ушли
         * ли деньги. Отвергнутый возврат не оставляет в журнале ни одной
         * записи — потому что не произошло ничего.
         */
        ...ledger('refund_unlock'),
        ...ledger('refund_external'),
        { type: 'notify', audience: 'buyer', messageKey: 'tranche.refunded.buyer' },
        { type: 'close_tranche' },
      ];
    case 'written_off':
      return [...ledger('write_off'), { type: 'close_tranche' }];
    case 'release_blocked':
      return [
        // Приоритет задачи оператора — по сумме транша (§1.5).
        { type: 'enqueue_operator_task', priorityAmount: context.facts.requiredAmount },
        { type: 'notify', audience: 'both', messageKey: 'tranche.release_blocked.both' },
      ];
    case 'refund_pending':
      // ROADMAP.md И12.3: «вторая сторона узнаёт из кабинета, а не по факту
      // неполучения денег». Ветки здесь не было вовсе, то есть отзыв покупателя
      // не порождал ни одного уведомления, хотя §6 задаёт представление
      // `refund_pending` для обеих сторон. `messageKey` — ключ локализации:
      // формулировка идёт через копирайтера и главреда, в коде её нет.
      return [{ type: 'notify', audience: 'both', messageKey: 'tranche.refund_pending.both' }];
    default:
      return [];
  }
}

function matches(candidate: TrancheTransition, input: GuardInput): readonly GuardId[] {
  const failed: GuardId[] = [];
  for (const guard of candidate.guards) {
    if (!evaluateGuard(guard, input)) failed.push(guard);
  }
  for (const guard of candidate.negatedGuards) {
    if (evaluateGuard(guard, input)) failed.push(guard);
  }
  return failed;
}

/**
 * Редьюсер транша: чистая функция состояния, события и контекста.
 * Побочных эффектов внутри нет — действия возвращаются намерениями.
 */
export function reduceTranche(
  state: TrancheState,
  event: TrancheEvent,
  context: TrancheContext,
): Result<TrancheTransitionResult, Rejection> {
  if (isTerminalTrancheStatus(state.status)) {
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
      // [открыто] §8: значение не подтверждено и до подтверждения не используется.
      return failure(
        rejection(RejectionCode.releaseConditionRequiresConfirmation, [], {
          conditionType: event.conditionType,
        }),
      );
    }
    /**
     * Владелец тип подтвердил, но наблюдения требуемого уровня от его источника
     * не производит никто (`release-condition.ts`, `calendar_date`).
     *
     * Отказ **здесь**, а не в guard'ах ниже, и в этом весь смысл правки: до
     * этого батча такое событие уходило в `g_observation_sufficient` и
     * `g_fields_match` и выглядело как «доказательств не хватило» — притом что
     * их не могло хватить никогда. Разница между «сегодня не сошлось» и
     * «сойтись не может» — это разница между «подождём выписку» и «этого
     * продукта нет».
     */
    if (!meta.sourceImplemented) {
      return failure(
        rejection(RejectionCode.releaseConditionSourceUnavailable, [], {
          conditionType: event.conditionType,
          sourceKey: meta.sourceKey,
        }),
      );
    }
  }

  const previousEnteredAt: Instant = 'enteredAt' in state ? state.enteredAt : context.now;
  const input: GuardInput = { facts: context.facts, event, now: context.now };
  const boundAct = boundConditionAct(state);

  // Изменение условия — не переход, а перепривязка акта, поэтому оно разбирается
  // до таблицы переходов: состояние, дедлайн и время входа остаются теми же.
  // После внесения средств это единственный путь изменить условие, и он требует
  // новой редакции, принятой обеими сторонами (CORE.md Ф13, E11-4).
  if (event.type === 'condition_act_amended' && 'deadline' in state) {
    const amendmentGuards: readonly GuardId[] = [
      'g_condition_agreed',
      'g_amendment_accepted_by_both',
    ];
    const failed = amendmentGuards.filter((guard) => !evaluateGuard(guard, input));
    if (failed.length > 0) {
      return failure(rejection(RejectionCode.guardFailed, failed, { status: state.status }));
    }
    return ok({
      state: nonTerminalTrancheState(state.status, state.deadline, state.enteredAt, event.act),
      intents: Object.freeze([]),
    });
  }

  // Подмена акта у транша, где деньги уже приняты, невозможна: акт, записанный
  // в состоянии, обязан совпадать с актом в фактах. Иначе условие
  // переопределяется молча — тем, что приложение передало другой акт.
  //
  // Отказ распространяется на все события, включая `deadline_reached`. Это
  // намеренно: расхождение означает, что данные о транше несогласованы, а
  // двигать по ним деньги — включая возврат — хуже, чем остановиться. Отказ
  // виден, потому что фоновая задача по дедлайну будет падать на нём, а не
  // тихо удерживать средства.
  if (boundAct !== null) {
    const current = context.facts.conditionAct;
    if (current === null || !conditionActsEqual(boundAct, current)) {
      return failure(
        rejection(RejectionCode.conditionActSubstituted, [], {
          status: state.status,
          event: event.type,
        }),
      );
    }
  }

  /**
   * Условие устанавливается **тем самым пакетом доказательств и тем самым типом
   * условия**, которые записаны у транша (E3-1, `ORACLE.md` §6.5).
   *
   * Обе сверки — рядом с `conditionActSubstituted` выше, тем же приёмом и по
   * той же причине: факты приходят снаружи на каждый вызов, и без сверки поле
   * события декоративно.
   *
   * 1. **Пакет доказательств.** Событие несёт `evidenceBundleId`, а намерения
   *    входа (`build_payout_instruction`, `enqueue_outbound_payout`) берут
   *    ссылку **из фактов**. Расхождение означает, что журнал аудита и guard
   *    говорят о разных пакетах — красная линия №5 держится на том, что пакет
   *    один. Случай «в фактах пакета нет вовсе» сюда не относится: его ловит
   *    `g_evidence_present` на том же ребре и называет своим именем.
   *
   * 2. **Тип условия.** Проверялась только принадлежность перечню, но не
   *    совпадение с типом в акте получателя. Транш с актом
   *    `registration_transfer` устанавливался событием `calendar_date` — и
   *    проходил, потому что у того `requiresConfirmation: false`. Прикрыто это
   *    было случайностью (базовые факты сквозного потока клали пять полей
   *    выписки в `false`), а не правилом. Условие определяет получатель
   *    (ст. 27(2), Ф13), и подменить его тип событием нельзя: иначе транш,
   *    ждущий регистрации, расчитывается по наступлению календарной даты.
   */
  if (event.type === 'condition_established') {
    const evidenceBundleId = context.facts.evidenceBundleId;
    if (evidenceBundleId !== null && event.evidenceBundleId !== evidenceBundleId) {
      return failure(
        rejection(RejectionCode.evidenceBundleSubstituted, [], {
          status: state.status,
          event: event.type,
        }),
      );
    }
    const act = boundAct ?? context.facts.conditionAct;
    if (act !== null && event.conditionType !== act.conditionType) {
      return failure(
        rejection(RejectionCode.conditionTypeSubstituted, [], {
          status: state.status,
          conditionType: event.conditionType,
          actConditionType: act.conditionType,
        }),
      );
    }
  }

  const outcome = eventOutcome(event);
  const resume: UnfreezeTarget | null = event.type === 'unfreeze' ? event.resume : null;

  if (event.type === 'unfreeze' && 'suspendedFrom' in state) {
    // Разморозку не утверждает тот, кто заморозил. Проверка здесь, а не в
    // guard'е: автор заморозки лежит **в состоянии**, а `GuardInput` состояния
    // не видит, и расширять его ради одного правила значит трогать все места
    // вызова guard'ов (см. комментарий у `g_unfreeze_approvers_distinct`).
    if (event.userIds.includes(state.frozenBy)) {
      return failure(
        rejection(RejectionCode.guardFailed, ['g_unfreeze_approvers_distinct'], {
          status: state.status,
          event: event.type,
        }),
      );
    }
    // Заморозка, взятая в `paying_out` или `refunding`, выходит **только** в
    // `release_blocked`. Поручение уже ушло в банк: вернуться в состояние
    // «поручение отправлено» значит выпустить его второй раз, а уйти в возврат
    // значит вернуть деньги, которые, возможно, уже выплачены. Исход поручения
    // обязан сначала пройти сверку человеком (§2.2, красная линия №8).
    // Список тот же, что убирает строки из таблицы: одно правило — одна константа.
    if (
      DISPATCHED_TRANCHE_STATUSES.includes(state.suspendedFrom) &&
      event.resume !== 'release_blocked'
    ) {
      return failure(
        rejection(RejectionCode.unfreezeTargetNotAllowed, [], {
          suspendedFrom: state.suspendedFrom,
          resume: event.resume,
        }),
      );
    }
  }

  const candidates = TRANCHE_TRANSITIONS.filter(
    (item) =>
      item.from === state.status &&
      item.event === event.type &&
      item.outcome === outcome &&
      item.resume === resume &&
      // `suspended_from` — не одно ребро, а по ребру на каждый остывший статус:
      // целевое состояние берётся из состояния, а не из события, и в таблице
      // всё равно присутствует поимённо, иначе обход графа его не увидит.
      (item.resume !== 'suspended_from' ||
        ('suspendedFrom' in state && item.to === state.suspendedFrom)),
  );
  if (candidates.length === 0) {
    return failure(
      rejection(RejectionCode.transitionNotAllowed, [], {
        status: state.status,
        event: event.type,
      }),
    );
  }

  let firstFailure: readonly GuardId[] = [];
  for (const candidate of candidates) {
    const failed = matches(candidate, input);
    if (failed.length > 0) {
      if (firstFailure.length === 0) firstFailure = failed;
      continue;
    }
    const nextStatus = candidate.to;
    /**
     * Самопереход — **внутренний** переход, а не выход и повторный вход.
     *
     * Единственный такой переход с действиями входа — `paying_out
     * --payout_result(unknown)--> paying_out`. Действия входа в `paying_out`
     * включают `enqueue_outbound_payout`, то есть каждый неответ банка велел
     * выпустить поручение **заново** — ровно то, что красная линия №8 и §2.2
     * объявляют невозможным без сверки. От второй выплаты спасал только
     * детерминированный ключ идемпотентности, то есть дисциплина адаптера:
     * приложение, доверившееся намерению, выпустило бы вторую.
     *
     * Признак берётся тот же, по которому не двигается `enteredAt`: состояние
     * не менялось, значит, ни выхода из него, ни входа в него не было. Дедлайн
     * пересчитывается — он и есть смысл этого события.
     */
    // Акт привязывается к траншу на выходе из `pending` — в тот момент, когда
    // открывается приём средств, и ровно тот, который прошёл `g_condition_agreed`.
    // Дальше он переносится без изменений: сменить его может только амендмент.
    //
    // Считается до разбора терминальных состояний, а не после: расчёт берёт
    // получателя **из акта**, и в терминальном `paid_out` акт нужен так же,
    // как в нетерминальных — там он нужен для состояния, здесь для денег.
    const conditionAct = boundAct ?? context.facts.conditionAct;

    const internal = nextStatus === state.status;
    const intents: Intent[] = internal ? [] : [...exitIntents(state.status, nextStatus)];
    if (isTerminalTrancheStatus(nextStatus)) {
      intents.push(...entryIntents(nextStatus, event, context, conditionAct));
      return ok({ state: terminalTrancheState(nextStatus), intents: Object.freeze(intents) });
    }

    if (nextStatus === 'frozen') {
      if (event.type !== 'compliance_hold' && event.type !== 'dispute_raised') {
        return failure(
          rejection(RejectionCode.transitionNotAllowed, [], {
            status: state.status,
            event: event.type,
          }),
        );
      }
      if (!('deadline' in state)) {
        // Заморозить замороженное нельзя: ребра `frozen → frozen` в таблице нет,
        // и сюда попасть невозможно. Ветка написана отказом, а не исключением,
        // чтобы появление такого ребра остановило транш, а не обнулило остаток.
        return failure(
          rejection(RejectionCode.transitionNotAllowed, [], {
            status: state.status,
            event: event.type,
          }),
        );
      }
      const remaining = remainingUntil(state.deadline, context.now);
      const reason: FreezeReason = event.type === 'compliance_hold' ? event.reason : 'dispute';
      intents.push({ type: 'suspend_deadline', remaining });
      return ok({
        state: frozenTrancheState(
          state.status,
          remaining,
          context.now,
          conditionAct,
          reason,
          event.frozenBy,
        ),
        intents: Object.freeze(intents),
      });
    }

    if (event.type === 'unfreeze') {
      // Разморозка не переигрывает вход в целевое состояние: повторное
      // `lock_beneficiary` и уведомление продавцу «средства подтверждены», а тем
      // более повторное `enqueue_outbound_payout` — это второе исполнение уже
      // исполненного. Единственное намерение разморозки — восстановление часов.
      //
      // Остаток применяется только при возврате в тот же статус. У
      // `refund_pending` и `release_blocked` часы чужие: срок возврата и норматив
      // разбора не наследуют неистёкшую часть чужого дедлайна.
      //
      // `enteredAt` сбрасывается всегда. Дедлайн и возраст — две разные заботы
      // (§5): часы денег клиента приостанавливаются и досчитываются, часы
      // внимания дежурного начинаются заново. Сохранить `enteredAt` значило бы
      // эскалировать транш в ту же секунду после трёхнедельной заморозки.
      const span =
        candidate.resume === 'suspended_from' && 'remaining' in state
          ? state.remaining
          : context.deadlinePolicy[nextStatus];
      const at = plus(context.now, span);
      return ok({
        state: nonTerminalTrancheState(nextStatus, deadline(at), context.now, conditionAct),
        intents: Object.freeze([{ type: 'set_deadline', at } as const]),
      });
    }

    const at = plus(context.now, context.deadlinePolicy[nextStatus]);
    intents.push({ type: 'set_deadline', at });
    if (!internal) {
      intents.push(...entryIntents(nextStatus, event, context, conditionAct));
    }
    // Переход `paying_out → paying_out` по `payout_result(unknown)` — это то же
    // состояние: дедлайн пересчитывается, время входа сохраняется, иначе каждый
    // неответ банка обнулял бы возраст и застрявшая выплата никогда не попадала
    // бы в эскалацию (STATE-MACHINES.md §5).
    const enteredAt = internal ? previousEnteredAt : context.now;
    return ok({
      state: nonTerminalTrancheState(nextStatus, deadline(at), enteredAt, conditionAct),
      intents: Object.freeze(intents),
    });
  }

  return failure(
    rejection(RejectionCode.guardFailed, firstFailure, {
      status: state.status,
      event: event.type,
    }),
  );
}

export function initialTrancheState(now: Instant, policy: DeadlinePolicy): TrancheState {
  return nonTerminalTrancheState('pending', deadline(plus(now, policy.pending)), now, null);
}

/** Акт, под которым транш принял деньги. `null` — денег ещё не принимали. */
export function boundConditionAct(state: TrancheState): ConditionAct | null {
  return 'conditionAct' in state ? state.conditionAct : null;
}
