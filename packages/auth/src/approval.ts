import { type Result, failure, ok } from '@sdelka/domain';
import { type DualControl, dualControlSatisfied } from '@sdelka/compliance';
import type { Instant } from '@sdelka/domain';
import { AuthError, AuthErrorCode } from './errors';
import { type AuthReasonKey, AUTH_REASON_KEYS } from './keys';
import type { ActorRef, UnknownFact } from './ids';
import { UNKNOWN_FACT, includesActor, sameActor } from './ids';
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

/**
 * Сколько подписей требует ступень тарифа — **1 или 2, и ничего больше**.
 *
 * Прежде здесь стоял `number`, и `evaluateQuorum({ required: 0 })` отвечал
 * «кворум набран» без единого утверждения: ноль проходил все три проверки
 * (`>= 0` у различности, `required >= 1` и `required >= 2` — ложны). Ноль
 * подтверждений — это не низкий порог, а его отсутствие, то есть автоматический
 * релиз, прямо запрещённый при любой сумме (`ACTORS.md` §6.10, И16.5;
 * `packages/domain/src/guards.ts` — «ступени с нулём утверждений здесь нет и
 * быть не может»).
 *
 * Двойка — верх не по осторожности, а по устройству кворума: уровней всего два
 * (`APPROVAL_LEVELS`), и третью подпись брать неоткуда. Ступень «три подписи»
 * потребует сначала третьего уровня; до тех пор она невыразима.
 */
export const APPROVAL_REQUIREMENTS = [1, 2] as const;
export type ApprovalRequirement = (typeof APPROVAL_REQUIREMENTS)[number];

/**
 * Разбор числа подписей, пришедшего из-за границы процесса (ступень тарифа
 * лежит в базе, `requiredApprovals` в `packages/domain` возвращает `number`).
 *
 * Бросает, а не возвращает отказ, ровно как конструкторы идентификаторов:
 * ступень с нулём, тройкой или дробью — это не отказ в кворуме конкретной
 * сделке, а испорченная настройка, и продолжать по ней нельзя.
 */
export function approvalRequirement(value: number): ApprovalRequirement {
  const known = APPROVAL_REQUIREMENTS.find((candidate) => candidate === value);
  if (known === undefined) {
    throw new AuthError(AuthErrorCode.approvalRequirementInvalid, { value: String(value) });
  }
  return known;
}

export interface QuorumRequest {
  /**
   * Требование ступени. `null` — ступень не берётся вовсе (`FUNCTIONAL.md` §3.5:
   * свыше 500 000 ₾ на пилоте не берём), и это не «нужно много», а «нельзя
   * никак». Ноль невыразим типом; из базы значение приходит через
   * `approvalRequirement`.
   */
  readonly required: ApprovalRequirement | null;
  /**
   * Кто готовил операцию. Он не может её утверждать — Н1.
   *
   * `UNKNOWN_FACT` вместо прежнего `null`: «готовившего нет» и «готовившего не
   * выясняли» — разные вещи, а `null` покрывал обе и отключал Н1 в кворуме
   * молча. Неизвестность отказывает; операции без человека-подготовителя
   * (подготовка `system`) сегодня невыразимы — см. отчёт.
   */
  readonly preparedBy: ActorRef | UnknownFact;
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
function eligibleApprovals(
  approvals: readonly ApprovalRecord[],
  preparedBy: ActorRef,
): readonly ApprovalRecord[] {
  const accepted: ApprovalRecord[] = [];
  for (const approval of approvals) {
    if (sameActor(approval.actor, preparedBy)) continue;
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

  /*
   * Рантайм-дубль компиляционного рубежа. Тип не переживает границу процесса:
   * ступень приходит из базы и попадает сюда приведением. Ноль, тройка и дробь
   * обязаны отказать здесь, а не разойтись по ветвям сравнения ниже, где ноль
   * когда-то и означал «кворум набран».
   */
  const required = APPROVAL_REQUIREMENTS.find((candidate) => candidate === request.required);
  if (required === undefined) {
    return failure(AUTH_REASON_KEYS.quorumRequirementInvalid);
  }

  // Н1 в кворуме проверять нечем — значит он не проверен, значит отказ.
  if (request.preparedBy === UNKNOWN_FACT) {
    return failure(AUTH_REASON_KEYS.quorumPreparerUnknown);
  }
  const preparedBy = request.preparedBy;

  const counted = eligibleApprovals(request.approvals, preparedBy);

  /*
   * Различность учётных записей — общий примитив комплаенса, а не пятая копия
   * того же правила. Он смотрит только на учётные записи; измерение «человек»
   * уже отработано в `eligibleApprovals` выше.
   */
  const accountControl: DualControl = {
    preparedBy: preparedBy.accountId,
    approvals: counted.map((item) => item.actor.accountId),
    requiredApprovals: required,
  };
  if (!dualControlSatisfied(accountControl)) {
    return failure(AUTH_REASON_KEYS.quorumApproversNotDistinct);
  }

  // Уровень 1 нужен всегда: ступени, не требующей ни одной подписи, не бывает.
  const levelOne = counted.find((item) => item.level === 1) ?? null;
  if (levelOne === null) {
    return failure(AUTH_REASON_KEYS.quorumLevelOneMissing);
  }

  if (required === 2) {
    const levelTwo = counted.find(
      (item) => item.level === 2 && !sameActor(item.actor, levelOne.actor),
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
