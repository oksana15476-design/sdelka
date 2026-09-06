import type { CompliancePolicy, PolicyVersionId } from '@sdelka/compliance';
import type {
  ConditionAct,
  DealEvent,
  FilingSource,
  TrancheEvent,
  TrancheFacts,
  WithdrawalEvent,
} from '@sdelka/domain';
import type { ObservationEvent } from '@sdelka/oracle';
import { dueTrancheEvent } from '@sdelka/domain';
import type { CurrencyCode, FxRates, IsoDate, Money } from '@sdelka/money';
import type { ClientKey, FxExecution, RecognisedShortfall } from '@sdelka/ledger';
import type { RawSourceRef } from '@sdelka/audit';
import type { Authority } from '@sdelka/app';
import type { Capability } from '@sdelka/auth';
import {
  type ConversionResult,
  type CorrectionRequest,
  type DealSpec,
  type DecisionRecord,
  type ObservationStepResult,
  type RegistryExtract,
  type ShortfallRecognition,
  type TrancheEventOptions,
  type TrancheSpec,
  type TrancheStepResult,
  type HaltLiftRequest,
  type UnwindRequest,
  type WithdrawalSpec,
  type WithdrawalStepOptions,
  type WithdrawalWorld,
  type World,
  advance,
  expireDeal,
  tickTranche,
  approve as appApprove,
  approveUnwind as appApproveUnwind,
  approveWithdrawal as appApproveWithdrawal,
  absorbIncomingShortfall as appAbsorbIncomingShortfall,
  applyDealEvent as appApplyDealEvent,
  applyObservationEvent as appApplyObservationEvent,
  applyTrancheEvent as appApplyTrancheEvent,
  applyWithdrawalEvent as appApplyWithdrawalEvent,
  attachObservation as appAttachObservation,
  authorizeUnwind as appAuthorizeUnwind,
  convertBalance as appConvertBalance,
  correctPayoutReason as appCorrectPayoutReason,
  createDeal as appCreateDeal,
  createTranche as appCreateTranche,
  executeBalanceConversion as appExecuteBalanceConversion,
  fundIncomingShortfall as appFundIncomingShortfall,
  holdThirdPartyPayment as appHoldThirdPartyPayment,
  patchFacts as appPatchFacts,
  receiveConvertedBalance as appReceiveConvertedBalance,
  receiveExternalPayment as appReceiveExternalPayment,
  receivePaidExtract as appReceivePaidExtract,
  receiveTrancheFee as appReceiveTrancheFee,
  receiveWriteOffTransit as appReceiveWriteOffTransit,
  recordConditionAct as appRecordConditionAct,
  recordDecision as appRecordDecision,
  registerFiling as appRegisterFiling,
  requestUnwind as appRequestUnwind,
  requestWithdrawal as appRequestWithdrawal,
  haltIntake as appHaltIntake,
  liftIntakeHalt as appLiftIntakeHalt,
  requestHaltLift as appRequestHaltLift,
  authorizeIntake,
  returnHeldPayment as appReturnHeldPayment,
  authorizeWithdrawal,
  PLATFORM_SUBJECT,
  sendBalanceForConversion as appSendBalanceForConversion,
  trancheOf,
} from '@sdelka/app';
import {
  type Actor,
  STAFF,
  acting,
  login,
  dealActor,
  dealCapability,
  isClockEvent,
  observationCapability,
  party,
  staffFor,
  subjectOfDeal,
  subjectOfTranche,
  trancheActor,
  trancheCapability,
  withdrawalCapability,
} from './actors';

/**
 * Шаги мира от лица действующего штата.
 *
 * Имена совпадают с именами в `@sdelka/app` намеренно: сценарий отличается от
 * прежнего только строкой импорта. Отличие по существу одно и оно в том, что
 * каждый вызов ниже сначала **входит в систему** и **получает разрешение**, а
 * потом уже делает шаг. Обёртка ничего не смягчает: `requireAuthority` — то же
 * решение, что в продукте, и его отказ роняет сценарий.
 *
 * Пятым (последним) аргументом всюду, где это осмысленно, идёт `as` — лицо,
 * которым совершается шаг. Он **необязателен**, и это безопасно ровно потому,
 * что умолчание здесь — не «проверку пропустить», а «взять того, у кого это
 * полномочие есть»: без полномочия шаг всё равно не пройдёт. Сценарии, которым
 * важно **кто именно** (вторая подпись, снятие удержания не автором), называют
 * лицо явно.
 */

/* ------------------------------------------------------------------------- */
/* Сделка и транш                                                            */
/* ------------------------------------------------------------------------- */

export function createDeal(world: World, spec: DealSpec, as: Actor = STAFF.operator): World {
  const step = acting(world, 'create_deal', subjectOfDeal(spec.dealId), as);
  return appCreateDeal(step.world, spec, step.authority);
}

export function createTranche(world: World, spec: TrancheSpec, as: Actor = STAFF.operator): World {
  const step = acting(world, 'create_deal', subjectOfDeal(spec.dealId), as);
  return appCreateTranche(step.world, spec, step.authority);
}

export function recordDecision(
  world: World,
  dealId: string,
  input: DecisionRecord,
  as: Actor = STAFF.analyst,
): World {
  const step = acting(world, 'adjudicate_screening', subjectOfDeal(dealId), as);
  return appRecordDecision(step.world, input, step.authority);
}

/**
 * Акт об условии совершает **получатель, названный в акте**. Лицо берётся
 * оттуда же, а не из умолчания: подписать чужой акт не должно быть возможно.
 */
export function recordConditionAct(
  world: World,
  dealId: string,
  trancheId: string,
  act: ConditionAct,
  source: RawSourceRef,
  policy: PolicyVersionId,
  as: Actor = party(act.recipient.partyId),
): World {
  const step = acting(world, 'record_condition_act', subjectOfTranche(world, trancheId), as);
  return appRecordConditionAct(step.world, dealId, trancheId, act, source, policy, step.authority);
}

export function patchFacts(
  world: World,
  trancheId: string,
  patch: Partial<TrancheFacts>,
  as: Actor = STAFF.operator,
): World {
  const step = acting(world, 'patch_tranche_facts', subjectOfTranche(world, trancheId), as);
  return appPatchFacts(step.world, trancheId, patch, step.authority);
}

export function approve(world: World, trancheId: string, as: Actor = STAFF.controller): World {
  const step = acting(world, 'approve_payout', subjectOfTranche(world, trancheId), as);
  return appApprove(step.world, trancheId, step.authority);
}

/* ------------------------------------------------------------------------- */
/* Деньги помимо автомата                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Шаг с предметом «платформа»: он не привязан ни к сделке, ни к траншу. Фактов
 * у такого предмета нет, и полномочие, связанное несовместимостью **на
 * фактах**, с ним не выдалось бы вовсе — поэтому ни у одного из пяти полномочий
 * механики расчёта таких несовместимостей нет (`ACTORS.md` §5.1.1).
 */
function platform<C extends Capability>(
  world: World,
  capability: C,
  as: Actor,
): { world: World; authority: Authority<C> } {
  return acting(world, capability, PLATFORM_SUBJECT, as);
}

export function receiveExternalPayment(
  world: World,
  owner: ClientKey,
  amount: Money<CurrencyCode>,
  as: Actor = STAFF.operator,
): World {
  const step = platform(world, 'record_bank_outcome', as);
  return appReceiveExternalPayment(step.world, owner, amount, step.authority);
}

export function holdThirdPartyPayment(
  world: World,
  amount: Money<CurrencyCode>,
  as: Actor = STAFF.operator,
): World {
  const step = platform(world, 'record_bank_outcome', as);
  return appHoldThirdPartyPayment(step.world, amount, step.authority);
}

export function returnHeldPayment(
  world: World,
  amount: Money<CurrencyCode>,
  as: Actor = STAFF.operator,
): World {
  const step = platform(world, 'record_bank_outcome', as);
  return appReturnHeldPayment(step.world, amount, step.authority);
}

export function receiveWriteOffTransit(
  world: World,
  amount: Money<CurrencyCode>,
  as: Actor = STAFF.operator,
): World {
  const step = platform(world, 'record_bank_outcome', as);
  return appReceiveWriteOffTransit(step.world, amount, step.authority);
}

export function absorbIncomingShortfall(
  world: World,
  owner: ClientKey,
  received: Money<CurrencyCode>,
  shortfall: Money<CurrencyCode>,
  as: Actor = STAFF.controller,
): ShortfallRecognition {
  const step = platform(world, 'operate_treasury', as);
  return appAbsorbIncomingShortfall(step.world, owner, received, shortfall, step.authority);
}

export function fundIncomingShortfall(
  world: World,
  recognised: RecognisedShortfall,
  as: Actor = STAFF.controller,
): World {
  const step = platform(world, 'operate_treasury', as);
  return appFundIncomingShortfall(step.world, recognised, step.authority);
}

export function receiveTrancheFee(
  world: World,
  dealId: string,
  trancheId: string,
  amount: Money<CurrencyCode>,
  as: Actor = STAFF.controller,
): World {
  // Предмет — транш, а не платформа: комиссия приходит по конкретному траншу, и
  // фактов у него хватает. Полномочие всё равно казначейское — деньги идут на
  // операционный счёт, то есть это наши деньги, а не ведение сделки.
  const step = acting(world, 'operate_treasury', subjectOfTranche(world, trancheId), as);
  return appReceiveTrancheFee(step.world, dealId, trancheId, amount, step.authority);
}

export function sendBalanceForConversion(
  world: World,
  owner: ClientKey,
  execution: FxExecution,
  as: Actor = STAFF.controller,
): World {
  const step = platform(world, 'operate_treasury', as);
  return appSendBalanceForConversion(step.world, owner, execution, step.authority);
}

export function executeBalanceConversion(
  world: World,
  owner: ClientKey,
  execution: FxExecution,
  as: Actor = STAFF.controller,
): World {
  const step = platform(world, 'operate_treasury', as);
  return appExecuteBalanceConversion(step.world, owner, execution, step.authority);
}

export function receiveConvertedBalance(
  world: World,
  owner: ClientKey,
  execution: FxExecution,
  spread: Parameters<typeof appReceiveConvertedBalance>[3],
  as: Actor = STAFF.controller,
): World {
  const step = platform(world, 'operate_treasury', as);
  return appReceiveConvertedBalance(step.world, owner, execution, spread, step.authority);
}

export function convertBalance(
  world: World,
  owner: ClientKey,
  conversionId: string,
  source: Money<CurrencyCode>,
  rates: FxRates,
  asOf: IsoDate,
  as: Actor = STAFF.controller,
): ConversionResult {
  const step = platform(world, 'operate_treasury', as);
  return appConvertBalance(step.world, owner, conversionId, source, rates, asOf, step.authority);
}

/* ------------------------------------------------------------------------- */
/* Наблюдение                                                                */
/* ------------------------------------------------------------------------- */

export function attachObservation(
  world: World,
  trancheId: string,
  extract: RegistryExtract,
  evidenceBundleId: string,
  policy: CompliancePolicy,
  as: Actor = STAFF.oracle,
): World {
  const step = acting(world, 'record_observation', subjectOfTranche(world, trancheId), as);
  return appAttachObservation(step.world, trancheId, extract, evidenceBundleId, policy, step.authority);
}

export function receivePaidExtract(
  world: World,
  trancheId: string,
  extract: RegistryExtract,
  evidenceBundleId: string,
  policy: CompliancePolicy,
  options: TrancheEventOptions,
  as: Actor = STAFF.oracle,
): ObservationStepResult {
  const step = acting(world, 'record_observation', subjectOfTranche(world, trancheId), as);
  return appReceivePaidExtract(
    step.world,
    trancheId,
    extract,
    evidenceBundleId,
    policy,
    step.authority,
    options,
  );
}

export function applyObservationEvent<E extends ObservationEvent>(
  world: World,
  trancheId: string,
  event: E,
  options: TrancheEventOptions,
  as?: Actor,
): ObservationStepResult {
  const capability = observationCapability(event);
  const actor = as ?? staffFor(capability);
  const step = acting(world, capability, subjectOfTranche(world, trancheId), actor);
  return appApplyObservationEvent(
    step.world,
    trancheId,
    event,
    step.authority as Parameters<typeof appApplyObservationEvent<E>>[3],
    options,
  );
}

/* ------------------------------------------------------------------------- */
/* Автоматы транша и сделки                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Шаг автомата транша.
 *
 * События часов (`reserve_expired`, `deadline_reached`) сюда **не подаются**:
 * их разрешает только происхождение `clock`, а его выдаёт продукт и никто
 * больше. Вместо подачи вызывается `tickTranche` — то есть сценарий обязан
 * сначала довести время до срока. Прежде такое событие подавалось на траншe, у
 * которого срок ещё не наступил, и никто этого не замечал.
 */
export function applyTrancheEvent<E extends TrancheEvent>(
  world: World,
  trancheId: string,
  event: E,
  options: TrancheEventOptions,
  as?: Actor,
): TrancheStepResult {
  if (isClockEvent(event)) {
    // Часы двигает **время**, а не вызывающий: сценарий доводится до срока и
    // спрашивает часы, что они порождают. Если порождают не то, о чём сценарий
    // утверждает, — это расхождение таблицы часов с ожиданием сценария, и оно
    // обязано падать здесь, а не тихо пройти под другим событием.
    const atDue = toDeadline(world, trancheId);
    const due = dueTrancheEvent(trancheOf(atDue, trancheId).state, atDue.now);
    if (due === null || due.type !== event.type) {
      throw new Error(
        `e2e.clock.not_due:${trancheId}:${event.type}:got=${due?.type ?? 'none'}:status=${trancheOf(atDue, trancheId).state.status}`,
      );
    }
    const ticked = tickTranche(atDue, trancheId, options);
    if (ticked === null) {
      throw new Error(`e2e.clock.silent:${trancheId}:${event.type}`);
    }
    return ticked;
  }
  const capability = trancheCapability(event);
  const actor = as ?? trancheActor(world, trancheId, event);
  const step = acting(world, capability, subjectOfTranche(world, trancheId), actor);
  return appApplyTrancheEvent(
    step.world,
    trancheId,
    event,
    step.authority as Parameters<typeof appApplyTrancheEvent<E>>[3],
    options,
  );
}

/** Часы транша: довести мир до срока, если он ещё не наступил. */
function toDeadline(world: World, trancheId: string): World {
  const state = trancheOf(world, trancheId).state;
  if (!('deadline' in state)) return world;
  return state.deadline.at > world.now ? advance(world, state.deadline.at - world.now) : world;
}

export function applyDealEvent<E extends DealEvent>(
  world: World,
  dealId: string,
  event: E,
  options: TrancheEventOptions,
  as?: Actor,
): World {
  if (event.type === 'deadline_reached') {
    // У сделки часов нет (`schedule.ts`), поэтому «наступил ли срок» здесь не
    // проверяется ничем — см. оговорку [открыто] у `expireDeal`.
    return expireDeal(world, dealId, options);
  }
  const capability = dealCapability(event);
  const actor = as ?? dealActor(world, dealId, event);
  const step = acting(world, capability, subjectOfDeal(dealId), actor);
  return appApplyDealEvent(
    step.world,
    dealId,
    event,
    step.authority as Parameters<typeof appApplyDealEvent<E>>[3],
    options,
  );
}

export function registerFiling(
  world: World,
  dealId: string,
  applicationId: string,
  source: FilingSource,
  options: TrancheEventOptions,
  as: Actor = STAFF.operator,
): World {
  const step = acting(world, 'create_deal', subjectOfDeal(dealId), as);
  return appRegisterFiling(step.world, dealId, applicationId, source, step.authority, options);
}

/* ------------------------------------------------------------------------- */
/* Разбор отката                                                             */
/* ------------------------------------------------------------------------- */

export function requestUnwind(
  world: World,
  dealId: string,
  request: UnwindRequest,
  options: TrancheEventOptions,
  as: Actor = STAFF.operator,
): World {
  const step = acting(world, 'prepare_settlement', subjectOfDeal(dealId), as);
  return appRequestUnwind(step.world, dealId, request, step.authority, options);
}

export function approveUnwind(
  world: World,
  dealId: string,
  options: TrancheEventOptions,
  as: Actor = STAFF.controller,
): World {
  const step = acting(world, 'approve_lift_block', subjectOfDeal(dealId), as);
  return appApproveUnwind(step.world, dealId, step.authority, options);
}

export function authorizeUnwind(
  world: World,
  dealId: string,
  options: TrancheEventOptions,
  as: Actor = STAFF.controller,
): World {
  const step = acting(world, 'approve_lift_block', subjectOfDeal(dealId), as);
  return appAuthorizeUnwind(step.world, dealId, step.authority, options);
}

/* ------------------------------------------------------------------------- */
/* Исправление записи журнала                                                */
/* ------------------------------------------------------------------------- */

/**
 * Исправление ключа причины у записанного исхода выплаты.
 *
 * Полномочие то же, под которым исход был записан, — `record_bank_outcome`:
 * исправление собственной формулировки нового права не даёт. Автора обёртка не
 * называет и назвать не может: он выводится из сессии внутри шага.
 */
export function correctPayoutReason(
  world: World,
  trancheId: string,
  request: CorrectionRequest,
  as: Actor = STAFF.operator,
): World {
  const step = acting(world, 'record_bank_outcome', subjectOfTranche(world, trancheId), as);
  return appCorrectPayoutReason(step.world, request, step.authority);
}

/* ------------------------------------------------------------------------- */
/* Вывод со счёта клиента                                                    */
/* ------------------------------------------------------------------------- */

function inScene(scene: WithdrawalWorld, world: World): WithdrawalWorld {
  return { ...scene, world };
}

export function requestWithdrawal(
  scene: WithdrawalWorld,
  spec: WithdrawalSpec,
  as: Actor = STAFF.operator,
): WithdrawalWorld {
  const step = acting(scene.world, 'conduct_withdrawal', PLATFORM_SUBJECT, as);
  return appRequestWithdrawal(inScene(scene, step.world), spec, step.authority);
}

/**
 * Разрешение по заявке на вывод: факты берёт `authorizeWithdrawal`, потому что
 * предмет здесь — сама заявка, а не сделка с траншем. Для сценария разница одна
 * — Н1 и Н5 считаются по заявке.
 */
function actingOnWithdrawal<C extends Capability>(
  scene: WithdrawalWorld,
  capability: C,
  withdrawalId: string,
  actor: Actor,
): { readonly scene: WithdrawalWorld; readonly authority: Authority<C> } {
  const session = login(scene.world, actor);
  const next = inScene(scene, session.world);
  const decided = authorizeWithdrawal(next, session.sessionId, capability, withdrawalId);
  if (!decided.ok) {
    throw new Error(`e2e.withdrawal.denied:${capability}:${decided.error.reason}`);
  }
  return { scene: next, authority: decided.value };
}

export function approveWithdrawal(
  scene: WithdrawalWorld,
  withdrawalId: string,
  as: Actor = STAFF.controller,
): WithdrawalWorld {
  const step = actingOnWithdrawal(scene, 'approve_payout', withdrawalId, as);
  return appApproveWithdrawal(step.scene, withdrawalId, step.authority);
}

export function applyWithdrawalEvent<E extends WithdrawalEvent>(
  scene: WithdrawalWorld,
  withdrawalId: string,
  event: E,
  options: WithdrawalStepOptions,
  as?: Actor,
): WithdrawalWorld {
  const capability = withdrawalCapability(event);
  const actor = as ?? staffFor(capability);
  const step = actingOnWithdrawal(scene, capability, withdrawalId, actor);
  return appApplyWithdrawalEvent(
    step.scene,
    withdrawalId,
    event,
    step.authority as Parameters<typeof appApplyWithdrawalEvent<E>>[3],
    options,
  );
}

/* ------------------------------------------------------------------------- */
/* Остановка приёма новых сделок                                             */
/* ------------------------------------------------------------------------- */

/**
 * Разрешение на шаг по остановке приёма.
 *
 * Своя функция, а не `acting`, по той же причине, что у заявки на вывод: у
 * остановки нет ни сделки, ни транша, и факты для Н5 («снять не может тот, кто
 * остановил») собирает сам продукт — `authorizeIntake`. Подставить их отсюда
 * нечем.
 */
function actingOnIntake<C extends Capability>(
  world: World,
  capability: C,
  actor: Actor,
): { readonly world: World; readonly authority: Authority<C> } {
  const session = login(world, actor);
  const decided = authorizeIntake<C>(session.world, session.sessionId, capability);
  if (!decided.ok) {
    throw new Error(`e2e.intake.denied:${actor.key}:${capability}:${decided.error.reason}`);
  }
  return { world: session.world, authority: decided.value };
}

/** Стоп-кран человека. Умолчание — дежурный аналитик: полномочие есть у всех. */
export function haltIntake(
  world: World,
  reasonKey: string,
  as: Actor = STAFF.analyst,
): World {
  const step = actingOnIntake(world, 'halt_intake', as);
  return appHaltIntake(step.world, reasonKey, step.authority);
}

/** Первая подпись под снятием. Умолчание — ФК: уровень 1. */
export function requestHaltLift(
  world: World,
  request: HaltLiftRequest,
  as: Actor = STAFF.controller,
): World {
  const step = actingOnIntake(world, 'lift_halt', as);
  return appRequestHaltLift(step.world, request, step.authority);
}

/** Вторая подпись — она же снятие. Умолчание — РО: уровень 2. */
export function liftIntakeHalt(world: World, as: Actor = STAFF.head): World {
  const step = actingOnIntake(world, 'lift_halt', as);
  return appLiftIntakeHalt(step.world, step.authority);
}
