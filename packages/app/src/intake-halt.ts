import {
  type AuditChain,
  type CoverageMeasurement,
  type NonEmpty,
  type RawSourceRef,
  appendRecord,
  auditAmount,
  auditInstant,
  auditRef,
  policyRef,
} from '@sdelka/audit';
import type { PolicyVersionId } from '@sdelka/compliance';
import {
  type ActionContext,
  type ApprovalRecord,
  type Capability,
  type Denial,
  recordApproval,
  sameActor,
} from '@sdelka/auth';
import { dualControlSatisfied } from '@sdelka/compliance';
import type { Result } from '@sdelka/domain';
import {
  type CoverageByCurrency,
  type InvariantViolation as LedgerInvariantViolation,
  type Journal,
  STOP_ACCEPTING_INVARIANT_CODES,
  checkLedgerInvariants,
  coverage,
} from '@sdelka/ledger';
import {
  type Authority,
  AuthorityError,
  actingPerson,
  actingRole,
  assertOrigin,
  authorizeWithContext,
  clockAuthority,
  journalActor,
} from './authority';
import { auditRecordId } from './ids';
import {
  type ActingParty,
  type AppInvariant,
  type IntakeHalt,
  type IntakeHaltLift,
  type World,
  invariantViolations,
  recorded,
  sealed,
} from './world';

/**
 * Остановка приёма новых сделок — **автомат, а не человек** (красная линия №3).
 *
 * ## Что здесь появилось и почему
 *
 * Полномочие `halt_intake` существовало с самого подключения `@sdelka/auth` и
 * прямо называло цену своего отсутствия: «цена не нажатого стоп-крана —
 * покрытие ≠ 1 (красная линия №3)» (`auth/src/capabilities.ts`). Нажать его
 * при этом было **нечем**: ни одного шага мира с этим полномочием в проекте не
 * было, и `grep 'halt_intake'` вне самого `@sdelka/auth` не давал ни одного
 * попадания. Автоматической части не было тем более: `shouldStopAcceptingDeals`
 * в `@sdelka/ledger` и представление `v_should_stop_accepting_deals` в базе
 * считали **признак** и оба честно писали «решение принимает приложение» — а
 * приложение решения не принимало. Красная линия держалась на том, что человек
 * заметит расхождение и нажмёт кнопку, которой нет.
 *
 * ## Три состояния, а не два
 *
 * 1. **Приём открыт** — `world.halt === null` и журнал не расходится.
 * 2. **Расхождение живо** — журнал показывает нарушение из
 *    `STOP_ACCEPTING_INVARIANT_CODES`. Приём закрыт **немедленно и без
 *    состояния**: заводить сделку, пока покрытие не сошлось, нельзя независимо
 *    от того, дошли ли до этого мира часы. Снимается само, когда расхождение
 *    исчезнет, — потому что это не решение, а измерение.
 * 3. **Остановка стоит** — `world.halt !== null`. Ставится автоматом на
 *    закрытии банковского дня (и стоп-краном человека), **не снимается сама
 *    никогда**: причина могла исчезнуть по-разному, и разбирает это человек.
 *
 * Разница между 2 и 3 — это и есть разница между «в любой момент» и «на конец
 * банковского дня» из красной линии. Между поступлением и довнесением недостачи
 * корреспондента покрытие законно меньше единицы (`FUNCTIONAL.md` §3.1, случай
 * А; `world.ts`, `recorded`), и остановка, срабатывающая на этом промежутке,
 * останавливала бы платформу на ровном месте: промежуток закрывается тем же
 * днём. Поэтому автомат меряет **на закрытии дня** — а до тех пор действует
 * состояние 2, которое ничего не запоминает и никого не поднимает ночью.
 *
 * ## Чего остановка не делает
 *
 * **Не удерживает чужие деньги.** Выводы клиентов и возвраты покупателю она не
 * трогает: fail-closed, превращающийся в удержание, нарушает красную линию №7
 * (`ACTORS.md` §7.4 — «остановка приёма не останавливает возвраты и выводы»).
 * Сегодня это держалось «только отсутствием guard'а у вывода»
 * (`ROADMAP.md`:1761); теперь — тем, что остановку читают ровно два шага, оба
 * входные (`flow.ts`, `createDeal`, `createTranche`), и ни один шаг вывода или
 * возврата её не спрашивает.
 */

/* ------------------------------------------------------------------------- */
/* Ключи причин                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Ключи локализации, а не текст: ни одной строки пользовательского текста в
 * коде (`CLAUDE.md`, три языка).
 */
export const INTAKE_HALT_KEYS = Object.freeze({
  /** Автомат: покрытие на закрытии банковского дня не сошлось. */
  coverageDeviation: 'intake.halt.coverage_deviation',
  /** Отказ на входе: остановка действует. */
  halted: 'intake.refused.halted',
  /** Отказ на входе: журнал расходится прямо сейчас, остановки ещё нет. */
  coverageOpen: 'intake.refused.coverage_deviation',
  /** Снятие: подписей не хватает либо они одного уровня. */
  liftQuorum: 'intake.lift.quorum_not_met',
  /** Снятие: подписал тот, кто остановил (Н5). */
  liftCauser: 'intake.lift.causer_cannot_lift',
  /** Снятие: покрытие всё ещё не сошлось. */
  liftCoverage: 'intake.lift.coverage_still_deviates',
  /** Снятие: заявки никто не поднимал. */
  liftNotRequested: 'intake.lift.not_requested',
} as const);

/** Состояние приёма в записи вечного журнала. Третьего не бывает. */
const ACCEPTING = 'accepting' as const;
const HALTED = 'halted' as const;

/* ------------------------------------------------------------------------- */
/* Измерение                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Расхождения, останавливающие приём, — перечнем **учёта**, а не своим.
 *
 * Список кодов живёт в `@sdelka/ledger` (`STOP_ACCEPTING_INVARIANT_CODES`) и
 * построчно сверен с базой (`v_should_stop_accepting_deals`). Второй его
 * экземпляр здесь означал бы третий список, расходящийся с двумя первыми молча.
 */
export function stopAcceptingViolations(
  journal: Journal,
): readonly LedgerInvariantViolation[] {
  const stopping: readonly string[] = STOP_ACCEPTING_INVARIANT_CODES;
  return Object.freeze(
    checkLedgerInvariants(journal).filter((violation) => stopping.includes(violation.code)),
  );
}

/** Покрытие по каждой валюте — то же значение, которым его считает учёт. */
export function coverageOf(world: World): readonly CoverageByCurrency[] {
  return coverage(world.journal);
}

function measurements(items: readonly CoverageByCurrency[]): readonly CoverageMeasurement[] {
  return Object.freeze(
    items.map((item) => ({
      currency: item.currency,
      custody: auditAmount(item.currency, item.custody.minor),
      obligations: auditAmount(item.currency, item.obligations.minor),
    })),
  );
}

/* ------------------------------------------------------------------------- */
/* Отказ на входе                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Приём остановлен — **отказ шага, а не предупреждение на экране**.
 *
 * Отдельный класс, а не `Error`: вызывающему нужно отличить «сделку сейчас
 * заводить нельзя» от испорченных данных, и отличить не разбором строки. Внутри
 * — сама остановка (если она стоит) и расхождения, по которым отказано.
 */
export class IntakeHaltedError extends Error {
  readonly reasonKey: string;
  /** Действующая остановка. `null` — расхождение живо, а остановки ещё нет. */
  readonly halt: IntakeHalt | null;
  readonly violations: readonly LedgerInvariantViolation[];

  constructor(
    reasonKey: string,
    what: string,
    halt: IntakeHalt | null,
    violations: readonly LedgerInvariantViolation[],
  ) {
    super(`app.intake.refused:${what}:${reasonKey}`);
    this.name = 'IntakeHaltedError';
    this.reasonKey = reasonKey;
    this.halt = halt;
    this.violations = violations;
  }
}

/** Действующая остановка приёма. `null` — приёма никто не останавливал. */
export function intakeHaltOf(world: World): IntakeHalt | null {
  return world.halt;
}

/**
 * Открыт ли приём: остановки нет **и** журнал не расходится.
 *
 * Два условия, а не одно. Первое — решение, которое снимает человек; второе —
 * измерение, которое снимается само. Склеить их значило бы либо открыть приём
 * при живом расхождении, либо оставить остановку висеть на измерении.
 */
export function isIntakeOpen(world: World): boolean {
  return world.halt === null && stopAcceptingViolations(world.journal).length === 0;
}

/**
 * Дверь на входе: заведение сделки и транша проходит через неё и ниоткуда
 * больше.
 *
 * Бросает, а не возвращает отказ значением, по той же причине, по которой
 * бросает `sealed`: шаг, которому отказано, не должен иметь возможности
 * продолжиться «с предупреждением».
 */
export function assertIntakeOpen(world: World, what: string): void {
  const halt = world.halt;
  if (halt !== null) {
    throw new IntakeHaltedError(INTAKE_HALT_KEYS.halted, what, halt, halt.violations);
  }
  const violations = stopAcceptingViolations(world.journal);
  if (violations.length > 0) {
    throw new IntakeHaltedError(INTAKE_HALT_KEYS.coverageOpen, what, null, violations);
  }
}

/* ------------------------------------------------------------------------- */
/* Автомат: закрытие банковского дня                                         */
/* ------------------------------------------------------------------------- */

export interface BankingDayClose {
  readonly world: World;
  /** Числа покрытия по каждой валюте на момент закрытия. */
  readonly coverage: readonly CoverageByCurrency[];
  /** Расхождения, останавливающие приём. Пусто — покрытие сошлось. */
  readonly violations: readonly LedgerInvariantViolation[];
  /** Остановка, действующая после закрытия. `null` — приём открыт. */
  readonly halt: IntakeHalt | null;
  /** Поставило ли остановку **это** закрытие. Повторное — не второй инцидент. */
  readonly tripped: boolean;
}

/**
 * Закрытие банковского дня: измерить покрытие и остановить приём, если оно не
 * сошлось.
 *
 * **Разрешение — часы, и взять его снаружи неоткуда.** `clockAuthority` из
 * пакета не экспортируется, поэтому «остановку поставил человек, назвавшись
 * автоматом» невыразимо, а «автомат не сработал, потому что его никто не
 * позвал» остаётся ответственностью планировщика, а не лазейкой в правиле.
 *
 * **Шаг идёт через `recorded`, а не через `sealed`.** Мир, в котором покрытие не
 * сошлось, — это ровно тот мир, ради которого шаг существует; `sealed` в нём
 * бросает по построению, и остановка оказалась бы непроводима именно тогда,
 * когда нужна. Терпимое перечисляется **поимённо и из самого мира**: шаг не
 * добавляет ни одной проводки, поэтому список нарушений до и после совпадает, а
 * любое новое нарушение по-прежнему исключение.
 *
 * **Сошедшееся покрытие остановку не снимает.** Это не упущение: см. заголовок
 * модуля и `DECISIONS-REVIEW.md` §T1 **[открыто]**.
 */
export function closeBankingDay(world: World): BankingDayClose {
  const measured = coverageOf(world);
  const violations = stopAcceptingViolations(world.journal);

  if (violations.length === 0) {
    // Покрытие сошлось. Остановка, если она стоит, остаётся стоять.
    return Object.freeze({
      world,
      coverage: measured,
      violations,
      halt: world.halt,
      tripped: false,
    });
  }
  if (world.halt !== null) {
    // Второй записи о той же остановке не появляется: журнал не редактируется,
    // и дублирующая запись через год читалась бы как второй инцидент.
    return Object.freeze({
      world,
      coverage: measured,
      violations,
      halt: world.halt,
      tripped: false,
    });
  }

  const authority = clockAuthority(world);
  const seq = world.seq + 1;
  const recordId = auditRecordId(world.chain.chainId, seq);
  const halt: IntakeHalt = Object.freeze({
    by: authority.by,
    at: world.now,
    reasonKey: INTAKE_HALT_KEYS.coverageDeviation,
    violations,
    coverage: measured,
    recordId,
    lift: null,
  });

  const step = recorded(
    {
      ...world,
      seq,
      halt,
      chain: appendRecord(world.chain, {
        recordId,
        recordedAt: auditInstant(world.now),
        actor: journalActor(authority),
        // Предмет — цепочка, то есть платформа: остановка не о сделке и не о
        // траншe. Своего охвата `platform` у ссылки журнала нет (`REF_SCOPES`),
        // и заводить его значит трогать перечень базы; названо в отчёте.
        subject: auditRef('chain', world.chain.chainId),
        related: [],
        body: {
          kind: 'state_transition',
          machine: 'intake',
          from: ACCEPTING,
          to: HALTED,
          eventKey: INTAKE_HALT_KEYS.coverageDeviation,
          failedGuards: violations.map((item) => item.code),
          coverage: measurements(measured),
        },
      }),
      checks: world.checks,
    },
    toleratedOf(world),
  );

  return Object.freeze({
    world: step.world,
    coverage: measured,
    violations,
    halt,
    tripped: true,
  });
}

/**
 * Терпимое для шага, который не двигает денег: ровно то, что мир уже нёс.
 *
 * Считается **до** шага и по самому миру, а не перечисляется вызывающим: список
 * из аргумента — это список, которым можно протащить любое расхождение. Шаги
 * этого модуля не добавляют ни одной проводки, поэтому список до и после
 * совпадает, а всё, чего в нём нет, по-прежнему роняет шаг исключением.
 */
function toleratedOf(world: World): readonly AppInvariant[] {
  return Object.freeze([...new Set(invariantViolations(world).map((item) => item.invariant))]);
}

/* ------------------------------------------------------------------------- */
/* Стоп-кран человека                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Стоп-кран: остановить приём по суждению человека (`ACTORS.md` §7.3, Ф17).
 *
 * Второго фактора у полномочия нет намеренно — он работает в 23:40 в субботу с
 * чужого телефона и только сужает. Разделение обязанностей его не разводит тоже:
 * сужающее действие, которое некому согласовать ночью, — это действие, которое
 * не совершат.
 *
 * Расхождений в записи нет: человек останавливает по своему суждению, а не по
 * нарушенному инварианту. Числа покрытия при этом записываются всё равно — через
 * год «почему остановили» читается вместе с тем, как в тот момент сходились
 * деньги.
 */
export function haltIntake(
  world: World,
  reasonKey: string,
  authority: Authority<'halt_intake'>,
): World {
  assertOrigin(['halt_intake'], authority, 'intake.halt');
  if (reasonKey.length === 0) {
    // Остановка без причины через год неотличима от сбоя.
    throw new Error('app.intake.halt.reason_required');
  }
  if (world.halt !== null) {
    // Вторая остановка поверх первой стёрла бы, кто и почему остановил первым.
    throw new Error('app.intake.halt.already_halted');
  }
  const measured = coverageOf(world);
  const seq = world.seq + 1;
  const recordId = auditRecordId(world.chain.chainId, seq);
  const halt: IntakeHalt = Object.freeze({
    by: authority.by,
    at: world.now,
    reasonKey,
    violations: Object.freeze([]),
    coverage: measured,
    recordId,
    lift: null,
  });
  const step = recorded(
    {
      ...world,
      seq,
      halt,
      chain: appendRecord(world.chain, {
        recordId,
        recordedAt: auditInstant(world.now),
        actor: journalActor(authority),
        subject: auditRef('chain', world.chain.chainId),
        related: [],
        body: {
          kind: 'state_transition',
          machine: 'intake',
          from: ACCEPTING,
          to: HALTED,
          eventKey: reasonKey,
          failedGuards: Object.freeze([]),
          coverage: measurements(measured),
        },
      }),
      checks: world.checks,
    },
    // Стоп-кран нажимают в том числе в расходящемся мире — иначе он не нужен
    // вовсе. Терпимое — то, что мир уже нёс, и ни на одну строку больше.
    toleratedOf(world),
  );
  return step.world;
}

/* ------------------------------------------------------------------------- */
/* Снятие: двое, и ни один из них не остановивший                            */
/* ------------------------------------------------------------------------- */

/**
 * Факты о прошлом для шагов по остановке.
 *
 * Отдельная функция, как у заявки на вывод (`withdrawalActionContext`), и по
 * той же причине: `actionContextFor` собирает факты по сделке и траншу, а у
 * остановки нет ни того, ни другого — предметом ей служит платформа.
 *
 * - готовивших у остановки не бывает: её не готовят, её ставят;
 * - наблюдений не бывает тоже;
 * - реквизитов не бывает;
 * - **вызвавший** — тот, кто остановил, если это был человек (Н5: снять
 *   остановку не может тот, кто её вызвал).
 *
 * ⚠ **Автоматическая остановка не называет ни одного человека, и это названное
 * ограничение, а не утверждение.** Проводки журнала актора не несут — по
 * расхождению покрытия нельзя сказать, чьё действие его внесло. Пустой перечень
 * здесь означает «остановку поставило измерение, а не чьё-то решение», и Н5 в
 * этом случае не исключает никого; настоящая защита — двое разных людей разных
 * уровней ниже. `DECISIONS-REVIEW.md` §T2 **[открыто]**.
 */
export function haltActionContext(world: World): ActionContext {
  const halt = world.halt;
  const causedBy =
    halt !== null && halt.by.kind === 'person'
      ? Object.freeze([halt.by.ref])
      : Object.freeze([]);
  return Object.freeze({
    preparedBy: Object.freeze([]),
    observedBy: Object.freeze([]),
    beneficiaryChangeRequestedBy: Object.freeze([]),
    causedBy,
  });
}

/**
 * Разрешение на шаг по остановке приёма. Факты берутся из самой остановки;
 * подставить их вызывающему нечем — `authorizeWithContext` наружу пакета не
 * выходит.
 */
export function authorizeIntake<C extends Capability>(
  world: World,
  sessionId: string,
  capability: C,
): Result<Authority<C>, Denial> {
  return authorizeWithContext(world, sessionId, capability, haltActionContext(world));
}

export interface HaltLiftRequest {
  /** Ключ локализации причины: почему приём можно открывать. Текста в коде нет. */
  readonly reasonKey: string;
  /** Сошедшаяся сверка — сырым ответом источника, а не пересказом. */
  readonly evidence: readonly RawSourceRef[];
  /**
   * Версия политики, под которой принято решение (`CORE.md` Ф11, инвариант 23).
   * Аргумент, а не константа: редакция принадлежит владельцу, и решение,
   * записанное без неё, через год не восстанавливается.
   */
  readonly policy: PolicyVersionId;
}

function haltOf(world: World): IntakeHalt {
  const halt = world.halt;
  if (halt === null) {
    throw new Error('app.intake.lift.not_halted');
  }
  return halt;
}

function signatureOf(world: World, authority: Authority<'lift_halt'>): ApprovalRecord {
  const person = actingPerson(authority);
  const approval = recordApproval(person, actingRole(authority), world.now);
  if (!approval.ok) {
    // Роль без уровня утверждения подписать не может — собрать запись нечем.
    throw new AuthorityError(`app.approval.level_missing:${approval.error}`);
  }
  return approval.value;
}

/**
 * Запись о поднятой заявке на снятие — **решение**, а не переход: состояние
 * приёма ею не меняется. Основание и редакция политики обязательны типом
 * записи, и это ровно то, чего требует §7.4 от снятия.
 */
function requestRecord(
  world: World,
  halt: IntakeHalt,
  lift: IntakeHaltLift,
  authority: Authority<'lift_halt'>,
  seq: number,
): AuditChain {
  return appendRecord(world.chain, {
    recordId: auditRecordId(world.chain.chainId, seq),
    recordedAt: auditInstant(world.now),
    actor: journalActor(authority),
    subject: auditRef('chain', world.chain.chainId),
    related: [],
    body: {
      kind: 'decision_made',
      outcomeKey: 'intake.halt_lift_requested',
      policy: policyRef(lift.policy),
      // Причина заявки и причина самой остановки: снимают конкретную остановку,
      // а не остановку вообще.
      reasonKeys: [lift.reasonKey, halt.reasonKey],
      evidence: lift.evidence,
    },
  });
}

/**
 * Первая подпись: поднять заявку на снятие остановки.
 *
 * Полномочие — `lift_halt`: расширяющее, со вторым фактором, и его нет ни у
 * дежурного, ни у оператора (`ACTORS.md` §7.3). Основание обязательно и
 * непусто: «снятие требует сошедшейся сверки, а не объяснения» (§7.4).
 *
 * Заявка ничего не открывает сама. Приём остаётся остановленным до второй
 * подписи — и это видно значением: `world.halt` не `null`.
 */
export function requestHaltLift(
  world: World,
  request: HaltLiftRequest,
  authority: Authority<'lift_halt'>,
): World {
  assertOrigin(['lift_halt'], authority, 'intake.lift.request');
  const halt = haltOf(world);
  if (halt.lift !== null) {
    // Вторая заявка потеряла бы подписи под первой.
    throw new Error('app.intake.lift.already_requested');
  }
  if (request.reasonKey.length === 0) {
    throw new Error('app.intake.lift.reason_required');
  }
  const [head, ...rest] = request.evidence;
  if (head === undefined) {
    throw new Error('app.intake.lift.evidence_required');
  }
  const evidence: NonEmpty<RawSourceRef> = [head, ...rest];
  const lift: IntakeHaltLift = Object.freeze({
    reasonKey: request.reasonKey,
    evidence,
    policy: request.policy,
    openedAt: world.now,
    signatures: Object.freeze([signatureOf(world, authority)]),
  });
  const seq = world.seq + 1;
  const step = recorded(
    {
      ...world,
      seq,
      halt: Object.freeze({ ...halt, lift }),
      chain: requestRecord(world, halt, lift, authority, seq),
      checks: world.checks,
    },
    toleratedOf(world),
  );
  return step.world;
}

/**
 * Вторая подпись — она же снятие остановки.
 *
 * Три правила, и ни одно не про полномочие (полномочие уже проверено выдачей
 * `Authority`):
 *
 * 1. **Двое разных.** Различность учётных записей и достаточность считает общий
 *    примитив `dualControlSatisfied` (`@sdelka/compliance`) — тот самый, ради
 *    которого правило «две различные записи, и ни одна не готовила» в проекте
 *    одно, а не пять.
 * 2. **Оба уровня.** ФК даёт уровень 1, РО — уровень 2 (`ACTORS.md` §5.2, §7.4:
 *    «ФК + РО»). Двух подписей одного уровня недостаточно: иначе один и тот же
 *    финансовый контролёр закрывал бы остановку в паре с коллегой по смене.
 * 3. **Не остановивший.** Н5 — снять не может тот, кто остановил. Проверяется и
 *    здесь, и полномочием (`haltActionContext`): полномочие отказывает до шага,
 *    а эта проверка ловит подпись, поставленную до того, как остановил тот же
 *    человек.
 *
 * И сверх правил — **измерение**: пока покрытие не сошлось, снимать нечего
 * («Покрытие не сошлось — снимает **никто**», §7.4). Отказ здесь закрытый:
 * приём остаётся остановленным.
 */
export function liftIntakeHalt(
  world: World,
  authority: Authority<'lift_halt'>,
): World {
  assertOrigin(['lift_halt'], authority, 'intake.lift');
  const halt = haltOf(world);
  const lift = halt.lift;
  if (lift === null) {
    throw new IntakeHaltedError(
      INTAKE_HALT_KEYS.liftNotRequested,
      'intake.lift',
      halt,
      halt.violations,
    );
  }

  const live = stopAcceptingViolations(world.journal);
  if (live.length > 0) {
    throw new IntakeHaltedError(INTAKE_HALT_KEYS.liftCoverage, 'intake.lift', halt, live);
  }

  const signatures: readonly ApprovalRecord[] = [
    ...lift.signatures,
    signatureOf(world, authority),
  ];
  const halted: ActingParty = halt.by;
  if (
    halted.kind === 'person' &&
    signatures.some((item) => sameActor(item.actor, halted.ref))
  ) {
    throw new IntakeHaltedError(INTAKE_HALT_KEYS.liftCauser, 'intake.lift', halt, halt.violations);
  }
  const distinct = dualControlSatisfied({
    // Остановивший — если это был человек — в счёт подписей не идёт вовсе.
    // Машина учётной записи не имеет: `null` здесь означает «остановило
    // измерение», и это выразимо типом примитива.
    preparedBy: halted.kind === 'person' ? halted.ref.accountId : null,
    approvals: signatures.map((item) => item.actor.accountId),
    requiredApprovals: 2,
  });
  const levels = new Set(signatures.map((item) => item.level));
  if (!distinct || !levels.has(1) || !levels.has(2)) {
    throw new IntakeHaltedError(INTAKE_HALT_KEYS.liftQuorum, 'intake.lift', halt, halt.violations);
  }

  const seq = world.seq + 1;
  const measured = coverageOf(world);
  return sealed({
    ...world,
    seq,
    // Приём открыт. Остановка остаётся в вечном журнале двумя записями —
    // срабатыванием и снятием, — а из мира уходит: она **состояние**, а не
    // история (историю правит только новая запись, красная линия №11).
    halt: null,
    chain: appendRecord(world.chain, {
      recordId: auditRecordId(world.chain.chainId, seq),
      recordedAt: auditInstant(world.now),
      actor: journalActor(authority),
      subject: auditRef('chain', world.chain.chainId),
      related: [],
      body: {
        kind: 'state_transition',
        machine: 'intake',
        from: HALTED,
        to: ACCEPTING,
        eventKey: lift.reasonKey,
        // Расхождений нет — их отсутствие и есть основание снятия; числа рядом.
        failedGuards: Object.freeze([]),
        coverage: measurements(measured),
      },
    }),
    checks: world.checks,
  });
}
