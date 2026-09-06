import type { Anchor, AuditChain, AuditRoleId, NonEmpty, RawSourceRef } from '@sdelka/audit';
import { verifyChain } from '@sdelka/audit';
import type { ActorRef, ApprovalRecord, Capability, RoleId, Session } from '@sdelka/auth';
import type {
  BeneficiaryState,
  NameObservation,
  PolicyVersionId,
  ReviewTask,
} from '@sdelka/compliance';
import {
  type Approval,
  type Audience,
  type ConditionAct,
  type DealFiling,
  type DealState,
  type Instant,
  type NonTerminalWithdrawalStatus,
  type PartyRef,
  type PayoutState,
  type SourceAccountRef,
  type TrancheFacts,
  type TrancheState,
  type WithdrawalState,
  boundConditionAct,
  isTerminalTrancheStatus,
  violatesSingleActivePayout,
} from '@sdelka/domain';
import type { ObservationState, ObservationTaskKind } from '@sdelka/oracle';
import {
  type ClientKey,
  type CoverageByCurrency,
  type InvariantViolation as LedgerInvariantViolation,
  type Journal,
  accountBalance,
  balanceByCurrency,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  checkLedgerInvariants,
  isEveryFundsSourceCovered,
  isEveryTrancheCovered,
  isFullyCovered,
  negativeClientBalances,
} from '@sdelka/ledger';
import type { CurrencyCode, Money } from '@sdelka/money';
import type { TariffSeries } from '@sdelka/pricing';
import type { LedgerTemplate } from '@sdelka/domain';
import type { TrancheTariff } from './tariff';

/** Уведомление стороне. `messageKey` — ключ локализации, текста в коде нет. */
export interface Notification {
  readonly audience: Audience;
  readonly messageKey: string;
}

/** Намерение проводки, у которого проводки не оказалось. Видно тесту, а не молча. */
export interface SuppressedEntry {
  readonly trancheId: string;
  readonly template: LedgerTemplate;
  readonly reasonKey: string;
}

export interface TrancheRuntime {
  readonly dealId: string;
  readonly trancheId: string;
  readonly state: TrancheState;
  readonly facts: TrancheFacts;
  /**
   * Тариф, прилипший к этому траншу: версия, план, комиссия, брутто, нетто и
   * строка удержания — **одним значением** (`tariff.ts`, `@sdelka/pricing`).
   *
   * Прежде здесь лежали два независимых поля — `deductions` и
   * `tariffVersionId` (обычная строка), — и связи между ними не было никакой:
   * удержание считалось по одной ставке, а запись начисления называла любую
   * версию, какую передал вызывающий. Теперь и то и другое читается из одной
   * котировки, а котировку выдаёт только разрешение версии на момент создания
   * транша.
   *
   * `null` — у транша, **поднятого из хранилища**: версии тарифа в схеме нет
   * (`resume.ts`, `gaps`). Это не «нулевая комиссия», а отсутствие тарифа, и
   * расчёт по такому траншу отказывает (`requireTrancheTariff`).
   *
   * ⚠ Место этой величины — на сделке, в `packages/domain` (И14.3); пока его
   * там нет, держит приложение. Названо в отчёте.
   */
  readonly tariff: TrancheTariff | null;
  readonly payouts: readonly PayoutState[];
  /**
   * Подписи под выплатой **с уровнем роли** (`ACTORS.md` §5.2).
   *
   * Рядом с `facts.approvals`, а не вместо них: домен знает об утверждающих
   * только имя (`Approval { userId }`, чужой пакет), и по имени различает
   * подписи. Порог же берётся **набором уровней**: одна подпись — уровень 1
   * (ФК), две — уровень 1 плюс уровень 2 (ФК и РО). Держать уровень в фактах
   * домена нечем, а без него «две подписи» означало бы две любые учётные
   * записи — ровно тот дефект, который `ACTORS.md` §0 п.3 называет
   * невыполненным обещанием.
   */
  readonly approvalRecords: readonly ApprovalRecord[];
  readonly beneficiary: BeneficiaryState;
  /**
   * Имена покупателя как наблюдения: вход сверки собственника из выписки.
   * Лежат при транше, а не приезжают параметром в шаг приложения — иначе
   * выписку можно было бы сверить с именами постороннего лица (`CORE.md` Ф7).
   */
  readonly buyerNames: readonly NameObservation[];
  /** Сырые ответы источников, из которых собирается пакет доказательств. */
  readonly evidence: readonly RawSourceRef[];
  /** Приостановленный остаток дедлайна, если транш заморожен. */
  readonly suspendedRemaining: number | null;
  /**
   * Состояние машины наблюдения по этому траншу (`@sdelka/oracle`).
   *
   * Живёт рядом с траншем, а не отдельной картой мира: наблюдение всегда о
   * конкретном условии конкретного транша, и «наблюдение без транша» —
   * состояние, которого не бывает. Деньги оно не двигает: движение остаётся за
   * guard'ами транша, машина только собирает наблюдение и присваивает уровень
   * доверия (`CTO-architecture.md`, «Принцип разделения», п. 2).
   */
  readonly observation: ObservationState;
}

/**
 * Подпись под откатом: кто поставил, в какой роли и когда.
 *
 * Роль хранится вместе с именем, а не выводится потом из справочника: через год
 * ответ на вопрос «кто имел право это подписать» обязан читаться из самой
 * записи. Домену она не видна — `g_unwind_approvers_distinct` считает только
 * различие имён, — но журналу и оператору видна.
 */
export interface UnwindApproval {
  readonly userId: string;
  readonly roleId: AuditRoleId;
  readonly at: Instant;
}

/**
 * Разбор человеком: заявка на откат сделки и собранные под ней подписи.
 *
 * **Почему это живёт в приложении, а не в фактах сделки.** Домен принимает
 * утверждающих **событием** (`unwind_authorized.userIds`) и объясняет почему:
 * копить их в фактах значило бы завести у сделки поле «откат кем-то утверждён»,
 * которое переживёт причину своего появления (`deal.ts`, комментарий к
 * `g_unwind_approvers_distinct`). Но подписи ставятся не одновременно: первый
 * утверждающий уходит, второй приходит через час, и между ними состояние
 * «разбор идёт» обязано где-то лежать. Место такого состояния — слой
 * приложения: у сделки от него не появляется ни нового статуса, ни нового
 * правила.
 *
 * Заодно закрывается цена, названная в `STATE-MACHINES.md` §3.2 у выбранного
 * разбора развилки: «идёт разбор» было неотличимо от «ждём реестр». Теперь
 * отличимо — по наличию заявки, а не по статусу сделки.
 *
 * ⚠ **Проверки «двое и они разные» здесь нет намеренно.** Это правило домена, и
 * второй его экземпляр в приложении сделал бы guard непроверяемым: снятие
 * `g_unwind_approvers_distinct` не изменило бы поведения ни в одном сценарии, и
 * мутационный прогон отчитался бы о покрытии, которого нет.
 */
export interface UnwindReview {
  /** Кто поднял разбор. Утверждающим при этом он может быть, а может и не быть. */
  readonly requestedBy: string;
  /** Ключ локализации причины. Текста в коде нет (три языка, `CLAUDE.md`). */
  readonly reasonKey: string;
  readonly openedAt: Instant;
  /**
   * На чём основано решение. Непусто по типу: возврат денег при поданном
   * заявлении — это движение денег, и «просто вернуть» без основания не
   * существует как операция (красная линия №5 по смыслу, `DecisionMadeBody` по
   * типу записи журнала).
   */
  readonly evidence: NonEmpty<RawSourceRef>;
  readonly approvals: readonly UnwindApproval[];
}

export interface DealRuntime {
  readonly dealId: string;
  readonly state: DealState;
  readonly conditionAct: ConditionAct | null;
  readonly preparedBy: string | null;
  readonly trancheIds: readonly string[];
  /**
   * Кадастровый код объекта сделки. Один на сделку, а не по одному на транш:
   * транши — это график платежей по одному объекту, и два разных кода у одной
   * сделки означали бы две сделки.
   */
  readonly objectCadastralCode: string;
  /**
   * Заявления, поданные по этой сделке (`ORACLE.md` §9, И3.2). Наполняется
   * событием `filing_registered`, читается guard'ом `g_no_open_filing`.
   */
  readonly filings: readonly DealFiling[];
  /**
   * Открытый разбор отката. `null` — разбора никто не поднимал.
   *
   * Хранится при сделке, а не отдельной картой мира: разбор всегда о конкретной
   * сделке, и «разбор без сделки» — состояние, которого не бывает.
   */
  readonly unwindReview: UnwindReview | null;
}

/* ------------------------------------------------------------------------- */
/* Заявка на вывод                                                           */
/* ------------------------------------------------------------------------- */

/** След поднятой задачи: какой простой заявки уже показан дежурному. */
export interface WithdrawalStallMark {
  readonly taskId: string;
  readonly status: NonTerminalWithdrawalStatus;
  readonly enteredAt: Instant;
}

/**
 * Заявка на вывод со счёта клиента.
 *
 * **Почему она живёт здесь, а не рядом с миром.** Прежде выводы носила пара
 * `WithdrawalWorld` (`withdrawal.ts`), и цена этого была названа в самом
 * `store.ts`: дельта шага строится **из двух значений `World`**, поэтому заявка,
 * лежащая сбоку, в базу не попадала и в перечне непопавшего не появлялась —
 * единственное место всего подключения, где было возможно молчание. Переезд
 * сюда закрывает его структурой: заявка меняется только вместе с миром, а мир
 * получается только из `sealed`/`recorded`/`resumeWorld`.
 *
 * Часы заявки (`WithdrawalClockPolicy`) сюда **не** переехали и не должны:
 * норматив — величина владельца, приходящая версией настройки, а не состояние
 * (`withdrawal-clock.ts`).
 */
export interface WithdrawalRuntime {
  readonly state: WithdrawalState;
  /**
   * Клиент **стороной целиком**, а не ключом его счёта.
   *
   * Ключ счёта — половина личности (`FUNCTIONAL.md` §2.1), и обратно к лицу по
   * нему не пройти: строка `sdelka.withdrawal` требует `party_id`, а выдумать
   * его из ключа счёта нельзя. Тот же довод и то же устройство, что у
   * плательщика по траншу (`TrancheFacts.buyer`, `payerOf`): один ответ на
   * вопрос «чьи это деньги», а не два расходящихся.
   */
  readonly party: PartyRef;
  readonly amount: Money<CurrencyCode>;
  /** `null` — счёт-источник неизвестен: вывод уйдёт в `blocked`, а не наружу. */
  readonly sourceAccount: SourceAccountRef | null;
  readonly preparedBy: string | null;
  /**
   * Тот же готовивший, но лицом целиком: учётная запись **и** человек.
   * `preparedBy` рядом — строка для фактов домена (`ClientAccountFacts`, чужой
   * пакет); Н1 в кворуме сравнивает пару, потому что одна учётная запись и один
   * человек — не одно и то же (`@sdelka/auth`, `ids.ts`).
   *
   * `null` — готовивший **неизвестен**, а не «его не было». Такова заявка,
   * поднятая из хранилища: лица в схеме нет, и кворум по ней не набирается
   * (`resume.ts`, `requireWithdrawalQuorum`).
   */
  readonly preparerRef: ActorRef | null;
  readonly approvals: readonly Approval[];
  /** Подписи с уровнем роли — как у транша, и по той же причине (`ACTORS.md` §5.2). */
  readonly approvalRecords: readonly ApprovalRecord[];
  /**
   * Чьё действие увело вывод в `blocked`. `null` — не уводило ничьё.
   *
   * Нужно Н5: снимать удержание не может тот, кто его вызвал. Пока поле пусто, а
   * состояние `blocked`, факт считается **неизвестным**, и снятие отказывает —
   * см. `withdrawalActionContext`.
   */
  readonly blockedBy: ActorRef | null;
  /**
   * След о том, что заявку уже подняли дежурному. `null` — не поднимали.
   *
   * Нужен ровно для одного: задача о простое заводится **один раз на простой**, а
   * не на каждый проход часов. Ключ следа — статус вместе с моментом входа в
   * него: перешла заявка в другое состояние — простой начался заново и задача
   * будет новой; остался тот же (`paying_out --payout_result(unknown)-->
   * paying_out`, внутренний самопереход) — простой тот же, и второй задачи о нём
   * не появится.
   */
  readonly stall: WithdrawalStallMark | null;
}

/* ------------------------------------------------------------------------- */
/* Остановка приёма новых сделок (красная линия №3)                          */
/* ------------------------------------------------------------------------- */

/**
 * Заявка на снятие остановки: причина, основание и подписи.
 *
 * Устроена как разбор отката (`UnwindReview`) и по той же причине: подписи
 * ставят разные люди в разные моменты, и мир между первой и второй подписью
 * обязан быть выразим. Первая подпись открывает заявку, вторая — снимает
 * остановку, если правило сошлось (`intake-halt.ts`, `liftIntakeHalt`).
 */
export interface IntakeHaltLift {
  /** Ключ локализации причины. Текста в коде нет (три языка, `CLAUDE.md`). */
  readonly reasonKey: string;
  /**
   * На чём основано снятие. Непусто по типу: «снятие требует сошедшейся сверки,
   * а не объяснения» (`ACTORS.md` §7.4), а сверка — это ответ источника, а не
   * слова снимающего.
   */
  readonly evidence: NonEmpty<RawSourceRef>;
  /** Редакция политики, под которой принято решение (`CORE.md` Ф11). */
  readonly policy: PolicyVersionId;
  readonly openedAt: Instant;
  /**
   * Подписи с уровнем роли. Уровень берётся из роли сессии
   * (`recordApproval`, `@sdelka/auth`), а не из аргумента: подписать «за
   * уровень 2» нельзя.
   */
  readonly signatures: readonly ApprovalRecord[];
}

/**
 * Приём новых сделок остановлен.
 *
 * **Состояние, а не вычисление.** Считать остановку из журнала на каждый вызов
 * было бы тем же самым, что снимать её автоматически: покрытие сошлось —
 * признак погас — приём открылся сам. Именно этого красная линия №3 не
 * допускает: причина расхождения могла исчезнуть по-разному, и разбирается это
 * человеком (`ACTORS.md` §7.4, и см. `DECISIONS-REVIEW.md` §T1 **[открыто]** —
 * автоснятие документом разрешено, кодом сегодня не сделано).
 *
 * ⚠ **В хранилище этого состояния нет.** Колонки под остановку в схеме не
 * существует, поэтому после перезапуска процесса поднятый мир получает
 * остановку заново — закрытым отказом, а не открытым приёмом (`resume.ts`,
 * `GAPS`).
 */
export interface IntakeHalt {
  /**
   * Кто или что остановило приём: человек по сессии либо машина. Разметка, а не
   * `ActorRef | null`: «остановил автомат» и «остановившего не выяснили» —
   * разные состояния, и от первого зависит Н5 при снятии.
   */
  readonly by: ActingParty;
  readonly at: Instant;
  /** Ключ локализации причины. Текста в коде нет. */
  readonly reasonKey: string;
  /**
   * По какому факту остановлено: нарушенные инварианты учёта **с числами**.
   * Пусто у остановки, нажатой человеком: он останавливает по своему суждению,
   * а не по расхождению журнала.
   */
  readonly violations: readonly LedgerInvariantViolation[];
  /**
   * Покрытие по каждой валюте на момент срабатывания — целыми минорными
   * единицами (красная линия №4). Отношение хранится тем же значением, каким
   * его считает учёт: числитель и знаменатель, а не дробь.
   */
  readonly coverage: readonly CoverageByCurrency[];
  /** Запись вечного журнала, которой остановка записана. Правке не подлежит. */
  readonly recordId: string;
  /** Заявка на снятие. `null` — снятия никто не поднимал. */
  readonly lift: IntakeHaltLift | null;
}

/**
 * Задача оператору, порождённая наблюдением оракула.
 *
 * ⚠ **Отдельный список, а не строка в очереди `@sdelka/compliance`, — и это
 * названное расхождение, а не архитектурный замысел.**
 *
 * У оракула три вида задачи: `owner_reconciliation` («собственника установить
 * не смогли»), `field_mismatch` («поле выписки разошлось») и
 * `observation_insufficient` («документ не дотягивает»). В
 * `REVIEW_TASK_KINDS` (`packages/compliance/src/queue.ts`) нет ни одного из
 * них. Подставить вместо них ближайший существующий вид значило бы показать
 * оператору очередь «источник средств» или «цена разошлась» там, где речь о
 * выписке из реестра, — то есть соврать в интерфейсе ради того, чтобы тип
 * сошёлся.
 *
 * Поэтому задача заводится своим типом и лежит рядом, пока в очередь не
 * добавят три строки. Чинится тремя строками в чужом пакете; до тех пор
 * расхождение видно, а не растворено.
 */
export interface ObservationTask {
  readonly taskId: string;
  readonly dealId: string;
  readonly trancheId: string;
  readonly kind: ObservationTaskKind;
  readonly enteredAt: Instant;
  readonly policyVersionId: string;
}

/* ------------------------------------------------------------------------- */
/* Кто что делал: факты для разделения обязанностей                          */
/* ------------------------------------------------------------------------- */

/**
 * Происхождение шага, у которого человека нет.
 *
 * Два и только два: часы приложения (`tick`) и источник наблюдения (реестр,
 * через машину `@sdelka/oracle`). Оба уже присутствовали в журнале аудита как
 * `SYSTEM_ACTOR` и `ORACLE_ACTOR`; здесь у них появляется тип, потому что
 * «шаг без сессии» обязан быть либо одним из этих двух, либо невозможным.
 */
export type MachineOrigin = 'clock' | 'oracle_source';

/**
 * Кто совершил шаг: человек по сессии либо машина.
 *
 * Разметка, а не `ActorRef | null`. `null` означал бы «человека нет» и
 * «человека не выяснили» одновременно — ровно та склейка, из-за которой
 * разделение обязанностей отключалось молчанием (`@sdelka/auth`, `UNKNOWN_FACT`).
 */
export type ActingParty =
  | {
      readonly kind: 'person';
      readonly ref: ActorRef;
      readonly roleId: RoleId;
      readonly sessionId: string;
    }
  | { readonly kind: 'machine'; readonly origin: MachineOrigin };

/**
 * Вид факта о прошлом действии. Ровно четыре — по числу вопросов, которые
 * задаёт `ActionContext` в `@sdelka/auth`: кто готовил (Н1), кто вносил
 * наблюдение (Н2), кто заявлял реквизиты (Н4), кто вызвал расхождение (Н5).
 *
 * Пятого вида здесь быть не должно: перечень определён не нами, а тем, что
 * проверяет `evaluateSeparation`.
 */
export const ACTION_FACT_KINDS = ['prepared', 'observed', 'beneficiary_requested', 'caused'] as const;
export type ActionFactKind = (typeof ACTION_FACT_KINDS)[number];

/**
 * Запись «кто что сделал» — **след авторизованного шага, а не заявление
 * вызывающего**.
 *
 * Кладётся только изнутри шага мира, из выписанного `Authority`, и нигде больше:
 * функции, принимающей такую запись снаружи, в пакете нет. Именно поэтому
 * `evaluateSeparation` можно кормить отсюда — факт «оператор готовил транш»
 * возникает в тот момент, когда оператор его действительно завёл, под своим
 * полномочием.
 */
export interface ActionFact {
  readonly kind: ActionFactKind;
  readonly dealId: string;
  /** `null` — факт о сделке целиком, а не о конкретном транше. */
  readonly trancheId: string | null;
  readonly by: ActingParty;
  readonly capability: Capability | MachineOrigin;
  readonly at: Instant;
}

/**
 * Метка происхождения мира.
 *
 * Значения у символа не существует, поэтому объект-литерал `World` не
 * собирается ни у кого: единственный вход — `emptyWorld`, единственный переход —
 * `sealed`/`recorded`, принимающие уже существующий мир. Без метки перечень
 * сессий и перечень фактов ниже были бы декорацией: любой вызывающий собрал бы
 * мир с нужной ему сессией и нужным ему «кто готовил».
 */
declare const worldBrand: unique symbol;

export interface World {
  /** См. `worldBrand`: мир нельзя собрать литералом, только провести через `sealed`. */
  readonly [worldBrand]: 'sealed';
  readonly now: Instant;
  readonly journal: Journal;
  readonly chain: AuditChain;
  readonly anchors: readonly Anchor[];
  readonly deals: ReadonlyMap<string, DealRuntime>;
  readonly tranches: ReadonlyMap<string, TrancheRuntime>;
  /**
   * Журнал версий тарифа (`@sdelka/pricing`, `@sdelka/settings`).
   *
   * Поле мира, а не аргумент шага, и по той же причине, по которой в мире живут
   * сессии: журнал-аргумент — это журнал, который вызывающий собрал сам, и
   * тогда «тарифа на этот момент не было» перестаёт существовать как состояние.
   * Отсюда его читает `createTranche` — единственное место, где версия тарифа
   * разрешается, — и читает **на `world.now`**, то есть на момент создания
   * транша, а не на произвольный названный момент.
   *
   * Пустой журнал — законное начальное состояние и **не** умолчание: тарифа
   * нет, и заведение транша отказывает (`SETTINGS_REFUSAL_KEYS.noVersionInEffect`).
   */
  readonly tariffs: TariffSeries;
  /**
   * Заявки на вывод со счёта клиента, по номеру заявки.
   *
   * Поле мира, а не карта сбоку от него: см. `WithdrawalRuntime`. Отсюда их
   * видит дельта шага (`store.ts`, `stepDelta`) — тем же сравнением двух миров,
   * каким она видит транши, — и поэтому «заявка ушла мимо базы» перестало быть
   * выразимым.
   */
  readonly withdrawals: ReadonlyMap<string, WithdrawalRuntime>;
  /**
   * Приём новых сделок остановлен. `null` — приём открыт.
   *
   * Поле мира, а не признак, вычисляемый из журнала: остановка обязана
   * **пережить** исчезновение своей причины (красная линия №3, `ACTORS.md`
   * §7.4). Ставится только изнутри пакета — автоматом при закрытии банковского
   * дня и стоп-краном человека, — снимается только двумя людьми
   * (`intake-halt.ts`).
   */
  readonly halt: IntakeHalt | null;
  readonly tasks: readonly ReviewTask[];
  /** Задачи оракула: см. `ObservationTask` — почему они лежат отдельно. */
  readonly observationTasks: readonly ObservationTask[];
  readonly notifications: readonly Notification[];
  readonly suppressed: readonly SuppressedEntry[];
  /**
   * Ключи идемпотентности поручений, которые автомат велел отправить повторно.
   * Гасятся ключом, а не молчанием: повтор обязан быть виден. Отчёт, расхождение 13.
   */
  readonly reissuedPayouts: readonly string[];
  /**
   * Действующие сессии, по идентификатору сессии.
   *
   * Живут в мире, а не приезжают аргументом в шаг. Разница не в удобстве:
   * сессия-аргумент — это сессия, которую вызывающий собрал сам, и тогда
   * «истёкшая» и «отозванная» перестают существовать как состояния. Здесь она
   * попадает только через `openSession` (то есть через `establishSession` с его
   * политикой роли), а `authorize` берёт её отсюда по идентификатору и меряет
   * `world.now`, а не своими часами.
   */
  readonly sessions: ReadonlyMap<string, Session>;
  /**
   * Кто что делал раньше. Единственный источник фактов для разделения
   * обязанностей: `actionContextFor` читает **отсюда**, а не из аргументов.
   */
  readonly facts: readonly ActionFact[];
  /** Сколько раз инварианты проверялись. Растёт на каждом шаге, тест это видит. */
  readonly checks: number;
  /** Счётчик идентификаторов записей журнала и аудита. */
  readonly seq: number;
}

/**
 * Кандидат в миры: всё то же самое, кроме счётчика проверок.
 *
 * Метка происхождения в нём **остаётся**, и это и есть весь приём: собрать
 * такое значение можно только раскрытием уже существующего мира
 * (`{ ...world, … }`), а первый мир выдаёт `emptyWorld` — единственное место с
 * приведением.
 */
export type WorldCandidate = Omit<World, 'checks'> & { readonly checks: number };

/**
 * Первый мир. Единственное приведение к `World` в пакете: до него мира нет, и
 * раскрывать нечего.
 */
export function seedWorld(seed: Omit<World, typeof worldBrand>): World {
  return seed as World;
}

/* ------------------------------------------------------------------------- */
/* Инварианты                                                                */
/* ------------------------------------------------------------------------- */

export const APP_INVARIANTS = [
  'entry_not_zero',
  'coverage_below_one',
  'tranche_uncovered',
  'funds_source_uncovered',
  'negative_client_balance',
  /**
   * Собранное, объявленное приложением, не обеспечено учётом.
   *
   * `collectedAmount` — **единственный денежный факт, который приложение держит
   * само**: покрытие и запертую сумму `contextFor` пересчитывает из журнала на
   * каждый вызов, а собранное берёт из события `funds_received` и запоминает.
   * Отнесение свободной части счёта клиента к траншу в журнале не записано
   * (зачисление кредитует `client:{c}:free`, где траншей не видно), поэтому
   * вывести собранное из журнала нельзя — но **проверить** можно: сумма
   * притязаний живых траншей одного клиента не может превышать того, что учёт
   * этому клиенту должен.
   *
   * Проба, которую это закрывает: приложение объявляет полную сумму, а на счёт
   * клиента пришло на 50 ₾ меньше. Транш проходит `collected`,
   * `refund_pending` и `refunding` — **каждый шаг запечатан без единого
   * нарушения**, — и падает только на `refunded`, когда деньги физически
   * уходят с номинального счёта. Денежный факт, который приложение может
   * объявить, — не факт, и ловиться он обязан на шаге, где объявлен, а не
   * тремя шагами позже.
   */
  'collected_not_backed',
  'double_active_payout',
  'non_terminal_without_deadline',
  'audit_chain_broken',
] as const;

export type AppInvariant = (typeof APP_INVARIANTS)[number];

export interface InvariantViolation {
  readonly invariant: AppInvariant;
  readonly subject: string;
  readonly detail: string;
}

/**
 * Поверхность, на которой инварианты вообще проверяемы: журнал учёта, цепочка
 * аудита и состояния траншей вместе с их поручениями.
 *
 * Заведена не ради красоты разбиения, а ради одного вопроса, который иначе
 * задать нечем: **те же ли инварианты держатся на мире, поднятом из
 * хранилища.** Мир целиком из базы сегодня не поднимается — фактов приложения
 * (собранное, реквизиты, наблюдение, подписи) в схеме нет вовсе, — но всё, что
 * перечислено здесь, база хранит. Проверять поднятое **той же функцией**, а не
 * её похожей копией, — единственный способ ответить на вопрос честно: копия
 * разошлась бы с оригиналом на первой же правке, и «инварианты те же» стало бы
 * утверждением о двух разных проверках.
 */
export interface SurfaceTranche {
  readonly trancheId: string;
  readonly state: TrancheState;
  readonly payouts: readonly PayoutState[];
}

export interface InvariantSurface {
  readonly journal: Journal;
  readonly chain: AuditChain;
  readonly tranches: readonly SurfaceTranche[];
}

export function surfaceOf(world: World): InvariantSurface {
  return {
    journal: world.journal,
    chain: world.chain,
    tranches: [...world.tranches.values()].map((tranche) => ({
      trancheId: tranche.trancheId,
      state: tranche.state,
      payouts: tranche.payouts,
    })),
  };
}

/**
 * Проверка после каждого шага.
 *
 * Четыре денежных инварианта здесь проверяются **поимённо**, а не одним вызовом
 * `checkLedgerInvariants`, хотя он их и покрывает: сквозной прогон обязан
 * называть нарушенное правило, а не отдавать список кодов. Пятый и шестой —
 * из домена: одна активная выплата на транш и «нетерминальное состояние несёт
 * дедлайн либо остаток приостановленного дедлайна» (`STATE-MACHINES.md` §5,
 * уточнение E9-10). Седьмой — целостность журнала аудита: он тоже часть шага.
 *
 * `claims` — притязания на собранное, единственная проверка, которой нужен не
 * журнал и не состояние, а факт приложения (`TrancheFacts.collectedAmount`).
 * Она приходит **аргументом**, а не считается здесь, ровно потому, что
 * поверхность, поднятая из хранилища, её посчитать не может: собранного в
 * схеме нет. Пустой список у поднятого мира означает «эта проверка не
 * проводилась», и `restoreWorld` называет её среди непроверяемого, а не
 * выдаёт молчание за чистый результат.
 */
export function surfaceViolations(
  surface: InvariantSurface,
  claims: readonly InvariantViolation[],
): readonly InvariantViolation[] {
  const out: InvariantViolation[] = [];

  // 1. Сумма проводок в записи равна нулю по каждой валюте.
  for (const entry of surface.journal.entries) {
    for (const [currency, total] of balanceByCurrency(entry.postings)) {
      if (total !== 0n) {
        out.push({ invariant: 'entry_not_zero', subject: entry.id, detail: `${currency}:${total}` });
      }
    }
  }

  // 2. Покрытие клиентских средств по портфелю.
  if (!isFullyCovered(surface.journal)) {
    out.push({ invariant: 'coverage_below_one', subject: 'portfolio', detail: '' });
  }

  // 3. Пофайловое обеспечение: по траншу и по счёту клиента.
  if (!isEveryTrancheCovered(surface.journal)) {
    out.push({ invariant: 'tranche_uncovered', subject: 'tranche', detail: '' });
  }
  if (!isEveryFundsSourceCovered(surface.journal)) {
    out.push({ invariant: 'funds_source_uncovered', subject: 'funds_source', detail: '' });
  }

  // 4. Неотрицательность остатков клиентских счетов.
  for (const item of negativeClientBalances(surface.journal)) {
    out.push({
      invariant: 'negative_client_balance',
      subject: item.accountCode,
      detail: item.balance.minor.toString(),
    });
  }

  // 5. Собранное, объявленное приложением, обеспечено учётом.
  for (const violation of claims) {
    out.push(violation);
  }

  for (const tranche of surface.tranches) {
    if (violatesSingleActivePayout(tranche.payouts, tranche.trancheId)) {
      out.push({ invariant: 'double_active_payout', subject: tranche.trancheId, detail: '' });
    }
    const state = tranche.state;
    if (isTerminalTrancheStatus(state.status)) continue;
    if (!('deadline' in state) && !('remaining' in state)) {
      out.push({
        invariant: 'non_terminal_without_deadline',
        subject: tranche.trancheId,
        detail: state.status,
      });
    }
  }

  const integrity = verifyChain(surface.chain);
  if (!integrity.intact) {
    out.push({
      invariant: 'audit_chain_broken',
      subject: surface.chain.chainId,
      detail: integrity.firstBreak.kind,
    });
  }

  // Второй контур: коды учёта. Если он что-то видит, а поимённые проверки нет —
  // расходятся не деньги, а наши представления о них, и это тоже отказ.
  for (const violation of checkLedgerInvariants(surface.journal)) {
    if (out.some((item) => item.subject === violation.subject)) continue;
    out.push({
      invariant: 'coverage_below_one',
      subject: violation.subject,
      detail: violation.code,
    });
  }

  return Object.freeze(out);
}

/**
 * Инварианты мира. Та же проверка, что у поднятого состояния, плюс притязание
 * на собранное — единственное, что видно только в памяти.
 */
export function invariantViolations(world: World): readonly InvariantViolation[] {
  return surfaceViolations(surfaceOf(world), unbackedCollectedClaims(world));
}

/**
 * Притязания живых траншей на деньги клиента против того, что учёт этому
 * клиенту должен.
 *
 * Сумма — по клиенту и валюте, а не по одному траншу: два транша одного
 * покупателя, каждый в пределах остатка, вместе могут этот остаток превышать, и
 * пофайловая проверка такую пару пропустила бы. Терминальные транши не
 * считаются: их обязательство уже погашено расчётом, возвратом или списанием, а
 * `collectedAmount` в фактах остаётся как след прошлого.
 *
 * Обеспечением считается **свободная часть плюс запертое под траншами этого же
 * клиента**: пока деньги не заперты, притязание опирается на свободный остаток,
 * после запирания — на файл транша. Обе половины принадлежат одному клиенту, и
 * складывать их законно.
 */
function unbackedCollectedClaims(world: World): readonly InvariantViolation[] {
  return collectedClaimViolations(
    world.journal,
    [...world.tranches.values()].map((tranche) => ({
      owner: payerOf(tranche),
      dealId: tranche.dealId,
      trancheId: tranche.trancheId,
      terminal: isTerminalTrancheStatus(tranche.state.status),
      claimed: tranche.facts.collectedAmount,
    })),
  );
}

/**
 * Притязание одного транша на деньги клиента: чьи деньги, под каким файлом и
 * сколько объявлено собранным.
 *
 * Заведено ради подъёма из хранилища (`resume.ts`): у поднятого транша нет
 * `TrancheRuntime`, а вопрос «обеспечено ли объявленное собранное» у него ровно
 * тот же. Второй реализации той же проверки быть не должно — она разошлась бы с
 * первой молча, и разошлась бы именно на подъёме, где проверять некому.
 */
export interface CollectedClaim {
  readonly owner: ClientKey;
  readonly dealId: string;
  readonly trancheId: string;
  /** Терминальный транш притязания не заявляет: его обязательство уже погашено. */
  readonly terminal: boolean;
  readonly claimed: Money<CurrencyCode> | null;
}

/**
 * Та самая проверка: сумма притязаний живых траншей против того, что учёт
 * должен их клиенту.
 */
export function collectedClaimViolations(
  journal: Journal,
  tranches: readonly CollectedClaim[],
): readonly InvariantViolation[] {
  const claims = new Map<string, { owner: ClientKey; currency: CurrencyCode; minor: bigint }>();
  const owners = new Map<ClientKey, CollectedClaim[]>();
  for (const tranche of tranches) {
    const owner = tranche.owner;
    owners.set(owner, [...(owners.get(owner) ?? []), tranche]);
    if (tranche.terminal) continue;
    const claimed = tranche.claimed;
    if (claimed === null || claimed.minor <= 0n) continue;
    const key = `${owner}|${claimed.currency}`;
    const previous = claims.get(key);
    claims.set(key, {
      owner,
      currency: claimed.currency,
      minor: (previous?.minor ?? 0n) + claimed.minor,
    });
  }

  const out: InvariantViolation[] = [];
  for (const claim of claims.values()) {
    let backing = accountBalance(journal, clientFreeAccount(claim.owner), claim.currency).minor;
    for (const tranche of owners.get(claim.owner) ?? []) {
      backing += accountBalance(
        journal,
        clientLockedAccount(claim.owner, tranche.dealId, tranche.trancheId),
        claim.currency,
      ).minor;
    }
    if (claim.minor > backing) {
      out.push({
        invariant: 'collected_not_backed',
        subject: `${claim.owner}:${claim.currency}`,
        detail: `${claim.minor} > ${backing}`,
      });
    }
  }
  return out;
}

export class AppInvariantError extends Error {
  readonly violations: readonly InvariantViolation[];

  constructor(violations: readonly InvariantViolation[]) {
    super(
      `invariant violated: ${violations
        .map((item) => `${item.invariant}(${item.subject}${item.detail === '' ? '' : ` ${item.detail}`})`)
        .join(', ')}`,
    );
    this.name = 'AppInvariantError';
    this.violations = violations;
  }
}

/**
 * Запечатать шаг, расхождение которого **названо заранее**.
 *
 * Ровно один момент в `FUNCTIONAL.md` §3.1 обязан оставлять мир в расхождении:
 * признание недостачи корреспондента (случай А). Обязательство перед клиентом
 * доводится до полной суммы в момент поступления, а деньги платформы приходят
 * межбанковским переводом через день-два — и между двумя записями покрытие
 * меньше единицы. Документ говорит об этом промежутке дословно: «до второй
 * записи транш не обеспечен, и **это видно в системе как расхождение**, а не
 * как норма».
 *
 * Через `sealed` такой момент невыразим: `sealed` отдаёт либо чистый мир, либо
 * исключение, а исключение стирает состояние — расхождение оказывается не
 * видно, а недостача непроводима и невидима одновременно. Ту же ошибку
 * `0008_views.sql` называет причиной, по которой покрытие — представление, а не
 * `CHECK`: «недостачу нужно уметь записать, чтобы её увидеть».
 *
 * Дверь **не открыта настежь** и не заменяет `sealed`:
 * - терпимые нарушения перечисляет вызывающий, и любое другое — по-прежнему
 *   исключение;
 * - расхождение возвращается значением, а не молчанием: не заметить его нельзя;
 * - следующий шаг мира идёт через `sealed` и падает, пока расхождение живо.
 *   То есть после признания в мире не может произойти ничего, кроме довнесения.
 */
export function recorded(
  next: WorldCandidate,
  tolerated: readonly AppInvariant[],
): { readonly world: World; readonly violations: readonly InvariantViolation[] } {
  const candidate: World = Object.freeze({ ...next, checks: next.checks + 1 });
  const violations = invariantViolations(candidate);
  const unexpected = violations.filter((item) => !tolerated.includes(item.invariant));
  if (unexpected.length > 0) {
    throw new AppInvariantError(unexpected);
  }
  return { world: candidate, violations };
}

/**
 * Запечатать шаг: проверить инварианты и вернуть новое состояние мира.
 *
 * Единственный способ получить новый `World` — пройти через эту функцию, и
 * поэтому «инварианты проверяются после каждого шага» держится структурой, а не
 * дисциплиной тестов.
 */
export function sealed(next: WorldCandidate): World {
  const candidate: World = Object.freeze({ ...next, checks: next.checks + 1 });
  const violations = invariantViolations(candidate);
  if (violations.length > 0) {
    throw new AppInvariantError(violations);
  }
  return candidate;
}

export function trancheOf(world: World, trancheId: string): TrancheRuntime {
  const runtime = world.tranches.get(trancheId);
  if (runtime === undefined) {
    throw new Error(`app.unknown_tranche:${trancheId}`);
  }
  return runtime;
}

export function dealOf(world: World, dealId: string): DealRuntime {
  const runtime = world.deals.get(dealId);
  if (runtime === undefined) {
    throw new Error(`app.unknown_deal:${dealId}`);
  }
  return runtime;
}

/**
 * Плательщик по траншу — ключ счёта покупателя.
 *
 * Отдельного поля у него больше нет. Раньше приложение хранило `payer` рядом с
 * фактами и подставляло его в проводки, а сторону сделки называл `buyerPartyId`
 * в фактах: два ответа на один вопрос в двух местах, ни разу не сверенные
 * между собой. Теперь ответ один — `TrancheFacts.buyer`, где обе половины
 * личности лежат в одном значении (`PartyRef`, `FUNCTIONAL.md` §2.1), и взять
 * половину неоткуда.
 */
export function payerOf(runtime: TrancheRuntime): ClientKey {
  return clientKey(runtime.facts.buyer.accountKey);
}

/**
 * Получатель расчёта — **из акта об условии**, и ниоткуда больше.
 *
 * Свободного параметра `TrancheSpec.recipient` не существует: акт получателя
 * (ст. 27(2), `CORE.md` Ф13) называет того, кто определил обстоятельство, и
 * деньги идут ему. Акт берётся сначала из состояния транша — он привязан на
 * выходе из `pending` и меняется только амендментом обеих сторон, — и лишь для
 * `pending`, где привязки ещё нет, из фактов.
 *
 * Приложение эту функцию в проводки не подставляет: получателя расчёта в учёт
 * приносит намерение `post_settlement_entry` вместе с подтверждением домена.
 * Здесь она нужна отчётности и тестам, которым надо назвать ожидаемое лицо.
 */
export function recipientOf(runtime: TrancheRuntime): ClientKey {
  const act = boundConditionAct(runtime.state) ?? runtime.facts.conditionAct;
  if (act === null) {
    throw new Error(`app.tranche.condition_act_missing:${runtime.trancheId}`);
  }
  return clientKey(act.recipient.accountKey);
}

/**
 * Владелец остатка, с которого идёт вывод, — ключ счёта стороны.
 *
 * Ровно то же устройство, что у `payerOf`: ключ **выводится** из стороны, а не
 * лежит рядом с ней вторым полем. Свободный ключ означал бы заявку, у которой
 * деньги списываются с одного счёта, а строка в базе называет другое лицо.
 */
export function withdrawalOwner(runtime: WithdrawalRuntime): ClientKey {
  return clientKey(runtime.party.accountKey);
}

export function withWithdrawal(
  world: World,
  runtime: WithdrawalRuntime,
): ReadonlyMap<string, WithdrawalRuntime> {
  const next = new Map(world.withdrawals);
  next.set(runtime.state.withdrawalId, runtime);
  return next;
}

export function withTranche(world: World, runtime: TrancheRuntime): ReadonlyMap<string, TrancheRuntime> {
  const next = new Map(world.tranches);
  next.set(runtime.trancheId, runtime);
  return next;
}

export function withDeal(world: World, runtime: DealRuntime): ReadonlyMap<string, DealRuntime> {
  const next = new Map(world.deals);
  next.set(runtime.dealId, runtime);
  return next;
}

/** Свободный остаток клиента — читается из учёта, домен его не считает. */
export function coverageOk(journal: Journal): boolean {
  return isFullyCovered(journal) && isEveryTrancheCovered(journal) && isEveryFundsSourceCovered(journal);
}

export function moneyLabel(value: Money<CurrencyCode>): string {
  return `${value.currency}:${value.minor}`;
}
