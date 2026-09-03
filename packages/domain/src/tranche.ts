import type { CurrencyCode, Money } from '@sdelka/money';
import { type ConditionAct, conditionActsEqual } from './condition-act';
import type { FreezeReason, UnfreezeTarget } from './freeze';
import { type GuardId, type GuardInput, type TrancheFacts, evaluateGuard } from './guards';
import { payoutIdempotencyKey } from './ids';
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
  /**
   * Владелец обязательства по траншу — ключ личности плательщика. Нужен
   * проводкам: после E12-1 счёт клиента адресуется владельцем, а не парой
   * «сделка + транш» (FUNCTIONAL.md §3.1). Домен ключ не разбирает и не хранит
   * — только передаёт в намерение.
   */
  readonly payerClientKey: string;
  readonly facts: TrancheFacts;
  readonly deadlinePolicy: DeadlinePolicy;
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
  'g_fields_match',
  'g_owner_is_buyer',
  'g_beneficiary_locked',
  'g_beneficiary_verified',
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

  transition('reserved', 'condition_established', 'release_pending', EVIDENCE_GUARDS),
  transition('reserved', 'mismatch_detected', 'release_blocked'),
  transition('reserved', 'reserve_expired', 'collected'),
  transition('reserved', 'condition_failed', 'refund_pending'),
  transition('reserved', 'revocation_requested', 'refund_pending'),

  transition('release_pending', 'release_authorized', 'paying_out', [
    ...EVIDENCE_GUARDS,
    'g_approvals_sufficient',
    'g_no_active_payout',
    'g_coverage_ok',
  ]),
  transition('release_pending', 'operator_blocked', 'release_blocked'),

  transition('release_blocked', 'approval_added', 'release_pending', ['g_mismatch_resolved']),
  transition('release_blocked', 'refund_requested', 'refund_pending'),
  transition('release_blocked', 'reserve_expired', 'collected'),
  transition('release_blocked', 'write_off_approved', 'written_off', [
    'g_write_off_approvers_distinct',
  ]),

  transition('paying_out', 'payout_result', 'paid_out', [], [], 'settled'),
  transition('paying_out', 'payout_result', 'release_blocked', [], [], 'rejected'),
  // «Неизвестно» оставляет транш здесь: повтор запрещён без сверки (§2.2).
  transition('paying_out', 'payout_result', 'paying_out', [], [], 'unknown'),
  // Событие сверки есть в §1.2, но отсутствует в таблице §1.4. Без него
  // обещание §5 «выход гарантирован не позднее следующего дня» не выполняется.
  transition('paying_out', 'reconciliation_resolved', 'paid_out', [], [], 'settled'),
  transition('paying_out', 'reconciliation_resolved', 'release_blocked', [], [], 'rejected'),

  transition('refund_pending', 'refund_initiated', 'refunding', ['g_source_account_known']),
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
 * Сумма, которой распоряжается проводка. Для зачисления — сумма события, для
 * выплаты, возврата и списания — фактически собранные средства.
 *
 * `null` означает, что денег по траншу не поступало: транш из `collecting`
 * уходит в возврат по дедлайну и возвращать нечего. Проводки в этом случае нет
 * вовсе — «возврат нуля» это запись с нулевой суммой, а такие записи журнал
 * не принимает.
 */
function moneyForTemplate(event: TrancheEvent, facts: TrancheFacts): Money<CurrencyCode> | null {
  if (event.type === 'funds_received') return event.amount;
  return facts.collectedAmount;
}

function exitIntents(from: TrancheStatus, to: TrancheStatus): readonly Intent[] {
  // §1.5: блокировка реквизитов снимается, только если уходим не в выплату.
  //
  // `frozen` в списке «блокировка сохраняется» намеренно. Заморозка — не уход
  // из резерва, а его приостановка, и без этой строки переход
  // `reserved → frozen` снимал бы блокировку реквизитов на всё время
  // расследования: заморозка стала бы способом сбросить периметр Ф15, то есть
  // защита превратилась бы в дыру.
  const keepsBeneficiaryLock: readonly TrancheStatus[] = [
    'release_pending',
    'paying_out',
    'paid_out',
    'frozen',
  ];
  if (from === 'reserved' && !keepsBeneficiaryLock.includes(to)) {
    return [{ type: 'unlock_beneficiary' }];
  }
  return [];
}

function entryIntents(
  to: TrancheStatus,
  event: TrancheEvent,
  context: TrancheContext,
): readonly Intent[] {
  const amount = moneyForTemplate(event, context.facts);
  const ledger = (template: LedgerTemplate): readonly Intent[] =>
    amount === null
      ? []
      : [
          {
            type: 'post_journal_entry',
            template,
            dealId: context.dealId,
            trancheId: context.trancheId,
            clientKey: context.payerClientKey,
            amount,
          },
        ];
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
        { type: 'notify', audience: 'buyer', messageKey: 'tranche.collected.buyer' },
      ];
    case 'reserved':
      return [
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
    case 'paid_out':
      return [
        // Выплата и комиссия — в одном журнале (красная линия №2, §1.5).
        ...ledger('payout_with_fee'),
        { type: 'notify', audience: 'both', messageKey: 'tranche.paid_out.both' },
        { type: 'close_tranche' },
      ];
    case 'refunded':
      return [
        ...ledger('refund'),
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
    const internal = nextStatus === state.status;
    const intents: Intent[] = internal ? [] : [...exitIntents(state.status, nextStatus)];
    if (isTerminalTrancheStatus(nextStatus)) {
      intents.push(...entryIntents(nextStatus, event, context));
      return ok({ state: terminalTrancheState(nextStatus), intents: Object.freeze(intents) });
    }

    // Акт привязывается к траншу на выходе из `pending` — в тот момент, когда
    // открывается приём средств, и ровно тот, который прошёл `g_condition_agreed`.
    // Дальше он переносится без изменений: сменить его может только амендмент.
    const conditionAct = boundAct ?? context.facts.conditionAct;

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
      intents.push(...entryIntents(nextStatus, event, context));
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
