import { type DurationMs, type Instant, DAY } from './instant';
import {
  type ReleaseConditionType,
  RELEASE_CONDITIONS,
  isReleaseConditionType,
} from './release-condition';
import { DomainError, RejectionCode } from './result';

/**
 * Наблюдение оракула — `CORE.md` Ф7, `ORACLE.md`.
 *
 * **Принцип: дешёвые сигналы управляют таймингом, дорогие — деньгами.**
 * Бесплатная карточка заявления запускает отсчёт, платная выписка подтверждает
 * деньги. Разница между ними выражена **уровнем доверия**, а не булевым
 * «подтверждено»: булево не различает «мы видели карточку» и «мы держим
 * выписку», а от этой разницы зависит вся сумма сделки.
 *
 * Модуль чистый: ни сети, ни времени, ни зависимостей от `@sdelka/audit` и
 * `@sdelka/compliance` — их в `package.json` домена нет и появляться им незачем.
 * Добывание наблюдения (подача, регламентный срок, заказ выписки, недоступность
 * реестра) живёт в `@sdelka/oracle`, байты — за портом реестра.
 */

/**
 * Лестница уровней доверия — `ORACLE.md` §2, `CTO-architecture.md`.
 *
 * Перечень закрытый ровно по той же причине, по которой закрыт тип условия
 * (`STATE-MACHINES.md` §8): добавление уровня обязано ломать компиляцию во всех
 * местах разбора, а не растворяться в конфигурации.
 *
 * Взято надмножество трёх документов: `PRODUCT.md` §9 давал `L1/L3/L4/L5`,
 * `CTO-architecture.md` — `L0…L5`, `STATE-MACHINES.md` §8 — «L3+» словом в
 * столбце источника, нигде уровень не определяя. Пропуск `L0` и `L2` означал бы,
 * что «сторона сказала» и «оператор посмотрел через капчу» ложатся на один
 * уровень с независимо полученной карточкой заявления, а они дают разное.
 */
export const OBSERVATION_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const;

export type ObservationLevel = (typeof OBSERVATION_LEVELS)[number];

/**
 * Ранг уровня — **явная таблица, а не сравнение строк**.
 *
 * `'L3' <= 'L4'` сегодня истинно случайно: лексикографический порядок совпадает
 * с порядком доверия, пока уровней меньше десяти, и ломается на первом же
 * двузначном (`'L10' < 'L3'`). Правило, которое держится на том, что значений
 * мало, — не правило.
 */
export const OBSERVATION_LEVEL_RANK: Readonly<Record<ObservationLevel, number>> = Object.freeze({
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
});

export function isObservationLevel(value: string): value is ObservationLevel {
  return (OBSERVATION_LEVELS as readonly string[]).includes(value);
}

/**
 * Вердикт по собственнику — зеркало `OWNER_RECONCILIATION_OUTCOMES` из
 * `packages/compliance` (`reconcileOwner`). Значения совпадают буква в букву;
 * равенство двух перечней проверяется сверкой в сквозных тестах, а не
 * зависимостью: домен от комплаенса не зависит (`package.json`).
 *
 * ⚠ **`insufficient` — не «почти established».** Выписка не отдала номер
 * документа собственника (открытый вопрос `CORE.md` Ф7 по иностранцам), и до
 * ответа реестра это читается как «оснований нет», а не «наверное совпало».
 * Guard `g_owner_is_buyer` роняется им ровно так же, как `refuted`;
 * различаются они ключом причины и видом задачи оператора, но не разрешением.
 */
export const OWNER_CHECKS = ['established', 'refuted', 'insufficient'] as const;

export type OwnerCheck = (typeof OWNER_CHECKS)[number];

export function isOwnerCheck(value: string): value is OwnerCheck {
  return (OWNER_CHECKS as readonly string[]).includes(value);
}

/**
 * Откуда известно о подаче заявления — `ROADMAP.md` И3.2, `ORACLE.md` §9.
 *
 * **Источник факта — атрибут события, а не флаг.** Разница между «сторона
 * назвала номер» и «мы сами увидели карточку заявления» — это разница между
 * тем, управляет ли сторона нашим дедлайном. Названный стороной номер помечен
 * непроверенным и **сам по себе автооткрата не запрещает** (И3.2, критерий 1);
 * подтверждённый карточкой — запрещает, и это записано с указанием источника
 * (критерий 2).
 */
export const FILING_SOURCES = ['party_claim', 'application_card'] as const;

export type FilingSource = (typeof FILING_SOURCES)[number];

export function isFilingSource(value: string): value is FilingSource {
  return (FILING_SOURCES as readonly string[]).includes(value);
}

/**
 * Пять полей выписки из `FUNCTIONAL.md` §3.5. Проверяются **поимённо**, а не
 * счётчиком: «сошлось четыре из пяти» — не результат, а расхождение.
 *
 * Тип живёт здесь, а не рядом с guard'ами: поля — часть наблюдения, и отдельно
 * от документа они не существуют (`ORACLE.md` §4).
 */
export interface StatementFields {
  readonly cadastralCode: boolean;
  /** Собственник сверяется по номеру документа, не по имени: латинизация необратима. */
  readonly ownerDocumentNumber: boolean;
  readonly share: boolean;
  readonly basis: boolean;
  readonly noUnexpectedEncumbrances: boolean;
}

export function allStatementFieldsMatch(fields: StatementFields): boolean {
  return (
    fields.cadastralCode &&
    fields.ownerDocumentNumber &&
    fields.share &&
    fields.basis &&
    fields.noUnexpectedEncumbrances
  );
}

/**
 * Наблюдение, на которое опирается расчёт.
 *
 * **Одно значение, а не набор соседних полей в фактах.** До E3-1 факты транша
 * несли пять булевых полей выписки и одно булево «собственник — покупатель»
 * порознь и **без документа**: фикстура интерфейса законно клала пять `true`,
 * не имея за ними ни одной выписки, и тип это разрешал. Один документ — один
 * вердикт: наблюдения нет — вердикта нет, и подделать его «забыв сбросить
 * булево» больше нечем.
 */
export interface ReleaseObservation {
  readonly level: ObservationLevel;
  /** О каком типе условия наблюдение. Сверяется с актом получателя, а не с фактами. */
  readonly conditionType: ReleaseConditionType;
  /** Чем установлено: ключ источника из `RELEASE_CONDITIONS`, а не название. */
  readonly sourceKey: string;
  /** Объект, о котором наблюдение. Сверяется с объектом сделки. */
  readonly cadastralCode: string;
  readonly fields: StatementFields;
  readonly ownerCheck: OwnerCheck;
  readonly observedAt: Instant;
  /**
   * Отпечаток сырого ответа источника — SHA-256, 64 hex.
   *
   * Обязателен **по типу**: `CORE.md` Ф11 — «разобранные поля без исходника суд
   * не убедит». Требование, выраженное типом, невозможно забыть; требование,
   * выраженное инструкцией к вызывающему, забывается на третьем адаптере.
   *
   * Строка, а не `Sha256Hex` из `@sdelka/audit`: домен от журнала не зависит и
   * зависеть не должен. Форма проверяется здесь же конструктором, а сведение
   * отпечатка с байтами — `verifyRawSource` на стороне журнала.
   */
  readonly rawSourceDigest: string;
}

export interface ReleaseObservationInput {
  readonly level: ObservationLevel;
  readonly conditionType: ReleaseConditionType;
  readonly sourceKey: string;
  readonly cadastralCode: string;
  readonly fields: StatementFields;
  readonly ownerCheck: OwnerCheck;
  readonly observedAt: Instant;
  readonly rawSourceDigest: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * Конструктор наблюдения. Проверки в рантайме, а не только по типам:
 * наблюдение приходит из базы и от адаптера реестра, а типы границу процесса не
 * переживают.
 *
 * Исключение, а не `Rejection`: собрать наблюдение без отпечатка сырого ответа —
 * ошибка вызывающего, а не решение автомата, и продолжать с таким значением
 * нельзя (Ф11).
 */
export function releaseObservation(input: ReleaseObservationInput): ReleaseObservation {
  if (!isObservationLevel(input.level)) {
    throw new DomainError(RejectionCode.observationInvalid, 'level');
  }
  if (!isReleaseConditionType(input.conditionType)) {
    throw new DomainError(RejectionCode.observationInvalid, 'conditionType');
  }
  if (!isOwnerCheck(input.ownerCheck)) {
    throw new DomainError(RejectionCode.observationInvalid, 'ownerCheck');
  }
  if (input.sourceKey.length === 0) {
    throw new DomainError(RejectionCode.observationInvalid, 'sourceKey');
  }
  if (input.cadastralCode.length === 0) {
    throw new DomainError(RejectionCode.observationInvalid, 'cadastralCode');
  }
  if (!SHA256_HEX.test(input.rawSourceDigest)) {
    throw new DomainError(RejectionCode.observationInvalid, 'rawSourceDigest');
  }
  return Object.freeze({
    level: input.level,
    conditionType: input.conditionType,
    sourceKey: input.sourceKey,
    cadastralCode: input.cadastralCode,
    fields: Object.freeze({ ...input.fields }),
    ownerCheck: input.ownerCheck,
    observedAt: input.observedAt,
    rawSourceDigest: input.rawSourceDigest,
  });
}

export interface ObservationRequirement {
  /** Ключ источника: тот же, что у типа условия в `RELEASE_CONDITIONS`. */
  readonly sourceKey: string;
  readonly minLevel: ObservationLevel;
}

function requirement(
  conditionType: ReleaseConditionType,
  minLevel: ObservationLevel,
): ObservationRequirement {
  // Источник берётся из перечня типов условия, а не переписывается сюда
  // строкой: два места, где записано «чем устанавливается этот факт», однажды
  // разъедутся, и разъедутся молча.
  return Object.freeze({ sourceKey: RELEASE_CONDITIONS[conditionType].sourceKey, minLevel });
}

/**
 * Что требуется от наблюдения по типу условия — `ORACLE.md` §6.1.
 *
 * Одна таблица, **без исключений**. У `calendar_date` требование такое же, как у
 * регистрации, и это не перестраховка: `CORE.md` Ф11 — «собственное время
 * оспоримо, нужна метка от независимого поставщика», порт `TimestampPort` в
 * `packages/audit` для этого уже объявлен. Исключение — это дверь без guard'а.
 *
 * `registration_preliminary` строку тоже имеет, хотя до неё не доходит: акт с
 * этим типом отвергается раньше (`isUsableReleaseCondition`, §8 помечен
 * **[открыто]**). Отсутствие строки означало бы, что при подтверждении типа
 * требование придётся сочинять в тот же момент.
 */
export const OBSERVATION_REQUIREMENTS: Readonly<
  Record<ReleaseConditionType, ObservationRequirement>
> = Object.freeze({
  registration_transfer: requirement('registration_transfer', 'L3'),
  registration_preliminary: requirement('registration_preliminary', 'L3'),
  calendar_date: requirement('calendar_date', 'L3'),
});

/**
 * Политика наблюдения. Отдельное значение, а не константа модуля: `CORE.md` Ф11
 * требует, чтобы решение хранило версию политики, действовавшую в момент
 * принятия, — а константу модуля в запись решения не положишь.
 */
export interface ObservationPolicy {
  /** Предельный возраст наблюдения. */
  readonly maxAge: DurationMs;
}

/**
 * Свежесть выписки не задана ни одним документом.
 *
 * **[установлено, `JUSTICE-API.md` §3.1]** Выписка отражает данные «на момент
 * подготовки» (ст. 10(1) закона): выписка трёхнедельной давности о сегодняшнем
 * отсутствии обременений не утверждает ничего.
 *
 * ⚠ **[открыто] владельцу — само значение** (`ORACLE.md` §6.3, §15). Здесь
 * рабочее умолчание в сутки, а не норма: отказ при этом закрытый, то есть при
 * сомнении система ведёт себя строго, а не «примерно».
 */
export const DEFAULT_OBSERVATION_POLICY: ObservationPolicy = Object.freeze({ maxAge: DAY });

/** Достаточен ли уровень наблюдения для типа условия. Сравнение по рангу, не по строке. */
export function observationLevelAtLeast(
  level: ObservationLevel,
  minimum: ObservationLevel,
): boolean {
  return OBSERVATION_LEVEL_RANK[level] >= OBSERVATION_LEVEL_RANK[minimum];
}

export interface ObservationCheck {
  /** Тип условия, о котором спрашивают: он берётся из акта получателя, а не из наблюдения. */
  readonly conditionType: ReleaseConditionType;
  /** Кадастровый код объекта сделки. */
  readonly expectedCadastralCode: string;
  readonly now: Instant;
  readonly policy: ObservationPolicy;
}

/**
 * Годится ли наблюдение как основание для движения денег — `ORACLE.md` §6.
 *
 * Пять проверок, и ни одна не про содержание выписки: содержание проверяют
 * `g_fields_match` и `g_owner_is_buyer` отдельно и поимённо (§7
 * `STATE-MACHINES.md`: склеенное правило невозможно проверить по частям).
 * Здесь — только про сам документ: он есть, он о том же условии, он от нужного
 * источника, он нужного уровня, он про наш объект и он не протух.
 *
 * Наблюдение из будущего отвергается наравне с просроченным: это рассогласование
 * часов, а не свежесть, и «отрицательный возраст» не должен читаться как
 * «совсем свежее».
 */
export function observationSatisfies(
  observation: ReleaseObservation | null,
  check: ObservationCheck,
): boolean {
  if (observation === null) {
    return false;
  }
  if (observation.conditionType !== check.conditionType) {
    return false;
  }
  const required = OBSERVATION_REQUIREMENTS[check.conditionType];
  if (observation.sourceKey !== required.sourceKey) {
    return false;
  }
  if (!observationLevelAtLeast(observation.level, required.minLevel)) {
    return false;
  }
  // Пустой ожидаемый код — не «совпало с чем угодно», а отсутствие объекта, с
  // которым сверяться. Отказ закрытый.
  if (check.expectedCadastralCode.length === 0) {
    return false;
  }
  if (observation.cadastralCode !== check.expectedCadastralCode) {
    return false;
  }
  const age = check.now - observation.observedAt;
  if (age < 0) {
    return false;
  }
  return age <= check.policy.maxAge;
}
