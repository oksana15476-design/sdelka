import {
  type AuditChain,
  type AuditRecord,
  appendRecord,
  auditActor,
  auditInstant,
  auditRef,
  genesisChain,
} from '@sdelka/audit';
import {
  type Capability,
  type Session,
  ROLE_SPECS,
  UNKNOWN_CONTEXT,
  decideCapability,
  requireAuditRole,
  separationRulesFor,
  sessionStatus,
} from '@sdelka/auth';
import {
  type Instant,
  type ReleaseConditionType,
  type Result,
  failure,
  isReleaseConditionType,
  isUsableReleaseCondition,
  ok,
} from '@sdelka/domain';
import {
  type CurrencyCode,
  type Money,
  fromDecimalString,
  isCurrencyCode,
} from '@sdelka/money';
import { SYSTEM_ACTOR } from './authority';
import { auditRecordId } from './ids';
import { mintDealApplicationKey } from './keys';
import type { WriteOutcome } from './store';

/**
 * Заявка на сделку — **первая настоящая запись, которую оставляет клиент**.
 *
 * ## Почему заявка, а не сделка
 *
 * Сделку заводит оператор: полномочие `create_deal` выдано роли `operator` и
 * никому из клиентских ролей (`auth/src/roles.ts`), а `DESCRIPTION.md` §9
 * ставит между обращением клиента и сделкой проверку объекта по реестру. То
 * есть «покупатель завёл сделку» не выражается в этой системе вовсе — и это не
 * пробел, а устройство: сделка означает принятые обязательства, а клиент
 * обязательств платформе не назначает.
 *
 * Заявка — то, что клиент действительно делает: называет объект, сумму, вторую
 * сторону и тип условия и ждёт, пока оператор разберёт. До разбора это разговор,
 * а не обязательство.
 *
 * ## Чего здесь нет и почему
 *
 * **Мира.** Заявка не двигает ни минорной единицы, не заводит счёта, не создаёт
 * притязания. В `World` ей делать нечего: каждая новая сущность там — это ещё
 * одна вещь, которую обязаны проверять инварианты после каждого шага, и платить
 * эту цену за строку, которая деньгами не является, значит размывать смысл самих
 * инвариантов. Поэтому здесь нет ни `sealed`, ни `stepWorld`, ни единой правки
 * `flow.ts`, `world.ts`, `store.ts`.
 *
 * **Проводки.** По той же причине: движения денег нет, а проводка «на всякий
 * случай» — это запись о деньгах, которых никто не переводил.
 *
 * **Решения на транспорте.** Ни срока, ни порога, ни разбора причин отказа:
 * серверное действие собирает намерение из формы и отдаёт результат в адрес
 * (`ROAD-TO-SCREEN.md` §3.2 правило 1).
 *
 * ## Что здесь есть
 *
 * Узкий порт хранилища (снимок заявки, выборка по подавшему, очередь
 * неразобранных, вечный журнал), сценарий подачи, читающие сценарии и автомат
 * состояний заявки. Реализация порта на Postgres — соседний батч; формы, которые
 * она примет, объявлены ниже и меняться под неё не должны.
 */

/* ------------------------------------------------------------------------- */
/* Ключи причин                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Ключи локализации, а не текст: ни одной строки пользовательского текста в
 * коде, три языка (`CLAUDE.md`).
 *
 * **`refused` — один ключ на все причины, различимые снаружи.** Под ним живут
 * «сессия не годна» и «этой ролью заявку не подают». Разница между ними снаружи
 * — это ответ на вопрос «а есть ли за этой сессией сотрудник»: перебирающий
 * узнавал бы по разным ответам, чья учётная запись клиентская, а чья консольная,
 * не имея ни одной заявки. Внутри разница не теряется — она уходит в вечный
 * журнал (запись отказа во входе пишет `sign-in.ts`) и в отказ полномочия, куда
 * экран не смотрит.
 *
 * Ключи разбора формы (`objectCodeMalformed` и соседние) под это правило не
 * подпадают: они говорят подавшему о том, что он сам же и ввёл, и не сообщают о
 * существовании ни одной чужой сущности.
 */
export const DEAL_APPLICATION_KEYS = Object.freeze({
  /** Единый отказ: сессия не годна либо роль не клиентская. */
  refused: 'deal_application.refused',
  /** Кадастровый код не разбирается. Указано поле, а не причина отказа сделки. */
  objectCodeMalformed: 'deal_application.object_code_malformed',
  /** Валюта не из перечня (`@sdelka/money`). */
  currencyUnknown: 'deal_application.currency_unknown',
  /** Сумма не разбирается, не положительна либо с лишними знаками. */
  amountInvalid: 'deal_application.amount_invalid',
  /** Контакт второй стороны пуст либо длиннее допустимого. */
  counterpartyInvalid: 'deal_application.counterparty_invalid',
  /** Тип условия не из перечня либо им сегодня расчёт не устанавливается. */
  conditionUnavailable: 'deal_application.condition_unavailable',
  /** Очередь неразобранных: полномочия заводить сделки нет. */
  queueRefused: 'deal_application.queue_refused',
  /** Переход автомата: из терминального состояния выхода нет. */
  stateTerminal: 'deal_application.state_terminal',
  /** Переход автомата: событие в этом состоянии не определено. */
  stateEventNotApplicable: 'deal_application.state_event_not_applicable',
} as const);

export type DealApplicationReasonKey =
  (typeof DEAL_APPLICATION_KEYS)[keyof typeof DEAL_APPLICATION_KEYS];

/* ------------------------------------------------------------------------- */
/* Состояния заявки                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Состояния заявки. Заявка живёт ровно до тех пор, пока оператор её не разобрал.
 *
 * - `submitted` — подана, лежит в очереди;
 * - `in_review` — принята в работу: оператор её взял, объект и стороны проверяет
 *   он (`DESCRIPTION.md` §9, шаг 3);
 * - `rejected` — отклонена, **терминальное**;
 * - `converted` — превращена в сделку, **терминальное**; номер сделки назван.
 *
 * Терминальных два, и из них не ведёт ни одно событие: «отклонена» и
 * «превращена» — это записанные решения, а решение отменяется новым решением по
 * новой заявке, а не переписыванием старой (красная линия №11 по духу: то же
 * правило, что для журнала, здесь держится состоянием).
 */
export const DEAL_APPLICATION_STATES = [
  'submitted',
  'in_review',
  'rejected',
  'converted',
] as const;

export type DealApplicationState = (typeof DEAL_APPLICATION_STATES)[number];

/** Терминальные состояния. Выхода из них нет ни по одному событию. */
export const TERMINAL_DEAL_APPLICATION_STATES = Object.freeze<readonly DealApplicationState[]>([
  'rejected',
  'converted',
]);

export function isTerminalDealApplicationState(state: DealApplicationState): boolean {
  return TERMINAL_DEAL_APPLICATION_STATES.includes(state);
}

/**
 * События заявки.
 *
 * `converted` несёт номер сделки: заявка, объявленная превращённой без указания,
 * во что именно, через месяц не восстанавливается — а восстановить нужно будет
 * ровно её, потому что в ней лежат данные второй стороны, которые никто больше
 * не хранит.
 */
export type DealApplicationEvent =
  | { readonly type: 'taken_into_review' }
  | { readonly type: 'rejected'; readonly reasonKey: string }
  | { readonly type: 'converted'; readonly dealId: string };

/**
 * Переход автомата заявки — **чистая функция, отказ значением**.
 *
 * Правило, ради которого автомат вообще выписан: `converted` достижимо только из
 * `in_review`. Сделка заводится после того, как человек посмотрел на объект и на
 * стороны; путь «подана → сразу сделка» означал бы, что проверка объекта
 * необязательна, а её обязательность — это и есть §9 шаг 3.
 *
 * Обратное послабление сделано осознанно: `rejected` достижимо и из `submitted`.
 * Заявку, которую видно с первого взгляда, оператор отклоняет не беря в работу, и
 * заставлять его сначала «взять» её означало бы завести обязательный шаг ради
 * симметрии картинки.
 */
export function applyDealApplicationEvent(
  state: DealApplicationState,
  event: DealApplicationEvent,
): Result<DealApplicationState, DealApplicationReasonKey> {
  if (isTerminalDealApplicationState(state)) {
    return failure(DEAL_APPLICATION_KEYS.stateTerminal);
  }
  switch (event.type) {
    case 'taken_into_review':
      return state === 'submitted'
        ? ok('in_review')
        : failure(DEAL_APPLICATION_KEYS.stateEventNotApplicable);
    case 'rejected':
      return ok('rejected');
    case 'converted':
      return state === 'in_review'
        ? ok('converted')
        : failure(DEAL_APPLICATION_KEYS.stateEventNotApplicable);
  }
}

/* ------------------------------------------------------------------------- */
/* Сущность                                                                  */
/* ------------------------------------------------------------------------- */

/** Чем подавший будет в сделке: платит или получает (`FUNCTIONAL.md` §2.1). */
export type DealApplicationSide = 'payer' | 'recipient';

/**
 * Снимок заявки — то, что ложится в хранилище, и ровно то, что из него читается.
 *
 * Суммы целыми минорными единицами (`Money`, `bigint`): красная линия №4 держится
 * типом, а не договорённостью — плавающей точки здесь нет ни в одном поле.
 *
 * Персональные данные (кадастровый код объекта, контакт второй стороны) лежат
 * **здесь**, а не в вечном журнале: строку заявки можно выдать по законному
 * требованию и по нему же удалить, а запись журнала не редактируется никогда
 * (красная линия №11).
 */
export interface DealApplicationSnapshot {
  /** Номер = отчеканенный ключ идемпотентности (`keys.ts`). */
  readonly applicationId: string;
  /**
   * Кто подал. Ключ стороны — он же учётная запись: домен сверяет их как одно
   * значение (`authority.ts`, `requireSamePerson` сличает `accountId` с
   * `PartyRef.partyId`).
   */
  readonly applicant: string;
  readonly side: DealApplicationSide;
  readonly objectCadastralCode: string;
  readonly amount: Money<CurrencyCode>;
  /** Как связаться со второй стороной. Персональные данные — см. заголовок типа. */
  readonly counterpartyContact: string;
  readonly conditionType: ReleaseConditionType;
  readonly state: DealApplicationState;
  readonly submittedAt: Instant;
  /**
   * Подана при остановленном приёме (красная линия №3).
   *
   * ⚠ **[гипотеза]** Заявка при остановке **принимается**: она не сделка и не
   * обязательство, а остановка запрещает принимать новые обязательства, не
   * разговоры. Признак нужен, чтобы экран сказал об остановке прямо, а очередь
   * оператора такие заявки пометила — иначе оператор превратит заявку в сделку в
   * момент, когда сделки заводить нельзя, и упрётся в `assertIntakeOpen` уже
   * после разговора с клиентом.
   *
   * Решение владельца не получено. Обратный выбор — отклонять на входе — меняет
   * одну ветвь сценария (`submitDealApplication`, проверка приёма) и ни одной
   * строки устройства: признак останется, изменится ответ.
   */
  readonly submittedDuringHalt: boolean;
}

/**
 * Строка очереди оператора — **без контакта второй стороны**.
 *
 * Очередь просматривают, а не читают по одной: показывать в ней персональные
 * данные значит раздавать их каждым открытием списка. Просмотр самой заявки — это
 * отдельный шаг, и он обязан оставить запись `personal_data_viewed`
 * (`FUNCTIONAL.md` инвариант 24); такого шага в этом батче нет, поэтому нет и
 * контакта в проекции: выдать данные без записи о выдаче нельзя, а записать
 * нечем.
 */
export interface DealApplicationQueueItem {
  readonly applicationId: string;
  readonly applicant: string;
  readonly side: DealApplicationSide;
  readonly objectCadastralCode: string;
  readonly amount: Money<CurrencyCode>;
  readonly conditionType: ReleaseConditionType;
  readonly state: DealApplicationState;
  readonly submittedAt: Instant;
  readonly submittedDuringHalt: boolean;
}

/* ------------------------------------------------------------------------- */
/* Порт хранилища                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Узкий порт заявок.
 *
 * Узкий намеренно: `WorldStore` сюда не годится ни одной стороной — он про мир,
 * его снимки и его инварианты, а заявка мира не касается. Взять его целиком
 * значило бы связать сущность, которая деньгами не двигает, со всем, что двигает.
 *
 * Формы подобраны так, чтобы реализация на Postgres не потребовала их менять:
 *
 * - чтение по номеру и запись снимка идут **внутри одной транзакции** с записью
 *   вечного журнала (`readChain`/`appendAudit`), поэтому подача целиком ложится
 *   либо не ложится вовсе;
 * - `saveApplication` принимает «из какого состояния уходим» — тем же приёмом,
 *   что `saveTranche`/`savePayout` (`store.ts`): переход, сделанный из состояния,
 *   которого в базе уже нет, обязан упереться в конфликт, а не перезаписать чужое;
 * - `unhandledApplications` требует потолок **словом**: выборка без предела по
 *   растущей таблице — это страница, которая однажды перестанет открываться, и
 *   назвать предел обязан вызывающий, а не забыть его;
 * - `applicationsOf` отбирает по подавшему в самом хранилище, а не в памяти:
 *   отбор после чтения означал бы, что чужие строки всё-таки покидают базу.
 */
export interface DealApplicationTransaction {
  loadApplication(applicationId: string): Promise<DealApplicationSnapshot | null>;
  saveApplication(
    snapshot: DealApplicationSnapshot,
    previous: DealApplicationSnapshot | null,
  ): Promise<WriteOutcome>;
  applicationsOf(applicant: string): Promise<readonly DealApplicationSnapshot[]>;
  unhandledApplications(limit: number): Promise<readonly DealApplicationSnapshot[]>;
  /**
   * Цепочка вечного журнала. Пустой перечень записей — цепочка ещё не открыта, и
   * открыть её обязан первый же пишущий (`genesisChain`).
   */
  readChain(chainId: string): Promise<AuditChain>;
  appendAudit(records: readonly AuditRecord[]): Promise<WriteOutcome>;
}

export interface DealApplicationStore {
  transact<T>(body: (tx: DealApplicationTransaction) => Promise<T>): Promise<T>;
}

/**
 * Открыт ли приём новых сделок — портом, а не миром.
 *
 * Ответ знает `isIntakeOpen(world)` (`intake-halt.ts`), но мира у этого сценария
 * нет и быть не должно: восстановление мира — дорогая операция и не свойство
 * подачи заявки (`ROAD-TO-SCREEN.md` §3.2 правило 7). Поэтому вопрос задаётся
 * порту, а его боевая реализация — ровно вызов `isIntakeOpen` у того, кто мир
 * держит.
 *
 * Решение по ответу принимает **сценарий**, а не порт: порт отвечает «открыт или
 * нет» и ничего больше.
 */
export interface IntakeStatusPort {
  isOpen(): Promise<boolean>;
}

export interface DealApplicationDeps {
  readonly store: DealApplicationStore;
  readonly intake: IntakeStatusPort;
  /**
   * Цепочка вечного журнала для заявок.
   *
   * ⚠ **Не цепочка мира.** Номер записи в цепочке — это `World.seq`, счётчик
   * мира, и мир его ведёт сам; заявка, дописавшая запись в ту же цепочку, увела
   * бы номера, и следующий же шаг мира получил бы конфликт по `(chain_id, seq)`
   * на строке, которую он считает своей. Разные цепочки — разные счётчики.
   */
  readonly chainId: string;
  /** Момент берётся у среды один раз на шаг: свободный момент оживляет истёкшее. */
  now(): Instant;
}

/* ------------------------------------------------------------------------- */
/* Намерение                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Сумма как её ввёл человек: код валюты и десятичная строка.
 *
 * Числа с плавающей точкой сюда не попадают ни на одном шаге (красная линия
 * №4): строку разбирает `fromDecimalString` (`@sdelka/money`) целочисленно, и
 * лишние знаки после запятой он отвергает, а не округляет. Разбор живёт в
 * сценарии, а не на транспорте, потому что «сколько знаков у этой валюты» —
 * правило, а не форматирование.
 */
export interface DeclaredAmount {
  readonly currency: string;
  readonly decimal: string;
}

/**
 * Намерение подать заявку — ровно то, что собрано формой, и ни одного вывода.
 *
 * Кто подаёт, здесь не назван: подавший берётся **из сессии**. Поле «от чьего
 * имени» означало бы, что подать заявку от имени другого клиента может любой, у
 * кого есть своя сессия.
 */
export interface DealApplicationIntent {
  readonly side: DealApplicationSide;
  readonly objectCadastralCode: string;
  readonly amount: DeclaredAmount;
  readonly counterpartyContact: string;
  /** Строкой: тип приезжает из формы, а формы типов не переживают. */
  readonly conditionType: string;
}

export interface DealApplicationSubmitted {
  readonly applicationId: string;
  readonly state: DealApplicationState;
  /**
   * Заявка уже была — повтор формы, двойной клик, перезагрузка. Не отказ: тот же
   * исход, что и в первый раз, второй строки не появилось.
   */
  readonly repeated: boolean;
  /** Приём новых сделок приостановлен. См. `submittedDuringHalt`. */
  readonly intakeHalted: boolean;
}

/* ------------------------------------------------------------------------- */
/* Разбор намерения                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Кадастровый код: группы цифр через точку.
 *
 * ⚠ **[гипотеза]** Форма выведена из образца в засеве (`seed.ts`,
 * `01.14.05.021.041`), а не из первоисточника публичного реестра. Поэтому она
 * намеренно шире образца: от четырёх до восьми групп по одной-четырёх цифр.
 * Настоящая проверка объекта — внешний факт из реестра (красная линия №6), а не
 * это выражение; здесь отсеивается заведомый мусор, чтобы он не доехал до
 * оператора и до платного запроса.
 */
const CADASTRAL_PATTERN = /^\d{1,4}(?:\.\d{1,4}){3,7}$/u;

/** Потолок длины контакта. Форма контакта не проверяется: у неё три страны. */
const CONTACT_MAX_LENGTH = 256;

function parsedAmount(
  declared: DeclaredAmount,
): Result<Money<CurrencyCode>, DealApplicationReasonKey> {
  if (!isCurrencyCode(declared.currency)) {
    return failure(DEAL_APPLICATION_KEYS.currencyUnknown);
  }
  let amount: Money<CurrencyCode>;
  try {
    amount = fromDecimalString(declared.currency, declared.decimal.trim());
  } catch {
    // Отказ разбора наружу не пересказывается: в нём лежит введённое значение, а
    // ключ причины у всех разборов один и тот же по смыслу — «сумма не годится».
    return failure(DEAL_APPLICATION_KEYS.amountInvalid);
  }
  if (amount.minor <= 0n) {
    // Ноль и минус — не сумма сделки. Отдельного ключа им не нужно: подавший
    // видит своё же поле, а различать «ноль» и «минус» экрану незачем.
    return failure(DEAL_APPLICATION_KEYS.amountInvalid);
  }
  return ok(amount);
}

interface CheckedIntent {
  readonly side: DealApplicationSide;
  readonly objectCadastralCode: string;
  readonly amount: Money<CurrencyCode>;
  readonly counterpartyContact: string;
  readonly conditionType: ReleaseConditionType;
}

function checkedIntent(
  intent: DealApplicationIntent,
): Result<CheckedIntent, DealApplicationReasonKey> {
  const objectCadastralCode = intent.objectCadastralCode.trim();
  if (!CADASTRAL_PATTERN.test(objectCadastralCode)) {
    return failure(DEAL_APPLICATION_KEYS.objectCodeMalformed);
  }
  const amount = parsedAmount(intent.amount);
  if (!amount.ok) return failure(amount.error);
  const counterpartyContact = intent.counterpartyContact.trim();
  if (counterpartyContact.length === 0 || counterpartyContact.length > CONTACT_MAX_LENGTH) {
    return failure(DEAL_APPLICATION_KEYS.counterpartyInvalid);
  }
  if (!isReleaseConditionType(intent.conditionType)) {
    return failure(DEAL_APPLICATION_KEYS.conditionUnavailable);
  }
  /*
   * Тип условия обязан быть **работающим**, а не просто известным. Календарная
   * дата и предварительный договор в перечне есть, а установить по ним расчёт
   * сегодня нечем (`domain/src/release-condition.ts`): наблюдения нужного уровня
   * не производит никто. Принять заявку под таким условием значило бы обещать
   * человеку то, что не сработает, и узнал бы он об этом на выплате.
   */
  if (!isUsableReleaseCondition(intent.conditionType)) {
    return failure(DEAL_APPLICATION_KEYS.conditionUnavailable);
  }
  return ok({
    side: intent.side,
    objectCadastralCode,
    amount: amount.value,
    counterpartyContact,
    conditionType: intent.conditionType,
  });
}

/* ------------------------------------------------------------------------- */
/* Кто подаёт                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Может ли этой сессией подаваться заявка.
 *
 * Полномочия под подачу нет ни одного, и заводить его нельзя: перечень
 * `CAPABILITIES` построчно зеркалится таблицей `sdelka.role_capability`
 * (`packages/db`, `enums.test.ts`), то есть новое полномочие — это миграция, а не
 * строка здесь. Да и незачем: полномочия разводят тех, кто двигает чужие деньги,
 * а заявка не двигает ничего.
 *
 * Поэтому проверяются два условия, и оба существующим механизмом: сессия жива
 * (`sessionStatus` из `@sdelka/auth` — тот же, которым её проверяет
 * `decideCapability`) и роль клиентская (`ROLE_SPECS[...].audience`). Сотрудник
 * заявку не подаёт: он заводит сделку прямо, полномочием `create_deal`.
 */
function mayApply(session: Session, now: Instant): boolean {
  if (sessionStatus(session, now) !== 'active') return false;
  return ROLE_SPECS[session.roleId].audience === 'client';
}

/* ------------------------------------------------------------------------- */
/* Подача                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Состояние, из которого подача происходит. Не состояние заявки: заявки ещё нет.
 *
 * Стоит отдельным именем, чтобы читающий вечный журнал через год не гадал,
 * почему у первого перехода `from` не из перечня состояний.
 */
export const DEAL_APPLICATION_ABSENT = 'absent';

/**
 * Подать заявку на сделку.
 *
 * ## Что происходит
 *
 * Сессия и намерение проверяются, ключ чеканится из намерения и подавшего,
 * дальше — одна транзакция: если заявка с таким ключом уже есть, возвращается
 * она же; если нет, в базу ложатся **снимок и запись вечного журнала вместе**.
 *
 * ## Порядок проверок задан ценой ошибки
 *
 * Сначала «кто», потом «что». Разбор формы, выполненный до проверки сессии,
 * означал бы, что посторонний узнаёт по разным отказам, годится ли его
 * кадастровый код, — то есть получает бесплатный валидатор от чужого имени.
 *
 * ## Остановка приёма
 *
 * Спрашивается **до** записи и едет в снимок признаком. Заявка при остановке
 * принимается: см. `submittedDuringHalt` — там же названа цена и обратный выбор
 * (**[гипотеза]**, решение владельца не получено).
 *
 * ## Запись в вечный журнал — часть подачи, а не следствие
 *
 * Обе записи идут в одной транзакции, и порядок внутри не случаен: сначала
 * снимок, потом журнал — как в `writeDelta` (`store.ts`). Подача, записавшая
 * заявку и не записавшая журнал, невозможна: транзакция либо прошла целиком,
 * либо не прошла вовсе, и наружу тогда уходит отказ хранилища, а не результат.
 *
 * В журнал не попадает ни кадастровый код, ни контакт второй стороны: журнал не
 * редактируется, и персональные данные, попавшие в него, оттуда уже не убрать.
 * Связь записи с содержанием держится тем, что **номер заявки и есть образ её
 * содержания**: он отчеканен из намерения и подавшего (`keys.ts`), и предъявив
 * заявку, этот номер можно пересчитать.
 */
export async function submitDealApplication(
  deps: DealApplicationDeps,
  input: { readonly session: Session; readonly intent: DealApplicationIntent },
): Promise<Result<DealApplicationSubmitted, DealApplicationReasonKey>> {
  const now = deps.now();
  if (!mayApply(input.session, now)) {
    return failure(DEAL_APPLICATION_KEYS.refused);
  }
  const checked = checkedIntent(input.intent);
  if (!checked.ok) return failure(checked.error);
  const intent = checked.value;
  const applicant = input.session.accountId;

  /*
   * Ключ чеканится здесь — слоем сценариев, из намерения и подавшего. Ни
   * времени, ни счётчика: повтор формы обязан дать тот же ключ, иначе двойной
   * клик заводит вторую заявку с теми же персональными данными второй стороны.
   */
  const key = mintDealApplicationKey([
    applicant,
    intent.side,
    intent.objectCadastralCode,
    intent.amount.currency,
    intent.amount.minor.toString(),
    intent.conditionType,
    intent.counterpartyContact,
  ]);

  const intakeOpen = await deps.intake.isOpen();

  return deps.store.transact(async (tx) => {
    const existing = await tx.loadApplication(key.value);
    if (existing !== null) {
      /*
       * Повтор. Второй строки не появляется и второй записи в журнале — тоже:
       * запись о подаче уже есть, а дублирующая через год читалась бы как вторая
       * подача. Возвращается то же, что вернула первая попытка.
       */
      return ok({
        applicationId: existing.applicationId,
        state: existing.state,
        repeated: true,
        intakeHalted: existing.submittedDuringHalt,
      });
    }
    const snapshot: DealApplicationSnapshot = Object.freeze({
      applicationId: key.value,
      applicant,
      side: intent.side,
      objectCadastralCode: intent.objectCadastralCode,
      amount: intent.amount,
      counterpartyContact: intent.counterpartyContact,
      conditionType: intent.conditionType,
      state: 'submitted',
      submittedAt: now,
      submittedDuringHalt: !intakeOpen,
    });
    await tx.saveApplication(snapshot, null);
    await tx.appendAudit(await submissionRecords(tx, deps.chainId, snapshot, input.session, key));
    return ok({
      applicationId: snapshot.applicationId,
      state: snapshot.state,
      repeated: false,
      intakeHalted: snapshot.submittedDuringHalt,
    });
  });
}

/**
 * Записи вечного журнала о подаче: открытие цепочки, если её ещё нет, и переход.
 *
 * Цепочка открывается **системой**: заявка первого клиента не должна выглядеть
 * так, будто журнал завёл он. Ровно та же роль открывает цепочку мира
 * (`flow.ts`, `emptyWorld`).
 */
async function submissionRecords(
  tx: DealApplicationTransaction,
  chainId: string,
  snapshot: DealApplicationSnapshot,
  session: Session,
  key: ReturnType<typeof mintDealApplicationKey>,
): Promise<readonly AuditRecord[]> {
  const stored = await tx.readChain(chainId);
  const at = auditInstant(snapshot.submittedAt);
  const opened = stored.records.length === 0;
  const chain = opened ? genesisChain(chainId, at, SYSTEM_ACTOR) : stored;
  const last = chain.records[chain.records.length - 1];
  const seq = last === undefined ? 0 : last.seq + 1;
  const appended = appendRecord(chain, {
    recordId: auditRecordId(chainId, seq),
    recordedAt: at,
    /*
     * Полномочия у подачи нет вовсе (см. `mayApply`), поэтому третьим полем
     * стоит `null`. Подставить сюда похожее по смыслу полномочие значило бы
     * записать в нередактируемый журнал право, которого у роли нет.
     */
    actor: auditActor(session.accountId, requireAuditRole(session.roleId), null),
    /*
     * Предмет — документ, а не сделка: сделки ещё нет, и назвать её предметом
     * значило бы утверждать в вечном журнале, что она существует. Номер заявки
     * доказан чеканкой (`minted`), иначе примерно каждая тридцать вторая заявка
     * упёрлась бы в правило `digit_run` и записи бы не оставила.
     */
    subject: auditRef('document', snapshot.applicationId),
    related: [],
    body: {
      kind: 'state_transition',
      machine: 'deal_application',
      from: DEAL_APPLICATION_ABSENT,
      to: snapshot.state,
      // Остановка приёма попадает в журнал ключом события, а не в
      // `failedGuards`: заявка принята, ни один guard не отказал, и списывать
      // остановку в нарушения значило бы прочитать через год «подача не
      // прошла».
      eventKey: snapshot.submittedDuringHalt
        ? 'deal_application.submitted_during_halt'
        : 'deal_application.submitted',
      failedGuards: [],
    },
    minted: [key.minted],
  });
  // Дописанное этим шагом: генезис (если открывали) и сам переход. Уже лежащие в
  // базе записи повторно не отправляются — журнал только дополняется.
  return opened ? appended.records : appended.records.slice(stored.records.length);
}

/* ------------------------------------------------------------------------- */
/* Чтение                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Заявки подавшего — **только свои**.
 *
 * Отбор идёт по учётной записи из сессии и в самом хранилище: параметра «чьи
 * читать» нет и быть не должно — он и есть перечислитель чужих заявок. Чужая
 * заявка для этого сценария не существует: она не отличается от отсутствующей ни
 * ответом, ни отказом, потому что до отказа дело не доходит вовсе.
 */
export async function readDealApplications(
  deps: DealApplicationDeps,
  input: { readonly session: Session },
): Promise<Result<readonly DealApplicationSnapshot[], DealApplicationReasonKey>> {
  const now = deps.now();
  if (!mayApply(input.session, now)) {
    return failure(DEAL_APPLICATION_KEYS.refused);
  }
  const applicant = input.session.accountId;
  const mine = await deps.store.transact((tx) => tx.applicationsOf(applicant));
  /*
   * Второй рубеж к отбору хранилища. Порт объявлен нами, реализаций у него две и
   * будет больше; «отдал не то» у реализации, отбирающей по чужому полю, здесь
   * превращается в пустой ответ, а не в утечку.
   */
  return ok(Object.freeze(mine.filter((item) => item.applicant === applicant)));
}

/** Полномочие, под которым разбирают очередь. См. `readDealApplicationQueue`. */
const QUEUE_CAPABILITY: Capability = 'create_deal';

/**
 * Очередь неразобранных заявок.
 *
 * Полномочие — `create_deal`, и это не «похожее по смыслу»: очередь существует
 * ровно затем, чтобы заявка превратилась в сделку, а завести сделку может только
 * тот, кому это право выдано (`auth/src/roles.ts` — сегодня один оператор).
 * Отдельного права на чтение очереди заводить нельзя: перечень полномочий
 * зеркалится базой.
 *
 * Факты разделения обязанностей берутся как **неизвестные** (`UNKNOWN_CONTEXT`),
 * и это безопасно ровно потому, что у `create_deal` несовместимостей нет ни
 * одной; проверяется это здесь же и в рантайме — если завтра они появятся,
 * сценарий остановится, а не проверит их по пустым фактам.
 */
export async function readDealApplicationQueue(
  deps: DealApplicationDeps,
  input: { readonly session: Session; readonly limit: number },
): Promise<Result<readonly DealApplicationQueueItem[], DealApplicationReasonKey>> {
  if (separationRulesFor(QUEUE_CAPABILITY).length > 0) {
    // Несовместимость появилась, а фактов о предмете у очереди нет: проверять её
    // нечем, и молча пройти мимо нельзя.
    throw new Error('app.deal_application.queue_separation_unchecked');
  }
  const decided = decideCapability({
    session: input.session,
    capability: QUEUE_CAPABILITY,
    now: deps.now(),
    context: UNKNOWN_CONTEXT,
  });
  if (!decided.ok) return failure(DEAL_APPLICATION_KEYS.queueRefused);
  const items = await deps.store.transact((tx) => tx.unhandledApplications(input.limit));
  return ok(
    Object.freeze(
      items
        .filter((item) => !isTerminalDealApplicationState(item.state))
        .map((item) => queueItemOf(item)),
    ),
  );
}

/** Проекция очереди: всё, кроме контакта второй стороны. См. `DealApplicationQueueItem`. */
function queueItemOf(snapshot: DealApplicationSnapshot): DealApplicationQueueItem {
  return Object.freeze({
    applicationId: snapshot.applicationId,
    applicant: snapshot.applicant,
    side: snapshot.side,
    objectCadastralCode: snapshot.objectCadastralCode,
    amount: snapshot.amount,
    conditionType: snapshot.conditionType,
    state: snapshot.state,
    submittedAt: snapshot.submittedAt,
    submittedDuringHalt: snapshot.submittedDuringHalt,
  });
}
