import type { NameMatch } from '@sdelka/compliance';
import { type CurrencyCode, type Money, absolute, compare, subtract } from '@sdelka/money';
import { IntakeError, IntakeErrorCode } from './errors';
import { type IntakeReasonKey, INTAKE_REASON_KEYS } from './keys';
import type { IntakePolicy, MatchingWeights } from './policy';
import type { ReferenceMatch } from './reference';

/**
 * Сопоставление входящих — `CORE.md` Ф4, `ROADMAP.md` И2.2.
 *
 * «Референс теряется на корреспондентах» — значит сопоставление обязано работать
 * и без него, по совокупности признаков. Отсюда три правила, каждое из которых
 * держится не комментарием, а ветвью:
 *
 *  1. **Имя в одиночку кандидата не даёт никогда.** Вклад имени добавляется
 *     только после того, как сработал хотя бы один другой признак. Это то же
 *     утверждение, что `NameMatch.sufficientAlone: false` в `@sdelka/compliance`,
 *     и здесь оно исполнено, а не процитировано.
 *  2. **Два кандидата выше порога — автосопоставления нет ни одного.** Критерий
 *     A3a требует ноль отнесений к чужой сделке; «взять лучшего» из двух — это
 *     проиграть A3a ради A3.
 *  3. **Порог — с письменным обоснованием**, а не число в коде.
 */

export interface CandidateSignals {
  readonly dealId: string;
  readonly trancheId: string;
  readonly reference: ReferenceMatch;
  /** Сумма поступления похожа на непокрытый остаток требования — см. `amountFits`. */
  readonly amountFits: boolean;
  /** Счёт-источник встречался в прошлых платежах этого клиента. */
  readonly sourceAccountSeen: boolean;
  readonly currencyMatches: boolean;
  /**
   * Имя отправителя против стороны-плательщика. **Вторичный сигнал.** `null` —
   * сравнивать нечего (внутреннее движение, имени в сообщении нет).
   */
  readonly senderName: NameMatch | null;
}

export interface ScoredCandidate {
  readonly signals: CandidateSignals;
  readonly scoreBp: number;
  /** Вес без надбавки за имя. Ноль здесь означает ноль итога, каким бы имя ни было. */
  readonly withoutNameBp: number;
  readonly reasons: readonly IntakeReasonKey[];
}

/**
 * Сумма поступления похожа на остаток требования.
 *
 * Сравнивается с **непокрытым остатком** (требуемое минус уже накопленное), а не
 * с требуемым целиком: при дробных платежах второй платёж никогда не равен
 * требуемому, и признак, сверяющийся с требуемым, у дробных не срабатывает
 * вовсе — то есть выключается ровно там, где сопоставление и без того трудное.
 *
 * Допуск входит с обеих сторон: недостача корреспондента делает сумму меньше
 * ожидаемой, и это не повод перестать узнавать платёж.
 */
export function amountFits(
  incoming: Money<CurrencyCode>,
  outstanding: Money<CurrencyCode>,
  tolerance: Money<CurrencyCode>,
): boolean {
  if (incoming.currency !== outstanding.currency) return false;
  if (tolerance.currency !== outstanding.currency) return false;
  return compare(absolute(subtract(incoming, outstanding)), tolerance) <= 0;
}

/**
 * Веса непарных с именем признаков в сумме дают ровно сто процентов, а вес
 * искажённого референса не превышает вес точного.
 *
 * Проверка стоит здесь, а не в тесте политики: политика — данные, и вторая
 * политика (другой рынок, другой банк) обязана падать на том же правиле, а не
 * проходить, потому что для неё теста не написали.
 */
export function assertMatchingWeights(weights: MatchingWeights): void {
  const total =
    weights.referenceExactPercent +
    weights.amountFitsPercent +
    weights.sourceAccountSeenPercent +
    weights.currencyMatchesPercent;
  if (total !== 100) {
    throw new IntakeError(IntakeErrorCode.weightsNotHundred, { total: String(total) });
  }
  if (weights.referenceDamagedPercent > weights.referenceExactPercent) {
    throw new IntakeError(IntakeErrorCode.weightsNotHundred, {
      damaged: String(weights.referenceDamagedPercent),
      exact: String(weights.referenceExactPercent),
    });
  }
  if (weights.senderNameBonusPercent < 0) {
    throw new IntakeError(IntakeErrorCode.basisPointsOutOfRange, {
      value: String(weights.senderNameBonusPercent),
    });
  }
}

function referenceWeightBp(match: ReferenceMatch, weights: MatchingWeights): number {
  switch (match.degree) {
    case 'exact':
      return weights.referenceExactPercent * 100;
    case 'damaged':
      // Вес искажённого референса тем меньше, чем сильнее искажение. Целочисленно.
      return Math.floor((weights.referenceDamagedPercent * 100 * match.similarityBp) / 10_000);
    case 'foreign':
    case 'absent':
      return 0;
  }
}

function nameIsStrong(match: NameMatch | null): boolean {
  if (match === null) return false;
  return (
    match.degree === 'identical_in_source_alphabet' ||
    match.degree === 'identical_after_latinization' ||
    match.degree === 'strong'
  );
}

/**
 * Вес кандидата в базисных пунктах.
 *
 * Порядок вычисления — не стилистика: сначала считаются признаки, не связанные с
 * именем, и **только если их сумма не ноль**, к ней добавляется надбавка за имя.
 * Ноль непарных признаков даёт ноль итога при любом совпадении имени: сходство
 * имени не является достаточным основанием ни для чего, и это правило исполнено
 * ветвью, а не памятью разработчика.
 */
export function scoreCandidate(signals: CandidateSignals, policy: IntakePolicy): ScoredCandidate {
  const weights = policy.matching.weights;
  assertMatchingWeights(weights);

  let withoutNameBp = referenceWeightBp(signals.reference, weights);
  if (signals.amountFits) withoutNameBp += weights.amountFitsPercent * 100;
  if (signals.sourceAccountSeen) withoutNameBp += weights.sourceAccountSeenPercent * 100;
  if (signals.currencyMatches) withoutNameBp += weights.currencyMatchesPercent * 100;

  const reasons: IntakeReasonKey[] = [];
  if (signals.reference.degree === 'exact') reasons.push(INTAKE_REASON_KEYS.referenceExact);
  if (signals.reference.degree === 'damaged') reasons.push(INTAKE_REASON_KEYS.referenceDamaged);
  if (signals.sourceAccountSeen) reasons.push(INTAKE_REASON_KEYS.matchSourceAccountSeen);

  if (withoutNameBp === 0) {
    // Имя даже точное сюда не добавляется. Ветвь, а не оговорка.
    if (signals.senderName !== null) reasons.push(INTAKE_REASON_KEYS.matchNameSecondaryOnly);
    return Object.freeze({
      signals,
      scoreBp: 0,
      withoutNameBp: 0,
      reasons: Object.freeze(reasons),
    });
  }

  let scoreBp = withoutNameBp;
  if (nameIsStrong(signals.senderName)) {
    scoreBp += weights.senderNameBonusPercent * 100;
    reasons.push(INTAKE_REASON_KEYS.matchNameSecondaryOnly);
  }
  return Object.freeze({
    signals,
    scoreBp: Math.min(10_000, scoreBp),
    withoutNameBp,
    reasons: Object.freeze(reasons),
  });
}

export const MATCH_OUTCOMES = ['auto_matched', 'ambiguous', 'unmatched'] as const;
export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

export interface MatchResult {
  readonly outcome: MatchOutcome;
  /** Единственный кандидат выше порога. `null` у остальных исходов. */
  readonly matched: ScoredCandidate | null;
  /** Кандидаты выше порога автосопоставления. */
  readonly aboveThreshold: readonly ScoredCandidate[];
  /** Кандидаты, которых стоит показать оператору: выше порога показа. */
  readonly visible: readonly ScoredCandidate[];
  readonly reasons: readonly IntakeReasonKey[];
}

/**
 * Исход сопоставления одного поступления.
 *
 * `ambiguous` и `unmatched` ведут в одно и то же место — `suspense:unidentified`
 * и очередь оператора, — но это **разные причины**, и оператор обязан видеть
 * какая: в первом случае ему выбирать из двух, во втором искать.
 */
export function matchIncoming(
  candidates: readonly CandidateSignals[],
  policy: IntakePolicy,
): MatchResult {
  const scored = candidates.map((signals) => scoreCandidate(signals, policy));
  const autoThreshold = policy.matching.autoMatchThreshold.valueBp;
  const showThreshold = policy.matching.candidateThreshold.valueBp;

  const above = scored.filter((candidate) => candidate.scoreBp >= autoThreshold);
  const visible = Object.freeze(
    [...scored]
      .filter((candidate) => candidate.scoreBp >= showThreshold)
      .sort((left, right) => right.scoreBp - left.scoreBp),
  );

  if (above.length === 1) {
    const matched = above[0];
    if (matched === undefined) {
      throw new IntakeError(IntakeErrorCode.basisPointsOutOfRange, { value: '1' });
    }
    return Object.freeze({
      outcome: 'auto_matched',
      matched,
      aboveThreshold: Object.freeze(above),
      visible,
      reasons: Object.freeze([INTAKE_REASON_KEYS.matchAuto, ...matched.reasons]),
    });
  }

  if (above.length > 1) {
    // Взять лучшего из двух здесь запрещено намеренно: при двух кандидатах выше
    // порога автоматика ошибается там, где сделки похожи, а цена ошибки —
    // отнесение денег к чужой сделке (A3a).
    return Object.freeze({
      outcome: 'ambiguous',
      matched: null,
      aboveThreshold: Object.freeze(above),
      visible,
      reasons: Object.freeze([INTAKE_REASON_KEYS.matchAmbiguous]),
    });
  }

  return Object.freeze({
    outcome: 'unmatched',
    matched: null,
    aboveThreshold: Object.freeze([]),
    visible,
    reasons: Object.freeze([INTAKE_REASON_KEYS.matchNoCandidate]),
  });
}

/**
 * Метрика A3: доля поступлений, у которых кандидат ровно один и он выше порога.
 * В базисных пунктах, целочисленно. Пустой набор — `null`, а не сто процентов:
 * доля по нулю наблюдений не определена, и подставлять сюда успех значит
 * рисовать зелёный дашборд до первой сделки.
 */
export function autoMatchShareBp(results: readonly MatchResult[]): number | null {
  if (results.length === 0) return null;
  const matched = results.filter((result) => result.outcome === 'auto_matched').length;
  return Math.floor((matched * 10_000) / results.length);
}
