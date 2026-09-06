import {
  type Capability,
  type RoleId,
  type SecondFactorAssertion,
  challengeId,
} from '@sdelka/auth';
import {
  type DealEvent,
  type Instant,
  type TrancheEvent,
  type WithdrawalEvent,
  duration,
} from '@sdelka/domain';
import type { ObservationEvent } from '@sdelka/oracle';
import {
  type ActionSubject,
  type Authority,
  type StepOrigin,
  type World,
  DEAL_EVENT_ORIGINS,
  OBSERVATION_EVENT_ORIGINS,
  TRANCHE_EVENT_ORIGINS,
  WITHDRAWAL_EVENT_ORIGINS,
  dealSubject,
  openSession,
  requireAuthority,
  trancheOf,
  trancheSubject,
} from '@sdelka/app';

/**
 * Действующие лица сквозного контура — **сессии, а не строки**.
 *
 * ## Зачем файл появился
 *
 * До подключения `@sdelka/auth` шаги мира принимали актора журнала полем
 * `options.actor`, и сценарий писал `trancheOptions(policy, { actor:
 * APPROVER_ACTOR })` — то есть называл себя утверждающим. Проверять было нечего:
 * ни сессии, ни роли, ни полномочия за этой строкой не стояло. Теперь шаг
 * принимает `Authority`, выписать которое можно только по действующей сессии с
 * нужным полномочием, — и сценариям понадобился штат.
 *
 * ## Как устроено
 *
 * Штат — семь учётных записей и роль стороны, заводимая по идентификатору
 * участия. Имена учётных записей сохранены прежние (`operator-1`, `approver-1`,
 * `approver-2`, `analyst-1`), потому что на них стоят утверждения сценариев о
 * фактах домена: `preparedBy` и `approvals[].userId` — это те же строки, только
 * теперь они не пишутся вызывающим, а выводятся из сессии.
 *
 * Сессия **переоткрывается на момент шага**. Это не обход проверок, а их
 * прохождение: консольная политика даёт восемь часов абсолютного срока,
 * пятнадцать минут простоя и пять минут на свежесть второго фактора
 * (`CONSOLE_SESSION_POLICY`), а сценарии двигают часы сутками. Сотрудник,
 * работающий на третьи сутки сделки, входит заново — и здесь он делает ровно
 * это. Сценарии про истёкшую и отозванную сессию поэтому **не** пользуются этим
 * файлом: они держат сессию сами (`test/authority.test.ts`).
 *
 * ## Чего здесь нет
 *
 * Обхода. Ни одна обёртка ниже не собирает `Authority` сама — все зовут
 * `requireAuthority`, то есть то же решение, что и продукт. Если полномочия у
 * роли нет, разделение обязанностей нарушено или кворум не набран, сценарий
 * падает.
 */

export interface Actor {
  readonly key: string;
  readonly roleId: RoleId;
  /** Учётная запись. Она же — имя в фактах домена (`preparedBy`, `approvals`). */
  readonly accountId: string;
  /** Человек за учётной записью: второй рубеж разделения обязанностей. */
  readonly personId: string;
}

function staff(key: string, roleId: RoleId, accountId: string): Actor {
  return Object.freeze({ key, roleId, accountId, personId: `person-${accountId}` });
}

/**
 * Штат консоли.
 *
 * Разведён ровно по тем несовместимостям, ради которых `@sdelka/auth` и
 * построен: оператор **готовит** (Н1), оператор оракула **наблюдает** (Н2),
 * финансовый контролёр даёт **уровень 1**, руководитель операций — **уровень 2**
 * (Н3), а снимает удержание не тот аналитик, который его поставил (Н5). Второй
 * аналитик заведён именно поэтому, а не для симметрии.
 */
export const STAFF = Object.freeze({
  operator: staff('operator', 'operator', 'operator-1'),
  /** Второй оператор: списание невостребованного требует двух различных имён. */
  operator2: staff('operator2', 'operator', 'operator-2'),
  operator3: staff('operator3', 'operator', 'operator-3'),
  oracle: staff('oracle', 'oracle_operator', 'oracle-1'),
  analyst: staff('analyst', 'compliance_analyst', 'analyst-1'),
  /** Снимает то, чего не ставил: Н5. */
  analyst2: staff('analyst2', 'compliance_analyst', 'analyst-2'),
  analyst3: staff('analyst3', 'compliance_analyst', 'analyst-3'),
  /** ФК — уровень 1. */
  controller: staff('controller', 'financial_controller', 'approver-1'),
  /**
   * Второй ФК — тоже уровень 1. Заведён ради одного вопроса: «двое разных» и
   * «оба уровня» — разные правила, и без второго носителя уровня 1 второе из них
   * нечем проверить (снятие остановки приёма требует ФК **и** РО).
   */
  controller2: staff('controller2', 'financial_controller', 'approver-3'),
  /** РО — уровень 2. */
  head: staff('head', 'head_of_operations', 'approver-2'),
  support: staff('support', 'support', 'support-1'),
});

export type StaffKey = keyof typeof STAFF;

/**
 * Сторона сделки как действующее лицо.
 *
 * Учётная запись — идентификатор участия (`party-buyer`, `party-seller`): ровно
 * та строка, которую называет акт об условии и факты транша. Так шаг может
 * сверить «лицо в сессии и лицо, названное предметом, — одно», и подписать
 * чужой акт нечем.
 */
export function party(partyId: string): Actor {
  return Object.freeze({
    key: `party:${partyId}`,
    roleId: 'party',
    accountId: partyId,
    personId: `person-${partyId}`,
  });
}

function assertion(actor: Actor, at: Instant): SecondFactorAssertion {
  return {
    kind: 'webauthn',
    challengeId: challengeId(`challenge-${actor.accountId}`),
    verifiedAt: at,
    device: null,
  };
}

/** Час: меньше абсолютного срока и консоли (восемь), и кабинета (сутки). */
const SESSION_TTL = duration(60 * 60 * 1000);

/**
 * Открыть (или переоткрыть) сессию лица на момент мира.
 *
 * Идёт через `openSession`, то есть через `establishSession` с политикой роли:
 * консольной роли она потребует устойчивый к фишингу фактор на входе, ссылку в
 * письме отвергнет, а слишком длинный срок не выдаст. Обхода нет и здесь.
 */
export function login(world: World, actor: Actor): { world: World; sessionId: string } {
  const sessionId = `session-${actor.accountId}`;
  const opened = openSession(world, {
    sessionId,
    accountId: actor.accountId,
    personId: actor.personId,
    roleId: actor.roleId,
    onDuty: false,
    primary: { method: 'passkey', at: world.now, device: null, network: null },
    factors: [assertion(actor, world.now)],
    requestedTtl: SESSION_TTL,
  });
  if (!opened.ok) {
    throw new Error(`e2e.session.denied:${actor.key}:${opened.error}`);
  }
  return { world: opened.value.world, sessionId };
}

export interface Acted<C extends Capability> {
  readonly world: World;
  readonly authority: Authority<C>;
}

/** Войти и получить разрешение. Отказ — падение сценария, а не обход. */
export function acting<C extends Capability>(
  world: World,
  capability: C,
  subject: ActionSubject,
  actor: Actor,
): Acted<C> {
  const session = login(world, actor);
  return {
    world: session.world,
    authority: requireAuthority(session.world, session.sessionId, capability, subject),
  };
}

/* ------------------------------------------------------------------------- */
/* Кто по умолчанию делает шаг с таким полномочием                           */
/* ------------------------------------------------------------------------- */

/**
 * Умолчание — **выбор лица, а не пропуск проверки**.
 *
 * Разница с прежним `options.actor` принципиальна: там умолчание означало «шаг
 * пройдёт под каким-нибудь актором», здесь — «шаг пройдёт под тем, у кого это
 * полномочие есть, и упадёт, если разделение обязанностей его не пускает».
 * Сценарии, которым нужно именно другое лицо (вторая подпись, снятие
 * удержания не тем, кто его поставил), называют его пятым аргументом.
 */
const DEFAULT_STAFF: Partial<Record<Capability, Actor>> = Object.freeze({
  create_deal: STAFF.operator,
  verify_property: STAFF.operator,
  run_screening: STAFF.analyst,
  adjudicate_screening: STAFF.analyst,
  record_observation: STAFF.oracle,
  order_extract: STAFF.oracle,
  approve_payout: STAFF.controller,
  approve_lift_block: STAFF.controller,
  lift_block: STAFF.analyst2,
  /*
   * Механика расчёта — `ACTORS.md` §5.1.1. Носителей два, и умолчания это
   * повторяют: ОП готовит расчёт, вносит внешний факт платежа и ведёт заявку на
   * вывод; ФК двигает деньги платформы. Подставить сюда одно лицо на все пять
   * значило бы проверять сценариями ровно то устройство, от которого уходили.
   */
  prepare_settlement: STAFF.operator,
  record_bank_outcome: STAFF.operator,
  conduct_withdrawal: STAFF.operator,
  patch_tranche_facts: STAFF.operator,
  operate_treasury: STAFF.controller,
});

export function staffFor(capability: Capability): Actor {
  const actor = DEFAULT_STAFF[capability];
  if (actor === undefined) {
    throw new Error(`e2e.actors.no_default_for:${capability}`);
  }
  return actor;
}

/** Учётная запись из штата по имени: `approval_added` называет его в событии. */
export function staffByAccount(accountId: string): Actor {
  const found = Object.values(STAFF).find((item) => item.accountId === accountId);
  if (found === undefined) {
    throw new Error(`e2e.actors.unknown_account:${accountId}`);
  }
  return found;
}

/**
 * Полномочие, которым сценарий разрешает событие.
 *
 * Из перечня происхождений берётся **первое человеческое**: машинные
 * (`clock`, `oracle_source`) сценарию недоступны — их выдаёт только продукт, и
 * это проверяется тем, что взять их здесь неоткуда.
 */
export function humanOrigin(origins: readonly StepOrigin[], what: string): Capability {
  for (const origin of origins) {
    if (origin !== 'clock' && origin !== 'oracle_source') return origin;
  }
  throw new Error(`e2e.actors.machine_only:${what}`);
}

export function trancheCapability(event: TrancheEvent): Capability {
  return humanOrigin(TRANCHE_EVENT_ORIGINS[event.type], `tranche.${event.type}`);
}

export function dealCapability(event: DealEvent): Capability {
  return humanOrigin(DEAL_EVENT_ORIGINS[event.type], `deal.${event.type}`);
}

export function observationCapability(event: ObservationEvent): Capability {
  return humanOrigin(OBSERVATION_EVENT_ORIGINS[event.type], `observation.${event.type}`);
}

export function withdrawalCapability(event: WithdrawalEvent): Capability {
  return humanOrigin(WITHDRAWAL_EVENT_ORIGINS[event.type], `withdrawal.${event.type}`);
}

/** Клочные события: их не подаёт никто, кроме часов продукта. */
export function isClockEvent(event: TrancheEvent | DealEvent): boolean {
  const origins: readonly StepOrigin[] =
    event.type in TRANCHE_EVENT_ORIGINS
      ? TRANCHE_EVENT_ORIGINS[event.type as TrancheEvent['type']]
      : DEAL_EVENT_ORIGINS[event.type as DealEvent['type']];
  return origins.length === 1 && origins[0] === 'clock';
}

/* ------------------------------------------------------------------------- */
/* Лицо, которое называет сам предмет                                        */
/* ------------------------------------------------------------------------- */

/**
 * Кто обязан совершить шаг по траншу, если предмет называет исполнителя сам.
 *
 * Отзыв заявляет покупатель этого транша, новую редакцию акта принимают
 * названные в ней стороны, подпись ставит тот, чьё имя в событии. Во всех трёх
 * случаях лицо берётся **из предмета**, а не из умолчания: иначе сценарий
 * проверял бы, что шаг проходит у кого-нибудь, а не у того, кто вправе.
 */
export function trancheActor(world: World, trancheId: string, event: TrancheEvent): Actor {
  if (event.type === 'revocation_requested') {
    return party(trancheOf(world, trancheId).facts.buyer.partyId);
  }
  if (event.type === 'condition_act_amended') {
    const first = event.acceptedBy[0];
    if (first === undefined) throw new Error('e2e.actors.amendment_without_parties');
    return party(first);
  }
  if (event.type === 'approval_added') {
    return staffByAccount(event.userId);
  }
  return staffFor(trancheCapability(event));
}

export function dealActor(world: World, dealId: string, event: DealEvent): Actor {
  if (event.type === 'revocation_requested') {
    // Отзыв по сделке заявляет покупатель — тот же, что и по её траншам.
    const trancheId = firstTrancheOf(world, dealId);
    return party(trancheOf(world, trancheId).facts.buyer.partyId);
  }
  return staffFor(dealCapability(event));
}

function firstTrancheOf(world: World, dealId: string): string {
  for (const runtime of world.tranches.values()) {
    if (runtime.dealId === dealId) return runtime.trancheId;
  }
  throw new Error(`e2e.actors.deal_without_tranche:${dealId}`);
}

/** Предмет действия по событию транша либо сделки. */
export function subjectOfTranche(world: World, trancheId: string): ActionSubject {
  return trancheSubject(world, trancheId);
}

export function subjectOfDeal(dealId: string): ActionSubject {
  return dealSubject(dealId);
}
