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
});
