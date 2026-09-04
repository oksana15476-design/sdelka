import { type Result, failure, ok } from '@sdelka/domain';
import { type DualControl, dualControlSatisfied } from '@sdelka/compliance';
import type { Instant } from '@sdelka/domain';
import { type AuthReasonKey, AUTH_REASON_KEYS } from './keys';
import type { ActorRef } from './ids';
import { includesActor, sameActor } from './ids';
import { type RoleId, ROLE_IDS } from './roles';

/**
 * Порог утверждения — **уровень роли, а не число подписей** (`ACTORS.md` §5.2).
 *
 * Прежнее решение было неверным: `Approval { userId }` и подсчёт множества
 * `userId` — это разделение обязанностей на уровне **учётных записей**, а не
 * полномочий. Учётная запись поддержки, оказавшаяся в списке утверждающих,
 * набирала кворум, и ни один guard этого не видел (`packages/domain/src/guards.ts`,
 * `distinctApprovers`).
 *
 * Здесь уровень добавлен как отдельное измерение поверх различности учётных
 * записей, а не вместо неё: различность остаётся вторым рубежом, не первым.
 * Правило «две различные учётные записи, и ни одна не готовила операцию» не
 * переписывается — оно берётся у общего примитива
 * `packages/compliance/src/dual-control.ts`, чтобы копий этого правила в проекте
 * не стало пять.
 */
export type ApprovalLevel = 1 | 2;

/**
 * Кто какой уровень даёт. Запись тотальная: новая роль обязана ответить, даёт
 * ли она уровень утверждения, и ответ «не даёт» должен быть написан.
 *
 * **Никакая роль не даёт оба** — это проверяется типом значения (`1 | 2 | null`,
 * не множество) и является всей сутью Н3: первое утверждение и второе не могут
 * прийти от одной роли, а значит и от одного человека в одной роли.
 */
export const APPROVAL_LEVELS: Readonly<Record<RoleId, ApprovalLevel | null>> = Object.freeze({
  party: null,
  representative: null,
  operator: null,
  oracle_operator: null,
  compliance_analyst: null,
  compliance_officer: null,
  financial_controller: 1,
  head_of_operations: 2,
  support: null,
  principal: null,
  auditor: null,
  client_counsel: null,
});

export function approvalLevel(roleId: RoleId): ApprovalLevel | null {
  return APPROVAL_LEVELS[roleId];
}

export interface ApprovalRecord {
  readonly actor: ActorRef;
  readonly roleId: RoleId;
  readonly level: ApprovalLevel;
  readonly at: Instant;
}

/**
 * Утверждение принимается только от роли, дающей уровень.
 *
 * Критерий приёмки `ACTORS.md` §10: «учётная запись с ролью поддержки попала в
 * список утверждающих ⇒ её утверждение не засчитывается». Не засчитывается тем,
 * что **не создаётся**: собрать `ApprovalRecord` без уровня нельзя.
 */
export function recordApproval(
  actor: ActorRef,
  roleId: RoleId,
  at: Instant,
): Result<ApprovalRecord, AuthReasonKey> {
  const level = APPROVAL_LEVELS[roleId];
  if (level === null) {
    return failure(AUTH_REASON_KEYS.sodApprovalLevelMissing);
  }
  return ok(Object.freeze({ actor, roleId, level, at }));
}

export interface QuorumRequest {
  /**
   * Сколько подписей требует ступень тарифа. `null` — ступень не берётся вовсе
   * (`FUNCTIONAL.md` §3.5: свыше 500 000 ₾ на пилоте не берём), и это не
   * «нужно много», а «нельзя никак».
   *
   * **Ноль здесь недостижим намеренно.** `packages/domain` уже запретил ступень
   * с нулём утверждений: автоматический релиз запрещён при любой сумме, и
   * владелец не вправе завести такую ступень (`ACTORS.md` §6.10, И16.5).
   */
  readonly required: number | null;
  /** Кто готовил операцию. Он не может её утверждать — Н1. */
  readonly preparedBy: ActorRef | null;
  readonly approvals: readonly ApprovalRecord[];
}

export interface Quorum {
  /** Утверждения, засчитанные к кворуму, в порядке поступления. */
  readonly counted: readonly ApprovalRecord[];
}

/**
 * Годные утверждающие: различные лица, ни одно из которых не готовило операцию.
 *
 * Различность по паре «учётная запись **или** человек» — см. `ids.ts`. Первое
 * попавшее утверждение лица сохраняется, повторное отбрасывается: одна и та же
 * рука, нажавшая дважды, — это одно утверждение.
 */
function eligibleApprovals(request: QuorumRequest): readonly ApprovalRecord[] {
  const accepted: ApprovalRecord[] = [];
  for (const approval of request.approvals) {
    if (request.preparedBy !== null && sameActor(approval.actor, request.preparedBy)) continue;
    if (includesActor(accepted.map((item) => item.actor), approval.actor)) continue;
    accepted.push(approval);
  }
  return Object.freeze(accepted);
}

/**
 * Кворум по **набору уровней**, а не по количеству записей.
 *
 * Тариф «две подписи» = один уровень 1 плюс один уровень 2, а не две любые
 * (`ACTORS.md` §5.2). Тариф «одна подпись» = уровень 1: финансовый контролёр —
 * это и есть «первое утверждение» (`ACTORS.md` §3.1, `FUNCTIONAL.md` §4.3.1).
 *
 * ⚠ Прочтение «одной подписи» строгое и является развилкой: сегодня
 * руководитель операций **в одиночку** ступень одной подписи не закрывает, хотя
 * он старше. Довод за строгость: уровень 2 определён документом как «второе
 * утверждение», и разрешить ему быть первым значит разрешить одному человеку
 * закрыть ступень, для которой он же будет вторым на соседней сделке. Цена
 * строгости — при отсутствии ФК мелкие выплаты стоят. См. отчёт.
 */
export function evaluateQuorum(request: QuorumRequest): Result<Quorum, AuthReasonKey> {
  if (request.required === null) {
    return failure(AUTH_REASON_KEYS.quorumTierNotOffered);
  }

  const counted = eligibleApprovals(request);

  /*
   * Различность учётных записей — общий примитив комплаенса, а не пятая копия
   * того же правила. Он смотрит только на учётные записи; измерение «человек»
   * уже отработано в `eligibleApprovals` выше.
   */
  const accountControl: DualControl = {
    preparedBy: request.preparedBy === null ? null : request.preparedBy.accountId,
    approvals: counted.map((item) => item.actor.accountId),
    requiredApprovals: request.required,
  };
  if (!dualControlSatisfied(accountControl)) {
    return failure(AUTH_REASON_KEYS.quorumApproversNotDistinct);
  }

  const levelOne = counted.find((item) => item.level === 1) ?? null;
  if (request.required >= 1 && levelOne === null) {
    return failure(AUTH_REASON_KEYS.quorumLevelOneMissing);
  }

  if (request.required >= 2) {
    const levelTwo = counted.find(
      (item) => item.level === 2 && (levelOne === null || !sameActor(item.actor, levelOne.actor)),
    );
    if (levelTwo === undefined) {
      return failure(AUTH_REASON_KEYS.quorumLevelTwoMissing);
    }
  }

  return ok(Object.freeze({ counted }));
}

/**
 * Инвариант §5.2: ровно одна роль на уровень 1 и ровно одна на уровень 2.
 *
 * Проверяется значением, а не прозой: если завтра уровень 1 получит вторая роль,
 * «двое утверждающих» перестанут означать двух разных людей в разных должностях,
 * а тест об этом скажет.
 */
export function approvalLevelViolations(): readonly string[] {
  const violations: string[] = [];
  for (const level of [1, 2] as const) {
    const holders = ROLE_IDS.filter((roleId) => APPROVAL_LEVELS[roleId] === level);
    if (holders.length !== 1) {
      violations.push(`level_holders:${level}:${holders.join(',')}`);
    }
  }
  return Object.freeze(violations);
}
