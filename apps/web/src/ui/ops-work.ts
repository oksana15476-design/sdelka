import type { DeadlineView, OpsTask, TaskType } from '@/fixtures/store';

/**
 * День оператора, выраженный значениями.
 *
 * Консоль была собрана вокруг сущностей: «решение о выплате», «сверка»,
 * «заморозка» — три раздела в боковой панели, каждый со своей единственной
 * сделкой внутри. Человек в такой навигации ищет работу сам и не видит, что из
 * неё вообще требует его сейчас (`CABINETS.md` §5.1: «главный экран — не все
 * сделки, а что требует меня сейчас»).
 *
 * Здесь описано ровно то, что нужно, чтобы собрать одну очередь и одну карточку
 * задачи: **чего ждёт задача**, **насколько она горит**, **какие у неё исходы**,
 * **чем исход подтверждается** и **кто её закрывает**. Правил перехода тут нет
 * ни одного — это проекция, как `view/money-state.ts`: состояния считает домен,
 * задачи собирает `fixtures/store.ts`, а здесь только ответ на вопрос «как это
 * положить на стол человеку».
 *
 * Всё, что ниже, взято из кода поимённо; места, где кода нет, помечены
 * `[открыто]` и разрешены в сторону строгого варианта.
 */

/* ------------------------------------------------------ чего ждёт задача */

/**
 * Две разные вещи, которые очередь обязана держать порознь.
 *
 * `human` — задача ждёт решения человека, и пока он не решит, ничего не
 * произойдёт. `external` — задача ждёт **внешнего факта**: ответа реестра или
 * банковской выписки. Человек по ней нужен, но **после** факта, а не сейчас; до
 * факта решать нечего, и показывать её как «ваш ход» — врать оператору.
 *
 * Разделение не выдумано: `STATE-MACHINES.md` §5 гарантирует выход из
 * `paying_out`/`refunding` «ответом провайдера или сверкой» и называет
 * `release_blocked` единственным состоянием, выход из которого зависит от
 * человека. Из `unknown` в `submitted` перехода нет вовсе
 * (`packages/domain/src/payout.ts:54`): выход только через сверку выписки.
 */
export type WaitingOn = 'human' | 'external';

/**
 * Какого внешнего факта ждёт задача. Ключ подписи, а не тон: оператору важно
 * знать, что именно должно прийти и откуда.
 */
export type ExternalFact = 'registry' | 'statement';

const EXTERNAL: Readonly<Partial<Record<TaskType, ExternalFact>>> = Object.freeze({
  /* `M-10 submitted`: заявление в реестре подано, ждём карточку и выписку —
     `packages/oracle/src/machine.ts:36` (`awaiting_filing … extract_ordered`). */
  confirmRegistration: 'registry',
  /* `M-13 payoutUnknown`: ответа банка нет. Повтор поручения запрещён, выход —
     ежедневная сверка (`packages/domain/src/payout.ts:66`). */
  reviewBreak: 'statement',
});

export function externalFactOf(type: TaskType): ExternalFact | null {
  return EXTERNAL[type] ?? null;
}

export function waitingOn(type: TaskType): WaitingOn {
  return externalFactOf(type) === null ? 'human' : 'external';
}

/* ------------------------------------------------------------------ сроки */

/**
 * Насколько задача горит. Четыре значения, а не два: «часы остановлены» — это не
 * «времени много», а «времени не считают вовсе», и у замороженного транша
 * дедлайна в домене физически нет (`packages/domain/src/tranche.ts:299`).
 */
export type Urgency = 'overdue' | 'soon' | 'later' | 'paused';

/**
 * Порог «скоро» — четыре часа.
 *
 * Взят из самого короткого порога эскалации в коде: `release_pending` и
 * `release_blocked` в `DEFAULT_ESCALATION_POLICY`
 * (`packages/domain/src/tranche.ts:286`). Норматив дежурного документом не
 * задан — там же стоит `[открыто]`; до ответа берётся самый строгий из
 * существующих порогов, а не среднее по таблице.
 */
export const SOON_MS = 4 * 60 * 60 * 1000;

export function urgencyOf(deadline: DeadlineView | null, now: number): Urgency {
  if (deadline === null) return 'later';
  if (deadline.at === null) return 'paused';
  const left = deadline.at - now;
  if (left <= 0) return 'overdue';
  return left <= SOON_MS ? 'soon' : 'later';
}

/* ------------------------------------------------------------ группировка */

export interface QueueGroups {
  /** Ждут решения человека и не заняты никем. */
  readonly forHuman: readonly OpsTask[];
  /** Ждут внешнего факта: реестра или выписки. Человек нужен после. */
  readonly forFact: readonly OpsTask[];
  /** Взяты другим сотрудником: двое за одну задачу не берутся. */
  readonly claimed: readonly OpsTask[];
}

/**
 * Раскладка очереди по трём полкам. Порядок внутри полки не трогается: его уже
 * посчитал `getOpsQueue` — сначала срок, потом сумма (`CABINETS.md` §5.1,
 * «оператор не должен искать работу» и не должен настраивать сортировку).
 */
export function groupQueue(tasks: readonly OpsTask[]): QueueGroups {
  const forHuman: OpsTask[] = [];
  const forFact: OpsTask[] = [];
  const claimed: OpsTask[] = [];
  for (const task of tasks) {
    if (task.claimedBy !== null) {
      claimed.push(task);
      continue;
    }
    (waitingOn(task.type) === 'human' ? forHuman : forFact).push(task);
  }
  return Object.freeze({
    forHuman: Object.freeze(forHuman),
    forFact: Object.freeze(forFact),
    claimed: Object.freeze(claimed),
  });
}

/* -------------------------------------------------------------- исходы */

/**
 * Закрытый перечень исходов задачи — **префиксы ключей**, а не тексты.
 *
 * Каждый перечень взят из кода, и ни один не придуман:
 *
 * · `approvePayout` — `release_pending` выходит утверждением либо
 *   `operator_blocked` в `release_blocked` (`packages/domain/src/tranche.ts:473`).
 *   Третьего ребра у состояния нет, значит и третьей карточки быть не может.
 * · `reviewBreak` — два ребра выплаты из `unknown`:
 *   `reconciliation_found_in_statement → settled` и
 *   `reconciliation_absent_from_statement → rejected`
 *   (`packages/domain/src/payout.ts:66`).
 * · `reviewSanction` — три цели разморозки `UNFREEZE_TARGETS`
 *   (`packages/domain/src/freeze.ts:44`); ключи переиспользуются те же, что на
 *   прежнем экране снятия приостановки.
 * · `matchPayment` — деньги на `suspense:unidentified` уходят либо к сделке
 *   ручным сопоставлением (`packages/intake/src/manual-match.ts:104`), либо
 *   отправителю; зачисление по догадке запрещено (`INTAKE_ROUTES`,
 *   `packages/intake/src/route.ts:21`).
 * · `releaseBlock` — платёж третьего лица: зачислить с обоснованием либо вернуть
 *   отправителю на счёт-источник (ключ `ops.money.heldThirdParty.note`, текст
 *   прошёл главреда).
 * · `confirmRegistration` — ручное подтверждение с обязательным приложением
 *   документа либо запись расхождения (`CABINETS.md` §5.2; виды задач наблюдения
 *   `packages/oracle/src/machine.ts:89`).
 * · `verifyClient`, `reviewSof` — лестница исходов детекторов `DETECTOR_OUTCOMES`
 *   (`packages/compliance/src/decision.ts:87`). Какие ступени этой лестницы
 *   человек вправе выбрать по каждому из двух видов задач, документом не
 *   установлено — `[открыто]`; поэтому показана лестница целиком, а не её
 *   усечение по нашему выбору.
 */
const OUTCOMES: Readonly<Record<TaskType, readonly string[]>> = Object.freeze({
  approvePayout: Object.freeze(['ops.outcome.approvePayout', 'ops.outcome.blockRelease']),
  reviewBreak: Object.freeze(['ops.outcome.foundInStatement', 'ops.outcome.absentFromStatement']),
  reviewSanction: Object.freeze([
    'ops.unfreeze.target.suspended_from',
    'ops.unfreeze.target.refund_pending',
    'ops.unfreeze.target.release_blocked',
  ]),
  matchPayment: Object.freeze(['ops.outcome.matchToDeal', 'ops.outcome.returnToSender']),
  releaseBlock: Object.freeze(['ops.outcome.creditWithJustification', 'ops.outcome.returnToSender']),
  confirmRegistration: Object.freeze([
    'ops.outcome.confirmWithDocument',
    'ops.outcome.recordMismatch',
  ]),
  verifyClient: Object.freeze([
    'ops.outcome.clear',
    'ops.outcome.review',
    'ops.outcome.stop',
    'ops.outcome.hold',
    'ops.outcome.block',
  ]),
  reviewSof: Object.freeze([
    'ops.outcome.clear',
    'ops.outcome.review',
    'ops.outcome.stop',
    'ops.outcome.hold',
    'ops.outcome.block',
  ]),
});

export function outcomesOf(type: TaskType): readonly string[] {
  return OUTCOMES[type];
}

/* ---------------------------------------------- чем решение подтверждается */

/**
 * Виды доказательств — `EVIDENCE_KINDS` (`packages/compliance/src/decision.ts:25`),
 * буква в букву. Пакет `@sdelka/compliance` в зависимостях приложения не
 * значится, поэтому перечень здесь повторён строками; расхождение поймает не
 * компилятор, а человек — это названо в отчёте.
 */
export type EvidenceKind =
  | 'identity_document'
  | 'kinship_document'
  | 'ownership_document'
  | 'contract'
  | 'registry_extract'
  | 'bank_statement'
  | 'screening_response'
  | 'test_transfer'
  | 'operator_note';

/**
 * Чем подтверждается решение по каждому виду задачи.
 *
 * ⚠ `[открыто]`. Соответствие «вид задачи → допустимые доказательства» ни одним
 * документом не задано. Здесь оно выведено из того, чем задача вообще
 * порождена (выписка банка у сверки, выписка реестра у регистрации, ответ
 * скрининга у санкционного хита), и годится как подсказка, а не как правило.
 * Обязательным во всех случаях остаётся другое, и оно из кода: у решения есть
 * версия политики, причины и доказательства (`Decision`,
 * `packages/compliance/src/decision.ts:48`), у ручного сопоставления
 * обязательна ссылка на основание (`justificationRef`,
 * `packages/intake/src/manual-match.ts:126`), а откат без единого основания
 * журнал не принимает по типу (`packages/app/src/unwind.ts:115`).
 */
const EVIDENCE: Readonly<Record<TaskType, readonly EvidenceKind[]>> = Object.freeze({
  approvePayout: Object.freeze(['registry_extract', 'contract'] as const),
  reviewBreak: Object.freeze(['bank_statement'] as const),
  reviewSanction: Object.freeze(['screening_response', 'operator_note'] as const),
  matchPayment: Object.freeze(['bank_statement', 'operator_note'] as const),
  releaseBlock: Object.freeze(['bank_statement', 'kinship_document'] as const),
  confirmRegistration: Object.freeze(['registry_extract'] as const),
  verifyClient: Object.freeze(['identity_document', 'test_transfer'] as const),
  reviewSof: Object.freeze(['bank_statement', 'ownership_document'] as const),
});

export function evidenceOf(type: TaskType): readonly EvidenceKind[] {
  return EVIDENCE[type];
}

/* ------------------------------------------------------- кто закрывает */

/**
 * Правило закрытия задачи. Не «сколько подписей», а **какое правило действует**:
 * «второго не требуется» и «второй требуется и не найден» — разные вещи, и
 * подменять первое нулём запрещено (`packages/intake/src/manual-match.ts:52`).
 *
 * · `quorum` — уровень 1 и уровень 2, две разные роли и две разные учётные
 *   записи, ни одна из них не готовила операцию (`packages/auth/src/approval.ts:35`
 *   и `evaluateQuorum` там же). Уровней ровно два, третьей подписи взять неоткуда.
 * · `dualControl` — двое разных сотрудников, автор расхождения не снимает его
 *   сам (Н5, `packages/auth/src/separation.ts:34`).
 * · `thresholdSecond` — второй нужен, если сумма выше порога
 *   (`packages/intake/src/manual-match.ts:40`); ниже порога правила нет вовсе.
 * · `singleWithRecord` — закрывает один человек, но решение хранит версию
 *   политики, причины и доказательства.
 */
export type ClosingRule = 'quorum' | 'dualControl' | 'thresholdSecond' | 'singleWithRecord';

const CLOSING: Readonly<Record<TaskType, ClosingRule>> = Object.freeze({
  approvePayout: 'quorum',
  reviewSanction: 'dualControl',
  releaseBlock: 'dualControl',
  reviewBreak: 'dualControl',
  matchPayment: 'thresholdSecond',
  confirmRegistration: 'singleWithRecord',
  verifyClient: 'singleWithRecord',
  reviewSof: 'singleWithRecord',
});

export function closingRuleOf(type: TaskType): ClosingRule {
  return CLOSING[type];
}

/* ------------------------------------------------------------- маршруты */

/** Адрес карточки задачи. Единственный путь к работе — из очереди. */
export function taskHref(locale: string, taskId: string): string {
  return `/${locale}/ops/task/${taskId}`;
}

/**
 * Разбор, у которого в этом слое есть данные. У остальных видов задач тела
 * разбора нет, и карточка честно показывает это отдельным состоянием, а не
 * пустым местом: пустое место читается как «данных нет вообще».
 */
export type DetailKind = 'decision' | 'break' | 'unfreeze' | 'none';

const DETAIL: Readonly<Record<TaskType, DetailKind>> = Object.freeze({
  approvePayout: 'decision',
  reviewBreak: 'break',
  reviewSanction: 'unfreeze',
  matchPayment: 'none',
  releaseBlock: 'none',
  confirmRegistration: 'none',
  verifyClient: 'none',
  reviewSof: 'none',
});

export function detailKindOf(type: TaskType): DetailKind {
  return DETAIL[type];
}
