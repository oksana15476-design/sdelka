import {
  type BeneficiaryStatus,
  type UnfreezeTarget,
  type WithdrawalStatus,
  UNFREEZE_TARGETS,
  WITHDRAWAL_REQUIRED_APPROVALS,
  WITHDRAWAL_STATUSES,
  WITHDRAWAL_TRANSITIONS,
  isTerminalWithdrawalStatus,
} from '@sdelka/domain';
import { type AllocationKind, type MatchOutcome, type QuoteStatus, QUOTE_STATUSES } from '@sdelka/intake';
import { type CurrencyCode, type Money, money } from '@sdelka/money';
import { FIXTURE_NOW } from './engine';
import { type DealSnapshot, getDeal } from './store';
import { FIXTURE_DATA } from './scenarios';
import type { LabelledGuardId } from '@/ui/guards';
import type { WithdrawSource } from '@/view/withdraw-form';

/**
 * Данные экранов, которых нет в автоматах домена: пополнение, вывод, документы,
 * уведомления, профиль, архив и три экрана консоли.
 *
 * Правило то же, что в `store.ts`: **идентификаторы состояний берутся из кода**,
 * а не из макета. Там, где макет назвал состояния иначе, здесь стоят имена
 * пакетов, и расхождение описано в комментарии — молча подгонять код под
 * картинку нельзя, это и есть тот случай, когда прав код.
 */

export { WITHDRAWAL_STATUSES, UNFREEZE_TARGETS, QUOTE_STATUSES };
export type { WithdrawalStatus, UnfreezeTarget, QuoteStatus, BeneficiaryStatus };

/* ------------------------------------------------------------ пополнение */

/**
 * Котировка. В `packages/intake/src/quote.ts` статусов три:
 * `firm` · `voided_by_market_move` · `expired`. В макете их шесть
 * (`fresh · expiring · expired · requoting · unavailable · same`) — расхождение
 * разрешено в пользу кода:
 *
 * · `expiring` — не статус, а близость `expiresAt`: считается из времени и
 *   показывается таймером поверх `firm`;
 * · `requoting` — переход, а не положение: пока идёт пересчёт, действует прежний
 *   статус, а кнопка стоит в состоянии «в работе»;
 * · `same` — отсутствие котировки вовсе: валюта перевода совпала с валютой
 *   сделки, и конвертационный слой исчезает целиком (`IMPLEMENTATION.md` §3);
 * · `unavailable` — не котировка, а недоступность поставщика курса; в коде это
 *   ошибка получения, не статус. Решение владельца — принимать ли деньги без
 *   курса — помечено `[открыто]`, и до ответа экран блокирует пополнение.
 */
export type QuoteSituation = QuoteStatus | 'none' | 'unavailable';

export const QUOTE_SITUATIONS: readonly QuoteSituation[] = Object.freeze([
  'firm',
  'voided_by_market_move',
  'expired',
  'unavailable',
  'none',
]);

/**
 * Зачисление. В макете семь состояний (`none · seen · credited · short ·
 * excess · thirdParty · noRef`), в коде это **две независимые величины**:
 * `MatchOutcome` (`auto_matched · ambiguous · unmatched`) из `matching.ts` и
 * `AllocationKind` (`exact · overpayment · insufficient · shortfall_absorbed ·
 * wrong_currency`) из `allocation.ts`, плюс маршрут `to_suspense` из `route.ts`.
 * Экран показывает пару, а не выдуманный третий перечень.
 */
export interface IntakeSituation {
  readonly id: string;
  readonly match: MatchOutcome | null;
  readonly allocation: AllocationKind | null;
  /** Деньги ушли в `suspense`: к сделке не отнесены и балансом не считаются. */
  readonly suspense: boolean;
}

const AWAITING: IntakeSituation = Object.freeze({
  id: 'awaiting',
  match: null,
  allocation: null,
  suspense: false,
});

export const INTAKE_SITUATIONS: readonly IntakeSituation[] = Object.freeze([
  AWAITING,
  Object.freeze({ id: 'exact', match: 'auto_matched', allocation: 'exact', suspense: false }),
  Object.freeze({ id: 'insufficient', match: 'auto_matched', allocation: 'insufficient', suspense: false }),
  Object.freeze({ id: 'shortfall_absorbed', match: 'auto_matched', allocation: 'shortfall_absorbed', suspense: false }),
  Object.freeze({ id: 'overpayment', match: 'auto_matched', allocation: 'overpayment', suspense: false }),
  Object.freeze({ id: 'wrong_currency', match: 'auto_matched', allocation: 'wrong_currency', suspense: false }),
  Object.freeze({ id: 'ambiguous', match: 'ambiguous', allocation: null, suspense: true }),
  Object.freeze({ id: 'unmatched', match: 'unmatched', allocation: null, suspense: true }),
]);

export interface PayinRequisites {
  readonly beneficiary: string;
  readonly iban: string;
  readonly swift: string;
  readonly reference: string;
}

export interface TopupView {
  readonly deal: DealSnapshot;
  readonly quote: QuoteSituation;
  readonly quoteExpiresAt: number | null;
  readonly intake: IntakeSituation;
  readonly requisites: PayinRequisites;
  /** Способы пополнения: доступен, проверяется, не подходит по сумме. */
  readonly methods: readonly { readonly id: string; readonly status: 'available' | 'checking' | 'unsuitable' }[];
}

const METHODS: TopupView['methods'] = Object.freeze([
  Object.freeze({ id: 'bank', status: 'available' as const }),
  Object.freeze({ id: 'paybybank', status: 'checking' as const }),
  Object.freeze({ id: 'card', status: 'unsuitable' as const }),
]);

function quoteOf(value: string | undefined, deal: DealSnapshot): QuoteSituation {
  if (deal.conversion === null) return 'none';
  const found = QUOTE_SITUATIONS.find((item) => item === value);
  return found ?? 'firm';
}

function intakeOf(value: string | undefined): IntakeSituation {
  return INTAKE_SITUATIONS.find((item) => item.id === value) ?? AWAITING;
}

export async function getTopup(
  dealId: string,
  quote: string | undefined,
  intake: string | undefined,
): Promise<TopupView | null> {
  const deal = await getDeal(dealId);
  if (deal === null) return null;
  return {
    deal,
    quote: quoteOf(quote, deal),
    quoteExpiresAt: FIXTURE_NOW + 27 * 60 * 1000,
    intake: intakeOf(intake),
    requisites: {
      beneficiary: FIXTURE_DATA.bank.payinBeneficiary,
      iban: FIXTURE_DATA.bank.payinIban,
      swift: FIXTURE_DATA.bank.payinSwift,
      reference: FIXTURE_DATA.bank.payinReference,
    },
    methods: METHODS,
  };
}

/* ----------------------------------------------------------------- вывод */

export interface WithdrawView {
  readonly status: WithdrawalStatus;
  readonly amount: Money<CurrencyCode>;
  readonly fee: Money<CurrencyCode>;
  readonly source: WithdrawSource | null;
  /**
   * Отмена доступна только в `requested`: перехода `approved → cancelled` в
   * `client-account.ts` нет, поэтому кнопки быть не должно
   * (`IMPLEMENTATION.md` §2.2).
   */
  readonly cancellable: boolean;
  /** Повторная заявка запрещена: `g_no_active_withdrawal`. */
  readonly repeatBlocked: boolean;
  /**
   * Сколько утверждений набрано из
   * `WITHDRAWAL_REQUIRED_APPROVALS`. Ноль — законное значение и **единственное**
   * начальное: заявка создаётся без единой подписи, и экран это показывает
   * числом, а не умолчанием.
   */
  readonly approvals: number;
  readonly approvalsRequired: number;
}

/**
 * Заявка на экране: `null` — активной заявки нет, и на экране стоит форма.
 *
 * Прежде отсутствие параметра значило `requested`, то есть у экрана не было
 * состояния «заявки нет» вовсе — а именно оно и есть первое, что видит клиент.
 */
export function withdrawStatusOf(value: string | undefined): WithdrawalStatus | null {
  return WITHDRAWAL_STATUSES.find((item) => item === value) ?? null;
}

/**
 * Счёт-источник для приёмки: три положения, которые невозможно получить
 * фикстурой данных, но которые обязаны быть на снимках.
 *
 * `known` — счёт есть и он на имя плательщика; `unknown` — счёта нет вовсе
 * (заявка не создаётся, работа уходит человеку, И12.2); `otherHolder` — счёт
 * известен, но владелец не плательщик. Третье — не оттенок второго: инвариант
 * 20 требует совпадения **имени**, и совпадения счёта для него недостаточно.
 */
export type WithdrawSourceCase = 'known' | 'unknown' | 'otherHolder';

export function withdrawSourceCaseOf(value: string | undefined): WithdrawSourceCase {
  return value === 'unknown' || value === 'otherHolder' ? value : 'known';
}

export function withdrawSource(situation: WithdrawSourceCase): WithdrawSource | null {
  if (situation === 'unknown') return null;
  return {
    // Ключ реквизитов непрозрачный: номера счёта в домене нет и здесь тоже.
    accountRef: 'source-weiss-commerzbank',
    holderIsPayer: situation !== 'otherHolder',
    masked: FIXTURE_DATA.viewer.sourceAccountMasked,
    bank: FIXTURE_DATA.viewer.sourceBank,
  };
}

/**
 * Комиссия за перевод. Фиксированная величина фикстуры: тариф вывода документом
 * не назван — **[открыто]**. Здесь она живёт одним значением, чтобы форма и
 * созданная заявка не показывали разные числа.
 *
 * Из суммы вывода комиссия **не вычитается** ни здесь, ни на экране: удерживается
 * она из перевода или берётся сверх него — тоже [открыто], и «к зачислению»
 * посчитано быть не может, пока это не названо.
 */
export function withdrawFee(amount: Money<CurrencyCode>): Money<CurrencyCode> {
  return money(amount.currency, 1_500n);
}

/**
 * Можно ли отменить заявку в этом состоянии — **спрашивается у машины**, а не
 * пишется здесь заново.
 *
 * ⚠ И тут же — расхождение, которое надо назвать, а не сгладить.
 * `WITHDRAWAL_TRANSITIONS` разрешает `withdrawal_cancelled` из трёх состояний:
 * `requested`, `approved` и `blocked`. Принятый текст утверждает обратное:
 * `withdraw.state.approved.body` — «отменить заявку после отправки уже нельзя»,
 * `withdraw.cancel.blocked` — «перехода из утверждённой в отменённую в системе
 * нет». Второе — прямое утверждение о машине, и машина его не подтверждает.
 *
 * Чьё слово здесь главное — вопрос продуктовый, а не оформительский: может ли
 * клиент отозвать уже утверждённое поручение. Поэтому **[открыто]**, и до ответа
 * экран держится строгого варианта — как принятый текст, — но расхождение
 * записано здесь, а не растворено в условии `status === 'requested'`.
 *
 * `blocked` при этом отменять можно: машина разрешает, и ни одна принятая
 * строка обратного не говорит. Прежде экран запрещал и это, объясняя запрет
 * утверждением, которого у приостановленной заявки нет.
 */
const CANCEL_DENIED_BY_COPY: readonly WithdrawalStatus[] = Object.freeze(['approved']);

export function withdrawCancellable(status: WithdrawalStatus): boolean {
  if (CANCEL_DENIED_BY_COPY.includes(status)) return false;
  return WITHDRAWAL_TRANSITIONS.some(
    (item) => item.from === status && item.event === 'withdrawal_cancelled',
  );
}

/**
 * Почему отменить нельзя. У двух состояний причины разные, и общая строка одному
 * из них врёт: в `paying_out` заявка не «ещё не утверждена», а уже ушла в банк.
 */
export function withdrawCancelBlockedKey(status: WithdrawalStatus): string {
  return status === 'paying_out' ? 'withdraw.cancel.blocked.sent' : 'withdraw.cancel.blocked';
}

export async function getWithdraw(
  status: WithdrawalStatus,
  amount: Money<CurrencyCode>,
  options: {
    readonly source?: WithdrawSourceCase | undefined;
    readonly approvals?: number | undefined;
  } = {},
): Promise<WithdrawView> {
  // Число подписей приходит из адреса и потому обязано быть приведено к
  // осмысленному: `NaN` и «три из двух» — не состояния заявки, а мусор в
  // параметре, и на экране он превратился бы в ступени неизвестно чего.
  const asked = options.approvals;
  const clamped =
    asked === undefined || !Number.isFinite(asked)
      ? undefined
      : Math.min(Math.max(Math.trunc(asked), 0), WITHDRAWAL_REQUIRED_APPROVALS);
  const approvals =
    clamped ??
    // Утверждённая заявка не существует без двух подписей: их набрали, иначе
    // перехода `requested → approved` не случилось бы (`APPROVAL_GUARDS`).
    (status === 'requested' || status === 'blocked' || status === 'cancelled'
      ? 0
      : WITHDRAWAL_REQUIRED_APPROVALS);
  return {
    status,
    amount,
    fee: withdrawFee(amount),
    source: withdrawSource(withdrawSourceCaseOf(options.source)),
    cancellable: withdrawCancellable(status),
    // Активная заявка — любая нетерминальная, включая `requested` и `blocked`:
    // `g_no_active_withdrawal` считает заявки в активных статусах, а не только
    // те, по которым уже ушло поручение. Прежде здесь стояли два статуса из
    // четырёх, то есть вторую заявку поверх первой экран разрешал бы завести.
    repeatBlocked: !isTerminalWithdrawalStatus(status),
    approvals,
    approvalsRequired: WITHDRAWAL_REQUIRED_APPROVALS,
  };
}

/* ------------------------------------------------------------ документы */

export interface DocumentView {
  readonly id: string;
  readonly kind: 'reservation' | 'settlement' | 'contract' | 'extract';
  readonly no: string | null;
  readonly at: number | null;
  readonly available: boolean;
  readonly dealRef: string;
}

export async function getDocuments(): Promise<readonly DocumentView[]> {
  const reserved = await getDeal('m09');
  const ref = reserved?.ref ?? '';
  return [
    {
      id: 'reservation',
      kind: 'reservation',
      no: reserved?.confirmationNo ?? null,
      at: reserved?.reservedAt ?? null,
      available: true,
      dealRef: ref,
    },
    { id: 'contract', kind: 'contract', no: null, at: FIXTURE_NOW - 96 * 3600_000, available: true, dealRef: ref },
    {
      id: 'extract',
      kind: 'extract',
      no: null,
      at: reserved?.property.extractAt ?? null,
      available: true,
      dealRef: ref,
    },
    { id: 'settlement', kind: 'settlement', no: null, at: null, available: false, dealRef: ref },
  ];
}

/* ---------------------------------------------------------- уведомления */

export interface NotificationView {
  readonly id: string;
  readonly tone: 'info' | 'warn' | 'ok';
  readonly at: number;
  readonly dealId: string;
  readonly dealRef: string;
  readonly unread: boolean;
}

export async function getNotifications(): Promise<readonly NotificationView[]> {
  const reserved = await getDeal('m09');
  const requisites = await getDeal('r03');
  const credited = await getDeal('m06');
  const items: NotificationView[] = [];
  if (reserved !== null) {
    items.push({
      id: 'reserved',
      tone: 'info',
      at: reserved.reservedAt ?? FIXTURE_NOW - 18 * 3600_000,
      dealId: reserved.id,
      dealRef: reserved.ref,
      unread: true,
    });
  }
  if (requisites !== null) {
    items.push({
      id: 'requisites',
      tone: 'warn',
      at: FIXTURE_NOW - 30 * 3600_000,
      dealId: requisites.id,
      dealRef: requisites.ref,
      unread: false,
    });
  }
  if (credited !== null) {
    items.push({
      id: 'credited',
      tone: 'ok',
      at: FIXTURE_NOW - 52 * 3600_000,
      dealId: credited.id,
      dealRef: credited.ref,
      unread: false,
    });
  }
  return items;
}

export function unreadCount(items: readonly NotificationView[]): number {
  return items.filter((item) => item.unread).length;
}

/* --------------------------------------------------------------- профиль */

export interface SessionView {
  readonly id: string;
  readonly device: string;
  readonly place: string;
  readonly at: number;
  readonly current: boolean;
}

export interface ProfileView {
  readonly name: string;
  readonly email: string;
  readonly documentCountry: string;
  readonly documentMasked: string;
  readonly sourceAcceptedAt: number;
  readonly reviewAt: number;
  readonly sessions: readonly SessionView[];
}

export async function getProfile(): Promise<ProfileView> {
  return {
    name: FIXTURE_DATA.viewer.displayName,
    email: FIXTURE_DATA.viewer.email,
    documentCountry: FIXTURE_DATA.viewer.documentCountry,
    documentMasked: FIXTURE_DATA.viewer.documentMasked,
    sourceAcceptedAt: FIXTURE_NOW - 21 * 24 * 3600_000,
    reviewAt: FIXTURE_NOW + 300 * 24 * 3600_000,
    sessions: [
      { id: 'current', device: 'MacBook', place: 'Berlin', at: FIXTURE_NOW - 3600_000, current: true },
      { id: 'phone', device: 'iPhone', place: 'Tbilisi', at: FIXTURE_NOW - 40 * 3600_000, current: false },
    ],
  };
}

/* ----------------------------------------------------------------- архив */

export interface ArchiveItem {
  readonly id: string;
  readonly address: string;
  readonly ref: string;
  readonly at: number;
  readonly outcome: 'settled' | 'notSettled';
  readonly amount: Money<CurrencyCode> | null;
}

export async function getArchive(): Promise<readonly ArchiveItem[]> {
  const settled = await getDeal('m12');
  const refunded = await getDeal('m17');
  const items: ArchiveItem[] = [];
  if (settled !== null) {
    items.push({
      id: settled.id,
      address: settled.property.addressLatin,
      ref: settled.ref,
      at: settled.marks.at(-1)?.at ?? FIXTURE_NOW,
      outcome: 'settled',
      amount: settled.payeeReceives,
    });
  }
  if (refunded !== null) {
    items.push({
      id: refunded.id,
      address: refunded.property.addressLatin,
      ref: refunded.ref,
      at: refunded.marks.at(-1)?.at ?? FIXTURE_NOW,
      outcome: 'notSettled',
      amount: null,
    });
  }
  return items;
}

/* ------------------------------------------------- консоль: O-05, O-06, O-02 */

export interface FieldMatch {
  readonly id: string;
  readonly contract: string;
  readonly registry: string;
  readonly matched: boolean;
}

export interface DecisionView {
  readonly deal: DealSnapshot;
  readonly fields: readonly FieldMatch[];
  readonly evidence: readonly { readonly id: string; readonly present: boolean; readonly note: string | null }[];
  readonly approvalsRequired: number;
  readonly approvalsCollected: number;
  readonly preparedBySelf: boolean;
  /**
   * Имена guard'ов из `packages/domain/src/guards.ts`, буква в букву.
   *
   * Тип — объединение домена, а не `string`: экран подписывает каждое имя из
   * словаря, и имя, которого словарь не знает, обязано ловиться сборкой, а не
   * печататься оператору меткой `[ops.guard.…]`.
   */
  readonly failedGuards: readonly LabelledGuardId[];
  readonly passedGuards: readonly LabelledGuardId[];
}

export async function getDecision(): Promise<DecisionView | null> {
  const deal = await getDeal('m11');
  if (deal === null) return null;
  const fields: FieldMatch[] = [
    { id: 'cadastral', contract: deal.property.cadastral, registry: deal.property.cadastral, matched: true },
    { id: 'owner', contract: deal.property.ownerContract, registry: deal.property.ownerRegistry, matched: true },
    { id: 'basis', contract: 'sale', registry: 'sale', matched: true },
    { id: 'registeredAt', contract: '2026-09-02', registry: '2026-09-02', matched: true },
    { id: 'encumbrance', contract: 'none', registry: 'mortgage', matched: false },
  ];
  return {
    deal,
    fields,
    evidence: [
      { id: 'extract', present: true, note: 'L3' },
      { id: 'contract', present: true, note: null },
      { id: 'conditionAct', present: true, note: null },
      { id: 'beneficiaryLock', present: true, note: null },
    ],
    approvalsRequired: 2,
    approvalsCollected: 1,
    preparedBySelf: true,
    failedGuards: ['g_fields_match', 'g_approvals_sufficient'],
    passedGuards: ['g_coverage_ok', 'g_evidence_present'],
  };
}

export interface BreakItem {
  readonly id: string;
  readonly kind: 'noPair' | 'withinTolerance';
  readonly ref: string;
  readonly status: string;
  readonly ageHours: number;
  readonly amount: Money<CurrencyCode>;
  readonly difference: Money<CurrencyCode> | null;
}

export interface ReconciliationView {
  readonly breaks: readonly BreakItem[];
  readonly obligations: Money<CurrencyCode>;
  readonly heldOnAccounts: Money<CurrencyCode>;
  readonly postings: readonly { readonly id: string; readonly amount: Money<CurrencyCode> }[];
  readonly total: Money<CurrencyCode>;
  readonly oldestBreakHours: number;
  readonly targetHours: number;
}

export async function getReconciliation(): Promise<ReconciliationView> {
  const unknown = await getDeal('m13');
  const settled = await getDeal('m12');
  const amount = unknown?.required ?? money('GEL', 0n);
  return {
    breaks: [
      {
        id: 'noPair',
        kind: 'noPair',
        ref: unknown?.ref ?? '',
        status: unknown?.trancheStatus ?? 'paying_out',
        ageHours: 6,
        amount,
        difference: null,
      },
      {
        id: 'tolerance',
        kind: 'withinTolerance',
        ref: settled?.ref ?? '',
        status: settled?.trancheStatus ?? 'paid_out',
        ageHours: 1,
        amount: settled?.required ?? money('GEL', 0n),
        difference: money('GEL', 42n),
      },
    ],
    obligations: money('GEL', 184_200_000n),
    heldOnAccounts: money('GEL', 184_200_000n),
    postings: [
      { id: 'debit', amount: amount },
      { id: 'credit', amount: money(amount.currency, -amount.minor) },
    ],
    total: money(amount.currency, 0n),
    oldestBreakHours: 6,
    targetHours: 4,
  };
}

export interface UnfreezeView {
  readonly deal: DealSnapshot | null;
  readonly targets: readonly UnfreezeTarget[];
  readonly chosen: UnfreezeTarget;
  readonly approvalsRequired: number;
  readonly approvalsCollected: number;
  readonly caseId: string;
}

export function unfreezeTargetOf(value: string | undefined): UnfreezeTarget {
  return UNFREEZE_TARGETS.find((item) => item === value) ?? 'suspended_from';
}

export async function getUnfreeze(chosen: UnfreezeTarget): Promise<UnfreezeView> {
  return {
    deal: await getDeal('m18'),
    targets: UNFREEZE_TARGETS,
    chosen,
    approvalsRequired: 2,
    approvalsCollected: 1,
    caseId: 'SD-CASE-88-1042',
  };
}

/* ------------------------------------------- реквизиты: статус из домена */

/**
 * Проекция экранных состояний периметра `P-*` на статус из
 * `packages/domain/src/beneficiary.ts`.
 *
 * ⚠ Расхождение с макетом, разрешённое в пользу кода. Макет
 * (`IMPLEMENTATION.md` §2.3) называет шесть статусов:
 * `draft · awaiting_verification · verified · cooling · locked · rejected`.
 * В домене их четыре — `draft · name_consistent · verified · blocked`, — а
 * «охлаждение» и «заперто» это **не статусы, а два отдельных факта** той же
 * структуры `BeneficiaryLock`: `lastChangedAt` и `locked`. Разница
 * принципиальная: заперты могут быть и проверенные реквизиты, а охлаждение
 * идёт поверх любого статуса. Свести их в один перечень значит потерять
 * возможность проверить каждое условие поимённо (`STATE-MACHINES.md` §1.3).
 */
export interface BeneficiaryFacts {
  readonly status: BeneficiaryStatus;
  readonly locked: boolean;
  readonly cooling: boolean;
  /** Изменение запрещено вовсе: до расчёта меньше 72 часов. */
  readonly frozenWindow: boolean;
}

export function beneficiaryFacts(perimeter: string): BeneficiaryFacts {
  switch (perimeter) {
    case 'P-01':
      return { status: 'draft', locked: false, cooling: false, frozenWindow: false };
    case 'P-03':
      return { status: 'blocked', locked: false, cooling: false, frozenWindow: false };
    case 'P-04':
      return { status: 'name_consistent', locked: false, cooling: false, frozenWindow: false };
    case 'P-07':
      return { status: 'verified', locked: true, cooling: false, frozenWindow: false };
    case 'P-09':
      return { status: 'verified', locked: false, cooling: true, frozenWindow: false };
    case 'P-10':
      return { status: 'verified', locked: true, cooling: false, frozenWindow: true };
    default:
      return { status: 'verified', locked: false, cooling: false, frozenWindow: false };
  }
}
