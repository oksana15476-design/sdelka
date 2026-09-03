import {
  type Anchor,
  type AuditActor,
  type AuditChain,
  type AuditRecordInput,
  type AuditRef,
  type NonEmpty,
  type PolicyRef,
  type RawSourceRef,
  appendRecord,
  auditActor,
  auditAmount,
  auditFingerprint,
  auditInstant,
  auditRef,
  genesisChain,
  policyRef,
} from '@sdelka/audit';
import {
  type BeneficiaryState,
  type DetectorOutcome,
  type PolicyVersionId,
  type ReviewTask,
  type ReviewTaskKind,
  lockOnFunding,
  toBeneficiaryLock,
} from '@sdelka/compliance';
import {
  type ConditionAct,
  type DealEvent,
  type DealFacts,
  type DealState,
  type Instant,
  type Intent,
  type PartyRef,
  type PayoutEvent,
  type PayoutState,
  type Rejection,
  type TrancheContext,
  type TrancheEvent,
  type TrancheFacts,
  type TrancheState,
  type TrancheTransitionResult,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_DEADLINE_POLICY,
  createPayout,
  dealState,
  initialTrancheState,
  instant,
  reduceDeal,
  reducePayout,
  reduceTranche,
} from '@sdelka/domain';
import {
  type ClientKey,
  type EntryMeta,
  type Journal,
  type JournalEntry,
  type TrancheRef,
  accountBalance,
  appendEntry,
  clientLockedAccount,
  emptyJournal,
  lockForTranche,
  unlockToClientAccount,
} from '@sdelka/ledger';
import type { ConvertedAmount, CurrencyCode, Deduction, FxRates, IsoDate, Money, PlatformSpread } from '@sdelka/money';
import { accountingFxDifference, convert, platformSpread } from '@sdelka/money';
import {
  type CreditRoute,
  convertClientBalance,
  creditIncomingPayment,
  feeOf,
  holdUnidentifiedPayment,
  projectLedgerIntent,
  projectSettlementIntent,
  returnUnidentifiedPayment,
  writeOffTransitArrived,
} from './ledger-app';
import type { RegistryExtract } from './ports';
import {
  type DealRuntime,
  type Notification,
  type SuppressedEntry,
  type TrancheRuntime,
  type World,
  coverageOk,
  dealOf,
  payerOf,
  sealed,
  trancheOf,
  withDeal,
  withTranche,
} from './world';

/* ------------------------------------------------------------------------- */
/* Акторы журнала аудита                                                     */
/* ------------------------------------------------------------------------- */

/** Переход по дедлайну и прочее действие без человека. */
export const SYSTEM_ACTOR: AuditActor = auditActor('scheduler', 'system', null);
/** Наблюдение из реестра: `condition_established` порождается оракулом (§8). */
export const ORACLE_ACTOR: AuditActor = auditActor('registry-oracle', 'oracle', null);
/**
 * Полномочия названы буква в букву как в `compliance/src/roles.ts`: у записи
 * журнала аудита поле `capability` — свободная строка, и сверить её оттуда
 * нечем (см. `test/cross-package.test.ts`).
 */
export const OPERATOR_ACTOR: AuditActor = auditActor('operator-1', 'operator', 'read_deal');
export const ANALYST_ACTOR: AuditActor = auditActor('analyst-1', 'compliance_analyst', 'lift_block');
export const APPROVER_ACTOR: AuditActor = auditActor('approver-1', 'approver', 'approve_payout');

/* ------------------------------------------------------------------------- */
/* Мир                                                                       */
/* ------------------------------------------------------------------------- */

export interface WorldSeed {
  readonly now: Instant;
  readonly chainId: string;
}

export function emptyWorld(seed: WorldSeed): World {
  const chain: AuditChain = genesisChain(seed.chainId, auditInstant(seed.now), SYSTEM_ACTOR);
  return sealed({
    now: seed.now,
    journal: emptyJournal,
    chain,
    anchors: Object.freeze<Anchor[]>([]),
    deals: new Map<string, DealRuntime>(),
    tranches: new Map<string, TrancheRuntime>(),
    tasks: Object.freeze<ReviewTask[]>([]),
    notifications: Object.freeze<Notification[]>([]),
    suppressed: Object.freeze<SuppressedEntry[]>([]),
    reissuedPayouts: Object.freeze<string[]>([]),
    checks: 0,
    seq: 0,
  });
}

function nextMeta(world: World, label: string): { readonly meta: EntryMeta; readonly seq: number } {
  const seq = world.seq + 1;
  return {
    meta: { id: `entry-${seq}-${label}`, occurredAt: new Date(world.now).toISOString() },
    seq,
  };
}

function nonEmpty<T>(items: readonly T[]): NonEmpty<T> {
  const [head, ...rest] = items;
  if (head === undefined) {
    // Красная линия №5: поручение без пакета доказательств не существует как
    // операция. Пустой пакет — ошибка сборки, а не пустой массив в записи.
    throw new Error('e2e.evidence.empty');
  }
  return [head, ...rest];
}

function record(world: World, input: AuditRecordInput): AuditChain {
  return appendRecord(world.chain, input);
}

function auditId(world: World, seq: number): string {
  return `${world.chain.chainId}:r${seq}`;
}

export function advance(world: World, milliseconds: number): World {
  return sealed({ ...world, now: instant(world.now + milliseconds), checks: world.checks });
}

/* ------------------------------------------------------------------------- */
/* Заведение сделки и транша                                                 */
/* ------------------------------------------------------------------------- */

export interface DealSpec {
  readonly dealId: string;
  readonly conditionAct: ConditionAct | null;
  readonly preparedBy: string | null;
}

export function createDeal(world: World, spec: DealSpec): World {
  const runtime: DealRuntime = {
    dealId: spec.dealId,
    state: dealState('draft'),
    conditionAct: spec.conditionAct,
    preparedBy: spec.preparedBy,
    trancheIds: Object.freeze([]),
  };
  return sealed({ ...world, deals: withDeal(world, runtime), checks: world.checks });
}

export interface TrancheSpec {
  readonly dealId: string;
  readonly trancheId: string;
  /**
   * Покупатель — он же плательщик, чья запертая часть дебетуется расчётом.
   * Обе половины личности в одном значении: сторона сделки и ключ её счёта
   * (`FUNCTIONAL.md` §2.1). Раньше здесь было три поля — `payer`,
   * `buyerPartyId` и `buyerPayerKey`, — и первые два никто не сверял между
   * собой: приложение могло назвать стороной одного, а деньги взять со счёта
   * другого.
   */
  readonly buyer: PartyRef;
  /**
   * Ключ личности покупателя в форме, которой подписан банковский платёж: с ним
   * сверяется имя отправителя (`g_payer_matches`). Это наблюдение из выписки, а
   * не сторона сделки, поэтому поле отдельное и алфавит у него свой.
   */
  readonly buyerPayerKey: string;
  readonly requiredAmount: Money<CurrencyCode>;
  readonly conditionAct: ConditionAct;
  readonly createdOn: IsoDate;
  readonly deductions: readonly Deduction[];
  readonly beneficiary: BeneficiaryState;
  readonly preparedBy: string | null;
  readonly sourceAccountKnown: boolean;
}

export function createTranche(world: World, spec: TrancheSpec): World {
  const deal = dealOf(world, spec.dealId);
  const facts: TrancheFacts = {
    requiredAmount: spec.requiredAmount,
    collectedAmount: null,
    buyerPayerKey: spec.buyerPayerKey,
    buyer: spec.buyer,
    conditionAct: spec.conditionAct,
    evidenceBundleId: null,
    // До выписки не совпало ни одно поле: отказ закрытый, а не «наверное сойдётся».
    statementFields: {
      cadastralCode: false,
      ownerDocumentNumber: false,
      share: false,
      basis: false,
      noUnexpectedEncumbrances: false,
    },
    registryOwnerIsBuyer: false,
    beneficiary: toBeneficiaryLock(spec.beneficiary),
    preparedBy: spec.preparedBy,
    approvals: Object.freeze([]),
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
    createdOn: spec.createdOn,
    officialRateAtCreation: null,
    activePayouts: 0,
    coverageOk: coverageOk(world.journal),
    sourceAccountKnown: spec.sourceAccountKnown,
    mismatchResolved: true,
  };
  const runtime: TrancheRuntime = {
    dealId: spec.dealId,
    trancheId: spec.trancheId,
    state: initialTrancheState(world.now, DEFAULT_DEADLINE_POLICY),
    facts,
    deductions: spec.deductions,
    payouts: Object.freeze([]),
    beneficiary: spec.beneficiary,
    evidence: Object.freeze([]),
    suspendedRemaining: null,
  };
  return sealed({
    ...world,
    deals: withDeal(world, { ...deal, trancheIds: [...deal.trancheIds, spec.trancheId] }),
    tranches: withTranche(world, runtime),
    checks: world.checks,
  });
}

/* ------------------------------------------------------------------------- */
/* Записи журнала аудита, не привязанные к переходу                          */
/* ------------------------------------------------------------------------- */

export interface DecisionRecord {
  readonly subject: AuditRef;
  readonly related: readonly AuditRef[];
  readonly actor: AuditActor;
  readonly outcome: DetectorOutcome | string;
  readonly policy: PolicyVersionId;
  readonly reasonKeys: readonly string[];
  readonly evidence: readonly RawSourceRef[];
}

export function recordDecision(world: World, input: DecisionRecord): World {
  const seq = world.seq + 1;
  return sealed({
    ...world,
    seq,
    chain: record(world, {
      recordId: auditId(world, seq),
      recordedAt: auditInstant(world.now),
      actor: input.actor,
      subject: input.subject,
      related: input.related,
      body: {
        kind: 'decision_made',
        outcomeKey: input.outcome,
        policy: policyRef(input.policy),
        reasonKeys: input.reasonKeys,
        evidence: nonEmpty(input.evidence),
      },
    }),
    checks: world.checks,
  });
}

/**
 * Акт получателя об условии — порождающий акт (`CORE.md` Ф13). Пишется в журнал
 * до приёма средств: без него у отложенного платежа нет основания.
 */
export function recordConditionAct(
  world: World,
  dealId: string,
  trancheId: string,
  act: ConditionAct,
  source: RawSourceRef,
  policy: PolicyVersionId,
): World {
  const seq = world.seq + 1;
  const runtime = trancheOf(world, trancheId);
  return sealed({
    ...world,
    seq,
    tranches: withTranche(world, { ...runtime, evidence: [...runtime.evidence, source] }),
    chain: record(world, {
      recordId: auditId(world, seq),
      recordedAt: auditInstant(world.now),
      actor: auditActor(act.recipient.partyId, 'client', 'sign_condition_act'),
      subject: auditRef('tranche', trancheId),
      related: [auditRef('deal', dealId)],
      body: {
        kind: 'condition_act_recorded',
        conditionType: act.conditionType,
        actorSide: 'recipient',
        act: source,
        policy: policyRef(policy),
      },
    }),
    checks: world.checks,
  });
}

/* ------------------------------------------------------------------------- */
/* Деньги, приходящие и уходящие помимо автомата транша                      */
/* ------------------------------------------------------------------------- */

function appendJournal(world: World, entry: JournalEntry): Journal {
  return appendEntry(world.journal, entry);
}

export function receiveExternalPayment(
  world: World,
  owner: ClientKey,
  amount: Money<CurrencyCode>,
): World {
  const { meta, seq } = nextMeta(world, 'top-up');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, creditIncomingPayment(meta, owner, amount)),
    checks: world.checks,
  });
}

/** Платёж третьего лица: деньги в учёте есть, обязательства перед покупателем нет. */
export function holdThirdPartyPayment(world: World, amount: Money<CurrencyCode>): World {
  const { meta, seq } = nextMeta(world, 'suspense');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, holdUnidentifiedPayment(meta, amount)),
    checks: world.checks,
  });
}

export function returnHeldPayment(world: World, amount: Money<CurrencyCode>): World {
  const { meta, seq } = nextMeta(world, 'suspense-return');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, returnUnidentifiedPayment(meta, amount)),
    checks: world.checks,
  });
}

/**
 * Списание, момент 2: деньги дошли с номинального счёта на операционный.
 *
 * Отдельный шаг приложения, а не намерение автомата: транш терминален с момента
 * 1, а приход подтверждает банковская выписка (`FUNCTIONAL.md` §3.1, «два
 * момента, а не один»). До этого шага долг перед невостребованными стоит против
 * транзита — и это видно в отчётности, как и требует документ.
 */
export function receiveWriteOffTransit(world: World, amount: Money<CurrencyCode>): World {
  const { meta, seq } = nextMeta(world, 'write-off-transit');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, writeOffTransitArrived(meta, amount)),
    checks: world.checks,
  });
}

export interface ConversionResult {
  readonly world: World;
  readonly converted: ConvertedAmount<CurrencyCode, CurrencyCode>;
  readonly spread: PlatformSpread<CurrencyCode>;
}

export function convertBalance(
  world: World,
  owner: ClientKey,
  source: Money<CurrencyCode>,
  target: CurrencyCode,
  rates: FxRates,
  asOf: IsoDate,
): ConversionResult {
  const converted = convert(source, target, rates, asOf, 'trunc');
  const spread = platformSpread(converted, 'trunc');
  // Учётная курсовая разница считается здесь же и **не складывается** со
  // спредом: это два разных показателя и два разных типа (`CORE.md` Ф5).
  accountingFxDifference(converted, 'trunc');
  const { meta, seq } = nextMeta(world, 'fx');
  return {
    world: sealed({
      ...world,
      seq,
      journal: appendJournal(world, convertClientBalance(meta, owner, converted, spread)),
      checks: world.checks,
    }),
    converted,
    spread,
  };
}

function trancheRefOf(runtime: TrancheRuntime): TrancheRef {
  return { dealId: runtime.dealId, trancheId: runtime.trancheId };
}

/**
 * Привязка свободных денег клиента к траншу.
 *
 * Намерения на это у автомата **нет**: `LedgerTemplate` знает четыре шаблона, и
 * ни один из них не про запирание. Отчёт, расхождение 2.
 */
export function lockFundsForTranche(
  world: World,
  trancheId: string,
  amount: Money<CurrencyCode>,
): World {
  const runtime = trancheOf(world, trancheId);
  const { meta, seq } = nextMeta(world, 'lock');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(world, lockForTranche(meta, payerOf(runtime), trancheRefOf(runtime), amount)),
    checks: world.checks,
  });
}

export function unlockFundsFromTranche(
  world: World,
  trancheId: string,
  amount: Money<CurrencyCode>,
): World {
  const runtime = trancheOf(world, trancheId);
  const { meta, seq } = nextMeta(world, 'unlock');
  return sealed({
    ...world,
    seq,
    journal: appendJournal(
      world,
      unlockToClientAccount(meta, payerOf(runtime), trancheRefOf(runtime), amount),
    ),
    checks: world.checks,
  });
}

/**
 * Комиссия платформы.
 *
 * Отдельного шага вывода комиссии на операционный счёт **больше нет**: расчёт
 * стал одной записью, включающей вывод (`ledger/src/entries.ts`,
 * `settleTrancheToClientAccount`), и запись без вывода конструктор отвергает.
 * Прежняя `sweepFee` выводила комиссию вторым движением; сегодня такое движение
 * создало бы недостачу по файлу транша, который расчёт уже опустошил, и
 * `sealed` уронил бы шаг на инварианте `tranche_uncovered`.
 *
 * Функция ниже считает сумму комиссии для проверок, но ничего не пишет.
 */
export function feeForTranche(world: World, trancheId: string, gross: Money<CurrencyCode>): Money<CurrencyCode> {
  return feeOf(gross, trancheOf(world, trancheId).deductions);
}

/* ------------------------------------------------------------------------- */
/* Факты транша                                                              */
/* ------------------------------------------------------------------------- */

export function patchFacts(world: World, trancheId: string, patch: Partial<TrancheFacts>): World {
  const runtime = trancheOf(world, trancheId);
  return sealed({
    ...world,
    tranches: withTranche(world, { ...runtime, facts: { ...runtime.facts, ...patch } }),
    checks: world.checks,
  });
}

export function approve(world: World, trancheId: string, userId: string): World {
  const runtime = trancheOf(world, trancheId);
  return sealed({
    ...world,
    tranches: withTranche(world, {
      ...runtime,
      facts: { ...runtime.facts, approvals: [...runtime.facts.approvals, { userId }] },
    }),
    checks: world.checks,
  });
}

/**
 * Наблюдение оракула: платная выписка приложена, пакет доказательств собран.
 * Пять полей выписки проверяются поимённо, собственник — по номеру документа.
 */
export function attachRegistryExtract(
  world: World,
  trancheId: string,
  extract: RegistryExtract,
  evidenceBundleId: string,
): World {
  const runtime = trancheOf(world, trancheId);
  const seq = world.seq + 1;
  const next: TrancheRuntime = {
    ...runtime,
    facts: {
      ...runtime.facts,
      statementFields: extract.statementFields,
      registryOwnerIsBuyer: extract.ownerIsBuyer,
      evidenceBundleId,
    },
    evidence: [...runtime.evidence, extract.rawSource],
  };
  return sealed({
    ...world,
    seq,
    tranches: withTranche(world, next),
    chain: record(world, {
      recordId: auditId(world, seq),
      recordedAt: auditInstant(world.now),
      actor: ORACLE_ACTOR,
      subject: auditRef('tranche', trancheId),
      related: [auditRef('deal', runtime.dealId)],
      body: { kind: 'evidence_attached', evidence: extract.rawSource },
    }),
    checks: world.checks,
  });
}

/* ------------------------------------------------------------------------- */
/* Автомат транша                                                            */
/* ------------------------------------------------------------------------- */

export interface TrancheEventOptions {
  readonly actor: AuditActor;
  readonly creditRoute: CreditRoute;
  /** Сырой ответ провайдера — обязателен у `settled` и `rejected`. */
  readonly payoutResponse: RawSourceRef | null;
  readonly payoutReasonKey: string | null;
  readonly taskKind: ReviewTaskKind;
  readonly policy: PolicyVersionId;
}

export function contextFor(world: World, runtime: TrancheRuntime): TrancheContext {
  return {
    now: world.now,
    dealId: runtime.dealId,
    trancheId: runtime.trancheId,
    facts: {
      ...runtime.facts,
      // Покрытие считает учёт, домен только читает (`g_coverage_ok`).
      coverageOk: coverageOk(world.journal),
      activePayouts: runtime.payouts.filter((payout) =>
        (['created', 'submitted', 'unknown'] as readonly string[]).includes(payout.status),
      ).length,
    },
    deadlinePolicy: DEFAULT_DEADLINE_POLICY,
  };
}

function payoutEventFor(event: TrancheEvent): PayoutEvent | null {
  if (event.type === 'payout_result') {
    if (event.outcome === 'settled') return { type: 'provider_confirms' };
    if (event.outcome === 'rejected') return { type: 'provider_rejects' };
    // Сетевой исход ведёт только в `unknown`: отказ — это явный ответ.
    return { type: 'timeout' };
  }
  if (event.type === 'reconciliation_resolved') {
    return event.outcome === 'settled'
      ? { type: 'reconciliation_found_in_statement' }
      : { type: 'reconciliation_absent_from_statement' };
  }
  return null;
}

interface Applied {
  readonly runtime: TrancheRuntime;
  readonly journal: Journal;
  readonly chain: AuditChain;
  readonly tasks: readonly ReviewTask[];
  readonly notifications: readonly Notification[];
  readonly suppressed: readonly SuppressedEntry[];
  readonly reissued: readonly string[];
  readonly seq: number;
}

function applyIntents(
  world: World,
  runtime: TrancheRuntime,
  transition: TrancheTransitionResult,
  event: TrancheEvent,
  options: TrancheEventOptions,
): Applied {
  let next: TrancheRuntime = { ...runtime, state: transition.state };
  let journal = world.journal;
  let chain = world.chain;
  let seq = world.seq;
  const tasks = [...world.tasks];
  const notifications = [...world.notifications];
  const suppressed = [...world.suppressed];
  const reissued = [...world.reissuedPayouts];

  if (event.type === 'funds_received' && transition.state.status === 'collected') {
    // Собранную сумму держит приложение: факты приходят снаружи на каждый вызов.
    //
    // ⚠ Условие на статус обязательно. То же событие `funds_received` уводит
    // транш в `release_blocked` при несовпадении плательщика, и деньги при
    // этом на транш **не зачисляются**. Приложение, записавшее сумму на любое
    // `funds_received`, получит возврат из `release_blocked` на сумму, которой
    // у покупателя нет: `moneyForTemplate` берёт для шаблона `refund` именно
    // `collectedAmount`. Отличить одно от другого домен не помогает никак —
    // ни события, ни намерения у этих двух исходов не различаются. Отчёт,
    // расхождение 12; ловушка закреплена тестом в сценарии 4.
    next = { ...next, facts: { ...next.facts, collectedAmount: event.amount } };
  }

  for (const intent of transition.intents) {
    switch (intent.type) {
      case 'set_deadline':
        // Забота планировщика. В журнале следа нет — и не должно быть.
        next = { ...next, suspendedRemaining: null };
        break;
      case 'suspend_deadline':
        next = { ...next, suspendedRemaining: intent.remaining };
        break;
      case 'notify':
        notifications.push({ audience: intent.audience, messageKey: intent.messageKey });
        break;
      case 'lock_beneficiary':
        next = { ...next, beneficiary: lockOnFunding(next.beneficiary) };
        next = { ...next, facts: { ...next.facts, beneficiary: toBeneficiaryLock(next.beneficiary) } };
        break;
      case 'unlock_beneficiary':
        next = { ...next, beneficiary: { ...next.beneficiary, locked: false } };
        next = { ...next, facts: { ...next.facts, beneficiary: toBeneficiaryLock(next.beneficiary) } };
        break;
      case 'build_payout_instruction':
        // ⚠ Поручение здесь только **формируется** (`STATE-MACHINES.md` §1.5:
        // «Формирование поручения с детерминированным ключом»). Материализовать
        // на этом месте `PayoutState` нельзя: его начальный статус `created`
        // входит в активные, и `g_no_active_payout` на следующем же ребре
        // запирает транш в `release_pending` навсегда. Отчёт, расхождение 6;
        // тест-надгробие — в сценарии счастливого пути.
        break;
      case 'enqueue_outbound_payout': {
        // ⚠ Переход `paying_out → paying_out` по `payout_result(unknown)` —
        // это повторный **вход** в `paying_out`, и редьюсер безусловно
        // возвращает намерения входа, среди которых «отправить поручение в
        // исходящую очередь». То есть каждый неответ банка велит выпустить
        // поручение заново — ровно то, что §2.2 объявляет невозможным. Спасает
        // только ключ идемпотентности: он детерминирован по траншу, и очередь
        // гасит повтор. Приложение, доверившееся намерению, выпустит вторую
        // выплату. Отчёт, расхождение 13.
        const active = next.payouts.find(
          (payout) =>
            payout.idempotencyKey === intent.idempotencyKey &&
            (['created', 'submitted', 'unknown'] as readonly string[]).includes(payout.status),
        );
        if (active !== undefined) {
          reissued.push(intent.idempotencyKey);
          break;
        }
        const created: PayoutState = createPayout(runtime.trancheId);
        const submitted = reducePayout(created, { type: 'payout_submitted' });
        if (!submitted.ok) {
          throw new Error(`e2e.payout.submit_rejected:${submitted.error.code}`);
        }
        next = { ...next, payouts: [...next.payouts, submitted.value.state] };
        const amount = next.facts.collectedAmount ?? next.facts.requiredAmount;
        seq += 1;
        chain = appendRecord(chain, {
          recordId: `${chain.chainId}:r${seq}`,
          recordedAt: auditInstant(world.now),
          actor: options.actor,
          subject: auditRef('payout', intent.idempotencyKey),
          related: [auditRef('tranche', runtime.trancheId), auditRef('deal', runtime.dealId)],
          body: {
            kind: 'payout_ordered',
            idempotencyKey: intent.idempotencyKey,
            amount: auditAmount(amount.currency, amount.minor),
            beneficiary: auditFingerprint('account', next.beneficiary.requisites.account),
            policy: policyRef(options.policy),
            evidencePackage: nonEmpty(next.evidence),
          },
        });
        break;
      }
      case 'enqueue_operator_task':
        // ⚠ Намерение несёт только сумму приоритета. Вид задачи, важность,
        // сторона и версия политики — обязательные поля `ReviewTask` в
        // `@sdelka/compliance`, и все четыре приложение подставляет само.
        // Отчёт, расхождение 7.
        tasks.push({
          taskId: `task-${runtime.trancheId}-${tasks.length + 1}`,
          kind: options.taskKind,
          dealId: runtime.dealId,
          trancheId: runtime.trancheId,
          partyId: next.facts.buyer.partyId,
          rankAmount: intent.priorityAmount,
          enteredAt: world.now,
          deadlineAt: null,
          severity: 'hold',
          assigneeId: null,
          policyVersionId: options.policy,
        });
        break;
      case 'post_journal_entry': {
        seq += 1;
        const projected = projectLedgerIntent(intent, {
          meta: {
            id: `entry-${seq}-${intent.template}`,
            occurredAt: new Date(world.now).toISOString(),
          },
          deductions: next.deductions,
          route: options.creditRoute,
          lockedForTranche: accountBalance(
            journal,
            clientLockedAccount(payerOf(next), intent.dealId, intent.trancheId),
            intent.amount.currency,
          ),
        });
        if (projected.kind === 'entry') {
          journal = appendEntry(journal, projected.entry);
        } else {
          suppressed.push({
            trancheId: runtime.trancheId,
            template: projected.template,
            reasonKey: projected.reasonKey,
          });
        }
        break;
      }
      case 'post_settlement_entry': {
        // ⚠ Здесь приложение ничего не решает и решать не может. Стороны и
        // ссылка на доказательства пришли в намерении, подтверждение выдал
        // автомат — подставить своего получателя нечем, а построить
        // подтверждение самому невозможно по типу. Отчёт, расхождение 3:
        // свободный параметр `recipient` исчез вместе с возможностью ошибиться.
        seq += 1;
        const projected = projectSettlementIntent(intent, {
          meta: {
            id: `entry-${seq}-settlement`,
            occurredAt: new Date(world.now).toISOString(),
          },
          deductions: next.deductions,
          route: options.creditRoute,
          lockedForTranche: accountBalance(
            journal,
            clientLockedAccount(payerOf(next), intent.dealId, intent.trancheId),
            intent.amount.currency,
          ),
        });
        if (projected.kind === 'entry') {
          journal = appendEntry(journal, projected.entry);
        }
        break;
      }
      case 'close_tranche':
        break;
      case 'freeze_tranches':
      case 'unfreeze_tranches':
        // Каскад порождает сделка, а не транш. Сюда попасть нельзя.
        throw new Error(`e2e.tranche.unexpected_intent:${intent.type}`);
      default: {
        const unexpected: never = intent;
        throw new Error(`e2e.tranche.unknown_intent:${JSON.stringify(unexpected)}`);
      }
    }
  }

  seq += 1;
  chain = appendRecord(chain, {
    recordId: `${chain.chainId}:r${seq}`,
    recordedAt: auditInstant(world.now),
    actor: options.actor,
    subject: auditRef('tranche', runtime.trancheId),
    related: [auditRef('deal', runtime.dealId)],
    body: {
      kind: 'state_transition',
      machine: 'tranche',
      from: runtime.state.status,
      to: transition.state.status,
      eventKey: event.type,
      failedGuards: [],
    },
  });

  return { runtime: next, journal, chain, tasks, notifications, suppressed, reissued, seq };
}

const DEFAULT_OPTIONS: Omit<TrancheEventOptions, 'policy'> = {
  actor: OPERATOR_ACTOR,
  creditRoute: 'external_arrival',
  payoutResponse: null,
  payoutReasonKey: null,
  taskKind: 'source_of_funds',
};

export function trancheOptions(
  policy: PolicyVersionId,
  overrides: Partial<TrancheEventOptions> = {},
): TrancheEventOptions {
  return { ...DEFAULT_OPTIONS, policy, ...overrides };
}

export interface TrancheStepResult {
  readonly world: World;
  readonly transition: TrancheTransitionResult;
}

/**
 * Один шаг автомата транша: редьюсер, проекция намерений, запись в журнал
 * аудита и проверка инвариантов. Отказ здесь — исключение: тест, ожидающий
 * отказа, пользуется `rejectTrancheEvent`.
 */
export function applyTrancheEvent(
  world: World,
  trancheId: string,
  event: TrancheEvent,
  options: TrancheEventOptions,
): TrancheStepResult {
  const runtime = trancheOf(world, trancheId);

  // Машина выплаты ведётся отдельно и **раньше** машины транша: у неё легально
  // состояние «неизвестно», которого у транша нет (`STATE-MACHINES.md` §2).
  let payouts = runtime.payouts;
  const payoutEvent = payoutEventFor(event);
  if (payoutEvent !== null && payouts.length > 0) {
    const active = payouts[payouts.length - 1];
    if (active === undefined) {
      throw new Error('e2e.payout.missing');
    }
    // ⚠ Две машины расходятся на одном и том же событии. У транша
    // `paying_out --payout_result(unknown)--> paying_out` — ребро, которое
    // можно пройти сколько угодно раз; у выплаты из `unknown` сетевого ребра
    // нет вовсе, и второй неответ она отвергает. Правильна выплата: повторный
    // неответ по тому же поручению — это то же самое «неизвестно», а не новое
    // событие, и её состояние меняться не должно. Приложение обязано знать это
    // само: домен различить два случая не помогает. Отчёт, расхождение 14.
    const repeatedUnknown =
      event.type === 'payout_result' && event.outcome === 'unknown' && active.status === 'unknown';
    if (!repeatedUnknown) {
      const moved = reducePayout(active, payoutEvent);
      if (!moved.ok) {
        throw new Error(`e2e.payout.rejected:${moved.error.code}`);
      }
      payouts = [...payouts.slice(0, -1), moved.value.state];
    }
  }

  const withPayouts: TrancheRuntime = { ...runtime, payouts };
  const result = reduceTranche(withPayouts.state, event, contextFor(world, withPayouts));
  if (!result.ok) {
    throw new Error(
      `e2e.tranche.rejected:${result.error.code}:${result.error.failedGuards.join(',')}`,
    );
  }

  const applied = applyIntents(world, withPayouts, result.value, event, options);

  let chain = applied.chain;
  let seq = applied.seq;
  if (event.type === 'payout_result' || event.type === 'reconciliation_resolved') {
    const last = applied.runtime.payouts[applied.runtime.payouts.length - 1];
    if (last !== undefined) {
      seq += 1;
      const outcome = event.type === 'payout_result' ? event.outcome : event.outcome;
      chain = appendRecord(chain, {
        recordId: `${chain.chainId}:r${seq}`,
        recordedAt: auditInstant(world.now),
        actor: options.actor,
        subject: auditRef('payout', last.idempotencyKey),
        related: [auditRef('tranche', trancheId), auditRef('deal', runtime.dealId)],
        body:
          outcome === 'unknown'
            ? {
                kind: 'payout_result',
                outcome: 'unknown',
                response: options.payoutResponse,
                reasonKey: options.payoutReasonKey ?? 'payout.response_lost',
              }
            : {
                kind: 'payout_result',
                outcome,
                response: requireResponse(options.payoutResponse),
                reasonKey: options.payoutReasonKey,
              },
      });
    }
  }

  return {
    world: sealed({
      ...world,
      seq,
      journal: applied.journal,
      chain,
      tranches: withTranche(world, applied.runtime),
      tasks: applied.tasks,
      notifications: applied.notifications,
      suppressed: applied.suppressed,
      reissuedPayouts: applied.reissued,
      checks: world.checks,
    }),
    transition: result.value,
  };
}

function requireResponse(response: RawSourceRef | null): RawSourceRef {
  if (response === null) {
    // `settled` и `rejected` без сырого ответа — это разобранные поля без
    // исходника (`CORE.md` Ф11). Тип записи их и не принимает.
    throw new Error('e2e.payout.response_required');
  }
  return response;
}

/** Отказ автомата как значение: тест, который его ждёт, обязан его разобрать. */
export function rejectTrancheEvent(
  world: World,
  trancheId: string,
  event: TrancheEvent,
): Rejection {
  const runtime = trancheOf(world, trancheId);
  const result = reduceTranche(runtime.state, event, contextFor(world, runtime));
  if (result.ok) {
    throw new Error(`e2e.tranche.unexpected_transition:${result.value.state.status}`);
  }
  return result.error;
}

/* ------------------------------------------------------------------------- */
/* Автомат сделки                                                            */
/* ------------------------------------------------------------------------- */

export function dealFactsOf(world: World, dealId: string): DealFacts {
  const deal = dealOf(world, dealId);
  return {
    trancheStatuses: deal.trancheIds.map((id) => trancheOf(world, id).state.status),
    preparedBy: deal.preparedBy,
    conditionAct: deal.conditionAct,
  };
}

export function applyDealEvent(
  world: World,
  dealId: string,
  event: DealEvent,
  options: TrancheEventOptions,
): World {
  const deal = dealOf(world, dealId);
  const result = reduceDeal(deal.state, event, {
    dealId,
    facts: dealFactsOf(world, dealId),
    now: world.now,
  });
  if (!result.ok) {
    throw new Error(`e2e.deal.rejected:${result.error.code}:${result.error.failedGuards.join(',')}`);
  }

  const seq = world.seq + 1;
  let next: World = sealed({
    ...world,
    seq,
    deals: withDeal(world, { ...deal, state: result.value.state }),
    chain: record(world, {
      recordId: auditId(world, seq),
      recordedAt: auditInstant(world.now),
      actor: options.actor,
      subject: auditRef('deal', dealId),
      related: [],
      body: {
        kind: 'state_transition',
        machine: 'deal',
        from: deal.state.status,
        to: result.value.state.status,
        eventKey: event.type,
        failedGuards: [],
      },
    }),
    checks: world.checks,
  });

  // Каскад на транши. Без него комплаенс замораживает сделку, а её транши идут
  // к автовозврату по дедлайну (`CORE.md` Ф17).
  for (const intent of result.value.intents) {
    next = applyDealCascade(next, dealId, intent, options);
  }
  return next;
}

function applyDealCascade(
  world: World,
  dealId: string,
  intent: Intent,
  options: TrancheEventOptions,
): World {
  const deal = dealOf(world, dealId);
  let next = world;
  for (const trancheId of deal.trancheIds) {
    if (intent.type === 'freeze_tranches') {
      // ⚠ Намерение несёт `FreezeReason` целиком, а у транша событий два, и
      // `compliance_hold` не принимает основание `dispute` по типу. Разделять
      // обратно приходится приложению. Отчёт, расхождение 8.
      const event: TrancheEvent =
        intent.reason === 'dispute'
          ? { type: 'dispute_raised', frozenBy: intent.frozenBy }
          : { type: 'compliance_hold', reason: intent.reason, frozenBy: intent.frozenBy };
      next = applyTrancheEvent(next, trancheId, event, options).world;
      continue;
    }
    if (intent.type === 'unfreeze_tranches') {
      next = applyTrancheEvent(
        next,
        trancheId,
        { type: 'unfreeze', userIds: intent.userIds, resume: intent.resume },
        options,
      ).world;
    }
  }
  return next;
}

export function rejectDealEvent(world: World, dealId: string, event: DealEvent): Rejection {
  const deal = dealOf(world, dealId);
  const result = reduceDeal(deal.state, event, {
    dealId,
    facts: dealFactsOf(world, dealId),
    now: world.now,
  });
  if (result.ok) {
    throw new Error(`e2e.deal.unexpected_transition:${result.value.state.status}`);
  }
  return result.error;
}

export function dealStatusOf(world: World, dealId: string): DealState['status'] {
  return dealOf(world, dealId).state.status;
}

export function trancheStatusOf(world: World, trancheId: string): TrancheState['status'] {
  return trancheOf(world, trancheId).state.status;
}

export type { PolicyRef };
