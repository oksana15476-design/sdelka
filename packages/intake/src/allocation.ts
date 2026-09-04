import {
  type CurrencyCode,
  type Money,
  add,
  compare,
  isNegative,
  money,
  subtract,
} from '@sdelka/money';
import { IntakeError, IntakeErrorCode } from './errors';
import { type IntakeReasonKey, INTAKE_REASON_KEYS } from './keys';

/**
 * Разнесение поступления — `FUNCTIONAL.md` §4.3.2.
 *
 * Пакет ничего не записывает: результат — **план**, который исполняют
 * приложение и учёт. Поэтому здесь нет ни журнала, ни счетов, ни времени из
 * системных часов.
 *
 * Форма плана намеренно повторяет два разных события учёта (`FUNCTIONAL.md`
 * §3.1: «Зачисление на счёт клиента и привязка к сделке — разные события, и
 * сумма журнала равна нулю на каждом»): сначала всё поступление зачисляется на
 * свободную часть счёта клиента, затем требуемое запирается под транш. Это
 * единственный порядок, при котором дробный платёж и одиночный считаются одной
 * формулой, а излишек остаётся отзывным в момент зачисления, а не после
 * закрытия сделки (красная линия №7).
 */

/**
 * Отнесение расходов по переводу из платёжного сообщения (`ChrgBr` в `pacs.008`,
 * поле 71A в MT103).
 *
 * ⚠️ **[гипотеза]** `FUNCTIONAL.md` §4.3.2 требует различать срез корреспондента
 * и ошибку клиента «по реквизитам поступления, а не по сумме», но не называет
 * поле. Это единственное поле входящего сообщения, которое отвечает на вопрос
 * «мог ли корреспондент законно срезать». Доступность и достоверность его в
 * нашей выписке зависит от банковского договора — вопрос открыт (`INTAKE.md`
 * §3.5, §11 п.2).
 */
export const CHARGES_BEARERS = [
  /** `OUR`: все расходы на отправителе. Срезу взяться неоткуда. */
  'sender_pays_all',
  /** `SHA`: расходы разделены. Корреспондент вправе срезать. */
  'shared',
  /** `BEN`: расходы на получателе. Корреспондент вправе срезать. */
  'beneficiary_pays',
  /** Поле отсутствует или не распознано. Причина неизвестна. */
  'unknown',
] as const;
export type ChargesBearer = (typeof CHARGES_BEARERS)[number];

/**
 * Может ли допуск покрыть недостачу при таком отнесении расходов.
 *
 * Таблица тотальная: новый вид отнесения не соберётся, пока для него явно не
 * назван ответ. Ослабление правила обязано быть видно в диффе — тот же приём,
 * что `BASE_OUTCOME` в детекторе плательщика.
 *
 * `unknown` ведёт себя как `sender_pays_all`, а не как `shared`: отказ закрытый.
 * Иначе непрочитанное поле превращало бы допуск в «прощаем клиенту до N» —
 * ровно то, что §4.3.2 запрещает.
 */
const TOLERANCE_COVERS_SHORTFALL: Readonly<Record<ChargesBearer, boolean>> = Object.freeze({
  sender_pays_all: false,
  shared: true,
  beneficiary_pays: true,
  unknown: false,
});

export function shortfallCauseKey(bearer: ChargesBearer): IntakeReasonKey {
  switch (bearer) {
    case 'shared':
    case 'beneficiary_pays':
      return INTAKE_REASON_KEYS.shortfallCauseCorrespondent;
    case 'sender_pays_all':
      return INTAKE_REASON_KEYS.shortfallCausePayer;
    case 'unknown':
      return INTAKE_REASON_KEYS.shortfallCauseUnknown;
  }
}

export const ALLOCATION_KINDS = [
  'wrong_currency',
  'exact',
  'overpayment',
  'shortfall_absorbed',
  'insufficient',
] as const;
export type AllocationKind = (typeof ALLOCATION_KINDS)[number];

export interface AllocationInput {
  /** Требуемая сумма транша. */
  readonly required: Money<CurrencyCode>;
  /** Свободная часть счёта клиента в валюте транша **до** этого поступления. */
  readonly freeBefore: Money<CurrencyCode>;
  readonly incoming: Money<CurrencyCode>;
  /** Действующий допуск — только из `effectiveTolerance`, не из политики напрямую. */
  readonly tolerance: Money<CurrencyCode>;
  readonly chargesBearer: ChargesBearer;
}

export interface AllocationPlan {
  readonly kind: AllocationKind;
  /** Всё поступление зачисляется на свободную часть — в своей валюте. */
  readonly toClientFree: Money<CurrencyCode>;
  /** Сколько запирается под транш из свободной части. Ноль — привязки нет. */
  readonly toTranche: Money<CurrencyCode>;
  /**
   * Признаваемая недостача (`FUNCTIONAL.md` §3.1, случай А). Отдельным полем, а
   * не слагаемым в `toTranche`: получатель плана обязан увидеть, что вторая
   * запись — довнесение с операционного счёта — ещё не сделана, и до неё транш
   * не обеспечен. Недостача, спрятанная в сумме транша, — это недостача, о
   * которой никто не знает.
   */
  readonly shortfall: Money<CurrencyCode>;
  /** Сколько ещё не хватает до требуемого. Ненулевое только у `insufficient`. */
  readonly missing: Money<CurrencyCode>;
  /** Свободная часть после исполнения плана. Выводима, но выведена — её проверяют. */
  readonly freeAfter: Money<CurrencyCode>;
  readonly reasons: readonly IntakeReasonKey[];
}

function assertNonNegative(value: Money<CurrencyCode>): void {
  if (isNegative(value)) {
    throw new IntakeError(IntakeErrorCode.amountNegative, { amount: value.minor.toString() });
  }
}

/**
 * Разнесение поступления против требуемой суммы транша.
 *
 * Дробные платежи отдельной ветки не имеют: второй платёж — это тот же расчёт с
 * непустым `freeBefore` (`FUNCTIONAL.md` §4.3.2: «поступления накапливаются на
 * счёте клиента; транш зачисляется, когда накоплено требуемое»). Отдельная ветка
 * была бы вторым ответом на тот же вопрос.
 *
 * Следствие, ради которого это важно: **допуск считается от накопленного против
 * требуемого, а не от каждого платежа.** Иначе три платежа с допуском по
 * половине процента дают полтора процента суммарного послабления, чего никто
 * никогда не объявлял.
 */
export function allocateIncoming(input: AllocationInput): AllocationPlan {
  const { required, freeBefore, incoming, tolerance, chargesBearer } = input;
  assertNonNegative(required);
  assertNonNegative(freeBefore);
  assertNonNegative(incoming);
  assertNonNegative(tolerance);

  const zero = money(required.currency, 0n);

  // Поступление в чужой валюте — не отказ и не ошибка. Деньги пришли, они чужие,
  // и лежать они обязаны на счёте клиента в своей валюте. Отбрасывать их значило
  // бы удерживать чужие деньги без основания; зачислять на транш — сравнивать
  // несравнимое (`INTAKE.md` §4.2).
  if (incoming.currency !== required.currency) {
    return Object.freeze({
      kind: 'wrong_currency',
      toClientFree: incoming,
      toTranche: zero,
      shortfall: zero,
      missing: required,
      freeAfter: freeBefore,
      reasons: Object.freeze([INTAKE_REASON_KEYS.allocationWrongCurrency]),
    });
  }
  // Свободная часть и допуск обязаны быть в валюте требования: сравнивать
  // накопленное с требуемым через курс нельзя — курс это внешний факт, а здесь
  // чистая арифметика. Несовпадение — ошибка вызывающего, а не исход правила.
  if (freeBefore.currency !== required.currency) {
    throw new IntakeError(IntakeErrorCode.currencyMismatch, {
      left: freeBefore.currency,
      right: required.currency,
    });
  }
  if (tolerance.currency !== required.currency) {
    throw new IntakeError(IntakeErrorCode.currencyMismatch, {
      left: tolerance.currency,
      right: required.currency,
    });
  }

  const available = add(freeBefore, incoming);
  const order = compare(available, required);

  if (order === 0) {
    return Object.freeze({
      kind: 'exact',
      toClientFree: incoming,
      toTranche: required,
      shortfall: zero,
      missing: zero,
      freeAfter: zero,
      reasons: Object.freeze([INTAKE_REASON_KEYS.allocationExact]),
    });
  }

  if (order > 0) {
    // Излишек остаётся в свободной части **сразу**, а не после закрытия сделки:
    // деньги, не попавшие под условие расчёта, обязаны остаться отзывными
    // (`FUNCTIONAL.md` §4.3.2 [решение, исправляет предыдущее], красная линия №7).
    // `ROADMAP.md` И2.1 критерий 4 говорит обратное и подлежит правке — см.
    // `INTAKE.md` §9.1.
    return Object.freeze({
      kind: 'overpayment',
      toClientFree: incoming,
      toTranche: required,
      shortfall: zero,
      missing: zero,
      freeAfter: subtract(available, required),
      reasons: Object.freeze([INTAKE_REASON_KEYS.allocationOverpayment]),
    });
  }

  const deficit = subtract(required, available);
  const withinTolerance = compare(deficit, tolerance) <= 0;
  const causeAllows = TOLERANCE_COVERS_SHORTFALL[chargesBearer];

  if (withinTolerance && causeAllows) {
    // Случай А `FUNCTIONAL.md` §3.1: транш зачисляется на полную сумму, разницу
    // закрывает платформа, убыток признаётся **в момент поступления**.
    return Object.freeze({
      kind: 'shortfall_absorbed',
      toClientFree: incoming,
      toTranche: required,
      shortfall: deficit,
      missing: zero,
      freeAfter: zero,
      reasons: Object.freeze([
        INTAKE_REASON_KEYS.allocationShortfallAbsorbed,
        shortfallCauseKey(chargesBearer),
      ]),
    });
  }

  const reasons: IntakeReasonKey[] = [INTAKE_REASON_KEYS.allocationInsufficient];
  if (available.minor > 0n) reasons.push(INTAKE_REASON_KEYS.allocationAccumulating);
  reasons.push(shortfallCauseKey(chargesBearer));
  reasons.push(INTAKE_REASON_KEYS.shortfallAwaitsTopUp);

  return Object.freeze({
    kind: 'insufficient',
    toClientFree: incoming,
    toTranche: zero,
    shortfall: zero,
    missing: deficit,
    freeAfter: available,
    reasons: Object.freeze(reasons),
  });
}

/**
 * Сходимость плана. Не «ассерт на всякий случай», а то же правило, что сумма
 * проводок равна нулю: части обязаны сойтись с тем, что пришло, без потери
 * минорной единицы.
 *
 * Тождество одно на все исходы:
 *
 * ```
 * свободная_после = (свободная_до + поступление) − (на_транш − недостача)
 * ```
 *
 * Из файла клиента в файл транша уходит `на_транш − недостача`; остальное до
 * полной суммы транша доносит платформа, и клиентских денег это не касается.
 * Записав вместо этого «свободная_после = доступно − на_транш», мы бы увели
 * остаток клиента в минус ровно на величину недостачи — то есть заплатили бы
 * недостачу деньгами клиента.
 */
export function allocationBalances(input: AllocationInput, plan: AllocationPlan): boolean {
  if (plan.kind === 'wrong_currency') {
    return (
      plan.toTranche.minor === 0n &&
      plan.shortfall.minor === 0n &&
      plan.freeAfter.minor === input.freeBefore.minor
    );
  }
  const available = add(input.freeBefore, input.incoming);
  const fromClient = subtract(plan.toTranche, plan.shortfall);
  if (isNegative(fromClient)) return false;
  if (subtract(available, fromClient).minor !== plan.freeAfter.minor) return false;
  if (plan.toClientFree.minor !== input.incoming.minor) return false;

  switch (plan.kind) {
    case 'insufficient':
      return plan.toTranche.minor === 0n && plan.shortfall.minor === 0n;
    case 'exact':
    case 'overpayment':
      return plan.toTranche.minor === input.required.minor && plan.shortfall.minor === 0n;
    case 'shortfall_absorbed':
      return (
        plan.toTranche.minor === input.required.minor &&
        add(available, plan.shortfall).minor === input.required.minor
      );
  }
}
