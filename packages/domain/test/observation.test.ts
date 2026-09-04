import { describe, expect, it } from 'vitest';
import {
  type ObservationLevel,
  DEFAULT_OBSERVATION_POLICY,
  DomainError,
  OBSERVATION_LEVELS,
  OBSERVATION_LEVEL_RANK,
  OBSERVATION_REQUIREMENTS,
  OWNER_CHECKS,
  RELEASE_CONDITIONS,
  RELEASE_CONDITION_TYPES,
  RejectionCode,
  instant,
  observationLevelAtLeast,
  observationSatisfies,
  releaseObservation,
} from '../src/index';
import { CADASTRAL_CODE, NOW, RAW_DIGEST, observation } from './support/facts';

describe('лестница уровней доверия (ORACLE.md §2)', () => {
  it('has a rank for every level of the runtime list, not just the ones we typed', () => {
    // Перебор по рантайм-перечню, а не по литералу: уровень, добавленный без
    // ранга, обязан ронять этот тест, а не молча сравниваться строкой.
    for (const level of OBSERVATION_LEVELS) {
      expect(typeof OBSERVATION_LEVEL_RANK[level]).toBe('number');
    }
    expect(Object.keys(OBSERVATION_LEVEL_RANK).sort()).toEqual([...OBSERVATION_LEVELS].sort());
  });

  it('orders levels by rank, and the order is monotone along the list', () => {
    for (let i = 1; i < OBSERVATION_LEVELS.length; i += 1) {
      const previous = OBSERVATION_LEVELS[i - 1] as ObservationLevel;
      const current = OBSERVATION_LEVELS[i] as ObservationLevel;
      expect(OBSERVATION_LEVEL_RANK[current]).toBeGreaterThan(OBSERVATION_LEVEL_RANK[previous]);
      expect(observationLevelAtLeast(current, previous)).toBe(true);
      expect(observationLevelAtLeast(previous, current)).toBe(false);
    }
  });

  it('compares by rank, not lexicographically', () => {
    // Ранг задан таблицей именно потому, что строковое сравнение работает
    // случайно: оно совпадает с порядком доверия, пока уровней меньше десяти.
    const ranks = OBSERVATION_LEVELS.map((level) => OBSERVATION_LEVEL_RANK[level]);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(new Set(ranks).size).toBe(OBSERVATION_LEVELS.length);
  });
});

describe('вердикт по собственнику — три значения, а не два (ORACLE.md §5.3)', () => {
  it('keeps insufficient distinct from refuted and from established', () => {
    expect(OWNER_CHECKS).toEqual(['established', 'refuted', 'insufficient']);
    expect(new Set(OWNER_CHECKS).size).toBe(3);
    // «Недостаточно» — не «почти установлено» и не «опровергнуто». Оно
    // отличается от обоих **значением**, а разрешение у него то же, что у
    // `refuted`: выплаты нет. Различие нужно, чтобы оператор видел разницу
    // между «выписка сказала другое лицо» и «выписка вообще не отдала номер».
    expect(OWNER_CHECKS.includes('insufficient')).toBe(true);
    expect(('insufficient' as string) === 'established').toBe(false);
    expect(('insufficient' as string) === 'refuted').toBe(false);
  });
});

describe('конструктор наблюдения (CORE.md Ф11)', () => {
  it('refuses an observation without a usable raw source digest', () => {
    for (const digest of ['', 'not-a-digest', 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(() => observation({ rawSourceDigest: digest })).toThrow(DomainError);
    }
    expect(observation({ rawSourceDigest: RAW_DIGEST }).rawSourceDigest).toBe(RAW_DIGEST);
  });

  it('refuses an observation about no object at all', () => {
    try {
      observation({ cadastralCode: '' });
      expect.unreachable('наблюдение без объекта собралось');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe(RejectionCode.observationInvalid);
    }
  });

  it('refuses values outside the closed lists, because they arrive from the database', () => {
    expect(() =>
      releaseObservation({
        ...observation(),
        level: 'L9' as ObservationLevel,
      }),
    ).toThrow(DomainError);
  });

  it('freezes what it returns', () => {
    const value = observation();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.fields)).toBe(true);
  });
});

describe('требования к наблюдению по типу условия (ORACLE.md §6.1)', () => {
  it('names a requirement for every condition type, sourced from the condition list', () => {
    for (const conditionType of RELEASE_CONDITION_TYPES) {
      const required = OBSERVATION_REQUIREMENTS[conditionType];
      // Источник не переписан строкой: два места, где записано «чем
      // устанавливается этот факт», однажды разъедутся молча.
      expect(required.sourceKey).toBe(RELEASE_CONDITIONS[conditionType].sourceKey);
      expect(OBSERVATION_LEVEL_RANK[required.minLevel]).toBeGreaterThanOrEqual(
        OBSERVATION_LEVEL_RANK.L3,
      );
    }
  });

  it('makes no exception for calendar_date', () => {
    // Исключение — это дверь без guard'а. CORE.md Ф11: собственное время
    // оспоримо, нужна метка независимого поставщика.
    expect(OBSERVATION_REQUIREMENTS.calendar_date.minLevel).toBe('L3');
    expect(OBSERVATION_REQUIREMENTS.calendar_date.sourceKey).toBe('time.independent_timestamp');
  });
});

describe('годность наблюдения', () => {
  const check = {
    conditionType: 'registration_transfer',
    expectedCadastralCode: CADASTRAL_CODE,
    now: NOW,
    policy: DEFAULT_OBSERVATION_POLICY,
  } as const;

  it('accepts the paid extract about our object, fresh and of the right level', () => {
    expect(observationSatisfies(observation(), check)).toBe(true);
  });

  it('refuses the absence of an observation — silence is not consent', () => {
    expect(observationSatisfies(null, check)).toBe(false);
  });

  it('refuses a cheap signal: the free card starts the clock, not the money', () => {
    expect(observationSatisfies(observation({ level: 'L1' }), check)).toBe(false);
  });

  it('refuses an observation about someone else’s object', () => {
    expect(observationSatisfies(observation({ cadastralCode: '77.77.77.777.777' }), check)).toBe(
      false,
    );
  });

  it('refuses an extract older than the policy allows and one dated in the future', () => {
    const edge = instant(NOW - DEFAULT_OBSERVATION_POLICY.maxAge);
    expect(observationSatisfies(observation({ observedAt: edge }), check)).toBe(true);
    expect(observationSatisfies(observation({ observedAt: instant(edge - 1) }), check)).toBe(false);
    expect(observationSatisfies(observation({ observedAt: instant(NOW + 1) }), check)).toBe(false);
  });

  it('does not look at the five fields or at the owner: that is the other guards’ job', () => {
    // §7 STATE-MACHINES.md: каждое правило проверяется поимённо. Здесь — только
    // про сам документ, содержимое проверяют `g_fields_match` и
    // `g_owner_is_buyer`.
    expect(
      observationSatisfies(
        observation({
          ownerCheck: 'refuted',
          fields: {
            cadastralCode: false,
            ownerDocumentNumber: false,
            share: false,
            basis: false,
            noUnexpectedEncumbrances: false,
          },
        }),
        check,
      ),
    ).toBe(true);
  });
});
