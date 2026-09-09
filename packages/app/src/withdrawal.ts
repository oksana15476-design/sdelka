import {
  type NonEmpty,
  type RawSourceRef,
  appendRecord,
  auditAmount,
  auditFingerprint,
  auditInstant,
  auditMinted,
  auditRef,
  policyRef,
} from '@sdelka/audit';
import {
  type Approval,
  type ClientAccountFacts,
  type Instant,
  type LockedPortion,
  type PartyRef,
  type Rejection,
  type SourceAccountRef,
  type WithdrawalClockPolicy,
  type WithdrawalContext,
  type WithdrawalEvent,
  type WithdrawalState,
  createWithdrawal,
  isTerminalTrancheStatus,
  isTerminalWithdrawalStatus,
  isWithdrawalStalled,
  reduceWithdrawal,
  withdrawalStateAge,
} from '@sdelka/domain';
import {
  type ClientKey,
  type EntryMeta,
  accountBalance,
  appendEntry,
  clientLockedAccount,
  freeBalance,
  refundToSourceAccount,
} from '@sdelka/ledger';
import type { CurrencyCode, Money } from '@sdelka/money';
import type { Result } from '@sdelka/domain';
import {
  type ActionContext,
  type ActorRef,
  type ApprovalRecord,
  type Capability,
  type Denial,
  UNKNOWN_FACT,
  evaluateQuorum,
  recordApproval,
} from '@sdelka/auth';
import {
  type Authority,
  AuthorityError,
  actingAccount,
  actingPerson,
  actingRole,
  assertOrigin,
  authorizeWithContext,
  journalActor,
} from './authority';
import { auditRecordId, journalEntryId } from './ids';
import { type WithdrawalOrigin, withdrawalOriginsOf } from './origins';
import {
  type WithdrawalRuntime,
  type World,
  payerOf,
  sealed,
  withWithdrawal,
  withdrawalOwner,
} from './world';

/**
 * Вывод со счёта клиента в сквозном контуре.
 *
 * ## Зачем это здесь появилось
 *
 * Машина вывода (`packages/domain/src/client-account.ts`) существовала с И12.2,
 * и её guard'ы до сегодня **не звались из продукта ни разу**: единственным их
 * вызывающим было тело теста
 * (`evaluateWithdrawalGuard('g_free_balance_sufficient', …)` в
 * `reserve-expiry.test.ts`). Такой вызов проверяет, что функция возвращает то,
 * что написано в функции, и ровно ничего больше: `reduceWithdrawal` мог бы не
 * ставить guard ни на одно ребро, и тест остался бы зелёным.
 *
 * Мутационный прогон это и показал: пять guard'ов вывода в него не входили
 * вовсе, а тот единственный, что звался, «убивался» прямым вызовом.
 *
 * Здесь вывод собран так же, как собран транш: редьюсер домена, факты,
 * посчитанные учётом, проводка из словаря, запись в журнал аудита и
 * `sealed()` — то есть проверка инвариантов после каждого шага. Guard теперь
 * стоит между клиентом и деньгами, а не рядом с ними.
 *
 * ## Где он лежит
 *
 * Рядом с `flow.ts`, в `@sdelka/app`. Прежняя редакция лежала в
 * `packages/e2e/test/support` и сама называла это временным: «место этого
 * модуля — рядом с `flow.ts`, переезд туда — первое, что стоит сделать
 * следующим». Переезд сделан: продукт в пакете сквозных **тестов** — это
 * продукт, которым не может пользоваться ни `apps/web`, ни сервер, а guard'ы
 * вывода тогда снова стоят рядом с деньгами, а не между клиентом и деньгами.
 */

/* ------------------------------------------------------------------------- */
/* Состояние                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Заявка и след поднятой задачи объявлены **в мире** (`world.ts`), рядом с
 * траншем и сделкой, и вывозятся отсюда для тех, кто читал их здесь.
 *
 * Переезд — это и есть подключение заявки к хранилищу: дельта шага строится из
 * двух значений `World`, и карта выводов, лежавшая сбоку от мира, в неё не
 * попадала вовсе.
 */
export type { WithdrawalRuntime, WithdrawalStallMark } from './world';

/**
 * Мир вместе с часами заявок.
 *
 * Сами заявки лежат **в мире** (`World.withdrawals`); здесь остаётся то, что
 * состоянием не является и в базу не ложится, — норматив владельца. Прежде пара
 * несла ещё и карту выводов, и именно поэтому заявка не доезжала до базы:
 * `stepDelta` сравнивает два `World`, а карта была снаружи.
 */
export interface WithdrawalWorld {
  readonly world: World;
  /**
   * Часы заявок: срок операции и норматив простоя.
   *
   * Лежат на сцене, а не приезжают аргументом в каждый шаг, по той же причине,
   * по которой сессии лежат в мире: политика, переданная в шаг, — это политика,
   * которую вызывающий собрал сам, и тогда норматив у каждого шага свой.
   *
   * Аргумент **обязателен**: величина принадлежит владельцу и приходит версией
   * настройки (`withdrawal-clock.ts`). Умолчание здесь означало бы норматив, до
   * которого можно докатиться, забыв параметр.
   *
   * В `World` часы не переехали намеренно: они не состояние, их нельзя
   * восстановить из базы и незачем — версия настройки приходит от владельца в
   * каждый процесс заново.
   */
  readonly clock: WithdrawalClockPolicy;
}

export function withWithdrawals(world: World, clock: WithdrawalClockPolicy): WithdrawalWorld {
  return { world, clock };
}

function runtimeOf(scene: WithdrawalWorld, withdrawalId: string): WithdrawalRuntime {
  const runtime = scene.world.withdrawals.get(withdrawalId);
  if (runtime === undefined) {
    throw new Error(`app.unknown_withdrawal:${withdrawalId}`);
  }
  return runtime;
}

/**
 * Момент и таблица сроков для шага автомата.
 *
 * Собирается **из сцены**, а не из аргумента вызывающего: «сейчас» у мира одно
 * (`world.now`), норматив — владельца. Свободные поля здесь означали бы шаг, у
 * которого своё время и свой срок.
 */
function withdrawalContext(scene: WithdrawalWorld): WithdrawalContext {
  return { now: scene.world.now, deadlinePolicy: scene.clock.deadline };
}

/* ------------------------------------------------------------------------- */
/* Факты: считает учёт, домен читает                                         */
/* ------------------------------------------------------------------------- */

/**
 * Запертые части остатка — из журнала, а не из памяти приложения.
 *
 * Ни один guard вывода в `locked` не смотрит (`g_free_balance_sufficient`
 * сравнивает только свободную часть — красная линия №1 держится тем, что
 * запертое лежит на другом счёте). Но факты обязаны быть честными целиком:
 * `lockedTotal` по ним считает то, что клиент видит на экране, и подсунуть туда
 * пустой массив значило бы проверять вывод в мире, где резервов не бывает.
 */
function lockedPortions(world: World, owner: ClientKey): readonly LockedPortion[] {
  const out: LockedPortion[] = [];
  for (const tranche of world.tranches.values()) {
    if (payerOf(tranche) !== owner) continue;
    if (isTerminalTrancheStatus(tranche.state.status)) continue;
    const account = clientLockedAccount(owner, tranche.dealId, tranche.trancheId);
    const state = tranche.state;
    if (!('deadline' in state)) continue;
    for (const currency of currenciesOf(world)) {
      const amount = accountBalance(world.journal, account, currency);
      if (amount.minor <= 0n) continue;
      out.push({
        dealId: tranche.dealId,
        trancheId: tranche.trancheId,
        amount,
        until: state.deadline.at,
      });
    }
  }
  return Object.freeze(out);
}

/** Валюты, которые вообще встречаются в журнале: остаток считается по каждой. */
function currenciesOf(world: World): readonly CurrencyCode[] {
  const seen = new Set<CurrencyCode>();
  for (const entry of world.journal.entries) {
    for (const posting of entry.postings) {
      seen.add(posting.amount.currency);
    }
  }
  return [...seen];
}

/**
 * Сколько **других** поручений этого клиента в полёте.
 *
 * ⚠ **[решение]** Активным считается вывод в `paying_out` — и только он.
 * Документ (И12.2) говорит «не более одного вывода в активных статусах» и
 * слова «активный» не определяет; широкое чтение (любой нетерминальный,
 * включая `requested` и `approved`) я пробовал первым и отбросил, когда оно
 * заклинило собственный сценарий: два утверждённых вывода запрещали бы
 * отправку друг другу навсегда, потому что выйти из `approved` можно только
 * отправкой.
 *
 * Узкое чтение и по смыслу правильнее. Guard стоит ровно на ребре
 * `approved --withdrawal_dispatched--> paying_out`, то есть говорит о
 * **поручении**, а не о намерении; у выплаты по траншу активность считается
 * так же — с момента создания поручения до терминального исхода
 * (`ACTIVE_PAYOUT_STATUSES`), а не с момента, когда о выплате подумали.
 *
 * Сам вывод в счёт не входит: считая себя, guard не пропускал бы никогда.
 */
function activeWithdrawals(scene: WithdrawalWorld, self: string, owner: ClientKey): number {
  let count = 0;
  for (const [id, runtime] of scene.world.withdrawals) {
    if (id === self) continue;
    if (withdrawalOwner(runtime) !== owner) continue;
    if (runtime.state.status !== 'paying_out') continue;
    count += 1;
  }
  return count;
}

export function withdrawalFacts(
  scene: WithdrawalWorld,
  withdrawalId: string,
): ClientAccountFacts {
  const runtime = runtimeOf(scene, withdrawalId);
  const owner = withdrawalOwner(runtime);
  return {
    free: freeBalance(scene.world.journal, owner, runtime.amount.currency),
    locked: lockedPortions(scene.world, owner),
    requestedAmount: runtime.amount,
    sourceAccount: runtime.sourceAccount,
    preparedBy: runtime.preparedBy,
    approvals: runtime.approvals,
    activeWithdrawals: activeWithdrawals(scene, withdrawalId, owner),
  };
}

/* ------------------------------------------------------------------------- */
/* Факты разделения обязанностей по заявке на вывод                          */
/* ------------------------------------------------------------------------- */

/**
 * Факты о прошлом для заявки на вывод.
 *
 * Отдельная функция, а не `actionContextFor(world, …)`: та собирает факты по
 * сделке и траншу, а у заявки на вывод нет ни того, ни другого — предметом ей
 * служит она сама. Собираются факты всё так же **из состояния**, а не из
 * аргументов вызывающего:
 *
 * - готовивший — из самой заявки, куда его положило разрешение;
 * - наблюдений у вывода не бывает вовсе — это «никто», утверждение, за которое
 *   отвечает мир, а не «неизвестно»;
 * - счёт-источник заявлен вместе с заявкой, то есть тем же лицом;
 * - вызвавший удержание — из заявки; если она `blocked`, а лица нет, факт
 *   **неизвестен**, и снятие отказывает.
 */
export function withdrawalActionContext(
  scene: WithdrawalWorld,
  withdrawalId: string,
): ActionContext {
  const runtime = runtimeOf(scene, withdrawalId);
  /*
   * Готовивший **неизвестен**, а не «его не было», когда заявка поднята из
   * хранилища: лица в схеме нет. `UNKNOWN_FACT` отказывает и Н1, и Н4 — тот же
   * закрытый отказ, что у поднятого транша (`resume.ts`).
   */
  const preparer = runtime.preparerRef === null ? UNKNOWN_FACT : Object.freeze([runtime.preparerRef]);
  return Object.freeze({
    preparedBy: preparer,
    observedBy: Object.freeze([]),
    beneficiaryChangeRequestedBy: preparer,
    causedBy:
      runtime.blockedBy !== null
        ? Object.freeze([runtime.blockedBy])
        : runtime.state.status === 'blocked'
          ? UNKNOWN_FACT
          : Object.freeze([]),
  });
}

/**
 * Разрешение на шаг по выводу. Факты берутся из заявки — см. выше; подставить
 * их вызывающему нечем, `authorizeWithContext` наружу пакета не выходит.
 */
export function authorizeWithdrawal<C extends Capability>(
  scene: WithdrawalWorld,
  sessionId: string,
  capability: C,
  withdrawalId: string,
): Result<Authority<C>, Denial> {
  return authorizeWithContext(
    scene.world,
    sessionId,
    capability,
    withdrawalActionContext(scene, withdrawalId),
  );
}

/* ------------------------------------------------------------------------- */
/* Шаги                                                                      */
/* ------------------------------------------------------------------------- */

export interface WithdrawalSpec {
  readonly withdrawalId: string;
  /**
   * Чья заявка — **сторона целиком**, а не ключ её счёта.
   *
   * Поле было `owner: ClientKey`, то есть половина личности, и половины хватало
   * ровно до тех пор, пока заявка жила в памяти: строка `sdelka.withdrawal`
   * требует `party_id`, а обратно из ключа счёта его не вывести. Достроить
   * недостающую половину при записи значило бы назвать лицо, которого никто не
   * называл; поэтому её называют здесь. Владелец остатка выводится
   * (`withdrawalOwner`), а не приезжает вторым полем, — иначе деньги списывались
   * бы с одного счёта, а строка называла бы другое лицо.
   */
  readonly party: PartyRef;
  readonly amount: Money<CurrencyCode>;
  readonly sourceAccount?: SourceAccountRef | null;
}

/**
 * Реквизиты счёта-источника — отпечаток, а не номер.
 *
 * `SourceAccountRef.accountRef` объявлен непрозрачным ключом («номера счёта в
 * домене нет и быть не должно»), и запись журнала аудита это подтверждает
 * типом: `auditFingerprint('account', …)` принимает только SHA-256. Строка
 * `source-account-1` сюда не проходит — и правильно делает.
 */
function accountFingerprintOf(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

/** Счёт-источник по умолчанию: известен и на имя плательщика (инвариант 20). */
export const KNOWN_SOURCE_ACCOUNT: SourceAccountRef = Object.freeze({
  accountRef: accountFingerprintOf(0x5010),
  holderIsPayer: true,
});

/** Тот же счёт, но владелец — не плательщик: красная линия №9 закрывает выход. */
export const FOREIGN_SOURCE_ACCOUNT: SourceAccountRef = Object.freeze({
  accountRef: accountFingerprintOf(0x5020),
  holderIsPayer: false,
});

/**
 * Заявка на вывод.
 *
 * `preparedBy` полем спецификации **больше нет**: готовивший — тот, кто завёл
 * заявку, и от него зависит Н1 у подписи (`g_preparer_not_approver` домена).
 * Свободное поле здесь означало, что готовившим можно назвать кого угодно, — то
 * есть подписать собственную заявку, назвавшись чужим именем.
 *
 * Полномочие — `conduct_withdrawal` (`ACTORS.md` §5.1.1, Ф14): завести заявку,
 * отправить поручение после подписей, отменить. Прежде здесь стояло чужое
 * `create_deal`, взятое как самое узкое существующее, потому что полномочия
 * «запросить вывод остатка» в перечне не было вовсе. Второй фактор обязателен:
 * заявка называет сумму и счёт-источник.
 */
export function requestWithdrawal(
  scene: WithdrawalWorld,
  spec: WithdrawalSpec,
  authority: Authority<'conduct_withdrawal'>,
): WithdrawalWorld {
  assertOrigin(['conduct_withdrawal'], authority, 'withdrawal.requested');
  if (scene.world.withdrawals.has(spec.withdrawalId)) {
    throw new Error(`app.withdrawal.duplicate:${spec.withdrawalId}`);
  }
  const runtime: WithdrawalRuntime = {
    // Дедлайн ставится вместе с заявкой: нетерминальной заявки без срока не
    // существует по типу (`client-account.ts`), и часы владельца — единственный
    // источник его длины.
    state: createWithdrawal(spec.withdrawalId, scene.world.now, scene.clock.deadline),
    party: spec.party,
    amount: spec.amount,
    sourceAccount: spec.sourceAccount === undefined ? KNOWN_SOURCE_ACCOUNT : spec.sourceAccount,
    preparedBy: actingAccount(authority),
    preparerRef: actingPerson(authority),
    approvals: Object.freeze([]),
    approvalRecords: Object.freeze([]),
    blockedBy: null,
    stall: null,
  };
  // Запрос вывода деньги не двигает: он их только называет. Шаг всё равно
  // запечатывается — «инварианты после каждого шага» не знает исключений, — и
  // заявка попадает в мир только через `sealed`, то есть в базу поедет
  // проверенное состояние, а не намерение.
  return {
    world: sealed({
      ...scene.world,
      withdrawals: withWithdrawal(scene.world, runtime),
      checks: scene.world.checks,
    }),
    clock: scene.clock,
  };
}

/**
 * Подпись под выводом. Своя же подпись готовившего не считается — guard'ом.
 *
 * Имя подписавшего — из разрешения, а не из аргумента: свободный `userId`
 * набирал «четыре глаза» перечислением строк. Рядом с именем кладётся запись с
 * уровнем роли: порог у вывода тот же, что у выплаты по траншу.
 */
export function approveWithdrawal(
  scene: WithdrawalWorld,
  withdrawalId: string,
  authority: Authority<'approve_payout'>,
): WithdrawalWorld {
  assertOrigin(['approve_payout'], authority, 'withdrawal.approve');
  const runtime = runtimeOf(scene, withdrawalId);
  const person = actingPerson(authority);
  const approval = recordApproval(person, actingRole(authority), scene.world.now);
  if (!approval.ok) {
    throw new AuthorityError(`app.approval.level_missing:${approval.error}`);
  }
  const signed: WithdrawalRuntime = {
    ...runtime,
    approvals: [...runtime.approvals, { userId: person.accountId }],
    approvalRecords: [...runtime.approvalRecords, approval.value],
  };
  /*
   * Подпись состояния заявки не двигает и в базу не ложится: колонок под
   * подписи в схеме нет. Мир всё равно запечатывается — иначе подпись оказалась
   * бы изменением мира мимо `sealed`, — а то, что шаг не оставил в базе следа,
   * называет дельта (`store.ts`, `withdrawal.facts_not_storable`), а не молчит.
   */
  return {
    world: sealed({
      ...scene.world,
      withdrawals: withWithdrawal(scene.world, signed),
      checks: scene.world.checks,
    }),
    clock: scene.clock,
  };
}

export interface WithdrawalStepOptions {
  readonly policy: string;
  /** Ответ банка. У `settled` и `rejected` обязателен типом записи. */
  readonly response?: RawSourceRef | null;
  readonly reasonKey?: string | null;
  /** Пакет доказательств поручения: красная линия №5 — без него поручения нет. */
  readonly evidence: NonEmpty<RawSourceRef>;
}

function meta(world: World, label: string): { readonly meta: EntryMeta; readonly seq: number } {
  const seq = world.seq + 1;
  return {
    meta: {
      id: journalEntryId(world.chain.chainId, seq, label),
      occurredAt: new Date(world.now).toISOString(),
    },
    seq,
  };
}

/**
 * Один шаг машины вывода: редьюсер домена на фактах учёта, проводка (там, где
 * деньги действительно уходят), запись в журнал аудита, проверка инвариантов.
 *
 * Отказ здесь — исключение, как у `applyTrancheEvent`. Тест, который ждёт
 * отказа, пользуется `rejectWithdrawalEvent` и разбирает `failedGuards`
 * поимённо, как требует `STATE-MACHINES.md` §7.
 */
export function applyWithdrawalEvent<E extends WithdrawalEvent>(
  scene: WithdrawalWorld,
  withdrawalId: string,
  event: E,
  authority: Authority<WithdrawalOrigin<E>>,
  options: WithdrawalStepOptions,
): WithdrawalWorld {
  assertOrigin(withdrawalOriginsOf(event), authority, `withdrawal.${event.type}`);
  const runtime = runtimeOf(scene, withdrawalId);
  if (event.type === 'withdrawal_approved') {
    requireWithdrawalQuorum(runtime);
  }
  const facts = withdrawalFacts(scene, withdrawalId);
  const result = reduceWithdrawal(runtime.state, event, facts, withdrawalContext(scene));
  if (!result.ok) {
    throw new Error(`app.withdrawal.rejected:${result.error.code}:${result.error.failedGuards.join(',')}`);
  }
  const moved: WithdrawalRuntime = {
    ...runtime,
    state: result.value.state,
    // Кто увёл вывод в удержание — след для Н5. Кладётся здесь и нигде больше.
    ...(event.type === 'withdrawal_blocked' ? { blockedBy: actingPerson(authority) } : {}),
  };
  const world = scene.world;

  /*
   * Деньги уходят **на подтверждении банка**, а не на отправке поручения.
   *
   * Между `withdrawal_dispatched` и `payout_result(settled)` сумма всё ещё
   * лежит на номинальном счёте и всё ещё принадлежит клиенту: поручение
   * отправлено, но не исполнено, и списать её раньше значило бы показать
   * клиенту ноль там, где деньги ещё его. Ровно на этот промежуток и стоит
   * `g_no_active_withdrawal`: свободный остаток второе поручение пропустит —
   * его останавливает не арифметика, а правило.
   */
  const settled = event.type === 'payout_result' || event.type === 'reconciliation_resolved'
    ? event.outcome === 'settled'
    : false;
  const { meta: entryMeta, seq: entrySeq } = meta(world, 'withdrawal');
  const journal = settled
    ? appendEntry(
        world.journal,
        refundToSourceAccount(entryMeta, withdrawalOwner(runtime), runtime.amount),
      )
    : world.journal;
  let seq = settled ? entrySeq : world.seq;

  seq += 1;
  const subject = auditRef('payout', moved.state.idempotencyKey);
  const chain = appendRecord(world.chain, {
    recordId: auditRecordId(world.chain.chainId, seq),
    recordedAt: auditInstant(world.now),
    actor: journalActor(authority),
    subject,
    related: [],
    // Ключ идемпотентности вывода — тот же UUID5, и та же беда: у каждого
    // тридцать второго девять цифр подряд, и правило `digit_run` отвергало бы
    // запись. Доказываем чеканкой из номера заявки, а не послаблением правила.
    minted: [auditMinted('withdrawal_idempotency', moved.state.withdrawalId)],
    body: bodyFor(event, moved, options),
  });

  return {
    clock: scene.clock,
    world: sealed({
      ...world,
      seq,
      journal,
      chain,
      withdrawals: withWithdrawal(world, moved),
      checks: world.checks,
    }),
  };
}

/**
 * Тело записи журнала аудита.
 *
 * ⚠ **[открыто]** У `state_transition` перечень машин закрытый —
 * `tranche | payout | deal | party_check | oracle_observation`, — и вывода в
 * нём нет. Поэтому переходы вывода пишутся тем, чем они являются по существу:
 * утверждение — решением (`decision_made`), отправка поручения и его исход —
 * теми же телами, что у выплаты по траншу (у вывода и ключ идемпотентности
 * тот же по форме). Собственная строка `withdrawal` в перечне машин была бы
 * честнее, но это правка `@sdelka/audit`, а не сквозного контура.
 */
function bodyFor(
  event: WithdrawalEvent,
  runtime: WithdrawalRuntime,
  options: WithdrawalStepOptions,
) {
  const policy = policyRef(options.policy);
  if (event.type === 'withdrawal_dispatched') {
    const source = runtime.sourceAccount;
    if (source === null) {
      // Поручение без известного счёта-источника не существует как операция:
      // `g_source_account_known` уводит вывод в `blocked` до этой строки.
      throw new Error('app.withdrawal.source_account_required');
    }
    return {
      kind: 'payout_ordered' as const,
      idempotencyKey: runtime.state.idempotencyKey,
      amount: auditAmount(runtime.amount.currency, runtime.amount.minor),
      beneficiary: auditFingerprint('account', source.accountRef),
      policy,
      evidencePackage: options.evidence,
    };
  }
  if (event.type === 'payout_result' || event.type === 'reconciliation_resolved') {
    if (event.outcome === 'unknown') {
      return {
        kind: 'payout_result' as const,
        outcome: 'unknown' as const,
        response: options.response ?? null,
        reasonKey: options.reasonKey ?? 'payout.response_lost',
      };
    }
    const response = options.response ?? null;
    if (response === null) {
      // `settled` и `rejected` без сырого ответа — разобранные поля без
      // исходника (`CORE.md` Ф11). Тип записи их и не принимает.
      throw new Error('app.withdrawal.response_required');
    }
    return {
      kind: 'payout_result' as const,
      outcome: event.outcome,
      response,
      reasonKey: options.reasonKey ?? null,
    };
  }
  return {
    kind: 'decision_made' as const,
    outcomeKey: `withdrawal.${event.type}`,
    policy,
    reasonKeys: Object.freeze([`withdrawal.${runtime.state.status}`]),
    evidence: options.evidence,
  };
}

/**
 * Кворум под выводом — набором уровней, а не числом строк.
 *
 * Ступень у вывода одна: **одна подпись уровня 1**. Лестницы тарифа у выводов
 * нет (`ClientAccountFacts` её не несёт), поэтому порог здесь не считается по
 * сумме, а берётся минимальным из выразимых, — и это самый строгий выбор из
 * доступных: «ноль подписей» невыразим типом `ApprovalRequirement`.
 *
 * ⚠ **[открыто]** Ступень вывода по сумме документом не описана. Если она
 * появится, её место — в `ClientAccountFacts` рядом с `approvals`, и тогда
 * `required` придёт оттуда, как у транша.
 */
function requireWithdrawalQuorum(runtime: WithdrawalRuntime): void {
  const quorum = evaluateQuorum({
    required: 1,
    // Готовивший известен из самой заявки: его имя положило туда разрешение, а
    // не аргумент. `UNKNOWN_FACT` остаётся выразимым и отказывает — на случай,
    // когда заявка приедет из хранилища без лица.
    preparedBy: runtime.preparerRef ?? UNKNOWN_FACT,
    approvals: runtime.approvalRecords,
  });
  if (!quorum.ok) {
    throw new AuthorityError(`app.quorum.not_met:${quorum.error}`);
  }
}

/** Отказ автомата как значение: тест, который его ждёт, обязан его разобрать. */
export function rejectWithdrawalEvent(
  scene: WithdrawalWorld,
  withdrawalId: string,
  event: WithdrawalEvent,
): Rejection {
  const runtime = runtimeOf(scene, withdrawalId);
  const result = reduceWithdrawal(
    runtime.state,
    event,
    withdrawalFacts(scene, withdrawalId),
    withdrawalContext(scene),
  );
  if (result.ok) {
    throw new Error(`app.withdrawal.unexpected_transition:${result.value.state.status}`);
  }
  return result.error;
}

export function withdrawalStatusOf(scene: WithdrawalWorld, withdrawalId: string): string {
  return runtimeOf(scene, withdrawalId).state.status;
}
