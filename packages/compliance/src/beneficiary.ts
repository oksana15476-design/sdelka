import {
  type BeneficiaryLock,
  type BeneficiaryStatus,
  type Instant,
  type Result,
  BENEFICIARY_STATUSES,
  failure,
  ok,
} from '@sdelka/domain';
import {
  type Decision,
  type EvidenceRef,
  type PolicyVersionId,
  decision,
} from './decision';
import type { IdentityDocument, PartyProfile } from './identity';
import { type ReasonKey, REASON_KEYS } from './keys';
import { type NameMatch, type NameObservations, compareNames, latinObservation } from './names';
import type { AccountFingerprint } from './pii';
import type { BeneficiaryPolicy, CompliancePolicy } from './policy';
import type { Authority } from './roles';

/**
 * Реквизиты выплаты как защитный периметр — `CORE.md` Ф15, отдельная функция, а
 * не подпункт выплаты. Самый вероятный вектор атаки на продукт: известны дата,
 * сумма и обе стороны.
 *
 * Правила (`FUNCTIONAL.md` инварианты 16–18, `PRODUCT.md` §10):
 *  · имя владельца счёта сверяется с профилем проверки личности, расхождение —
 *    блокировка, а не предупреждение;
 *  · реквизиты блокируются при финансировании сделки;
 *  · изменение: повторная верификация, охлаждение 24–48 часов, уведомление всем
 *    сторонам по всем каналам, второе утверждение;
 *  · изменение в последние 72 часа перед релизом — автоматический блок.
 *
 * Поддержка не участвует нигде: каждая функция ниже требует `Authority` с
 * полномочием, которого в роли поддержки нет.
 */
export interface BeneficiaryRequisites {
  readonly account: AccountFingerprint;
  /** Формы имени владельца счёта по данным банка. */
  readonly holderNames: NameObservations;
  /** Документ владельца счёта, если внешняя проверка владельца его отдала. */
  readonly holderDocument: IdentityDocument | null;
  /** Доказательство владения счётом: тестовый перевод или внешняя проверка. */
  readonly ownershipEvidence: EvidenceRef | null;
}

/**
 * Перечень статусов переехал в `@sdelka/domain` (E13-2) и здесь только
 * реэкспортируется. Решение о статусе по-прежнему принимает комплаенс, но на
 * этом статусе стоит guard домена `g_beneficiary_verified`, а два перечня одних
 * и тех же четырёх значений — тот самый класс расхождения, который однажды уже
 * стоил `g_owner_matches` (STATE-MACHINES.md §1.3).
 */
export { BENEFICIARY_STATUSES };
export type { BeneficiaryStatus };

export interface BeneficiaryState {
  readonly requisites: BeneficiaryRequisites;
  readonly status: BeneficiaryStatus;
  /** Блокировка наступает при финансировании сделки, а не по решению оператора. */
  readonly locked: boolean;
  readonly lastChangedAt: Instant | null;
}

export interface BeneficiaryVerification extends Decision<BeneficiaryStatus> {
  readonly nameMatch: NameMatch;
}

/**
 * Сверка владельца счёта с профилем.
 *
 * Расхождение имени — блокировка. Совпадение имени — **не** «проверено»:
 * максимум `name_consistent`, потому что совпадение имени не является
 * достаточным основанием ни для чего. Статус `verified` требует доказательства
 * владения счётом — тестового перевода или внешней проверки владельца
 * (`BACKLOG.md` E4-10, E4-13).
 */
export function verifyBeneficiaryHolder(
  requisites: BeneficiaryRequisites,
  profile: PartyProfile,
  policy: CompliancePolicy,
  now: Instant,
  evidence: readonly EvidenceRef[] = [],
): BeneficiaryVerification {
  const nameMatch = compareNames(profile.names, requisites.holderNames, {
    strongThresholdBp: policy.nameThresholds.ownerReconciliation.valueBp,
    weights: policy.nameThresholds.weights,
  });

  // Латинская форма обязательна: стандарт платёжных сообщений поддерживает
  // только латиницу, и без неё выплата невозможна физически.
  if (latinObservation(requisites.holderNames) === null) {
    return Object.freeze({
      ...decision<BeneficiaryStatus>(
        'blocked',
        policy.version,
        now,
        [REASON_KEYS.beneficiaryLatinNameRequired],
        evidence,
      ),
      nameMatch,
    });
  }

  const consistent =
    nameMatch.degree === 'identical_in_source_alphabet' ||
    nameMatch.degree === 'identical_after_latinization' ||
    nameMatch.degree === 'strong';

  if (!consistent) {
    return Object.freeze({
      ...decision<BeneficiaryStatus>(
        'blocked',
        policy.version,
        now,
        [REASON_KEYS.beneficiaryHolderNameMismatch, ...nameMatch.reasons],
        evidence,
      ),
      nameMatch,
    });
  }

  if (requisites.ownershipEvidence === null) {
    return Object.freeze({
      ...decision<BeneficiaryStatus>(
        'name_consistent',
        policy.version,
        now,
        [REASON_KEYS.beneficiaryHolderNameConsistent, REASON_KEYS.beneficiaryOwnershipEvidenceMissing],
        evidence,
      ),
      nameMatch,
    });
  }

  return Object.freeze({
    ...decision<BeneficiaryStatus>(
      'verified',
      policy.version,
      now,
      [REASON_KEYS.beneficiaryHolderNameConsistent],
      [...evidence, requisites.ownershipEvidence],
    ),
    nameMatch,
  });
}

/** Блокировка при финансировании сделки. Не действие оператора, а следствие события. */
export function lockOnFunding(state: BeneficiaryState): BeneficiaryState {
  return Object.freeze({ ...state, locked: true });
}

/**
 * Факт для guard'а `g_beneficiary_locked` в `@sdelka/domain`.
 *
 * Тип возвращаемого значения импортирован из домена намеренно: если форма факта
 * там изменится, здесь перестанет собираться, а не разойдётся молча.
 */
export function toBeneficiaryLock(state: BeneficiaryState): BeneficiaryLock {
  // Статус доезжает до домена целиком. Раньше он здесь **выбрасывался**, и
  // различение `name_consistent` / `verified`, ради которого написан
  // `verifyBeneficiaryHolder`, до автомата не доходило: выплата на реквизиты,
  // прошедшие только сверку имени, проходила (ROADMAP.md И13.1, E13-2).
  return Object.freeze({
    status: state.status,
    locked: state.locked,
    lastChangedAt: state.lastChangedAt,
  });
}

/**
 * Чтение реквизитов. Требует полномочия `read_beneficiary`, которого нет в роли
 * поддержки: «никогда не видит реквизиты выплаты» проверяется компилятором.
 */
export function readBeneficiary(
  state: BeneficiaryState,
  _authority: Authority<'read_beneficiary'>,
): BeneficiaryRequisites {
  return state.requisites;
}

/* ------------------------------------------------------------------------- */
/* Изменение реквизитов                                                      */
/* ------------------------------------------------------------------------- */

export const BENEFICIARY_CHANGE_STATUSES = [
  'cooling_off',
  'awaiting_second_approval',
  'applied',
  'auto_blocked',
] as const;
export type BeneficiaryChangeStatus = (typeof BENEFICIARY_CHANGE_STATUSES)[number];

export interface BeneficiaryChangeRequest {
  readonly requestId: string;
  readonly requestedBy: string;
  readonly requestedAt: Instant;
  readonly proposed: BeneficiaryRequisites;
  readonly status: BeneficiaryChangeStatus;
  readonly reverifiedAt: Instant | null;
  readonly notifiedAt: Instant | null;
  readonly approvals: readonly string[];
  readonly policyVersionId: PolicyVersionId;
}

export type BeneficiaryEffect =
  | { readonly type: 'require_reverification'; readonly requestId: string }
  | { readonly type: 'notify_all_parties_all_channels'; readonly requestId: string }
  | { readonly type: 'require_second_approval'; readonly requestId: string };

export interface BeneficiaryChangeOutcome {
  readonly request: BeneficiaryChangeRequest;
  readonly effects: readonly BeneficiaryEffect[];
}

export interface BeneficiaryChangeInput {
  readonly requestId: string;
  readonly proposed: BeneficiaryRequisites;
  /**
   * Планируемый момент релиза. `null` при профинансированной сделке читается как
   * «окно неизвестно» и ведёт к автоблоку: транш в нетерминальном состоянии без
   * дедлайна — ошибка (`FUNCTIONAL.md` инвариант 7), а не разрешение менять.
   */
  readonly releaseAt: Instant | null;
  readonly dealFunded: boolean;
}

function withinBlackout(
  releaseAt: Instant | null,
  dealFunded: boolean,
  now: Instant,
  policy: BeneficiaryPolicy,
): boolean {
  if (releaseAt === null) return dealFunded;
  return releaseAt - now <= policy.preReleaseBlackout;
}

/**
 * Открытие заявки на изменение реквизитов.
 *
 * Изменение в последние 72 часа перед релизом отвергается автоматом — это отказ,
 * а не задача в очередь: у него нет пути к исполнению, поэтому он терминальный.
 */
export function openBeneficiaryChange(
  state: BeneficiaryState,
  input: BeneficiaryChangeInput,
  authority: Authority<'write_beneficiary'>,
  policy: CompliancePolicy,
  now: Instant,
): Result<BeneficiaryChangeOutcome, BeneficiaryChangeOutcome> {
  const blocked = withinBlackout(input.releaseAt, input.dealFunded, now, policy.beneficiary);
  const base: BeneficiaryChangeRequest = {
    requestId: input.requestId,
    requestedBy: authority.actorId,
    requestedAt: now,
    proposed: input.proposed,
    status: blocked ? 'auto_blocked' : 'cooling_off',
    reverifiedAt: null,
    notifiedAt: null,
    approvals: Object.freeze([]),
    policyVersionId: policy.version,
  };

  if (blocked) {
    return failure(
      Object.freeze({ request: Object.freeze(base), effects: Object.freeze([]) }),
    );
  }

  // Реквизиты не заблокированы — сделка не профинансирована, менять можно, но
  // повторная верификация владельца обязательна всё равно.
  const effects: readonly BeneficiaryEffect[] = state.locked
    ? Object.freeze([
        { type: 'require_reverification' as const, requestId: input.requestId },
        { type: 'notify_all_parties_all_channels' as const, requestId: input.requestId },
        { type: 'require_second_approval' as const, requestId: input.requestId },
      ])
    : Object.freeze([{ type: 'require_reverification' as const, requestId: input.requestId }]);

  return ok(Object.freeze({ request: Object.freeze(base), effects }));
}

export type BeneficiaryChangeEvent =
  | { readonly type: 'reverification_passed' }
  | { readonly type: 'parties_notified' }
  | { readonly type: 'approval_added'; readonly userId: string };

export function advanceBeneficiaryChange(
  request: BeneficiaryChangeRequest,
  event: BeneficiaryChangeEvent,
  now: Instant,
): Result<BeneficiaryChangeRequest, ReasonKey> {
  if (request.status === 'auto_blocked' || request.status === 'applied') {
    return failure(REASON_KEYS.beneficiaryChangeInReleaseWindow);
  }
  switch (event.type) {
    case 'reverification_passed':
      return ok(Object.freeze({ ...request, reverifiedAt: now }));
    case 'parties_notified':
      return ok(Object.freeze({ ...request, notifiedAt: now }));
    case 'approval_added': {
      if (event.userId === request.requestedBy) {
        // Второе утверждение — второй человек. Не настройка прав, а разные учётные записи.
        return failure(REASON_KEYS.beneficiaryChangeApproverNotDistinct);
      }
      if (request.approvals.includes(event.userId)) {
        return failure(REASON_KEYS.beneficiaryChangeApproverNotDistinct);
      }
      return ok(
        Object.freeze({
          ...request,
          approvals: Object.freeze([...request.approvals, event.userId]),
          status: 'awaiting_second_approval' as const,
        }),
      );
    }
  }
}

export interface BeneficiaryApplyInput {
  readonly releaseAt: Instant | null;
  readonly dealFunded: boolean;
  readonly locked: boolean;
}

/**
 * Применение изменения. Собирает все четыре условия сразу: повторная
 * верификация, охлаждение, уведомление, второе утверждение. Окно релиза
 * проверяется **повторно на момент применения** — заявка могла пролежать в
 * охлаждении ровно до входа в запретные 72 часа.
 */
export function applyBeneficiaryChange(
  state: BeneficiaryState,
  request: BeneficiaryChangeRequest,
  input: BeneficiaryApplyInput,
  approval: Authority<'approve_beneficiary_change'>,
  policy: CompliancePolicy,
  now: Instant,
): Result<BeneficiaryState, readonly ReasonKey[]> {
  const failures: ReasonKey[] = [];
  if (request.status === 'auto_blocked' || request.status === 'applied') {
    failures.push(REASON_KEYS.beneficiaryChangeInReleaseWindow);
  }
  if (withinBlackout(input.releaseAt, input.dealFunded, now, policy.beneficiary)) {
    failures.push(REASON_KEYS.beneficiaryChangeInReleaseWindow);
  }
  if (request.reverifiedAt === null) {
    failures.push(REASON_KEYS.beneficiaryChangeReverificationMissing);
  }
  if (input.locked) {
    if (now - request.requestedAt < policy.beneficiary.cooldown) {
      failures.push(REASON_KEYS.beneficiaryChangeCoolingOff);
    }
    if (request.notifiedAt === null) {
      failures.push(REASON_KEYS.beneficiaryChangeAwaitsSecondApproval);
    }
    const approvers = new Set(
      request.approvals.filter((userId) => userId !== request.requestedBy),
    );
    if (approval.actorId !== request.requestedBy) approvers.add(approval.actorId);
    if (approvers.size < policy.beneficiary.requiredApprovals) {
      failures.push(REASON_KEYS.beneficiaryChangeAwaitsSecondApproval);
    }
    if (approval.actorId === request.requestedBy) {
      failures.push(REASON_KEYS.beneficiaryChangeApproverNotDistinct);
    }
  }
  if (failures.length > 0) return failure(Object.freeze(failures));

  return ok(
    Object.freeze({
      requisites: request.proposed,
      // Новые реквизиты не наследуют статус старых: доказательство владения
      // относилось к другому счёту.
      status: 'name_consistent' as const,
      locked: state.locked,
      lastChangedAt: now,
    }),
  );
}
