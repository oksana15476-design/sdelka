import {
  type BeneficiaryConfirmation,
  type BeneficiaryStatus,
  type Instant,
  type ParticipationKey,
  type Result,
  BENEFICIARY_STATUSES,
  beneficiaryConfirmation,
  failure,
  ok,
} from '@sdelka/domain';
import {
  type Decision,
  type EvidenceRef,
  type PolicyVersionId,
  decision,
} from './decision';
import {
  type DualControl,
  dualControlFailures,
  isDistinctApprover,
} from './dual-control';
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

/**
 * Реквизиты **одного участия**, а не лица (`@sdelka/domain`,
 * `participation.ts`; `ROADMAP.md` И13.1: «реквизиты висят на участии, а не на
 * личности: подтверждение по одной сделке не переносится на другую»).
 *
 * Участие приходит сюда не отдельным полем рядом со статусом, а **из решения о
 * проверке**: `beneficiaryStateOf` берёт его у `BeneficiaryVerification`, а тот
 * получает участие первым аргументом. Порядок именно такой, потому что иначе
 * участие оставалось бы свободным параметром: состояние, проверенное по сделке
 * А, помечалось бы сделкой Б одним присваиванием, и вся конструкция описывала
 * бы перенос, а не запрет переноса.
 */
export interface BeneficiaryState {
  readonly requisites: BeneficiaryRequisites;
  /** Участие, для которого эти реквизиты заявлены и проверены. */
  readonly participation: ParticipationKey;
  readonly status: BeneficiaryStatus;
  /** Блокировка наступает при финансировании сделки, а не по решению оператора. */
  readonly locked: boolean;
  readonly lastChangedAt: Instant | null;
}

export interface BeneficiaryVerification extends Decision<BeneficiaryStatus> {
  readonly nameMatch: NameMatch;
  /**
   * Участие, по которому принято решение. Часть решения, а не контекст вызова:
   * `CORE.md` Ф11 требует, чтобы решение хранило всё, что понадобится для его
   * восстановления, а «чьё это подтверждение» — первое, что понадобится.
   */
  readonly participation: ParticipationKey;
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
  participation: ParticipationKey,
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
      participation,
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
      participation,
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
      participation,
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
    participation,
  });
}

/**
 * Состояние реквизитов из **решения о проверке**.
 *
 * Единственный конструктор состояния, и участие он берёт у решения, а не у
 * вызывающего. Отсюда следует правило И13.1 целиком: чтобы получить
 * подтверждённые реквизиты по участию Б, надо провести проверку **по участию
 * Б** — то есть предъявить доказательство владения счётом ещё раз. Скопировать
 * решение по участию А сюда нечем: участие в нём уже записано, а второго места,
 * где его можно назвать, нет.
 *
 * Реквизиты передаются отдельным аргументом, потому что решение о них —
 * решение, а не хранилище: `Decision` несёт исход, версию политики, причины и
 * доказательства, но не сам счёт (`decision.ts`, `log-safe.ts` — реквизиты в
 * логи и решения не попадают).
 */
export function beneficiaryStateOf(
  verification: BeneficiaryVerification,
  requisites: BeneficiaryRequisites,
): BeneficiaryState {
  return Object.freeze({
    requisites,
    participation: verification.participation,
    status: verification.outcome,
    // Блокировка — следствие финансирования сделки, а не проверки владельца:
    // свежее состояние не заперто, запирает его `lockOnFunding` по событию.
    locked: false,
    lastChangedAt: null,
  });
}

/** Блокировка при финансировании сделки. Не действие оператора, а следствие события. */
export function lockOnFunding(state: BeneficiaryState): BeneficiaryState {
  return Object.freeze({ ...state, locked: true });
}

/**
 * Факт для guard'ов `g_beneficiary_locked` и `g_beneficiary_verified` в
 * `@sdelka/domain`.
 *
 * Значение изготавливает **домен** (`beneficiaryConfirmation`), а не этот
 * пакет: тип номинальный, его конструктор наружу не выпущен, и собрать
 * подтверждение литералом нельзя нигде. Здесь только передача состояния — и
 * участие едет вместе с ним.
 *
 * Что это закрывает. Раньше функция называлась `toBeneficiaryLock` и отдавала
 * домену `{ status, locked, lastChangedAt }` — три поля без ключа. Подтверждение,
 * полученное по сделке А, ложилось фактом транша сделки Б одним присваиванием, и
 * ни один guard этого не видел: злоумышленник, один раз прошедший проверку,
 * получал подтверждённый канал вывода по любой будущей сделке (И13.1).
 */
export function toBeneficiaryConfirmation(state: BeneficiaryState): BeneficiaryConfirmation {
  // Статус доезжает до домена целиком. Раньше он здесь **выбрасывался**, и
  // различение `name_consistent` / `verified`, ради которого написан
  // `verifyBeneficiaryHolder`, до автомата не доходило: выплата на реквизиты,
  // прошедшие только сверку имени, проходила (ROADMAP.md И13.1, E13-2).
  return beneficiaryConfirmation({
    participation: state.participation,
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
        Object.freeze({ type: 'require_reverification' as const, requestId: input.requestId }),
        Object.freeze({
          type: 'notify_all_parties_all_channels' as const,
          requestId: input.requestId,
        }),
        Object.freeze({ type: 'require_second_approval' as const, requestId: input.requestId }),
      ])
    : Object.freeze([
        Object.freeze({ type: 'require_reverification' as const, requestId: input.requestId }),
      ]);

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
      // Второе утверждение — второй человек. Не настройка прав, а разные учётные
      // записи; проверка одна на все периметры (`dual-control.ts`).
      //
      // Порог сюда не передаётся: вопрос «годится ли этот утверждающий» о людях,
      // а не о счёте. Раньше здесь стоял `requiredApprovals: 0` — поле не
      // читалось, но читался ноль, и выглядело это как «нуля утверждений
      // достаточно». Порог проверяется один раз, в `applyBeneficiaryChange`.
      if (
        !isDistinctApprover(
          { preparedBy: request.requestedBy, approvals: request.approvals },
          event.userId,
        )
      ) {
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
      failures.push(REASON_KEYS.beneficiaryChangeNotificationMissing);
    }
    // Правило «две различные учётные записи, и ни одна не готовила» живёт в
    // `dual-control.ts` в единственном экземпляре: до него оно было написано
    // здесь, у утверждений выплаты в домене и у разморозки — трижды порознь.
    // Ключи причин остаются периметровыми: оператору нужна строка про реквизиты,
    // а не про «второе утверждение вообще».
    const control: DualControl = {
      preparedBy: request.requestedBy,
      approvals: Object.freeze([...request.approvals, approval.actorId]),
      requiredApprovals: policy.beneficiary.requiredApprovals,
    };
    failures.push(
      ...dualControlFailures(
        control,
        {
          awaits: REASON_KEYS.beneficiaryChangeAwaitsSecondApproval,
          notDistinct: REASON_KEYS.beneficiaryChangeApproverNotDistinct,
        },
        approval.actorId,
      ),
    );
  }
  if (failures.length > 0) return failure(Object.freeze(failures));

  return ok(
    Object.freeze({
      requisites: request.proposed,
      /**
       * Участие — прежнее, из состояния, а не из заявки. Изменение реквизитов
       * это изменение **внутри участия**: сторона меняет счёт, на который
       * получает деньги по этой сделке (И13.2: «процедура применяется к
       * участию, где он получает; на вторую сделку изменение не
       * распространяется»). Заявка, которая могла бы принести другое участие,
       * означала бы переезд подтверждения между сделками через смену
       * реквизитов — обход того же запрета с другой стороны.
       */
      participation: state.participation,
      // Новые реквизиты не наследуют статус старых: доказательство владения
      // относилось к другому счёту.
      status: 'name_consistent' as const,
      locked: state.locked,
      lastChangedAt: now,
    }),
  );
}
