import {
  type ConditionAct,
  type DealEvent,
  type DealState,
  type DealStatus,
  type Instant,
  type Intent,
  type PartyRef,
  type PayoutEvent,
  type PayoutState,
  type TrancheContext,
  type TrancheEvent,
  type TrancheFacts,
  type TrancheState,
  type TrancheStatus,
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
  type Journal,
  type TrancheRef,
  accountBalance,
  appendEntry,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  clientTopUp,
  emptyJournal,
  lockForTranche,
  refundToSourceAccount,
  settleTrancheToClientAccount,
  trancheSettlement,
  unlockToClientAccount,
} from '@sdelka/ledger';
import { type CurrencyCode, type Deduction, type Money, isoDate, money, rational, split, subtract } from '@sdelka/money';

/**
 * Слой фикстур: одна воспроизводимая история на каждый экран.
 *
 * ⚠ Ни одного состояния этот модуль не выдумывает. Он подаёт события в автоматы
 * `@sdelka/domain` и записывает то, что автомат ответил: статус транша, статус
 * сделки, статус выплаты, дедлайн. Если автомат отказывает — фикстура падает
 * при сборке (`FixtureError`), а не тихо рисует состояние, которого в домене не
 * существует. Это и есть смысл слоя: экран нельзя нарисовать по положению,
 * недостижимому в жизни.
 *
 * Деньги считает `@sdelka/money`, остатки — `@sdelka/ledger`. Здесь только
 * проекция намерений автомата в записи журнала — тот самый шаг приложения,
 * который домен намеренно не делает сам (`FUNCTIONAL.md` инвариант 15).
 *
 * Заменяется на хранилище целиком: наружу торчит только `store.ts` с функциями
 * выборки, и ни один экран не знает, откуда пришли данные.
 */
export class FixtureError extends Error {}

export const FIXTURE_NOW: Instant = instant(Date.UTC(2026, 8, 3, 10, 0, 0));

export const OPERATIONS_TIME_ZONE = 'Asia/Tbilisi';

const HOUR_MS = 60 * 60 * 1000;

/** Комиссия за организацию расчёта: 1,2% плюс фиксированная часть. */
export const PLATFORM_DEDUCTIONS: readonly Deduction[] = Object.freeze([
  Object.freeze({ key: 'fee.platform', rate: rational(12n, 1000n), fixed: 100n }),
]);

export function platformFee(gross: Money<CurrencyCode>): Money<CurrencyCode> {
  return subtract(gross, split(gross, PLATFORM_DEDUCTIONS).recipient);
}

export type Step =
  | { readonly k: 'payment'; readonly hoursAgo: number; readonly minor: bigint; readonly currency: CurrencyCode }
  | { readonly k: 'tranche'; readonly hoursAgo: number; readonly event: TrancheEvent }
  | { readonly k: 'deal'; readonly hoursAgo: number; readonly event: DealEvent }
  | { readonly k: 'payoutCreate'; readonly hoursAgo: number }
  | { readonly k: 'payout'; readonly hoursAgo: number; readonly event: PayoutEvent }
  | { readonly k: 'refundOut'; readonly hoursAgo: number; readonly minor: bigint };

export interface FactOverrides {
  readonly beneficiaryLocked: boolean;
  readonly beneficiaryChangedHoursAgo: number | null;
  readonly senderName: string;
  readonly registryOwnerIsBuyer: boolean;
  readonly mismatchResolved: boolean;
  readonly sourceAccountKnown: boolean;
  readonly coverageOk: boolean;
}

export interface RunInput {
  readonly dealId: string;
  /**
   * Отправлен ли возврат на счёт-источник.
   *
   * ⚠ Расхождение домена и `SCREENS.md`, вскрытое при сборке экранов. Автомат
   * порождает намерение `refund_external` вместе с откатом: деньги уходят из
   * сервиса в банк плательщика автоматически. Спецификация интерфейса требует
   * другого: при откате средства возвращаются **на счёт клиента в сервисе**
   * (`M-15`), и уже оттуда клиент выбирает — вывести (`M-16`, `M-17`) или
   * провести сделку заново. Красная линия №7 удовлетворяется обоими вариантами,
   * но клиент видит разные вещи, и выбор здесь продуктовый, а не технический.
   *
   * Пока решение не принято, момент ухода денег наружу считается шагом
   * приложения: без этого флага положение `M-15` недостижимо вовсе.
   */
  readonly refundDispatched: boolean;
  readonly trancheId: string;
  readonly payer: PartyRef;
  readonly recipient: PartyRef;
  readonly required: Money<CurrencyCode>;
  readonly steps: readonly Step[];
  readonly overrides: FactOverrides;
}

/** Отметка о прохождении шага: из неё собирается лента сделки. */
export interface StatusMark {
  readonly status: TrancheStatus;
  readonly at: number;
}

export interface RunResult {
  readonly tranche: TrancheState;
  readonly deal: DealState;
  readonly payout: PayoutState | null;
  readonly journal: Journal;
  readonly collected: Money<CurrencyCode>;
  readonly creditedTotal: Money<CurrencyCode>;
  readonly marks: readonly StatusMark[];
  readonly notifications: readonly string[];
}

interface Mutable {
  tranche: TrancheState;
  deal: DealState;
  payout: PayoutState | null;
  journal: Journal;
  /**
   * Сумма, принятая **автоматом** под транш (`facts.collectedAmount`).
   *
   * Единственный счётчик, который здесь остался, и он не про деньги на счёте, а
   * про факт домена: сколько поступлений автомат зачёл этому траншу. Остатки
   * счетов — свободный и запертый — считает учёт по журналу, и второй копии у
   * них нет: расхождение проекций, из-за которого запирание разъехалось по трём
   * моментам, началось ровно со счётчика рядом с журналом.
   */
  collectedMinor: bigint;
  entrySeq: number;
  marks: StatusMark[];
  notifications: string[];
}

/** Владелец обязательства по траншу: плательщик, и никто другой. */
function payerKey(input: RunInput): ClientKey {
  return clientKey(input.payer.accountKey);
}

/** Свободная часть счёта плательщика в валюте транша — из журнала. */
function freeOf(input: RunInput, state: Mutable): Money<CurrencyCode> {
  return accountBalance(state.journal, clientFreeAccount(payerKey(input)), input.required.currency);
}

/**
 * Остаток файла транша `client:{клиент}:tranche:{сделка}:{транш}` — из журнала.
 *
 * Читается на каждый вызов, а не ведётся счётчиком рядом с учётом: на этой
 * величине стоит `g_funds_locked` (`STATE-MACHINES.md` §1.3), то есть запрет
 * финансировать выплату средствами других сделок (красная линия №1). Счётчик,
 * разошедшийся с журналом, снял бы guard, ничего при этом не сломав.
 */
function lockedOf(input: RunInput, state: Mutable): Money<CurrencyCode> {
  return accountBalance(
    state.journal,
    clientLockedAccount(payerKey(input), input.dealId, input.trancheId),
    input.required.currency,
  );
}

function conditionActOf(recipient: PartyRef, agreedAt: Instant): ConditionAct {
  return {
    recipient,
    agreedAt,
    conditionTextVersion: 'condition-2026-08',
    conditionType: 'registration_transfer',
  };
}

function factsOf(input: RunInput, state: Mutable, now: Instant): TrancheFacts {
  const changedAt =
    input.overrides.beneficiaryChangedHoursAgo === null
      ? null
      : instant(now - input.overrides.beneficiaryChangedHoursAgo * HOUR_MS);
  return {
    requiredAmount: input.required,
    collectedAmount: money(input.required.currency, state.collectedMinor),
    // Запертое под траншем приходит из учёта, а не из фактов приложения:
    // `g_funds_locked` сверяет с ним сумму, которую расчёт спишет с файла.
    lockedAmount: lockedOf(input, state),
    buyerPayerKey: input.overrides.senderName,
    buyer: input.payer,
    conditionAct: conditionActOf(input.recipient, instant(FIXTURE_NOW - 30 * 24 * HOUR_MS)),
    evidenceBundleId: 'evidence-2026-09',
    statementFields: {
      cadastralCode: true,
      ownerDocumentNumber: true,
      share: true,
      basis: true,
      noUnexpectedEncumbrances: true,
    },
    registryOwnerIsBuyer: input.overrides.registryOwnerIsBuyer,
    beneficiary: {
      status: 'verified',
      locked: input.overrides.beneficiaryLocked,
      lastChangedAt: changedAt,
    },
    preparedBy: 'op-1',
    approvals: [{ userId: 'approver-1' }, { userId: 'approver-2' }],
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
    createdOn: isoDate('2026-08-20'),
    officialRateAtCreation: null,
    activePayouts: state.payout === null ? 0 : 1,
    coverageOk: input.overrides.coverageOk,
    sourceAccountKnown: input.overrides.sourceAccountKnown,
    mismatchResolved: input.overrides.mismatchResolved,
  };
}

function meta(state: Mutable, dealId: string, at: number): { id: string; occurredAt: string } {
  state.entrySeq += 1;
  return { id: `${dealId}-e${state.entrySeq}`, occurredAt: new Date(at).toISOString() };
}

/**
 * Проекция намерений автомата в записи журнала — шаг приложения.
 *
 * Расчёт здесь ничего не изготавливает: подтверждение сторон приезжает внутри
 * намерения, выданное автоматом транша. Построить его тут нечем, и в этом
 * смысл — «просто выплатить» не существует как операция (красная линия №5).
 */
function applyIntent(
  intent: Intent,
  input: RunInput,
  state: Mutable,
  at: number,
): void {
  const deal: TrancheRef = { dealId: input.dealId, trancheId: input.trancheId };
  if (intent.type === 'notify') {
    state.notifications.push(intent.messageKey);
    return;
  }
  if (intent.type === 'post_journal_entry') {
    if (intent.template === 'funds_received') {
      // Деньги уже на свободной части счёта: их зачислил шаг «платёж пришёл».
      // Второе зачисление удвоило бы обязательство и сломало покрытие.
      return;
    }
    if (intent.template === 'lock_funds') {
      // Привязка к сделке — намерение автомата на входе в `reserved`, а не шаг
      // приложения (`STATE-MACHINES.md` §1.5). Раньше запирание стояло здесь
      // отдельным блоком после редьюсера, и момент его выбирала фикстура: до
      // тех пор, пока автомат намерения не выдавал, три проекции запирали
      // деньги в трёх разных статусах, и расхождение было невидимо — каждая
      // форма сходится в ноль и проходит пофайловое обеспечение.
      state.journal = appendEntry(
        state.journal,
        lockForTranche(meta(state, input.dealId, at), clientKey(intent.clientKey), deal, intent.amount),
      );
      return;
    }
    if (intent.template === 'unlock_funds') {
      // Расфиксация по `reserve_expired`: резерв снят, деньги остались у
      // клиента и снова свободны (`CABINETS.md` §3.2 блок 6 обещает это
      // дословно). Симметричной половины запирания не было ни у одной проекции.
      state.journal = appendEntry(
        state.journal,
        unlockToClientAccount(
          meta(state, input.dealId, at),
          clientKey(intent.clientKey),
          deal,
          intent.amount,
        ),
      );
      return;
    }
    if (intent.template === 'refund_unlock') {
      // Отвязка при возврате: деньги вернулись в свободную часть счёта того же
      // клиента — они снова его и снова отзывны (красная линия №7). Проверки
      // «а есть ли что отвязывать» здесь нет: при пустом файле транша автомат
      // намерения не порождает вовсе, и локальная защита была бы вторым местом,
      // где принимается то же решение.
      state.journal = appendEntry(
        state.journal,
        unlockToClientAccount(
          meta(state, input.dealId, at),
          clientKey(intent.clientKey),
          deal,
          intent.amount,
        ),
      );
      return;
    }
    if (intent.template === 'refund_external') {
      if (!input.refundDispatched) {
        // Деньги остались на счёте клиента в сервисе: они его и отзывны, и
        // следующий шаг выбирает он сам (`M-15`).
        return;
      }
      state.journal = appendEntry(
        state.journal,
        refundToSourceAccount(meta(state, input.dealId, at), clientKey(intent.clientKey), intent.amount),
      );
    }
    return;
  }
  if (intent.type === 'post_settlement_entry') {
    const fee = platformFee(intent.amount);
    state.journal = appendEntry(
      state.journal,
      settleTrancheToClientAccount(
        meta(state, input.dealId, at),
        trancheSettlement(
          deal,
          clientKey(intent.payerClientKey),
          clientKey(intent.recipientClientKey),
          intent.attestation,
        ),
        intent.amount,
        fee,
      ),
    );
  }
}

function stepAt(step: Step): number {
  return FIXTURE_NOW - step.hoursAgo * HOUR_MS;
}

export function runScenario(input: RunInput): RunResult {
  const state: Mutable = {
    tranche: initialTrancheState(FIXTURE_NOW, DEFAULT_DEADLINE_POLICY),
    deal: dealState('ready'),
    payout: null,
    journal: emptyJournal,
    collectedMinor: 0n,
    entrySeq: 0,
    marks: [{ status: 'pending', at: FIXTURE_NOW - 72 * HOUR_MS }],
    notifications: [],
  };

  for (const step of input.steps) {
    const at = stepAt(step);
    const now = instant(at);
    switch (step.k) {
      case 'payment': {
        // Поступление на свободную часть счёта клиента: событие приложения, а
        // не транша (`FUNCTIONAL.md` §3.1 — зачисление и привязка к сделке это
        // разные события, и сумма журнала равна нулю на каждом).
        const amount = money(step.currency, step.minor);
        state.journal = appendEntry(
          state.journal,
          clientTopUp(meta(state, input.dealId, at), clientKey(input.payer.accountKey), amount),
        );
        break;
      }
      case 'tranche': {
        const context: TrancheContext = {
          now,
          dealId: input.dealId,
          trancheId: input.trancheId,
          facts: factsOf(input, state, now),
          deadlinePolicy: DEFAULT_DEADLINE_POLICY,
        };
        const result = reduceTranche(state.tranche, step.event, context);
        if (!result.ok) {
          throw new FixtureError(
            `${input.dealId}: ${step.event.type} отвергнут автоматом транша — ${JSON.stringify(result.error)}`,
          );
        }
        state.tranche = result.value.state;
        if (step.event.type === 'funds_received' && state.tranche.status === 'collected') {
          state.collectedMinor += step.event.amount.minor;
        }
        for (const intent of result.value.intents) {
          applyIntent(intent, input, state, at);
        }
        if (state.marks.at(-1)?.status !== state.tranche.status) {
          state.marks.push({ status: state.tranche.status, at });
        }
        break;
      }
      case 'deal': {
        const result = reduceDeal(state.deal, step.event, {
          dealId: input.dealId,
          now,
          facts: {
            trancheStatuses: [state.tranche.status],
            preparedBy: 'op-1',
            conditionAct: conditionActOf(input.recipient, instant(FIXTURE_NOW - 30 * 24 * HOUR_MS)),
          },
        });
        if (!result.ok) {
          throw new FixtureError(
            `${input.dealId}: ${step.event.type} отвергнут автоматом сделки — ${JSON.stringify(result.error)}`,
          );
        }
        state.deal = result.value.state;
        break;
      }
      case 'payoutCreate': {
        state.payout = createPayout(input.trancheId);
        break;
      }
      case 'payout': {
        if (state.payout === null) {
          throw new FixtureError(`${input.dealId}: выплаты нет, событие ${step.event.type} некуда подать`);
        }
        const result = reducePayout(state.payout, step.event);
        if (!result.ok) {
          throw new FixtureError(
            `${input.dealId}: ${step.event.type} отвергнут автоматом выплаты — ${JSON.stringify(result.error)}`,
          );
        }
        state.payout = result.value.state;
        break;
      }
      case 'refundOut': {
        const amount = money(input.required.currency, step.minor);
        state.journal = appendEntry(
          state.journal,
          refundToSourceAccount(
            meta(state, input.dealId, at),
            clientKey(input.payer.accountKey),
            amount,
          ),
        );
        break;
      }
    }
  }

  return {
    tranche: state.tranche,
    deal: state.deal,
    payout: state.payout,
    journal: state.journal,
    collected: money(input.required.currency, state.collectedMinor),
    creditedTotal: freeOf(input, state),
    marks: state.marks,
    notifications: state.notifications,
  };
}

export type { DealStatus, TrancheStatus };
