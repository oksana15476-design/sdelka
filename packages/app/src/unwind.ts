import {
  type AuditRoleId,
  type NonEmpty,
  type RawSourceRef,
  appendRecord,
  auditInstant,
  auditRef,
  policyRef,
} from '@sdelka/audit';
import { requireAuditRole } from '@sdelka/auth';
import type { DealEvent, Rejection } from '@sdelka/domain';
import {
  type Authority,
  actingAccount,
  actingRole,
  assertOrigin,
  journalActor,
} from './authority';
import { type TrancheEventOptions, applyDealEvent, rejectDealEvent } from './flow';
import {
  type UnwindApproval,
  type UnwindReview,
  type World,
  dealOf,
  sealed,
  withDeal,
} from './world';

/**
 * Разбор человеком — путь из «подано» к возврату покупателю, когда реестр
 * молчит (красная линия №7, `STATE-MACHINES.md` §3.2).
 *
 * ## Зачем модуль появился
 *
 * Событие `unwind_authorized` и guard `g_unwind_approvers_distinct` в домене
 * были (`packages/domain/src/deal.ts:93`, `:277`, `:384-386`), а **порождать их
 * было некому**: во всём `packages/app`, `packages/e2e` и `apps/web` строка
 * `unwind_authorized` не встречалась ни разу. Единственным способом пройти это
 * ребро был вызов редьюсера из тела теста домена — то есть проверка, что
 * функция возвращает то, что в ней написано.
 *
 * Мутационный прогон это и показал: снятие `g_unwind_approvers_distinct` не
 * роняло ни одного сквозного теста. Правило стояло на двери, к которой не вело
 * ни одной дороги, и снести его можно было незаметно.
 *
 * ## Как устроен путь
 *
 * Три шага, и они разнесены во времени не для красоты: подписи ставят разные
 * люди в разные моменты, и мир между подписями обязан быть выразим.
 *
 * 1. `requestUnwind` — оператор поднимает разбор: причина (ключ локализации) и
 *    основание (сырые ответы источников). Деньги не двигаются.
 * 2. `approveUnwind` — утверждающий ставит подпись. Своим именем: имя берётся
 *    из актора журнала аудита, а не из аргумента, поэтому подписать за другого
 *    нельзя, и подпись не может разойтись с записью в журнале.
 * 3. `authorizeUnwind` — собранные подписи предъявляются автомату сделки одним
 *    событием. Пропустит их или нет — решает домен.
 *
 * ## Чего здесь нет намеренно
 *
 * **Проверки «утверждающих двое и они разные».** Она живёт ровно в одном месте
 * — в guard'е `g_unwind_approvers_distinct`, — и второй её экземпляр здесь
 * означал бы, что снятие guard'а ничего не меняет: мутационный прогон отчитался
 * бы о покрытии, которого нет. Поэтому приложение подписи **не схлопывает**,
 * повтор одного имени не отбрасывает и готовившего операцию не отсеивает: всё
 * это — работа домена, и она обязана быть видна, когда её отключают.
 */

/* ------------------------------------------------------------------------- */
/* Кто вправе подписать                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Перечня ролей `UNWIND_SIGNING_ROLES` здесь **больше нет**, и это то самое
 * [открыто], которое стояло в прошлой редакции этого файла и в
 * `docs/product/APP-LAYER.md` §5.
 *
 * Прежде подписывать откат разрешалось по **роли актора журнала** —
 * `operator`, `approver`, `compliance_analyst`, — а сам актор приезжал полем
 * `options.actor`, то есть его называл вызывающий. Проверка сводилась к
 * «назовись подходящей ролью». Комментарий тогда честно писал: «настоящее место
 * этой проверки — `@sdelka/auth` (проверка сессии); до тех пор здесь стоит самый
 * строгий из выразимых вариантов».
 *
 * Место найдено. Подпись под откатом — это `approve_lift_block`: «вторая
 * подпись» `ACTORS.md` §5.3, класс `release`, второй фактор, и четыре
 * несовместимости сразу — Н1 (не готовил), Н4 (не заявлял реквизиты), Н5 (не
 * вызвал расхождение), Н6 (не видит маржу). Носителей ровно два: ФК и РО, то
 * есть те же, кто даёт уровни утверждения. Оператор и аналитик, которым прежняя
 * редакция подписывать позволяла, подписывать больше не могут — и это
 * **ужесточение**, а не смена вкуса: они готовят разбор, а не утверждают его.
 *
 * Сторона (`party`, `representative`) не подписывает по-прежнему: у неё этого
 * полномочия нет вовсе, и второй разбор развилки `STATE-MACHINES.md` §3.2
 * остаётся решением владельца.
 */

/* ------------------------------------------------------------------------- */
/* Заявка на разбор                                                          */
/* ------------------------------------------------------------------------- */

export interface UnwindRequest {
  /** Ключ локализации причины: почему деньги возвращаются. Текста в коде нет. */
  readonly reasonKey: string;
  /** Основание решения: сырые ответы источников, а не пересказ. */
  readonly evidence: readonly RawSourceRef[];
}

function requireEvidence(
  evidence: readonly RawSourceRef[],
  dealId: string,
): NonEmpty<RawSourceRef> {
  const [head, ...rest] = evidence;
  if (head === undefined) {
    // Решение вернуть деньги при поданном заявлении без единого основания
    // невосстановимо через год: запись журнала его и не примет по типу.
    throw new Error(`app.unwind.evidence_required:${dealId}`);
  }
  return [head, ...rest];
}

function reviewOf(world: World, dealId: string): UnwindReview {
  const review = dealOf(world, dealId).unwindReview;
  if (review === null) {
    // Подпись под заявкой, которой нет, — не подпись. Отказ здесь, а не тихое
    // заведение заявки задним числом: иначе «кто поднял разбор» останется без
    // ответа именно в том случае, когда он нужен.
    throw new Error(`app.unwind.not_requested:${dealId}`);
  }
  return review;
}

/** Событие для автомата сделки — из собранных подписей, и ниоткуда больше. */
function unwindEvent(review: UnwindReview): DealEvent {
  return { type: 'unwind_authorized', userIds: review.approvals.map((item) => item.userId) };
}

/**
 * Поднять разбор отката.
 *
 * Деньги не двигаются, состояние сделки не меняется: заявка — это заявление о
 * намерении, а не переход. Шаг всё равно запечатывается: «инварианты после
 * каждого шага» не знает исключений.
 *
 * Полномочие — `prepare_settlement` (`ACTORS.md` §5.1.1, Ф9): поднять разбор
 * значит **подготовить** откат, а не разрешить его. Разрешают двое и другим
 * полномочием — `approve_lift_block`, связанным Н1, Н4, Н5 и Н6 сразу, и
 * заявитель среди них быть не может.
 */
export function requestUnwind(
  world: World,
  dealId: string,
  request: UnwindRequest,
  authority: Authority<'prepare_settlement'>,
  options: TrancheEventOptions,
): World {
  assertOrigin(['prepare_settlement'], authority, 'unwind.request');
  const deal = dealOf(world, dealId);
  if (deal.unwindReview !== null) {
    // Вторая заявка по той же сделке — это не второй разбор, а потерянный
    // первый: подписи под ним пришлось бы куда-то деть.
    throw new Error(`app.unwind.already_open:${dealId}`);
  }
  if (request.reasonKey.length === 0) {
    throw new Error(`app.unwind.reason_required:${dealId}`);
  }
  const evidence = requireEvidence(request.evidence, dealId);
  const review: UnwindReview = {
    requestedBy: actingAccount(authority),
    reasonKey: request.reasonKey,
    openedAt: world.now,
    evidence,
    approvals: Object.freeze<UnwindApproval[]>([]),
  };

  const seq = world.seq + 1;
  return sealed({
    ...world,
    seq,
    deals: withDeal(world, { ...deal, unwindReview: review }),
    chain: appendRecord(world.chain, {
      recordId: `${world.chain.chainId}:r${seq}`,
      recordedAt: auditInstant(world.now),
      actor: journalActor(authority),
      subject: auditRef('deal', dealId),
      related: deal.trancheIds.map((trancheId) => auditRef('tranche', trancheId)),
      body: {
        kind: 'decision_made',
        outcomeKey: 'deal.unwind_requested',
        policy: policyRef(options.policy),
        reasonKeys: [request.reasonKey],
        evidence,
      },
    }),
    checks: world.checks,
  });
}

/**
 * Поставить подпись под откатом.
 *
 * Имя подписывающего — `options.actor.actorId`, и это не удобство: подпись,
 * приходящая отдельным аргументом, позволяет записать в журнал одно имя, а в
 * решение подставить другое. Здесь разойтись нечему.
 *
 * Повтор той же подписи **не отбрасывается** — см. заголовок модуля: различие
 * утверждающих проверяет домен, и проверять его дважды значит перестать
 * проверять вовсе.
 */
export function approveUnwind(
  world: World,
  dealId: string,
  authority: Authority<'approve_lift_block'>,
  options: TrancheEventOptions,
): World {
  assertOrigin(['approve_lift_block'], authority, 'unwind.approve');
  const deal = dealOf(world, dealId);
  const review = reviewOf(world, dealId);
  const roleId: AuditRoleId = requireAuditRole(actingRole(authority));
  const approval: UnwindApproval = {
    userId: actingAccount(authority),
    roleId,
    at: world.now,
  };

  const seq = world.seq + 1;
  return sealed({
    ...world,
    seq,
    deals: withDeal(world, {
      ...deal,
      unwindReview: { ...review, approvals: [...review.approvals, approval] },
    }),
    chain: appendRecord(world.chain, {
      recordId: `${world.chain.chainId}:r${seq}`,
      recordedAt: auditInstant(world.now),
      actor: journalActor(authority),
      subject: auditRef('deal', dealId),
      related: deal.trancheIds.map((trancheId) => auditRef('tranche', trancheId)),
      body: {
        kind: 'decision_made',
        outcomeKey: 'deal.unwind_approved',
        policy: policyRef(options.policy),
        // Причина у подписи та же, что у заявки: подписывают конкретный разбор,
        // а не откат вообще.
        reasonKeys: [review.reasonKey],
        evidence: review.evidence,
      },
    }),
    checks: world.checks,
  });
}

/**
 * Предъявить собранные подписи автомату сделки.
 *
 * Отказ автомата — исключение, как и у всех прочих шагов мира: сценарий,
 * ожидающий отказа, разбирает его значением через `rejectUnwind` и называет
 * guard поимённо (`STATE-MACHINES.md` §7).
 *
 * Проверки «подписей хотя бы две» здесь нет: пустой разбор обязан отвергать
 * домен, иначе на снятом guard'е откат прошёл бы вообще без подписей и никто бы
 * этого не заметил.
 */
export function authorizeUnwind(
  world: World,
  dealId: string,
  authority: Authority<'approve_lift_block'>,
  options: TrancheEventOptions,
): World {
  const review = reviewOf(world, dealId);
  return applyDealEvent(world, dealId, unwindEvent(review), authority, options);
}

/** Отказ автомата как значение: тест, который его ждёт, обязан его разобрать. */
export function rejectUnwind(world: World, dealId: string): Rejection {
  return rejectDealEvent(world, dealId, unwindEvent(reviewOf(world, dealId)));
}

/** Открытый разбор по сделке — для консоли операций и для отчётности. */
export function unwindReviewOf(world: World, dealId: string): UnwindReview | null {
  return dealOf(world, dealId).unwindReview;
}
