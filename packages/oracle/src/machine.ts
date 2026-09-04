import {
  type FilingSource,
  type Instant,
  type ObservationPolicy,
  type ReleaseConditionType,
  type ReleaseObservation,
  type Result,
  allStatementFieldsMatch,
  failure,
  observationSatisfies,
  ok,
} from '@sdelka/domain';
import type { CurrencyCode, Money } from '@sdelka/money';
import type { SourcedObservation } from './sourced-observation';

/**
 * Машина наблюдения оракула — `STATE-MACHINES.md` §10, `ORACLE.md` §8.
 *
 * Отдельная забота и отдельный пакет: наблюдение «не двигает деньги и не должно
 * жить внутри автомата транша». Деньги двигает автомат транша, и он **заново**
 * выводит вердикт из того же наблюдения своими guard'ами — это не дублирование,
 * а тот же принцип, по которому guard стоит на обеих дверях (§1.4, §4).
 *
 * **Guard'ов здесь нет ни одного, и это ограничение, а не стиль.** Мутационный
 * регистр (`packages/e2e/scripts/guard-registry.mjs`) ищет перечни
 * `export const … = ['g_…'] as const` **только** в `packages/domain/src`.
 * Guard, заведённый здесь, выпал бы из мутационного прогона молча — ровно та
 * дыра, ради которой регистр однажды переписали. Поэтому условия переходов
 * названы своим коротким перечнем (`OBSERVATION_CONDITION_IDS`), а не именами
 * вида `g_…`, которые обещали бы покрытие, которого нет.
 *
 * `CTO-architecture.md`, «Принцип разделения», п. 2: оракул «только собирает
 * наблюдения и присваивает им уровень доверия. Решений не принимает».
 */

export const OBSERVATION_STATUSES = [
  'not_started',
  'awaiting_filing',
  /** Сторона назвала номер заявления (L0). Нашего дедлайна это не двигает. */
  'filing_claimed',
  /** Карточка заявления подтвердила подачу (L1) и сошлась по кадастровому коду. */
  'filing_confirmed',
  'extract_due',
  'extract_ordered',
  'matched',
  'mismatched',
  /** Оснований нет: документ не дотягивает, собственник не установлен, наблюдение брошено. */
  'insufficient',
  /** Реестр не отвечает. Нетерминальное: отсутствие сигнала — не «всё хорошо». */
  'unavailable',
] as const;

export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

export const TERMINAL_OBSERVATION_STATUSES = ['matched', 'mismatched', 'insufficient'] as const;

export type TerminalObservationStatus = (typeof TERMINAL_OBSERVATION_STATUSES)[number];

export function isTerminalObservationStatus(
  status: ObservationStatus,
): status is TerminalObservationStatus {
  return (TERMINAL_OBSERVATION_STATUSES as readonly string[]).includes(status);
}

/** Вердикт по полученной выписке. Значения совпадают с терминальными статусами. */
export type ExtractVerdict = TerminalObservationStatus;

/**
 * Поля, по которым может разойтись сверка — `FUNCTIONAL.md` §3.5, пять полей.
 *
 * Ключи, а не текст: формулировка для человека идёт через копирайтера и
 * главреда (`CLAUDE.md`), в коде её нет.
 *
 * ⚠ Пятое поле — **доля**. Фикстуры консоли (`apps/web/src/fixtures/screens.ts`)
 * перечисляют вместо неё дату записи: консоль показывает не тот набор, который
 * проверяет guard. Расхождение названо в `ORACLE.md` §13; правка — в чужом
 * пакете и в этом батче не сделана.
 */
export const MISMATCH_FIELDS = [
  'cadastral_code',
  'owner',
  'share',
  'basis',
  'encumbrance',
] as const;

export type MismatchField = (typeof MISMATCH_FIELDS)[number];

export const OBSERVATION_TASK_KINDS = [
  /** Собственник не установлен: номера документа выписка не отдала (Ф7, [открыто]). */
  'owner_reconciliation',
  /** Расхождение по одному из пяти полей — стоп и человек при любой сумме. */
  'field_mismatch',
  /** Документ не дотягивает до требований: уровень, источник, объект, свежесть. */
  'observation_insufficient',
] as const;

export type ObservationTaskKind = (typeof OBSERVATION_TASK_KINDS)[number];

/* ------------------------------------------------------------------------- */
/* События                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * События наблюдения — `ORACLE.md` §8.2.
 *
 * Три события введены кодом и названы в документе, а не молча:
 * `observation_started` (без него у первого перехода нет вызывающего — правило
 * §1.2 «переход без события некому вызвать»), `registry_recovered`
 * (единственный выход из `unavailable`) и `observation_abandoned` (сделка ушла
 * в откат или отменена: наблюдение обязано иметь выход, а не висеть вечно).
 */
export type ObservationEvent =
  | { readonly type: 'observation_started' }
  | {
      readonly type: 'filing_claimed';
      readonly applicationId: string;
      /** Кто из сторон назвал номер. Он же не может двигать наш дедлайн (И3.2). */
      readonly byParty: string;
    }
  | {
      readonly type: 'filing_card_observed';
      readonly applicationId: string;
      /** Сверяется с объектом сделки: «сторона называет чужой номер» (И3.2). */
      readonly cadastralCode: string;
      /**
       * Статус карточки заявления — **непрозрачная строка, и это намеренно**.
       *
       * `CORE.md` Ф7: «статус заявления „завершено“ не значит ничего —
       * заявление может быть закрыто отказом». Ни один переход его не читает,
       * поэтому закрытый перечень здесь был бы обещанием ветвления, которого
       * не будет: перечень нужен тому, кто собирается по нему решать. Значение
       * carried в состояние и в журнал — для восстановления истории (Ф11).
       */
      readonly applicationStatus: string;
    }
  | { readonly type: 'statutory_term_elapsed' }
  | { readonly type: 'extract_ordered'; readonly cost: Money<CurrencyCode> }
  /**
   * Выписка получена. Наблюдение приходит **вместе с записанным ответом**
   * источника (`SourcedObservation`): построить это событие, не предъявив
   * байты ответа, нечем. Красная линия №5 и `CORE.md` Ф11 держатся здесь
   * типом, а не проверкой у вызывающего.
   */
  | { readonly type: 'extract_received'; readonly observation: SourcedObservation }
  | { readonly type: 'registry_unavailable'; readonly reasonKey: string }
  | { readonly type: 'registry_recovered' }
  | { readonly type: 'observation_abandoned'; readonly reasonKey: string };

export type ObservationEventType = ObservationEvent['type'];

/* ------------------------------------------------------------------------- */
/* Намерения                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Намерения наблюдения — **собственный тип**, а не расширение `Intent` домена.
 *
 * Намерения оракула не двигают деньги, и попадание их в один перечень с
 * проводками стёрло бы ровно ту границу, ради которой машина вынесена
 * (`CTO-architecture.md`, «Принцип разделения»).
 */
export type ObservationIntent =
  /**
   * Факт подачи с указанием источника — `ROADMAP.md` И3.2, задача
   * «источник факта как атрибут события, а не bool». Единственное место, где
   * источник известен достоверно, — здесь; дальше он живёт в событии сделки
   * `filing_registered` и в guard'е `g_no_open_filing`.
   */
  | {
      readonly type: 'register_filing';
      readonly applicationId: string;
      readonly source: FilingSource;
    }
  /** Дешёвый сигнал управляет таймингом: отсчёт регламентного срока. */
  | { readonly type: 'start_statutory_clock' }
  | { readonly type: 'order_paid_extract'; readonly cadastralCode: string }
  /**
   * Расход на выписку. Счёт `oracle:cost:expense` в плане счетов уже заведён,
   * но проводка — E14: шаблоны учёта здесь не расширяются, и намерение остаётся
   * намерением (`ORACLE.md` §11). Сумма — целые минорные единицы
   * (красная линия №4).
   */
  | { readonly type: 'recognise_oracle_cost'; readonly amount: Money<CurrencyCode> }
  | {
      readonly type: 'emit_tranche_event';
      readonly event: 'condition_established';
      readonly conditionType: ReleaseConditionType;
      /**
       * Наблюдение, которым условие установлено: транш проверит его сам.
       * Ответ источника едет вместе с ним — иначе исполнитель намерения
       * собирал бы пакет доказательств заново и по памяти.
       */
      readonly observation: SourcedObservation;
    }
  | {
      readonly type: 'emit_tranche_event';
      readonly event: 'mismatch_detected';
      readonly field: MismatchField;
    }
  | { readonly type: 'enqueue_operator_task'; readonly kind: ObservationTaskKind }
  /**
   * Часы **сделки**, а не заморозка транша (`FUNCTIONAL.md` §3.6, `ORACLE.md`
   * §10). `registry_unavailable` намеренно не заведён основанием заморозки:
   * `ComplianceFreezeReason` втянул бы технический инцидент в
   * комплаенс-заморозку молча, и оператор увидел бы «заморожено санкциями» и
   * «реестр лежит» одним состоянием.
   */
  | { readonly type: 'suspend_deal_clock'; readonly reasonKey: string }
  | { readonly type: 'resume_deal_clock' };

/* ------------------------------------------------------------------------- */
/* Таблица переходов                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Условия переходов — закрытый перечень **из одного значения**.
 *
 * Перечень существует именно затем, чтобы на него можно было посмотреть
 * целиком: тест перебирает его и убеждается, что статуса заявления среди
 * условий нет. Условие, спрятанное в теле обработчика, такому перебору
 * недоступно.
 */
export const OBSERVATION_CONDITION_IDS = ['cadastral_code_matches'] as const;

export type ObservationConditionId = (typeof OBSERVATION_CONDITION_IDS)[number];

export interface ObservationTransition {
  readonly from: ObservationStatus;
  readonly to: ObservationStatus;
  readonly event: ObservationEventType;
  /** Различитель исхода для `extract_received`, как `outcome` у транша. */
  readonly verdict: ExtractVerdict | null;
  readonly requires: ObservationConditionId | null;
}

function transition(
  from: ObservationStatus,
  event: ObservationEventType,
  to: ObservationStatus,
  verdict: ExtractVerdict | null = null,
  requires: ObservationConditionId | null = null,
): ObservationTransition {
  return Object.freeze({ from, to, event, verdict, requires });
}

const NON_TERMINAL_STATUSES = OBSERVATION_STATUSES.filter(
  (status) => !isTerminalObservationStatus(status),
);

export const OBSERVATION_TRANSITIONS: readonly ObservationTransition[] = Object.freeze([
  transition('not_started', 'observation_started', 'awaiting_filing'),

  transition('awaiting_filing', 'filing_claimed', 'filing_claimed'),
  transition('awaiting_filing', 'filing_card_observed', 'filing_confirmed', null, 'cadastral_code_matches'),
  transition('filing_claimed', 'filing_card_observed', 'filing_confirmed', null, 'cadastral_code_matches'),

  /**
   * ⚠ Из `filing_claimed` регламентный срок **не течёт**: отсчёт запускает
   * карточка, а не слово стороны (И3.2, критерий 1). Строки нет намеренно —
   * это тот же приём, что запрет автовозврата из `frozen` у транша: проверку в
   * обработчике можно обойти новой веткой, отсутствующую строку — нет.
   */
  transition('filing_confirmed', 'statutory_term_elapsed', 'extract_due'),

  transition('extract_due', 'extract_ordered', 'extract_ordered'),

  /**
   * ⚠ Единственный вход в `matched` — полученная выписка. Из `filing_confirmed`
   * ребра в `matched` нет: дешёвый сигнал управляет таймингом, деньги двигает
   * платная выписка (`CORE.md` Ф7).
   */
  transition('extract_ordered', 'extract_received', 'matched', 'matched'),
  transition('extract_ordered', 'extract_received', 'mismatched', 'mismatched'),
  transition('extract_ordered', 'extract_received', 'insufficient', 'insufficient'),

  transition('extract_due', 'registry_unavailable', 'unavailable'),
  transition('extract_ordered', 'registry_unavailable', 'unavailable'),

  /**
   * ⚠ Из `unavailable` есть ровно одно ребро — обратно к заказу выписки.
   * Ни в `matched`, ни в `mismatched`: отсутствие сигнала никогда не читается
   * как «всё хорошо» (`CORE.md` Ф7).
   */
  transition('unavailable', 'registry_recovered', 'extract_due'),

  /**
   * Наблюдение брошено — сделка откачена или отменена. Выход есть у каждого
   * нетерминального состояния (§5: «у каждого состояния есть выход»), и ведёт
   * он в «оснований нет», а не в «сошлось».
   */
  ...NON_TERMINAL_STATUSES.map((status) =>
    transition(status, 'observation_abandoned', 'insufficient'),
  ),
]);

/* ------------------------------------------------------------------------- */
/* Состояние, контекст, отказы                                               */
/* ------------------------------------------------------------------------- */

export interface ObservationState {
  readonly status: ObservationStatus;
  /** Заявление, о котором наблюдение. `null` — о подаче ещё не знаем. */
  readonly applicationId: string | null;
  /**
   * Последний наблюдавшийся статус карточки. Хранится **для журнала**, читается
   * человеком, и ни один переход его не использует (Ф7).
   */
  readonly applicationStatus: string | null;
  /** Полученное наблюдение вместе с ответом. `null` — выписки ещё нет. */
  readonly observation: SourcedObservation | null;
}

export const initialObservationState: ObservationState = Object.freeze({
  status: 'not_started',
  applicationId: null,
  applicationStatus: null,
  observation: null,
});

export interface ObservationContext {
  readonly dealId: string;
  /** Тип условия по акту получателя: наблюдение сверяется с ним, а не с собой. */
  readonly conditionType: ReleaseConditionType;
  readonly expectedCadastralCode: string;
  readonly now: Instant;
  readonly policy: ObservationPolicy;
}

export const ObservationRejectionCode = {
  transitionNotAllowed: 'oracle.transition.not_allowed',
  terminalState: 'oracle.state.terminal',
  /**
   * Карточка заявления — о другом объекте. Отказ, а не тихий пропуск: сверка
   * кадастрового кода — обязательная часть подтверждения подачи, и «сторона
   * называет чужой номер» обязано быть видно (И3.2, крайний случай).
   */
  cadastralCodeMismatch: 'oracle.filing_card.cadastral_mismatch',
} as const;

export type ObservationRejectionCode =
  (typeof ObservationRejectionCode)[keyof typeof ObservationRejectionCode];

export interface ObservationRejection {
  readonly code: ObservationRejectionCode;
  readonly details: Readonly<Record<string, string>>;
}

function reject(
  code: ObservationRejectionCode,
  details: Readonly<Record<string, string>> = {},
): ObservationRejection {
  return Object.freeze({ code, details });
}

export interface ObservationTransitionResult {
  readonly state: ObservationState;
  readonly intents: readonly ObservationIntent[];
}

/* ------------------------------------------------------------------------- */
/* Вердикт                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Классификация полученной выписки — `ORACLE.md` §8.5.
 *
 * **Вердикт не разрешает ничего.** Он выбирает следующее состояние наблюдения и
 * вид задачи оператору; движение денег остаётся за автоматом транша, который
 * выводит то же самое из того же наблюдения своими тремя guard'ами. Машина
 * решений не принимает — она классифицирует документ по правилу, записанному в
 * `FUNCTIONAL.md` §3.5.
 *
 * Порядок проверок значим: сперва годность самого документа, потом собственник,
 * потом поля. `insufficient` у собственника идёт **раньше** расхождения полей,
 * потому что «мы не смогли установить» и «мы установили обратное» — разные
 * задачи для оператора, и первая не должна прятаться за второй.
 */
export function extractVerdict(
  observation: ReleaseObservation,
  context: ObservationContext,
): ExtractVerdict {
  const usable = observationSatisfies(observation, {
    conditionType: context.conditionType,
    expectedCadastralCode: context.expectedCadastralCode,
    now: context.now,
    policy: context.policy,
  });
  if (!usable) {
    return 'insufficient';
  }
  if (observation.ownerCheck === 'insufficient') {
    // ⚠ [открыто] CORE.md Ф7: отдаёт ли выписка номер документа иностранного
    // собственника. До ответа — «оснований нет», а не «наверное совпало».
    return 'insufficient';
  }
  if (observation.ownerCheck === 'refuted') {
    return 'mismatched';
  }
  return allStatementFieldsMatch(observation.fields) ? 'matched' : 'mismatched';
}

/**
 * Первое разошедшееся поле — для события `mismatch_detected` у транша.
 *
 * Порядок тот же, в котором поля перечислены в `FUNCTIONAL.md` §3.5, и
 * собственник среди них: вердикт `refuted` — это расхождение по собственнику,
 * а не отдельная сущность.
 */
export function firstMismatchField(observation: ReleaseObservation): MismatchField {
  if (!observation.fields.cadastralCode) return 'cadastral_code';
  if (observation.ownerCheck !== 'established' || !observation.fields.ownerDocumentNumber) {
    return 'owner';
  }
  if (!observation.fields.share) return 'share';
  if (!observation.fields.basis) return 'basis';
  return 'encumbrance';
}

/* ------------------------------------------------------------------------- */
/* Намерения входа                                                           */
/* ------------------------------------------------------------------------- */

function entryIntents(
  to: ObservationStatus,
  event: ObservationEvent,
  context: ObservationContext,
): readonly ObservationIntent[] {
  switch (to) {
    case 'filing_claimed':
      return event.type === 'filing_claimed'
        ? [
            {
              type: 'register_filing',
              applicationId: event.applicationId,
              // Непроверенный источник: автооткрата он не запрещает (И3.2).
              source: 'party_claim',
            },
          ]
        : [];
    case 'filing_confirmed':
      return event.type === 'filing_card_observed'
        ? [
            {
              type: 'register_filing',
              applicationId: event.applicationId,
              source: 'application_card',
            },
            // Дешёвый сигнал управляет таймингом — и только им.
            { type: 'start_statutory_clock' },
          ]
        : [];
    case 'extract_due':
      return [
        { type: 'order_paid_extract', cadastralCode: context.expectedCadastralCode },
        // Возврат из недоступности — это и возобновление часов сделки.
        ...(event.type === 'registry_recovered'
          ? ([{ type: 'resume_deal_clock' }] as const)
          : []),
      ];
    case 'extract_ordered':
      return event.type === 'extract_ordered'
        ? [{ type: 'recognise_oracle_cost', amount: event.cost }]
        : [];
    case 'matched':
      return event.type === 'extract_received'
        ? [
            {
              type: 'emit_tranche_event',
              event: 'condition_established',
              conditionType: context.conditionType,
              observation: event.observation,
            },
          ]
        : [];
    case 'mismatched':
      return event.type === 'extract_received'
        ? [
            {
              type: 'emit_tranche_event',
              event: 'mismatch_detected',
              field: firstMismatchField(event.observation),
            },
            // Расхождение хотя бы по одному полю — стоп и человек при любой
            // сумме (FUNCTIONAL.md §3.5).
            { type: 'enqueue_operator_task', kind: 'field_mismatch' },
          ]
        : [];
    case 'insufficient':
      return [
        {
          type: 'enqueue_operator_task',
          kind:
            event.type === 'extract_received' &&
            event.observation.ownerCheck === 'insufficient'
              ? 'owner_reconciliation'
              : 'observation_insufficient',
        },
      ];
    case 'unavailable':
      return event.type === 'registry_unavailable'
        ? [{ type: 'suspend_deal_clock', reasonKey: event.reasonKey }]
        : [];
    default:
      return [];
  }
}

/* ------------------------------------------------------------------------- */
/* Редьюсер                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Редьюсер наблюдения: чистая функция состояния, события и контекста. Сети нет
 * ни в одном виде — байты приносит порт реестра, машина работает на событиях.
 */
export function reduceObservation(
  state: ObservationState,
  event: ObservationEvent,
  context: ObservationContext,
): Result<ObservationTransitionResult, ObservationRejection> {
  if (isTerminalObservationStatus(state.status)) {
    return failure(reject(ObservationRejectionCode.terminalState, { status: state.status }));
  }

  // Сверка кадастрового кода карточки с объектом сделки — обязательная часть
  // подтверждения подачи (И3.2). Отказ виден: подтверждения не случилось, и
  // молчание означало бы, что чужой номер просто ничего не сделал.
  if (
    event.type === 'filing_card_observed' &&
    event.cadastralCode !== context.expectedCadastralCode
  ) {
    return failure(
      reject(ObservationRejectionCode.cadastralCodeMismatch, {
        status: state.status,
        applicationId: event.applicationId,
      }),
    );
  }

  const verdict: ExtractVerdict | null =
    event.type === 'extract_received' ? extractVerdict(event.observation, context) : null;

  const candidate = OBSERVATION_TRANSITIONS.find(
    (item) => item.from === state.status && item.event === event.type && item.verdict === verdict,
  );
  if (candidate === undefined) {
    return failure(
      reject(ObservationRejectionCode.transitionNotAllowed, {
        status: state.status,
        event: event.type,
      }),
    );
  }

  return ok({
    state: Object.freeze({
      status: candidate.to,
      applicationId:
        event.type === 'filing_claimed' || event.type === 'filing_card_observed'
          ? event.applicationId
          : state.applicationId,
      // Статус карточки переносится в состояние и уходит в журнал. Ни одна
      // ветка выше его не прочитала — и это проверяется перебором, а не глазами.
      applicationStatus:
        event.type === 'filing_card_observed' ? event.applicationStatus : state.applicationStatus,
      observation: event.type === 'extract_received' ? event.observation : state.observation,
    }),
    intents: Object.freeze(entryIntents(candidate.to, event, context)),
  });
}
