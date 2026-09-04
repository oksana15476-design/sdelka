import type { DurationMs, Instant } from '@sdelka/domain';
import {
  type ConvertedAmount,
  type CurrencyCode,
  type FxRates,
  type IsoDate,
  type Money,
  type Rational,
  type Rounding,
  compareRational,
  convert,
  subtractRational,
} from '@sdelka/money';
import { IntakeError, IntakeErrorCode } from './errors';
import { type IntakeReasonKey, INTAKE_REASON_KEYS } from './keys';
import type { IntakePolicy } from './policy';

/**
 * Котировка — `FUNCTIONAL.md` §4.5, `CORE.md` Ф5, `ROADMAP.md` И2.3.
 *
 * **Почему котировка живёт здесь, а не в `@sdelka/money`.** Срок действия
 * котировки требует `Instant`, а `Instant` живёт в `@sdelka/domain`, и `money` от
 * `domain` не зависит — зависимость идёт в обратную сторону. Вариантов было три:
 * выразить срок сырым числом в `money` (тип потерян, «миллисекунды против
 * секунд» становится возможной ошибкой), протащить `domain` в `money` (разворот
 * направления зависимости ради одного типа) или поселить котировку там, где оба
 * типа законно доступны. Выбран третий; молча протаскивать зависимость нельзя.
 *
 * Что остаётся в `money`: арифметика курса, три курса (`FxRates`), спред и
 * учётная курсовая разница **разными типами**. Здесь они не смешиваются и не
 * переопределяются.
 */

export interface Quote<F extends CurrencyCode = CurrencyCode, T extends CurrencyCode = CurrencyCode> {
  readonly quoteId: string;
  readonly source: Money<F>;
  readonly targetCurrency: T;
  /** Три курса вместе: клиентский, эталонный, официальный на дату операции. */
  readonly rates: FxRates;
  readonly asOf: IsoDate;
  readonly issuedAt: Instant;
  readonly validity: DurationMs;
  /** Порог движения рынка, при котором котировка гасится внутри срока. */
  readonly driftThresholdBp: number;
}

export function quote<F extends CurrencyCode, T extends CurrencyCode>(
  input: Omit<Quote<F, T>, 'validity' | 'driftThresholdBp'>,
  policy: IntakePolicy,
): Quote<F, T> {
  if ((input.source.currency as CurrencyCode) === (input.targetCurrency as CurrencyCode)) {
    throw new IntakeError(IntakeErrorCode.quoteSameCurrency, { currency: input.targetCurrency });
  }
  if (policy.quote.validity <= 0) {
    throw new IntakeError(IntakeErrorCode.quoteTtlInvalid, { value: String(policy.quote.validity) });
  }
  return Object.freeze({
    ...input,
    validity: policy.quote.validity,
    driftThresholdBp: policy.quote.driftThreshold.valueBp,
  });
}

export const QUOTE_STATUSES = ['firm', 'voided_by_market_move', 'expired'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export interface QuoteStatusReport {
  readonly status: QuoteStatus;
  /** Отклонение рынка от эталонного курса котировки, в базисных пунктах. */
  readonly driftBp: number;
  readonly expiresAt: Instant;
  readonly reasons: readonly IntakeReasonKey[];
}

/**
 * Отклонение рынка от эталонного курса котировки в базисных пунктах.
 *
 * Целочисленно, над рациональными курсами: `|market − reference| × 10000 /
 * reference`. Ни одной операции с плавающей точкой — курс 2,6686875 в double уже
 * не равен себе после трёх операций, а из него считается сумма, которую увидит
 * клиент (красная линия №4).
 */
export function marketDriftBp(reference: Rational, market: Rational): number {
  if (reference.numerator === 0n) {
    throw new IntakeError(IntakeErrorCode.basisPointsOutOfRange, { value: '0' });
  }
  const difference = subtractRational(market, reference);
  const absoluteNumerator =
    difference.numerator < 0n ? -difference.numerator : difference.numerator;
  const referenceNumerator =
    reference.numerator < 0n ? -reference.numerator : reference.numerator;
  // |Δ| / reference = (|Δn| · rd) / (Δd · |rn|); умножение на 10000 до деления.
  const numerator = absoluteNumerator * reference.denominator * 10_000n;
  const denominator = difference.denominator * referenceNumerator;
  return Number(numerator / denominator);
}

/**
 * Статус котировки — чистая функция от рынка и времени.
 *
 * **Аннулирование проверяется раньше истечения**, и это не стилистика. Оба
 * условия могут быть верны одновременно, а причина, которую увидит клиент,
 * обязана быть однозначной: рынок ушёл — это существо дела, срок истёк — это
 * часы. Из двух причин показывается первая.
 *
 * Гашение **внутри срока** — практика провайдеров, зафиксированная в
 * `FUNCTIONAL.md` §4.5 и `CORE.md` Ф5: без порога один разрыв по паре съедает
 * месяц маржи.
 */
export function quoteStatus(
  value: Quote,
  marketReferenceRate: Rational,
  now: Instant,
): QuoteStatusReport {
  const driftBp = marketDriftBp(value.rates.reference, marketReferenceRate);
  const expiresAt = (value.issuedAt + value.validity) as Instant;

  if (driftBp >= value.driftThresholdBp) {
    return Object.freeze({
      status: 'voided_by_market_move',
      driftBp,
      expiresAt,
      reasons: Object.freeze([INTAKE_REASON_KEYS.quoteVoidedByMarketMove]),
    });
  }
  if (now >= expiresAt) {
    return Object.freeze({
      status: 'expired',
      driftBp,
      expiresAt,
      reasons: Object.freeze([INTAKE_REASON_KEYS.quoteExpired]),
    });
  }
  return Object.freeze({
    status: 'firm',
    driftBp,
    expiresAt,
    reasons: Object.freeze([INTAKE_REASON_KEYS.quoteFirm]),
  });
}

/**
 * Подтверждение клиента на конкретную котировку.
 *
 * Идентификатор котировки — обязательное поле, и сравнивается именно он.
 * Подтверждение «вообще» позволило бы применить согласие, данное на прежний
 * курс, к пересчитанному: ровно тот молчаливый пересчёт, который `FUNCTIONAL.md`
 * §4.5 называет прямым путём к спору и к претензии по потребительскому праву.
 */
export interface ClientConfirmation {
  readonly quoteId: string;
  readonly confirmedAt: Instant;
  readonly partyId: string;
}

export interface ConversionDecision<F extends CurrencyCode, T extends CurrencyCode> {
  readonly allowed: boolean;
  readonly status: QuoteStatus;
  readonly converted: ConvertedAmount<F, T> | null;
  readonly reasons: readonly IntakeReasonKey[];
}

/**
 * Можно ли конвертировать по этой котировке прямо сейчас.
 *
 * Три отказа и один разрешённый путь:
 *  · подтверждения нет — отказ (И2.3: «конвертация без явного подтверждения
 *    клиента невозможна»);
 *  · подтверждение выдано на другую котировку — отказ;
 *  · котировка не `firm` — отказ; клиенту показывается новая, и подтверждать он
 *    будет её.
 *
 * ⚠️ **[гипотеза]** Случай «рынок ушёл за порог, а перевод уже в пути» ни в
 * одном документе не описан: §4.5 знает только истечение срока **до** поступления.
 * Отменять нечего — деньги придут. Здесь реализовано единственное правило, не
 * нарушающее красную линию №7: деньги ложатся на свободную часть
 * неконвертированными и ждут нового подтверждения. Вопрос владельцу
 * (`INTAKE.md` §11 п.5).
 */
export function decideConversion<F extends CurrencyCode, T extends CurrencyCode>(
  value: Quote<F, T>,
  marketReferenceRate: Rational,
  confirmation: ClientConfirmation | null,
  now: Instant,
  rounding: Rounding,
): ConversionDecision<F, T> {
  const report = quoteStatus(value, marketReferenceRate, now);

  if (confirmation === null) {
    return Object.freeze({
      allowed: false,
      status: report.status,
      converted: null,
      reasons: Object.freeze([
        INTAKE_REASON_KEYS.quoteConfirmationMissing,
        ...report.reasons,
      ]),
    });
  }
  if (confirmation.quoteId !== value.quoteId) {
    return Object.freeze({
      allowed: false,
      status: report.status,
      converted: null,
      reasons: Object.freeze([
        INTAKE_REASON_KEYS.quoteConfirmationForOtherQuote,
        ...report.reasons,
      ]),
    });
  }
  if (report.status !== 'firm') {
    return Object.freeze({
      allowed: false,
      status: report.status,
      converted: null,
      reasons: report.reasons,
    });
  }

  return Object.freeze({
    allowed: true,
    status: report.status,
    converted: convert(value.source, value.targetCurrency, value.rates, value.asOf, rounding),
    reasons: Object.freeze([INTAKE_REASON_KEYS.quoteFirm]),
  });
}

/**
 * Наценка для раскрытия стороне: насколько клиентский курс хуже эталонного, в
 * базисных пунктах. И2.3 требует показывать её вместе с тремя курсами.
 *
 * Величина **не является** ни спредом в деньгах, ни учётной курсовой разницей:
 * первое считает `platformSpread`, второе — `accountingFxDifference`, и они в
 * `@sdelka/money` разведены разными типами намеренно. Здесь только доля, и
 * складывать её с деньгами нечем.
 */
export function disclosedMarkupBp(rates: FxRates): number {
  if (rates.reference.numerator === 0n) {
    throw new IntakeError(IntakeErrorCode.basisPointsOutOfRange, { value: '0' });
  }
  const difference = subtractRational(rates.reference, rates.client);
  const sign = compareRational(difference, { numerator: 0n, denominator: 1n });
  const absoluteNumerator =
    difference.numerator < 0n ? -difference.numerator : difference.numerator;
  const referenceNumerator =
    rates.reference.numerator < 0n ? -rates.reference.numerator : rates.reference.numerator;
  const magnitude = Number(
    (absoluteNumerator * rates.reference.denominator * 10_000n) /
      (difference.denominator * referenceNumerator),
  );
  return sign < 0 ? -magnitude : magnitude;
}
