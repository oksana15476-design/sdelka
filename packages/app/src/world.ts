import type { Anchor, AuditChain, RawSourceRef } from '@sdelka/audit';
import { verifyChain } from '@sdelka/audit';
import type { BeneficiaryState, NameObservation, ReviewTask } from '@sdelka/compliance';
import {
  type Audience,
  type ConditionAct,
  type DealFiling,
  type DealState,
  type Instant,
  type PayoutState,
  type TrancheFacts,
  type TrancheState,
  boundConditionAct,
  isTerminalTrancheStatus,
  violatesSingleActivePayout,
} from '@sdelka/domain';
import type { ObservationState, ObservationTaskKind } from '@sdelka/oracle';
import {
  type ClientKey,
  type Journal,
  accountBalance,
  balanceByCurrency,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  checkLedgerInvariants,
  isEveryFundsSourceCovered,
  isEveryTrancheCovered,
  isFullyCovered,
  negativeClientBalances,
} from '@sdelka/ledger';
import type { CurrencyCode, Deduction, Money } from '@sdelka/money';
import type { LedgerTemplate } from '@sdelka/domain';

/** Уведомление стороне. `messageKey` — ключ локализации, текста в коде нет. */
export interface Notification {
  readonly audience: Audience;
  readonly messageKey: string;
}

/** Намерение проводки, у которого проводки не оказалось. Видно тесту, а не молча. */
export interface SuppressedEntry {
  readonly trancheId: string;
  readonly template: LedgerTemplate;
  readonly reasonKey: string;
}

export interface TrancheRuntime {
  readonly dealId: string;
  readonly trancheId: string;
  readonly state: TrancheState;
  readonly facts: TrancheFacts;
  readonly deductions: readonly Deduction[];
  /**
   * Версия тарифного плана, по которой считается комиссия (`CORE.md` Ф16,
   * И14.3). Уходит фактом в журнал вместе с начислением.
   *
   * ⚠ Её место — на сделке, в `packages/domain`; пока его там нет, держит
   * приложение. Названо в отчёте.
   */
  readonly tariffVersionId: string;
  readonly payouts: readonly PayoutState[];
  readonly beneficiary: BeneficiaryState;
  /**
   * Имена покупателя как наблюдения: вход сверки собственника из выписки.
   * Лежат при транше, а не приезжают параметром в шаг приложения — иначе
   * выписку можно было бы сверить с именами постороннего лица (`CORE.md` Ф7).
   */
  readonly buyerNames: readonly NameObservation[];
  /** Сырые ответы источников, из которых собирается пакет доказательств. */
  readonly evidence: readonly RawSourceRef[];
  /** Приостановленный остаток дедлайна, если транш заморожен. */
  readonly suspendedRemaining: number | null;
  /**
   * Состояние машины наблюдения по этому траншу (`@sdelka/oracle`).
   *
   * Живёт рядом с траншем, а не отдельной картой мира: наблюдение всегда о
   * конкретном условии конкретного транша, и «наблюдение без транша» —
   * состояние, которого не бывает. Деньги оно не двигает: движение остаётся за
   * guard'ами транша, машина только собирает наблюдение и присваивает уровень
   * доверия (`CTO-architecture.md`, «Принцип разделения», п. 2).
   */
  readonly observation: ObservationState;
}

export interface DealRuntime {
  readonly dealId: string;
  readonly state: DealState;
  readonly conditionAct: ConditionAct | null;
  readonly preparedBy: string | null;
  readonly trancheIds: readonly string[];
  /**
   * Кадастровый код объекта сделки. Один на сделку, а не по одному на транш:
   * транши — это график платежей по одному объекту, и два разных кода у одной
   * сделки означали бы две сделки.
   */
  readonly objectCadastralCode: string;
  /**
   * Заявления, поданные по этой сделке (`ORACLE.md` §9, И3.2). Наполняется
   * событием `filing_registered`, читается guard'ом `g_no_open_filing`.
   */
  readonly filings: readonly DealFiling[];
}

/**
 * Задача оператору, порождённая наблюдением оракула.
 *
 * ⚠ **Отдельный список, а не строка в очереди `@sdelka/compliance`, — и это
 * названное расхождение, а не архитектурный замысел.**
 *
 * У оракула три вида задачи: `owner_reconciliation` («собственника установить
 * не смогли»), `field_mismatch` («поле выписки разошлось») и
 * `observation_insufficient` («документ не дотягивает»). В
 * `REVIEW_TASK_KINDS` (`packages/compliance/src/queue.ts`) нет ни одного из
 * них. Подставить вместо них ближайший существующий вид значило бы показать
 * оператору очередь «источник средств» или «цена разошлась» там, где речь о
 * выписке из реестра, — то есть соврать в интерфейсе ради того, чтобы тип
 * сошёлся.
 *
 * Поэтому задача заводится своим типом и лежит рядом, пока в очередь не
 * добавят три строки. Чинится тремя строками в чужом пакете; до тех пор
 * расхождение видно, а не растворено.
 */
export interface ObservationTask {
  readonly taskId: string;
  readonly dealId: string;
  readonly trancheId: string;
  readonly kind: ObservationTaskKind;
  readonly enteredAt: Instant;
  readonly policyVersionId: string;
}

export interface World {
  readonly now: Instant;
  readonly journal: Journal;
  readonly chain: AuditChain;
  readonly anchors: readonly Anchor[];
  readonly deals: ReadonlyMap<string, DealRuntime>;
  readonly tranches: ReadonlyMap<string, TrancheRuntime>;
  readonly tasks: readonly ReviewTask[];
  /** Задачи оракула: см. `ObservationTask` — почему они лежат отдельно. */
  readonly observationTasks: readonly ObservationTask[];
  readonly notifications: readonly Notification[];
  readonly suppressed: readonly SuppressedEntry[];
  /**
   * Ключи идемпотентности поручений, которые автомат велел отправить повторно.
   * Гасятся ключом, а не молчанием: повтор обязан быть виден. Отчёт, расхождение 13.
   */
  readonly reissuedPayouts: readonly string[];
  /** Сколько раз инварианты проверялись. Растёт на каждом шаге, тест это видит. */
  readonly checks: number;
  /** Счётчик идентификаторов записей журнала и аудита. */
  readonly seq: number;
}

/* ------------------------------------------------------------------------- */
/* Инварианты                                                                */
/* ------------------------------------------------------------------------- */

export const APP_INVARIANTS = [
  'entry_not_zero',
  'coverage_below_one',
  'tranche_uncovered',
  'funds_source_uncovered',
  'negative_client_balance',
  /**
   * Собранное, объявленное приложением, не обеспечено учётом.
   *
   * `collectedAmount` — **единственный денежный факт, который приложение держит
   * само**: покрытие и запертую сумму `contextFor` пересчитывает из журнала на
   * каждый вызов, а собранное берёт из события `funds_received` и запоминает.
   * Отнесение свободной части счёта клиента к траншу в журнале не записано
   * (зачисление кредитует `client:{c}:free`, где траншей не видно), поэтому
   * вывести собранное из журнала нельзя — но **проверить** можно: сумма
   * притязаний живых траншей одного клиента не может превышать того, что учёт
   * этому клиенту должен.
   *
   * Проба, которую это закрывает: приложение объявляет полную сумму, а на счёт
   * клиента пришло на 50 ₾ меньше. Транш проходит `collected`,
   * `refund_pending` и `refunding` — **каждый шаг запечатан без единого
   * нарушения**, — и падает только на `refunded`, когда деньги физически
   * уходят с номинального счёта. Денежный факт, который приложение может
   * объявить, — не факт, и ловиться он обязан на шаге, где объявлен, а не
   * тремя шагами позже.
   */
  'collected_not_backed',
  'double_active_payout',
  'non_terminal_without_deadline',
  'audit_chain_broken',
] as const;

export type AppInvariant = (typeof APP_INVARIANTS)[number];

export interface InvariantViolation {
  readonly invariant: AppInvariant;
  readonly subject: string;
  readonly detail: string;
}

/**
 * Проверка после каждого шага.
 *
 * Четыре денежных инварианта здесь проверяются **поимённо**, а не одним вызовом
 * `checkLedgerInvariants`, хотя он их и покрывает: сквозной прогон обязан
 * называть нарушенное правило, а не отдавать список кодов. Пятый и шестой —
 * из домена: одна активная выплата на транш и «нетерминальное состояние несёт
 * дедлайн либо остаток приостановленного дедлайна» (`STATE-MACHINES.md` §5,
 * уточнение E9-10). Седьмой — целостность журнала аудита: он тоже часть шага.
 */
export function invariantViolations(world: World): readonly InvariantViolation[] {
  const out: InvariantViolation[] = [];

  // 1. Сумма проводок в записи равна нулю по каждой валюте.
  for (const entry of world.journal.entries) {
    for (const [currency, total] of balanceByCurrency(entry.postings)) {
      if (total !== 0n) {
        out.push({ invariant: 'entry_not_zero', subject: entry.id, detail: `${currency}:${total}` });
      }
    }
  }

  // 2. Покрытие клиентских средств по портфелю.
  if (!isFullyCovered(world.journal)) {
    out.push({ invariant: 'coverage_below_one', subject: 'portfolio', detail: '' });
  }

  // 3. Пофайловое обеспечение: по траншу и по счёту клиента.
  if (!isEveryTrancheCovered(world.journal)) {
    out.push({ invariant: 'tranche_uncovered', subject: 'tranche', detail: '' });
  }
  if (!isEveryFundsSourceCovered(world.journal)) {
    out.push({ invariant: 'funds_source_uncovered', subject: 'funds_source', detail: '' });
  }

  // 4. Неотрицательность остатков клиентских счетов.
  for (const item of negativeClientBalances(world.journal)) {
    out.push({
      invariant: 'negative_client_balance',
      subject: item.accountCode,
      detail: item.balance.minor.toString(),
    });
  }

  // 5. Собранное, объявленное приложением, обеспечено учётом.
  for (const violation of unbackedCollectedClaims(world)) {
    out.push(violation);
  }

  for (const tranche of world.tranches.values()) {
    if (violatesSingleActivePayout(tranche.payouts, tranche.trancheId)) {
      out.push({ invariant: 'double_active_payout', subject: tranche.trancheId, detail: '' });
    }
    const state = tranche.state;
    if (isTerminalTrancheStatus(state.status)) continue;
    if (!('deadline' in state) && !('remaining' in state)) {
      out.push({
        invariant: 'non_terminal_without_deadline',
        subject: tranche.trancheId,
        detail: state.status,
      });
    }
  }

  const integrity = verifyChain(world.chain);
  if (!integrity.intact) {
    out.push({
      invariant: 'audit_chain_broken',
      subject: world.chain.chainId,
      detail: integrity.firstBreak.kind,
    });
  }

  // Второй контур: коды учёта. Если он что-то видит, а поимённые проверки нет —
  // расходятся не деньги, а наши представления о них, и это тоже отказ.
  for (const violation of checkLedgerInvariants(world.journal)) {
    if (out.some((item) => item.subject === violation.subject)) continue;
    out.push({
      invariant: 'coverage_below_one',
      subject: violation.subject,
      detail: violation.code,
    });
  }

  return Object.freeze(out);
}

/**
 * Притязания живых траншей на деньги клиента против того, что учёт этому
 * клиенту должен.
 *
 * Сумма — по клиенту и валюте, а не по одному траншу: два транша одного
 * покупателя, каждый в пределах остатка, вместе могут этот остаток превышать, и
 * пофайловая проверка такую пару пропустила бы. Терминальные транши не
 * считаются: их обязательство уже погашено расчётом, возвратом или списанием, а
 * `collectedAmount` в фактах остаётся как след прошлого.
 *
 * Обеспечением считается **свободная часть плюс запертое под траншами этого же
 * клиента**: пока деньги не заперты, притязание опирается на свободный остаток,
 * после запирания — на файл транша. Обе половины принадлежат одному клиенту, и
 * складывать их законно.
 */
function unbackedCollectedClaims(world: World): readonly InvariantViolation[] {
  const claims = new Map<string, { owner: ClientKey; currency: CurrencyCode; minor: bigint }>();
  const owners = new Map<ClientKey, TrancheRuntime[]>();
  for (const tranche of world.tranches.values()) {
    const owner = payerOf(tranche);
    owners.set(owner, [...(owners.get(owner) ?? []), tranche]);
    if (isTerminalTrancheStatus(tranche.state.status)) continue;
    const claimed = tranche.facts.collectedAmount;
    if (claimed === null || claimed.minor <= 0n) continue;
    const key = `${owner}|${claimed.currency}`;
    const previous = claims.get(key);
    claims.set(key, {
      owner,
      currency: claimed.currency,
      minor: (previous?.minor ?? 0n) + claimed.minor,
    });
  }

  const out: InvariantViolation[] = [];
  for (const claim of claims.values()) {
    let backing = accountBalance(world.journal, clientFreeAccount(claim.owner), claim.currency).minor;
    for (const tranche of owners.get(claim.owner) ?? []) {
      backing += accountBalance(
        world.journal,
        clientLockedAccount(claim.owner, tranche.dealId, tranche.trancheId),
        claim.currency,
      ).minor;
    }
    if (claim.minor > backing) {
      out.push({
        invariant: 'collected_not_backed',
        subject: `${claim.owner}:${claim.currency}`,
        detail: `${claim.minor} > ${backing}`,
      });
    }
  }
  return out;
}

export class AppInvariantError extends Error {
  readonly violations: readonly InvariantViolation[];

  constructor(violations: readonly InvariantViolation[]) {
    super(
      `invariant violated: ${violations
        .map((item) => `${item.invariant}(${item.subject}${item.detail === '' ? '' : ` ${item.detail}`})`)
        .join(', ')}`,
    );
    this.name = 'AppInvariantError';
    this.violations = violations;
  }
}

/**
 * Запечатать шаг: проверить инварианты и вернуть новое состояние мира.
 *
 * Единственный способ получить новый `World` — пройти через эту функцию, и
 * поэтому «инварианты проверяются после каждого шага» держится структурой, а не
 * дисциплиной тестов.
 */
export function sealed(next: Omit<World, 'checks'> & { readonly checks: number }): World {
  const candidate: World = Object.freeze({ ...next, checks: next.checks + 1 });
  const violations = invariantViolations(candidate);
  if (violations.length > 0) {
    throw new AppInvariantError(violations);
  }
  return candidate;
}

export function trancheOf(world: World, trancheId: string): TrancheRuntime {
  const runtime = world.tranches.get(trancheId);
  if (runtime === undefined) {
    throw new Error(`app.unknown_tranche:${trancheId}`);
  }
  return runtime;
}

export function dealOf(world: World, dealId: string): DealRuntime {
  const runtime = world.deals.get(dealId);
  if (runtime === undefined) {
    throw new Error(`app.unknown_deal:${dealId}`);
  }
  return runtime;
}

/**
 * Плательщик по траншу — ключ счёта покупателя.
 *
 * Отдельного поля у него больше нет. Раньше приложение хранило `payer` рядом с
 * фактами и подставляло его в проводки, а сторону сделки называл `buyerPartyId`
 * в фактах: два ответа на один вопрос в двух местах, ни разу не сверенные
 * между собой. Теперь ответ один — `TrancheFacts.buyer`, где обе половины
 * личности лежат в одном значении (`PartyRef`, `FUNCTIONAL.md` §2.1), и взять
 * половину неоткуда.
 */
export function payerOf(runtime: TrancheRuntime): ClientKey {
  return clientKey(runtime.facts.buyer.accountKey);
}

/**
 * Получатель расчёта — **из акта об условии**, и ниоткуда больше.
 *
 * Свободного параметра `TrancheSpec.recipient` не существует: акт получателя
 * (ст. 27(2), `CORE.md` Ф13) называет того, кто определил обстоятельство, и
 * деньги идут ему. Акт берётся сначала из состояния транша — он привязан на
 * выходе из `pending` и меняется только амендментом обеих сторон, — и лишь для
 * `pending`, где привязки ещё нет, из фактов.
 *
 * Приложение эту функцию в проводки не подставляет: получателя расчёта в учёт
 * приносит намерение `post_settlement_entry` вместе с подтверждением домена.
 * Здесь она нужна отчётности и тестам, которым надо назвать ожидаемое лицо.
 */
export function recipientOf(runtime: TrancheRuntime): ClientKey {
  const act = boundConditionAct(runtime.state) ?? runtime.facts.conditionAct;
  if (act === null) {
    throw new Error(`app.tranche.condition_act_missing:${runtime.trancheId}`);
  }
  return clientKey(act.recipient.accountKey);
}

export function withTranche(world: World, runtime: TrancheRuntime): ReadonlyMap<string, TrancheRuntime> {
  const next = new Map(world.tranches);
  next.set(runtime.trancheId, runtime);
  return next;
}

export function withDeal(world: World, runtime: DealRuntime): ReadonlyMap<string, DealRuntime> {
  const next = new Map(world.deals);
  next.set(runtime.dealId, runtime);
  return next;
}

/** Свободный остаток клиента — читается из учёта, домен его не считает. */
export function coverageOk(journal: Journal): boolean {
  return isFullyCovered(journal) && isEveryTrancheCovered(journal) && isEveryFundsSourceCovered(journal);
}

export function moneyLabel(value: Money<CurrencyCode>): string {
  return `${value.currency}:${value.minor}`;
}
