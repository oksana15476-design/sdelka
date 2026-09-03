import {
  type CurrencyCode,
  type IsoDate,
  type Money,
  type Rational,
  compare,
  convertAtRate,
} from '@sdelka/money';
import { type Instant, HOUR } from './instant';
import type { TrancheEvent } from './tranche-events';

/**
 * Guard'ы транша — STATE-MACHINES.md §1.3, идентификаторы буква в букву.
 *
 * Два guard'а помечены как введённые кодом: документ формулирует условие прозой
 * («расхождение снято», «два разных пользователя») и не даёт ему имени. Имя
 * нужно, чтобы условие было тестируемо поимённо, как требует §7.
 */
export const GUARD_IDS = [
  'g_amount_sufficient',
  'g_payer_matches',
  'g_evidence_present',
  'g_fields_match',
  'g_owner_is_buyer',
  'g_approvals_sufficient',
  'g_beneficiary_locked',
  'g_no_active_payout',
  'g_coverage_ok',
  'g_source_account_known',
  /** введено кодом: §1.4 «release_blocked → release_pending on approval_added ∧ расхождение снято» */
  'g_mismatch_resolved',
  /** введено кодом: §1.4 «write_off_approved(два разных пользователя)» */
  'g_write_off_approvers_distinct',
] as const;

export type GuardId = (typeof GUARD_IDS)[number];

/** Пять полей выписки из FUNCTIONAL.md §3.5. Проверяются поимённо, а не счётчиком. */
export interface StatementFields {
  readonly cadastralCode: boolean;
  /** Собственник сверяется по номеру документа, не по имени: латинизация необратима. */
  readonly ownerDocumentNumber: boolean;
  readonly share: boolean;
  readonly basis: boolean;
  readonly noUnexpectedEncumbrances: boolean;
}

export interface BeneficiaryLock {
  readonly locked: boolean;
  readonly lastChangedAt: Instant | null;
}

export interface ApprovalTier {
  /** Верхняя граница включительно в минорных единицах; `null` — всё, что выше. */
  readonly upToMinor: bigint | null;
  /** `null` — сумма не берётся вообще (FUNCTIONAL.md §3.5: свыше 500 000 ₾ на пилоте не берём). */
  readonly requiredApprovals: number | null;
}

export interface ApprovalPolicy {
  readonly currency: CurrencyCode;
  readonly tiers: readonly ApprovalTier[];
}

/** Пороги утверждения из FUNCTIONAL.md §3.5, в тетри. */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = Object.freeze({
  currency: 'GEL',
  tiers: Object.freeze([
    Object.freeze({ upToMinor: 3_000_000n, requiredApprovals: 0 }),
    Object.freeze({ upToMinor: 15_000_000n, requiredApprovals: 1 }),
    Object.freeze({ upToMinor: 50_000_000n, requiredApprovals: 2 }),
    Object.freeze({ upToMinor: null, requiredApprovals: null }),
  ]),
});

/**
 * Официальный курс на дату создания транша — FUNCTIONAL.md §4.3.1.
 *
 * Курс лежит в фактах транша, а не выясняется в момент проверки guard'а: иначе
 * планка утверждения плавает вместе с рынком и одна и та же сделка утром
 * требует двух подписей, а вечером одной. Курс именно официальный, а не наш
 * клиентский: в клиентском сидит наш спред, то есть мы влияли бы на собственный
 * контрольный порог.
 *
 * Дата — календарная (`IsoDate`), а не момент времени: курс публикуется на дату,
 * и превращение `Instant` в дату потребовало бы зашитой временной зоны.
 */
export interface OfficialRateAtCreation {
  /** Дата публикации курса. Сверяется с датой создания транша, а не с «сегодня». */
  readonly asOf: IsoDate;
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /** Единиц валюты `to` за мажорную единицу валюты `from`. */
  readonly rate: Rational;
}

/** Период охлаждения реквизитов: 72 часа (FUNCTIONAL.md инвариант 18). */
export const BENEFICIARY_COOLDOWN_MS = 72 * HOUR;

export interface Approval {
  readonly userId: string;
}

/**
 * Факты, на которых стоят guard'ы. Домен их не добывает: реестр, банк и
 * учёт — за портами. Здесь только значения, приведённые к решению.
 */
export interface TrancheFacts {
  readonly requiredAmount: Money<CurrencyCode>;
  readonly collectedAmount: Money<CurrencyCode> | null;
  /** Ключ плательщика-покупателя, с которым сверяется отправитель платежа. */
  readonly buyerPayerKey: string;
  readonly evidenceBundleId: string | null;
  readonly statementFields: StatementFields;
  readonly registryOwnerIsBuyer: boolean;
  readonly beneficiary: BeneficiaryLock;
  /** Учётная запись, готовившая операцию: она не может быть утверждающей. */
  readonly preparedBy: string | null;
  readonly approvals: readonly Approval[];
  readonly approvalPolicy: ApprovalPolicy;
  /** Дата создания транша: к ней привязан курс пересчёта порогов (§4.3.1). */
  readonly createdOn: IsoDate;
  /**
   * Курс на дату создания. `null` для транша в валюте порогов — пересчитывать
   * нечего. Для транша в другой валюте `null` означает, что курса нет, и
   * утверждения не набираются: отказ закрытый, а не подстановка ближайшего.
   */
  readonly officialRateAtCreation: OfficialRateAtCreation | null;
  readonly activePayouts: number;
  /** Результат проверки покрытия из учёта: считает ledger, домен только читает. */
  readonly coverageOk: boolean;
  readonly sourceAccountKnown: boolean;
  readonly mismatchResolved: boolean;
}

export interface GuardInput {
  readonly facts: TrancheFacts;
  readonly event: TrancheEvent;
  readonly now: Instant;
}

/**
 * Ступень по сумме, уже приведённой к валюте порогов.
 *
 * `boundaryBelongsToNextTier` — та самая «более строгая ступень» из §4.3.1. Для
 * суммы в валюте порогов граница включительная, как и была. Для пересчитанной
 * суммы граница отдаётся верхней ступени: пересчёт неточен, и на границе должно
 * получаться больше подписей, а не меньше.
 */
function approvalsForTier(
  policy: ApprovalPolicy,
  minor: bigint,
  boundaryBelongsToNextTier: boolean,
): number | null {
  for (const tier of policy.tiers) {
    if (tier.upToMinor === null) {
      return tier.requiredApprovals;
    }
    if (boundaryBelongsToNextTier ? minor < tier.upToMinor : minor <= tier.upToMinor) {
      return tier.requiredApprovals;
    }
  }
  return null;
}

/**
 * Сколько утверждений нужно на сумму — FUNCTIONAL.md §3.5 и §4.3.1.
 *
 * Пороги заданы в лари. Сумма в другой валюте пересчитывается по официальному
 * курсу на дату создания транша и округляется вверх — к более строгой ступени.
 *
 * `null` означает «утверждений не набрать» и всегда читается как отказ:
 * сумма выше потолка пилота, курса на дату нет, курс не той пары или не на дату
 * создания. Подставлять ближайший курс нельзя — отказ закрытый.
 *
 * Функция экспортирована: её же показывает кабинет и консоль операций, а
 * второй реализации того же правила быть не должно.
 */
export function requiredApprovals(
  policy: ApprovalPolicy,
  amount: Money<CurrencyCode>,
  officialRate: OfficialRateAtCreation | null,
  createdOn: IsoDate,
): number | null {
  if (amount.currency === policy.currency) {
    return approvalsForTier(policy, amount.minor, false);
  }
  if (officialRate === null) {
    return null;
  }
  if (officialRate.from !== amount.currency || officialRate.to !== policy.currency) {
    return null;
  }
  // Курс обязан быть именно на дату создания транша, а не «свежий»: проверка
  // здесь, потому что иначе правило держится на добросовестности вызывающего.
  if (officialRate.asOf !== createdOn) {
    return null;
  }
  if (officialRate.rate.numerator <= 0n) {
    return null;
  }
  const converted = convertAtRate(amount, policy.currency, officialRate.rate, 'ceil');
  return approvalsForTier(policy, converted.minor, true);
}

function distinctApprovers(facts: TrancheFacts): number {
  const approvers = new Set<string>();
  for (const approval of facts.approvals) {
    if (approval.userId !== facts.preparedBy) {
      approvers.add(approval.userId);
    }
  }
  return approvers.size;
}

export const GUARDS: Readonly<Record<GuardId, (input: GuardInput) => boolean>> = Object.freeze({
  g_amount_sufficient: ({ facts, event }) => {
    if (event.type !== 'funds_received') return false;
    if (event.amount.currency !== facts.requiredAmount.currency) return false;
    return compare(event.amount, facts.requiredAmount) >= 0;
  },
  g_payer_matches: ({ facts, event }) => {
    if (event.type !== 'funds_received') return false;
    // Инвариант 19: несовпадение имени отправителя — удержание при любой сумме.
    return event.sender === facts.buyerPayerKey;
  },
  g_evidence_present: ({ facts }) =>
    facts.evidenceBundleId !== null && facts.evidenceBundleId.length > 0,
  g_fields_match: ({ facts }) =>
    facts.statementFields.cadastralCode &&
    facts.statementFields.ownerDocumentNumber &&
    facts.statementFields.share &&
    facts.statementFields.basis &&
    facts.statementFields.noUnexpectedEncumbrances,
  /**
   * Перед выплатой сверяется, что новый собственник в выписке — **покупатель**:
   * это и есть доказательство, что переход права состоялся. Выписка, всё ещё
   * показывающая продавца, доказывает обратное.
   *
   * Проверка «текущий собственник = продавец» — другая, она стоит на заведении
   * сделки (Ф3) и сюда не относится. Раньше оба момента назывались одним
   * guard'ом `g_owner_matches`, и STATE-MACHINES.md §1.3 с FUNCTIONAL.md §3.5
   * определяли его противоположно. См. §1.3.
   */
  g_owner_is_buyer: ({ facts }) => facts.registryOwnerIsBuyer,
  g_approvals_sufficient: ({ facts }) => {
    const required = requiredApprovals(
      facts.approvalPolicy,
      facts.requiredAmount,
      facts.officialRateAtCreation,
      facts.createdOn,
    );
    if (required === null) return false;
    return distinctApprovers(facts) >= required;
  },
  g_beneficiary_locked: ({ facts, now }) => {
    if (!facts.beneficiary.locked) return false;
    const changedAt = facts.beneficiary.lastChangedAt;
    if (changedAt === null) return true;
    return now - changedAt >= BENEFICIARY_COOLDOWN_MS;
  },
  g_no_active_payout: ({ facts }) => facts.activePayouts === 0,
  g_coverage_ok: ({ facts }) => facts.coverageOk,
  g_source_account_known: ({ facts }) => facts.sourceAccountKnown,
  g_mismatch_resolved: ({ facts }) => facts.mismatchResolved,
  g_write_off_approvers_distinct: ({ facts, event }) => {
    if (event.type !== 'write_off_approved') return false;
    const approvers = new Set(event.userIds.filter((userId) => userId !== facts.preparedBy));
    return approvers.size >= 2;
  },
});

export function evaluateGuard(guard: GuardId, input: GuardInput): boolean {
  return GUARDS[guard](input);
}
