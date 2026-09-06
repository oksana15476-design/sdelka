import { type AuditActor, auditActor } from '@sdelka/audit';
import {
  type AccountId,
  type ActionContext,
  type ActorFact,
  type ActorRef,
  type AuthReasonKey,
  type Capability,
  type Denial,
  type Grant,
  type PrimaryAuthentication,
  type RoleId,
  type SecondFactorAssertion,
  type Session,
  type SessionId,
  type SessionStatus,
  UNKNOWN_FACT,
  accountId as toAccountId,
  decideCapability,
  establishSession,
  personId as toPersonId,
  requireAuditRole,
  revoke,
  sessionActor,
  sessionId as toSessionId,
  sessionStatus,
  touch,
} from '@sdelka/auth';
import { type DurationMs, type Instant, type Result, failure, ok } from '@sdelka/domain';
import {
  type ActingParty,
  type ActionFact,
  type ActionFactKind,
  type MachineOrigin,
  type World,
  trancheOf,
} from './world';

/**
 * Полномочия на шагах мира — **дверь, а не табличка на двери**.
 *
 * ## Зачем модуль появился
 *
 * `@sdelka/auth` был построен целиком — роли, полномочия, сессии, второй фактор,
 * разделение обязанностей, кворум — и **не был подключён ни к чему**: проверка
 * `grep '@sdelka/auth'` вне самого пакета давала только его собственный
 * `package.json` и сверку перечней в `packages/db`. То есть каждый шаг мира,
 * двигающий деньги или состояние сделки, выполнялся вообще без проверки
 * полномочий, а разделение обязанностей и кворум существовали отдельно от
 * действий, которые они должны разводить.
 *
 * ## Три вещи, которые здесь сделаны, и почему именно так
 *
 * 1. **Доказательство полномочия — значение с меткой, а не аргумент-актор.**
 *    Прежде шаг принимал `AuditActor` — тройку строк, которую вызывающий
 *    собирал сам (`auditActor('approver-1', 'approver', 'approve_payout')`), и
 *    ни одна из трёх строк ни с чем не сверялась. Теперь шаг принимает
 *    `Authority`, у которого объявленный-но-несуществующий символ вместо
 *    конструктора: литералом его не собрать, и единственный способ получить —
 *    `authorize`, где отработали проверка сессии, проверка полномочия роли,
 *    второй фактор и разделение обязанностей.
 *
 * 2. **Параметр обязателен, умолчания нет.** Ровно то, чем это уже кусалось в
 *    `@sdelka/auth`: необязательный `context` у решения означал «не передал —
 *    Н1, Н2, Н4 и Н5 молча прошли». Здесь у полномочия нет ни умолчания, ни
 *    значения «не проверяем»: `applyTrancheEvent` без `Authority` не
 *    компилируется, а `Authority` неподходящего полномочия не компилируется
 *    тоже — каждому событию сопоставлено своё (см. `origins.ts`).
 *
 * 3. **Факты разделения обязанностей поднимаются из мира.** `ActionContext`
 *    собирается `actionContextFor` из `World.facts` — следа авторизованных
 *    шагов, — а не приходит от вызывающего. Где мир ответить не может, стоит
 *    `UNKNOWN_FACT`, и решение отказывает: «неизвестно» — не «никто».
 *
 * ## Чего здесь нет
 *
 * **Аутентификации.** `openSession` выдаёт сессию по предъявленным первичному
 * подтверждению и факторам; проверять, что за ними стоит настоящий человек, —
 * задача адаптера (порт `SessionStorePort` и `SecondFactorPort` объявлены в
 * `@sdelka/auth`). Названо в отчёте, а не спрятано: этот слой держит
 * **полномочия**, а не вход.
 */

/* ------------------------------------------------------------------------- */
/* Происхождение шага                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Чем шаг разрешён: полномочием человека либо машиной.
 *
 * Машинных происхождений ровно два, и оба заперты внутри пакета: значения
 * `Authority<'clock'>` и `Authority<'oracle_source'>` из `index.ts` не
 * экспортируются, поэтому снаружи их взять неоткуда. Иначе «шаг без сессии» был
 * бы разрешён любому, кто напишет `clockAuthority()`.
 */
export type StepOrigin = Capability | MachineOrigin;

declare const authorityBrand: unique symbol;

/**
 * Разрешение на один шаг мира.
 *
 * Ковариантно по `O`: `Authority<'lift_block'>` годится там, где ждут
 * `Authority<'lift_block' | 'oracle_source'>`, и не годится там, где ждут
 * `Authority<'approve_payout'>`. Это и есть компиляционный рубеж.
 */
export interface Authority<O extends StepOrigin> {
  /** Метка происхождения: значения не существует, литералом не собирается. */
  readonly [authorityBrand]: 'authorized';
  readonly origin: O;
  readonly by: ActingParty;
  readonly at: Instant;
  /**
   * Доказательство полномочия. `null` — шаг машинный, и полномочия у него нет
   * вовсе: у часов и у источника наблюдения нет ни сессии, ни роли.
   */
  readonly grant: Grant<Capability> | null;
}

export class AuthorityError extends Error {
  readonly reason: string;
  readonly denial: Denial | null;

  constructor(reason: string, denial: Denial | null = null) {
    super(denial === null ? reason : `${reason}:${denial.reason}`);
    this.name = 'AuthorityError';
    this.reason = reason;
    this.denial = denial;
  }
}

/* ------------------------------------------------------------------------- */
/* Сессии в мире                                                             */
/* ------------------------------------------------------------------------- */

export interface SessionOpening {
  readonly sessionId: string;
  readonly accountId: string;
  readonly personId: string;
  readonly roleId: RoleId;
  readonly onDuty: boolean;
  readonly primary: PrimaryAuthentication;
  readonly factors: readonly SecondFactorAssertion[];
  readonly requestedTtl: DurationMs;
}

export interface OpenedSession {
  readonly world: World;
  readonly session: Session;
}

/**
 * Выдать сессию и положить её в мир.
 *
 * Отказ — значение с ключом причины, как в `@sdelka/auth`: политика роли решает,
 * годится ли первичное подтверждение, достаточно ли силён фактор и не слишком ли
 * длинный срок запрошен. Подменить политику нечем — она берётся по роли.
 *
 * Сессия кладётся в мир **по идентификатору**, и второй сессии с тем же
 * идентификатором не бывает: повторная выдача заменяет прежнюю, а не копит две.
 */
export function openSession(
  world: World,
  opening: SessionOpening,
): Result<OpenedSession, AuthReasonKey> {
  const established = establishSession(
    {
      sessionId: toSessionId(opening.sessionId),
      accountId: toAccountId(opening.accountId),
      personId: toPersonId(opening.personId),
      roleId: opening.roleId,
      onDuty: opening.onDuty,
      primary: opening.primary,
      factors: opening.factors,
      requestedTtl: opening.requestedTtl,
    },
    world.now,
  );
  if (!established.ok) return failure(established.error);
  return ok({ world: withSession(world, established.value), session: established.value });
}

/**
 * Положить сессию в мир.
 *
 * ⚠ **Через `sealed` не идёт, и это названо.** Правило «инварианты после
 * каждого шага» — о шагах, двигающих деньги; выдача сессии не двигает ни одной
 * минорной единицы, и проверять по ней покрытие нечего. Пропуск здесь не
 * послабление, а необходимость: `absorbIncomingShortfall` намеренно оставляет
 * мир в **названном** расхождении (`recorded`, `FUNCTIONAL.md` §3.1 случай А), и
 * `sealed` в этот промежуток бросает по построению. Если бы вход в систему шёл
 * через `sealed`, довнести недостачу было бы невозможно: сотрудник не смог бы
 * войти ровно в тот момент, ради которого промежуток и существует.
 *
 * Денежные шаги как шли через `sealed`, так и идут — ни один из них эта функция
 * не заменяет.
 */
function withSession(world: World, session: Session): World {
  const sessions = new Map(world.sessions);
  sessions.set(session.sessionId, session);
  return Object.freeze({ ...world, sessions });
}

/** Сессия из мира. Отсутствие — дефект вызывающего, а не отказ в полномочии. */
export function sessionOf(world: World, id: SessionId | string): Session {
  const session = world.sessions.get(id);
  if (session === undefined) {
    throw new AuthorityError(`app.authority.unknown_session:${String(id)}`);
  }
  return session;
}

/**
 * Отзыв сессии. Отдельный шаг мира: отозванная сессия обязана быть выразима,
 * иначе «шаг с отозванной сессией» нечем проверить.
 */
export function revokeSession(world: World, id: SessionId | string): World {
  return withSession(world, revoke(sessionOf(world, id), world.now));
}

/** Отметка активности: двигает только простой, абсолютный срок остаётся. */
export function touchSession(world: World, id: SessionId | string): World {
  return withSession(world, touch(sessionOf(world, id), world.now));
}

export function statusOfSession(world: World, id: SessionId | string): SessionStatus {
  return sessionStatus(sessionOf(world, id), world.now);
}

/* ------------------------------------------------------------------------- */
/* Предмет действия и факты о прошлом                                        */
/* ------------------------------------------------------------------------- */

/**
 * О чём шаг. От предмета зависит, какие факты поднимаются: «кто готовил этот
 * транш» и «кто готовил соседний» — разные ответы, и склеивать их нельзя.
 *
 * `platform` — шаг, не привязанный ни к сделке, ни к траншу (движение по
 * невыясненным поступлениям, конвертация остатка клиента). У него фактов нет по
 * построению, поэтому полномочие, связанное несовместимостью на фактах, с таким
 * предметом не выдаётся вовсе — и это правильный отказ, а не пробел.
 */
export type ActionSubject =
  | { readonly kind: 'deal'; readonly dealId: string }
  | { readonly kind: 'tranche'; readonly dealId: string; readonly trancheId: string }
  | { readonly kind: 'platform' };

export function dealSubject(dealId: string): ActionSubject {
  return { kind: 'deal', dealId };
}

export function trancheSubject(world: World, trancheId: string): ActionSubject {
  const runtime = trancheOf(world, trancheId);
  return { kind: 'tranche', dealId: runtime.dealId, trancheId };
}

export const PLATFORM_SUBJECT: ActionSubject = Object.freeze({ kind: 'platform' as const });

/** Относится ли факт к предмету. Факт о сделке относится и к её траншам. */
function factMatches(fact: ActionFact, subject: ActionSubject): boolean {
  if (subject.kind === 'platform') return false;
  if (fact.dealId !== subject.dealId) return false;
  if (subject.kind === 'deal') return true;
  return fact.trancheId === null || fact.trancheId === subject.trancheId;
}

function peopleOf(facts: readonly ActionFact[]): readonly ActorRef[] {
  const out: ActorRef[] = [];
  for (const fact of facts) {
    const by = fact.by;
    if (by.kind !== 'person') continue;
    if (out.some((item) => item.accountId === by.ref.accountId)) continue;
    out.push(by.ref);
  }
  return Object.freeze(out);
}

/**
 * Ответ на вопрос «кто это делал» — три исхода, а не два.
 *
 * `expected` — знает ли мир, что действие такого рода вообще было. Если было, а
 * следа нет, ответ **`UNKNOWN_FACT`**, и решение откажет: наблюдение, автор
 * которого неизвестен, не годится в основание для «утверждающий не наблюдал».
 * Если действия не было — пустой перечень, и это утверждение мира, за которое он
 * отвечает: шагов в этот мир, кроме проведённых через `Authority`, не попадает.
 */
function factOf(
  facts: readonly ActionFact[],
  subject: ActionSubject,
  kind: ActionFactKind,
  expected: boolean,
): ActorFact {
  const scoped = facts.filter((fact) => fact.kind === kind && factMatches(fact, subject));
  if (scoped.length === 0) {
    return expected ? UNKNOWN_FACT : Object.freeze([]);
  }
  return peopleOf(scoped);
}

const BLOCKED_TRANCHE_STATUSES: readonly string[] = Object.freeze(['release_blocked', 'frozen']);

/**
 * Ответ мира «я об этом предмете не знаю ничего».
 *
 * Не пустой контекст: пустой означал бы «никто ничего не делал», то есть
 * утверждение, за которое мир отвечает. Здесь мир не отвечает, и полномочие,
 * связанное несовместимостью на фактах, с таким контекстом не выдаётся.
 */
const UNKNOWN_SUBJECT_CONTEXT: ActionContext = Object.freeze({
  preparedBy: UNKNOWN_FACT,
  observedBy: UNKNOWN_FACT,
  beneficiaryChangeRequestedBy: UNKNOWN_FACT,
  causedBy: UNKNOWN_FACT,
});
const BLOCKED_DEAL_STATUSES: readonly string[] = Object.freeze(['frozen']);

/**
 * Факты разделения обязанностей — **из мира, а не из аргументов вызывающего**.
 *
 * Каждое поле отвечает на вопрос, который задаёт `evaluateSeparation`
 * (`@sdelka/auth`, Н1, Н2, Н4, Н5), и каждое имеет три исхода. Правило одно:
 * если мир видит **последствие** действия и не видит его автора — это
 * `UNKNOWN_FACT`. Транш существует, но никто не помечен готовившим; наблюдение в
 * фактах есть, а кто его внёс — неизвестно; транш заблокирован, а кто вызвал
 * расхождение — неизвестно. Во всех трёх случаях проверять нечем, значит
 * проверка не пройдена.
 */
export function actionContextFor(world: World, subject: ActionSubject): ActionContext {
  if (subject.kind === 'platform') {
    return UNKNOWN_SUBJECT_CONTEXT;
  }

  /*
   * Предмета в мире может ещё не быть: `createDeal` спрашивает разрешение до
   * того, как сделка появится. Тогда фактов нет **и не может быть**, и все
   * четыре ответа — «неизвестно»: полномочие, связанное несовместимостью на
   * фактах, с несуществующим предметом не выдастся. Для `create_deal`
   * несовместимостей нет вовсе, и контекст остаётся неиспользованным — но
   * бросать здесь нельзя, иначе завести первую сделку было бы невозможно.
   */
  const deal = world.deals.get(subject.dealId);
  if (deal === undefined) {
    return UNKNOWN_SUBJECT_CONTEXT;
  }
  const tranches =
    subject.kind === 'tranche'
      ? [world.tranches.get(subject.trancheId)]
      : deal.trancheIds.map((id) => world.tranches.get(id));
  if (tranches.some((runtime) => runtime === undefined)) {
    return UNKNOWN_SUBJECT_CONTEXT;
  }
  const known = tranches.filter((runtime) => runtime !== undefined);

  const observationExists = known.some((runtime) => runtime.facts.observation !== null);
  const beneficiaryExists = known.length > 0;
  const blocked =
    known.some((runtime) => BLOCKED_TRANCHE_STATUSES.includes(runtime.state.status)) ||
    BLOCKED_DEAL_STATUSES.includes(deal.state.status);

  return Object.freeze({
    // Предмет существует — значит его кто-то завёл. Автор обязан быть известен.
    preparedBy: factOf(world.facts, subject, 'prepared', true),
    observedBy: factOf(world.facts, subject, 'observed', observationExists),
    beneficiaryChangeRequestedBy: factOf(
      world.facts,
      subject,
      'beneficiary_requested',
      beneficiaryExists,
    ),
    causedBy: factOf(world.facts, subject, 'caused', blocked),
  });
}

/* ------------------------------------------------------------------------- */
/* Выдача разрешения                                                         */
/* ------------------------------------------------------------------------- */

function brand<O extends StepOrigin>(value: {
  readonly origin: O;
  readonly by: ActingParty;
  readonly at: Instant;
  readonly grant: Grant<Capability> | null;
}): Authority<O> {
  // Единственное приведение к `Authority` в пакете. Ниже него — три
  // конструктора, и других входов нет.
  return Object.freeze(value) as unknown as Authority<O>;
}

/**
 * Разрешение человека на шаг.
 *
 * Момент берётся из мира (`world.now`), а не приходит аргументом: свободный
 * момент означал бы, что истёкшую сессию можно оживить, назвав вчерашнее время.
 * Сессия берётся из мира по идентификатору, а не приходит значением: сессия-
 * аргумент — это сессия, которую вызывающий собрал сам, и тогда «истёкшая» и
 * «отозванная» перестают быть состояниями.
 */
export function authorize<C extends Capability>(
  world: World,
  sessionId: SessionId | string,
  capability: C,
  subject: ActionSubject,
): Result<Authority<C>, Denial> {
  return authorizeWithContext(world, sessionId, capability, actionContextFor(world, subject));
}

/**
 * Тот же выпуск разрешения, но факты приходят готовыми.
 *
 * **Из `index.ts` не экспортируется**, и это не оплошность. Функция, берущая
 * `ActionContext` аргументом, — это ровно та дверь, через которую разделение
 * обязанностей отключается: подставил четыре пустых перечня, и Н1, Н2, Н4, Н5
 * прошли. Снаружи пакета её нет; внутри её зовут два места, и оба собирают
 * факты сами — `authorize` из мира по сделке и траншу, `authorizeWithdrawal`
 * (`withdrawal.ts`) из самой заявки на вывод, у которой ни сделки, ни транша
 * нет.
 */
export function authorizeWithContext<C extends Capability>(
  world: World,
  sessionId: SessionId | string,
  capability: C,
  context: ActionContext,
): Result<Authority<C>, Denial> {
  const session = sessionOf(world, sessionId);
  const decided = decideCapability({
    session,
    capability,
    now: world.now,
    context,
  });
  if (!decided.ok) return failure(decided.error);
  const grant = decided.value;
  return ok(
    brand<C>({
      origin: capability,
      by: {
        kind: 'person',
        ref: sessionActor(session),
        roleId: session.roleId,
        sessionId: session.sessionId,
      },
      at: world.now,
      grant,
    }),
  );
}

/** То же, но отказ — исключение: вызывающий, которому отказ не сценарий. */
export function requireAuthority<C extends Capability>(
  world: World,
  sessionId: SessionId | string,
  capability: C,
  subject: ActionSubject,
): Authority<C> {
  const decided = authorize(world, sessionId, capability, subject);
  if (!decided.ok) {
    throw new AuthorityError('app.authority.denied', decided.error);
  }
  return decided.value;
}

/* ------------------------------------------------------------------------- */
/* Машинные разрешения — не экспортируются наружу пакета                     */
/* ------------------------------------------------------------------------- */

/** Переход по дедлайну и прочее действие без человека. */
export const SYSTEM_ACTOR: AuditActor = auditActor('scheduler', 'system', null);
/** Наблюдение из реестра: `condition_established` порождается оракулом (§8). */
export const ORACLE_ACTOR: AuditActor = auditActor('registry-oracle', 'oracle', null);

/**
 * Разрешение часов. **Не экспортируется из `index.ts`** — единственный
 * вызывающий — `tick` в этом же пакете. Иначе «шаг без сессии» был бы доступен
 * любому, кто напишет `clockAuthority()`: наступление срока обязано быть
 * решением планировщика, а не оправданием.
 */
export function clockAuthority(world: World): Authority<'clock'> {
  return brand<'clock'>({
    origin: 'clock',
    by: { kind: 'machine', origin: 'clock' },
    at: world.now,
    grant: null,
  });
}

/**
 * Разрешение источника наблюдения. Тоже не экспортируется наружу: его выдаёт
 * только драйвер машины `@sdelka/oracle`, исполняя её намерения, и получить его
 * можно, лишь пройдя через шаг с полномочием `record_observation`.
 */
export function oracleAuthority(world: World): Authority<'oracle_source'> {
  return brand<'oracle_source'>({
    origin: 'oracle_source',
    by: { kind: 'machine', origin: 'oracle_source' },
    at: world.now,
    grant: null,
  });
}

/* ------------------------------------------------------------------------- */
/* Актор журнала аудита                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Актор записи журнала — **выводится из разрешения, а не приходит рядом с ним**.
 *
 * Прежде шаг принимал `AuditActor` отдельным полем, и «кто записан в журнал» с
 * «кто это сделал» связаны не были ничем: `trancheOptions(policy, { actor:
 * APPROVER_ACTOR })` записывал утверждающего под действием, которое совершал
 * оператор. Разойтись больше нечему: лицо одно и то же значение.
 *
 * Роль журнала берётся `requireAuditRole` и **бросает**, если соответствия нет
 * (`ACTORS.md` §13: `AUDIT_ROLES` — восемь значений, ролей доступа
 * двенадцать). Подставить похожую роль нельзя: журнал не редактируется
 * (красная линия №11), и `principal`, записанный как `operator`, останется там
 * навсегда.
 */
export function journalActor(authority: Authority<StepOrigin>): AuditActor {
  const by = authority.by;
  if (by.kind === 'machine') {
    return by.origin === 'clock' ? SYSTEM_ACTOR : ORACLE_ACTOR;
  }
  const grant = authority.grant;
  if (grant === null) {
    throw new AuthorityError('app.authority.person_without_grant');
  }
  return auditActor(by.ref.accountId, requireAuditRole(by.roleId), grant.capability);
}

/**
 * Лицо, совершающее шаг. У машинного разрешения его нет — и это отказ, а не
 * подстановка: шаг, требующий имени человека (акт об условии, подпись под
 * откатом), машиной не совершается.
 */
export function actingPerson(authority: Authority<StepOrigin>): ActorRef {
  const by = authority.by;
  if (by.kind !== 'person') {
    throw new AuthorityError(`app.authority.machine_cannot_act:${by.origin}`);
  }
  return by.ref;
}

/** Учётная запись действующего лица — она же имя в фактах домена. */
export function actingAccount(authority: Authority<StepOrigin>): AccountId {
  return actingPerson(authority).accountId;
}

/** Роль доступа действующего лица. Уровень утверждения считается по ней. */
export function actingRole(authority: Authority<StepOrigin>): RoleId {
  const by = authority.by;
  if (by.kind !== 'person') {
    throw new AuthorityError(`app.authority.machine_cannot_act:${by.origin}`);
  }
  return by.roleId;
}

/**
 * Сверка: лицо в разрешении и лицо, которое обязано было совершить шаг, — одно.
 *
 * Нужна там, где предмет сам называет исполнителя: акт об условии совершает
 * **получатель**, названный в акте, отзыв заявляет **покупатель**, названный в
 * траншe. Расхождение — ошибка, а не пропуск: иначе акт стороны подписывался бы
 * от её имени кем угодно, у кого есть полномочие.
 */
export function requireSamePerson(
  authority: Authority<StepOrigin>,
  expectedAccountKey: string,
  what: string,
): void {
  const acting = actingPerson(authority);
  if (acting.accountId !== expectedAccountKey) {
    throw new AuthorityError(`app.authority.actor_mismatch:${what}:${expectedAccountKey}`);
  }
}

/* ------------------------------------------------------------------------- */
/* След действия                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Записать факт «этот совершил это».
 *
 * Внешнего входа у перечня фактов нет: функция принимает `Authority`, то есть
 * заявить «готовил кто-то другой» вызывающему нечем. Именно поэтому
 * `actionContextFor` можно считать источником истины для Н1, Н2, Н4 и Н5.
 */
export function recordFact(
  world: World,
  kind: ActionFactKind,
  subject: ActionSubject,
  authority: Authority<StepOrigin>,
): World {
  if (subject.kind === 'platform') return world;
  const fact: ActionFact = Object.freeze({
    kind,
    dealId: subject.dealId,
    trancheId: subject.kind === 'tranche' ? subject.trancheId : null,
    by: authority.by,
    capability: authority.origin,
    at: world.now,
  });
  // Как и выдача сессии, след действия денег не двигает: `sealed` здесь
  // проверял бы то же самое второй раз за один шаг — и падал бы в названном
  // расхождении недостачи. См. оговорку у `withSession`.
  return Object.freeze({ ...world, facts: Object.freeze([...world.facts, fact]) });
}

/* ------------------------------------------------------------------------- */
/* Рантайм-рубеж происхождения                                               */
/* ------------------------------------------------------------------------- */

/**
 * Второй рубеж к компиляционному: событие приходит значением — из очереди, из
 * порта, из-за границы процесса, — и тип его происхождения там не переживает.
 * Тот же довод, по которому `decideCapability` дублирует `decide`
 * (`@sdelka/auth`, `decide.ts`).
 */
export function assertOrigin(
  allowed: readonly StepOrigin[],
  authority: Authority<StepOrigin>,
  what: string,
): void {
  if (!allowed.includes(authority.origin)) {
    throw new AuthorityError(
      `app.authority.wrong_origin:${what}:${authority.origin}:expected(${allowed.join('|')})`,
    );
  }
}
