import type { Instant } from '@sdelka/domain';
import { type CurrencyCode, type Money } from '@sdelka/money';
import { IntakeError, IntakeErrorCode } from './errors';
import { type IntakeReasonKey, INTAKE_REASON_KEYS } from './keys';

/**
 * Трекинг платежа — `ROADMAP.md` И2.4, `CORE.md` Ф4, Ф12.
 *
 * Ответ на «где мои деньги»: по расчёту операций это половина обращений в
 * поддержку, три-шесть на сделку, половина эскалируется оператору.
 *
 * Главное ограничение истории — не техническое: **участок «банк отправителя →
 * номинальный счёт» нам не виден**, и экран обязан честно показывать границу
 * нашей ответственности, «а не имитировать знание». Значит структура обязана
 * различать наблюдаемое и заявленное, и различать **типом**, а не полем
 * `isConfirmed`: флаг переворачивается присваиванием, тип — нет.
 */

export const TRANSFER_LEGS = [
  /** Ушёл из банка отправителя. Нам не виден: только со слов стороны. */
  'left_sender_bank',
  /** В пути через корреспондентов. Нам не виден вовсе. */
  'in_flight',
  /** Зачислен на номинальный счёт, опознаём. Наш факт. */
  'credited_unidentified',
  /** Зачислен на сделку. Наш факт. */
  'credited_to_deal',
] as const;
export type TransferLeg = (typeof TRANSFER_LEGS)[number];

/**
 * Чем участок подтверждён. Размеченное объединение: превратить заявление стороны
 * в наблюдение можно только сменив вид, то есть видимой правкой, а не
 * присваиванием булева поля.
 */
export type LegEvidence =
  | {
      readonly kind: 'observed_by_us';
      readonly observedAt: Instant;
      /** Источник наблюдения: строка выписки, вебхук банка. Технический ключ. */
      readonly sourceRef: string;
    }
  | {
      readonly kind: 'declared_by_party';
      readonly declaredAt: Instant;
      /** Ссылка на приложенное стороной подтверждение перевода. */
      readonly documentRef: string | null;
    }
  | { readonly kind: 'not_observable' };

/**
 * Наблюдаемость участка — свойство участка, а не наблюдения.
 *
 * Таблица тотальная. `in_flight` не наблюдаем никогда: показывать по нему
 * что-либо кроме «мы этого не видим» означало бы имитировать знание.
 */
export const LEG_IS_OBSERVABLE: Readonly<Record<TransferLeg, boolean>> = Object.freeze({
  left_sender_bank: false,
  in_flight: false,
  credited_unidentified: true,
  credited_to_deal: true,
});

export interface LegState {
  readonly leg: TransferLeg;
  readonly evidence: LegEvidence;
  /** Ожидаемый срок прохождения участка. `null` — срока не обещаем. */
  readonly expectedBy: Instant | null;
}

export interface TransferTracking {
  readonly legs: readonly LegState[];
}

export interface TrackingView {
  /** Самый дальний участок, по которому есть хоть какое-то подтверждение. */
  readonly currentLeg: TransferLeg | null;
  /** Подтверждён ли текущий участок **нашим** наблюдением, а не словами стороны. */
  readonly currentIsOurs: boolean;
  /** Просрочен ли ожидаемый срок текущего участка. */
  readonly overdue: boolean;
  readonly reasons: readonly IntakeReasonKey[];
}

function evidenceKey(evidence: LegEvidence): IntakeReasonKey {
  switch (evidence.kind) {
    case 'observed_by_us':
      return INTAKE_REASON_KEYS.trackingLegObserved;
    case 'declared_by_party':
      return INTAKE_REASON_KEYS.trackingLegDeclared;
    case 'not_observable':
      return INTAKE_REASON_KEYS.trackingLegNotObservable;
  }
}

/**
 * Что показать стороне.
 *
 * Порядок участков задан перечнем, а не сортировкой по времени: время у
 * заявленного участка — это время заявления, и сортировка по нему поставила бы
 * «сторона сказала, что отправила вчера» после «мы зачислили сегодня».
 *
 * `currentIsOurs` — то самое различение, ради которого написан этот файл:
 * сторона обязана видеть, на чьём слове стоит показанное состояние.
 */
export function trackingView(tracking: TransferTracking, now: Instant): TrackingView {
  let current: LegState | null = null;
  for (const leg of TRANSFER_LEGS) {
    const state = tracking.legs.find((item) => item.leg === leg);
    if (state === undefined) continue;
    if (state.evidence.kind === 'not_observable') continue;
    current = state;
  }
  if (current === null) {
    return Object.freeze({
      currentLeg: null,
      currentIsOurs: false,
      overdue: false,
      reasons: Object.freeze([INTAKE_REASON_KEYS.trackingLegNotObservable]),
    });
  }
  const overdue = current.expectedBy !== null && now > current.expectedBy;
  const reasons: IntakeReasonKey[] = [evidenceKey(current.evidence)];
  if (overdue) reasons.push(INTAKE_REASON_KEYS.trackingOverdue);
  return Object.freeze({
    currentLeg: current.leg,
    currentIsOurs: current.evidence.kind === 'observed_by_us',
    overdue,
    reasons: Object.freeze(reasons),
  });
}

/**
 * Медиана фактических потерь на корреспондентах — И2.4: «сегодня этой цифры не
 * знает никто, а она будущий аргумент продажи».
 *
 * Целочисленная: при чётном числе наблюдений берётся **меньшее** из двух
 * средних, а не полусумма. Полусумма двух нечётных минорных единиц дала бы
 * дробную величину — то есть плавающую точку в денежном домене (красная линия
 * №4) либо молчаливое округление, которое здесь ничем не обосновано.
 *
 * ⚠️ **[открыто]** У какой сущности эта метрика хранится, И2.4 не говорит.
 * Расчёт здесь, место хранения — вопрос владельцу (`INTAKE.md` §11 п.7).
 */
export function medianShortfall(
  observations: readonly Money<CurrencyCode>[],
): Money<CurrencyCode> | null {
  if (observations.length === 0) return null;
  const first = observations[0];
  if (first === undefined) return null;
  for (const observation of observations) {
    if (observation.currency !== first.currency) {
      throw new IntakeError(IntakeErrorCode.currencyMismatch, {
        left: observation.currency,
        right: first.currency,
      });
    }
  }
  const sorted = [...observations].sort((left, right) =>
    left.minor < right.minor ? -1 : left.minor > right.minor ? 1 : 0,
  );
  const index = sorted.length % 2 === 1 ? (sorted.length - 1) / 2 : sorted.length / 2 - 1;
  return sorted[index] ?? null;
}
