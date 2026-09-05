import { describe, expect, it } from 'vitest';
import {
  type CandidateSignals,
  type IntakePolicy,
  type ReferenceMatch,
  INTAKE_REASON_KEYS,
  PROPOSED_INTAKE_POLICY,
  amountFits,
  assertMatchingWeights,
  autoMatchShareBp,
  matchIncoming,
  matchReference,
  paymentReference,
  scoreCandidate,
} from '../src/index';
import { NO_NAME_MATCH, POLICY, STRONG_NAME_MATCH, gel, usd } from './support/fixtures';

const REFERENCE = paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T1' });

const ABSENT_REFERENCE: ReferenceMatch = matchReference(REFERENCE, null, POLICY);
const EXACT_REFERENCE: ReferenceMatch = matchReference(REFERENCE, REFERENCE, POLICY);

function candidate(overrides: Partial<CandidateSignals> = {}): CandidateSignals {
  return {
    dealId: 'deal-1',
    trancheId: 't1',
    reference: ABSENT_REFERENCE,
    amountFits: false,
    sourceAccountSeen: false,
    currencyMatches: false,
    senderName: null,
    ...overrides,
  };
}

describe('имя в одиночку кандидата не даёт никогда', () => {
  it('точное совпадение имени и ничего больше — ноль', () => {
    const scored = scoreCandidate(candidate({ senderName: STRONG_NAME_MATCH }), POLICY);
    expect(scored.scoreBp).toBe(0);
    expect(scored.reasons).toContain(INTAKE_REASON_KEYS.matchNameSecondaryOnly);
  });

  it('единственное поступление с точным именем не сопоставляется', () => {
    const result = matchIncoming([candidate({ senderName: STRONG_NAME_MATCH })], POLICY);
    expect(result.outcome).toBe('unmatched');
  });

  it('имя добавляется только к уже набранному весу', () => {
    const base = scoreCandidate(candidate({ amountFits: true, currencyMatches: true }), POLICY);
    const withName = scoreCandidate(
      candidate({ amountFits: true, currencyMatches: true, senderName: STRONG_NAME_MATCH }),
      POLICY,
    );
    expect(withName.scoreBp).toBeGreaterThan(base.scoreBp);
    expect(withName.withoutNameBp).toBe(base.withoutNameBp);
  });

  it('несовпавшее имя веса не отнимает', () => {
    const base = scoreCandidate(candidate({ amountFits: true }), POLICY);
    const withBadName = scoreCandidate(
      candidate({ amountFits: true, senderName: NO_NAME_MATCH }),
      POLICY,
    );
    expect(withBadName.scoreBp).toBe(base.scoreBp);
  });
});

describe('референс потерян — сопоставление работает по совокупности', () => {
  const withoutReference = candidate({
    reference: ABSENT_REFERENCE,
    amountFits: true,
    sourceAccountSeen: true,
    currencyMatches: true,
  });

  it('сумма, счёт-источник и валюта дают одного кандидата выше порога', () => {
    const result = matchIncoming([withoutReference], POLICY);
    expect(result.outcome).toBe('auto_matched');
    expect(result.matched?.signals.trancheId).toBe('t1');
  });

  it('одной суммы для автосопоставления мало', () => {
    const result = matchIncoming([candidate({ amountFits: true })], POLICY);
    expect(result.outcome).toBe('unmatched');
  });

  it('точный референс проходит и в одиночку', () => {
    const result = matchIncoming([candidate({ reference: EXACT_REFERENCE })], POLICY);
    expect(result.outcome).toBe('auto_matched');
  });
});

describe('два кандидата выше порога — автосопоставления нет ни одного', () => {
  const strong = { amountFits: true, sourceAccountSeen: true, currencyMatches: true };

  it('оба уходят оператору, ни один не выбирается', () => {
    const result = matchIncoming(
      [
        candidate({ ...strong, trancheId: 't1' }),
        candidate({ ...strong, trancheId: 't2', reference: EXACT_REFERENCE }),
      ],
      POLICY,
    );
    expect(result.outcome).toBe('ambiguous');
    expect(result.matched).toBeNull();
    expect(result.aboveThreshold).toHaveLength(2);
  });

  it('лучший из двух не побеждает даже с большим отрывом', () => {
    const result = matchIncoming(
      [
        candidate({ ...strong, trancheId: 't1', reference: EXACT_REFERENCE }),
        candidate({ ...strong, trancheId: 't2' }),
      ],
      POLICY,
    );
    expect(result.outcome).toBe('ambiguous');
  });

  it('слабый второй кандидат не делает исход неоднозначным', () => {
    const result = matchIncoming(
      [candidate({ ...strong, trancheId: 't1' }), candidate({ trancheId: 't2', amountFits: true })],
      POLICY,
    );
    expect(result.outcome).toBe('auto_matched');
    // Слабый всё равно показывается оператору, если перешагнул порог показа.
    expect(result.visible.length).toBeGreaterThanOrEqual(1);
  });
});

describe('признак «сумма подходит»', () => {
  it('сверяется с непокрытым остатком, а не с требуемым целиком', () => {
    // Дробный платёж: требуется 200 000, накоплено 150 000, пришло 50 000.
    expect(amountFits(gel(5_000_000n), gel(5_000_000n), gel(5_000n))).toBe(true);
  });

  it('допуск работает в обе стороны: недобор корреспондента и перебор одинаково', () => {
    expect(amountFits(gel(4_999_600n), gel(5_000_000n), gel(5_000n))).toBe(true);
    expect(amountFits(gel(5_000_400n), gel(5_000_000n), gel(5_000n))).toBe(true);
  });

  it('за пределами допуска сумма признаком не считается', () => {
    expect(amountFits(gel(4_994_000n), gel(5_000_000n), gel(5_000n))).toBe(false);
    expect(amountFits(gel(5_006_000n), gel(5_000_000n), gel(5_000n))).toBe(false);
  });

  it('расхождение ровно в допуск ещё подходит, на тетри больше — уже нет', () => {
    // Допуск объявлен стороне как величина, которую платформа принимает. Она
    // принимается целиком: «не более» включает саму границу, иначе объявленное
    // число на одну минорную единицу больше действующего.
    expect(amountFits(gel(4_995_000n), gel(5_000_000n), gel(5_000n))).toBe(true);
    expect(amountFits(gel(5_005_000n), gel(5_000_000n), gel(5_000n))).toBe(true);
    expect(amountFits(gel(4_994_999n), gel(5_000_000n), gel(5_000n))).toBe(false);
    expect(amountFits(gel(5_005_001n), gel(5_000_000n), gel(5_000n))).toBe(false);
  });

  it('нулевой допуск требует точного равенства', () => {
    expect(amountFits(gel(5_000_000n), gel(5_000_000n), gel(0n))).toBe(true);
    expect(amountFits(gel(5_000_001n), gel(5_000_000n), gel(0n))).toBe(false);
  });

  it('другая валюта не подходит никогда', () => {
    expect(amountFits(usd(5_000_000n), gel(5_000_000n), gel(5_000n))).toBe(false);
  });
});

describe('веса политики', () => {
  it('непарные с именем признаки в сумме дают сто процентов', () => {
    expect(() => assertMatchingWeights(PROPOSED_INTAKE_POLICY.matching.weights)).not.toThrow();
  });

  it('политика с неверной суммой весов падает на первом же расчёте', () => {
    const broken: IntakePolicy = Object.freeze({
      ...PROPOSED_INTAKE_POLICY,
      matching: Object.freeze({
        ...PROPOSED_INTAKE_POLICY.matching,
        weights: Object.freeze({
          ...PROPOSED_INTAKE_POLICY.matching.weights,
          currencyMatchesPercent: 50,
        }),
      }),
    });
    expect(() => scoreCandidate(candidate({ amountFits: true }), broken)).toThrow();
  });

  it('искажённый референс не может весить больше точного', () => {
    expect(() =>
      assertMatchingWeights({
        ...PROPOSED_INTAKE_POLICY.matching.weights,
        referenceDamagedPercent: 90,
      }),
    ).toThrow();
  });

  it('равные веса искажённого и точного законны: запрещён перевес, а не равенство', () => {
    expect(() =>
      assertMatchingWeights({
        ...PROPOSED_INTAKE_POLICY.matching.weights,
        referenceDamagedPercent: PROPOSED_INTAKE_POLICY.matching.weights.referenceExactPercent,
      }),
    ).not.toThrow();
  });

  it('сумма весов меньше ста отвергается так же, как больше ста', () => {
    // Недобор опаснее перебора: он занижает все веса разом и молча выключает
    // автосопоставление, не сломав ни одной проверки на «не больше ста».
    expect(() =>
      assertMatchingWeights({ ...PROPOSED_INTAKE_POLICY.matching.weights, currencyMatchesPercent: 1 }),
    ).toThrow('intake.matching.weights_not_hundred');
    expect(() =>
      assertMatchingWeights({ ...PROPOSED_INTAKE_POLICY.matching.weights, currencyMatchesPercent: 9 }),
    ).toThrow('intake.matching.weights_not_hundred');
  });

  it('нулевая надбавка за имя законна: имя просто ничего не добавляет', () => {
    expect(() =>
      assertMatchingWeights({ ...PROPOSED_INTAKE_POLICY.matching.weights, senderNameBonusPercent: 0 }),
    ).not.toThrow();
    expect(() =>
      assertMatchingWeights({
        ...PROPOSED_INTAKE_POLICY.matching.weights,
        senderNameBonusPercent: -1,
      }),
    ).toThrow('intake.basis_points.out_of_range');
  });

  it('отрицательный вес признака отвергается: иначе имя перестаёт быть вторичным', () => {
    // Сумма в сто процентов набирается и с отрицательным слагаемым. Такой набор
    // уводит вес непарных признаков в минус, и надбавка за имя добавляется к
    // отрицательному — то есть имя в одиночку снова даёт кандидата.
    expect(() =>
      assertMatchingWeights({
        ...PROPOSED_INTAKE_POLICY.matching.weights,
        amountFitsPercent: -20,
        currencyMatchesPercent: 45,
      }),
    ).toThrow('intake.basis_points.out_of_range');
  });
});

/**
 * Пороги сопоставления. Автосопоставление относит деньги к сделке без человека,
 * порог показа решает, увидит ли оператор кандидата вообще. Сторона границы у
 * обоих включающая, и ошибка на единицу здесь либо выключает автосверку там,
 * ради чего она написана, либо прячет кандидата от разбора.
 */
describe('пороги сопоставления: сторона границы', () => {
  it('вес ровно на пороге автосопоставления сопоставляет', () => {
    // «Сумма подходит» плюс «счёт-источник знаком» — ровно 40%, то есть порог.
    const exactly = candidate({ amountFits: true, sourceAccountSeen: true });
    expect(scoreCandidate(exactly, POLICY).scoreBp).toBe(
      POLICY.matching.autoMatchThreshold.valueBp,
    );
    expect(matchIncoming([exactly], POLICY).outcome).toBe('auto_matched');
  });

  it('вес на один пункт ниже порога автосопоставления не сопоставляет', () => {
    const below = candidate({ amountFits: true, currencyMatches: true });
    expect(scoreCandidate(below, POLICY).scoreBp).toBeLessThan(
      POLICY.matching.autoMatchThreshold.valueBp,
    );
    expect(matchIncoming([below], POLICY).outcome).toBe('unmatched');
  });

  it('вес ровно на пороге показа кандидата оператору показывает', () => {
    // Одна «сумма подходит» — 20%, то есть порог показа.
    const exactly = candidate({ amountFits: true });
    expect(scoreCandidate(exactly, POLICY).scoreBp).toBe(
      POLICY.matching.candidateThreshold.valueBp,
    );
    expect(matchIncoming([exactly], POLICY).visible).toHaveLength(1);
  });

  it('вес ниже порога показа кандидата не показывает', () => {
    const below = candidate({ currencyMatches: true });
    expect(scoreCandidate(below, POLICY).scoreBp).toBeLessThan(
      POLICY.matching.candidateThreshold.valueBp,
    );
    expect(matchIncoming([below], POLICY).visible).toHaveLength(0);
  });

  it('видимые кандидаты идут от сильного к слабому', () => {
    // Оператор читает список сверху, и первым обязан стоять самый вероятный.
    const strong = candidate({
      trancheId: 'strong',
      amountFits: true,
      sourceAccountSeen: true,
      currencyMatches: true,
    });
    const weak = candidate({ trancheId: 'weak', amountFits: true });
    const visible = matchIncoming([weak, strong], POLICY).visible;
    expect(visible.map((item) => item.signals.trancheId)).toEqual(['strong', 'weak']);
  });

  it('вес искажённого референса считается усечением, а не округлением вверх', () => {
    // Три изменённых знака из тринадцати: сходство 7 692, вес 30% × 0,7692 =
    // 2 307,6 → 2 307. Округли вверх — и искажённый референс станет весить
    // больше, чем даёт его сходство.
    const damagedRaw = `${(REFERENCE as string).slice(0, 4)}XYZ${(REFERENCE as string).slice(7)}`;
    const damaged = matchReference(REFERENCE, damagedRaw, POLICY);
    expect(damaged.degree).toBe('damaged');
    expect(damaged.similarityBp).toBe(7_692);
    expect(scoreCandidate(candidate({ reference: damaged }), POLICY).scoreBp).toBe(2_307);
  });
});

describe('метрика A3', () => {
  it('доля автосопоставлений считается целочисленно', () => {
    const auto = matchIncoming([candidate({ reference: EXACT_REFERENCE })], POLICY);
    const none = matchIncoming([candidate()], POLICY);
    expect(autoMatchShareBp([auto, none, none, auto])).toBe(5_000);
  });

  it('по нулю наблюдений доля не определена, а не равна ста процентам', () => {
    expect(autoMatchShareBp([])).toBeNull();
  });

  it('доля усекается вниз и считает именно сопоставленные', () => {
    // Одно из трёх — 33,33%. Округление вверх рисует дашборд лучше, чем есть,
    // а половина наблюдений в знаменателе делает симметричную ошибку
    // (посчитать несопоставленные) неотличимой от верного счёта.
    const auto = matchIncoming([candidate({ reference: EXACT_REFERENCE })], POLICY);
    const none = matchIncoming([candidate()], POLICY);
    expect(autoMatchShareBp([auto, none, none])).toBe(3_333);
    expect(autoMatchShareBp([auto, auto, none])).toBe(6_666);
  });
});
