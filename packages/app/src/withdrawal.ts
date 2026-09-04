import {
  type AuditActor,
  type NonEmpty,
  type RawSourceRef,
  appendRecord,
  auditAmount,
  auditFingerprint,
  auditInstant,
  auditRef,
  policyRef,
} from '@sdelka/audit';
import {
  type Approval,
  type ClientAccountFacts,
  type LockedPortion,
  type Rejection,
  type SourceAccountRef,
  type WithdrawalEvent,
  type WithdrawalState,
  createWithdrawal,
  isTerminalTrancheStatus,
  reduceWithdrawal,
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
import { type World, payerOf, sealed } from './world';

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

export interface WithdrawalRuntime {
  readonly state: WithdrawalState;
  readonly owner: ClientKey;
  readonly amount: Money<CurrencyCode>;
  /** `null` — счёт-источник неизвестен: вывод уйдёт в `blocked`, а не наружу. */
  readonly sourceAccount: SourceAccountRef | null;
  readonly preparedBy: string | null;
  readonly approvals: readonly Approval[];
}

/**
 * Мир вместе с выводами.
 *
 * Отдельная пара, а не поле `World`. На проверку инвариантов это не влияет:
 * каждый шаг ниже проходит через `sealed()`, и деньги вывода видны учёту так
 * же, как любые другие — вывод не заводит собственного журнала.
 *
 * ⚠ Половина работы, которая осталась и названа в отчёте: свести `withdrawals`
 * в сам `World`. Пока их две структуры, «мир» можно передать дальше без
 * выводов — и тогда шаг, который их не видит, запечатается без них.
 */
export interface WithdrawalWorld {
  readonly world: World;
  readonly withdrawals: ReadonlyMap<string, WithdrawalRuntime>;
}

export function withWithdrawals(world: World): WithdrawalWorld {
  return { world, withdrawals: new Map<string, WithdrawalRuntime>() };
}

function runtimeOf(scene: WithdrawalWorld, withdrawalId: string): WithdrawalRuntime {
  const runtime = scene.withdrawals.get(withdrawalId);
  if (runtime === undefined) {
    throw new Error(`app.unknown_withdrawal:${withdrawalId}`);
  }
  return runtime;
}

function replace(
  scene: WithdrawalWorld,
  withdrawalId: string,
  runtime: WithdrawalRuntime,
): ReadonlyMap<string, WithdrawalRuntime> {
  const next = new Map(scene.withdrawals);
  next.set(withdrawalId, runtime);
  return next;
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
  for (const [id, runtime] of scene.withdrawals) {
    if (id === self) continue;
    if (runtime.owner !== owner) continue;
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
  return {
    free: freeBalance(scene.world.journal, runtime.owner, runtime.amount.currency),
    locked: lockedPortions(scene.world, runtime.owner),
    requestedAmount: runtime.amount,
    sourceAccount: runtime.sourceAccount,
    preparedBy: runtime.preparedBy,
    approvals: runtime.approvals,
    activeWithdrawals: activeWithdrawals(scene, withdrawalId, runtime.owner),
  };
}

/* ------------------------------------------------------------------------- */
/* Шаги                                                                      */
/* ------------------------------------------------------------------------- */

export interface WithdrawalSpec {
  readonly withdrawalId: string;
  readonly owner: ClientKey;
  readonly amount: Money<CurrencyCode>;
  readonly sourceAccount?: SourceAccountRef | null;
  readonly preparedBy?: string | null;
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

export function requestWithdrawal(
  scene: WithdrawalWorld,
  spec: WithdrawalSpec,
): WithdrawalWorld {
  if (scene.withdrawals.has(spec.withdrawalId)) {
    throw new Error(`app.withdrawal.duplicate:${spec.withdrawalId}`);
  }
  const runtime: WithdrawalRuntime = {
    state: createWithdrawal(spec.withdrawalId),
    owner: spec.owner,
    amount: spec.amount,
    sourceAccount: spec.sourceAccount === undefined ? KNOWN_SOURCE_ACCOUNT : spec.sourceAccount,
    preparedBy: spec.preparedBy ?? null,
    approvals: Object.freeze([]),
  };
  const next = new Map(scene.withdrawals);
  next.set(spec.withdrawalId, runtime);
  // Запрос вывода деньги не двигает: он их только называет. Шаг всё равно
  // запечатывается — «инварианты после каждого шага» не знает исключений.
  return { world: sealed({ ...scene.world, checks: scene.world.checks }), withdrawals: next };
}

/** Подпись под выводом. Своя же подпись готовившего не считается — guard'ом. */
export function approveWithdrawal(
  scene: WithdrawalWorld,
  withdrawalId: string,
  userId: string,
): WithdrawalWorld {
  const runtime = runtimeOf(scene, withdrawalId);
  return {
    world: scene.world,
    withdrawals: replace(scene, withdrawalId, {
      ...runtime,
      approvals: [...runtime.approvals, { userId }],
    }),
  };
}

export interface WithdrawalStepOptions {
  readonly actor: AuditActor;
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
    meta: { id: `entry-${seq}-${label}`, occurredAt: new Date(world.now).toISOString() },
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
export function applyWithdrawalEvent(
  scene: WithdrawalWorld,
  withdrawalId: string,
  event: WithdrawalEvent,
  options: WithdrawalStepOptions,
): WithdrawalWorld {
  const runtime = runtimeOf(scene, withdrawalId);
  const facts = withdrawalFacts(scene, withdrawalId);
  const result = reduceWithdrawal(runtime.state, event, facts);
  if (!result.ok) {
    throw new Error(`app.withdrawal.rejected:${result.error.code}:${result.error.failedGuards.join(',')}`);
  }
  const moved: WithdrawalRuntime = { ...runtime, state: result.value.state };
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
    ? appendEntry(world.journal, refundToSourceAccount(entryMeta, runtime.owner, runtime.amount))
    : world.journal;
  let seq = settled ? entrySeq : world.seq;

  seq += 1;
  const subject = auditRef('payout', moved.state.idempotencyKey);
  const chain = appendRecord(world.chain, {
    recordId: `${world.chain.chainId}:r${seq}`,
    recordedAt: auditInstant(world.now),
    actor: options.actor,
    subject,
    related: [],
    body: bodyFor(event, moved, options),
  });

  return {
    world: sealed({ ...world, seq, journal, chain, checks: world.checks }),
    withdrawals: replace(scene, withdrawalId, moved),
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

/** Отказ автомата как значение: тест, который его ждёт, обязан его разобрать. */
export function rejectWithdrawalEvent(
  scene: WithdrawalWorld,
  withdrawalId: string,
  event: WithdrawalEvent,
): Rejection {
  const runtime = runtimeOf(scene, withdrawalId);
  const result = reduceWithdrawal(runtime.state, event, withdrawalFacts(scene, withdrawalId));
  if (result.ok) {
    throw new Error(`app.withdrawal.unexpected_transition:${result.value.state.status}`);
  }
  return result.error;
}

export function withdrawalStatusOf(scene: WithdrawalWorld, withdrawalId: string): string {
  return runtimeOf(scene, withdrawalId).state.status;
}
