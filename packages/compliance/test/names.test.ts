import { describe, expect, it } from 'vitest';
import {
  compareNames,
  DEFAULT_NAME_FEATURE_WEIGHTS,
  jaroWinklerBp,
  latinAmbiguity,
  latinGraphemes,
  levenshteinBp,
  nameObservation,
  toApostropheLatin,
  toPassportLatin,
  trigramBp,
} from '../src/index';
import {
  cyrillicName,
  georgianName,
  GEORGIAN_HARD,
  GEORGIAN_SOFT,
  latinName,
  POLICY,
} from './support/fixtures';

const strong = { strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp };

describe('латинизация грузинского необратима', () => {
  it('пять пар схлопываются в один латинский знак', () => {
    expect(toPassportLatin('georgian', 'თ')).toBe('t');
    expect(toPassportLatin('georgian', 'ტ')).toBe('t');
    expect(toPassportLatin('georgian', 'ქ')).toBe('k');
    expect(toPassportLatin('georgian', 'კ')).toBe('k');
    expect(toPassportLatin('georgian', 'ფ')).toBe('p');
    expect(toPassportLatin('georgian', 'პ')).toBe('p');
    expect(toPassportLatin('georgian', 'ც')).toBe('ts');
    expect(toPassportLatin('georgian', 'წ')).toBe('ts');
    expect(toPassportLatin('georgian', 'ჩ')).toBe('ch');
    expect(toPassportLatin('georgian', 'ჭ')).toBe('ch');
  });

  it('две разные последовательности дают одну паспортную форму', () => {
    expect(toPassportLatin('georgian', GEORGIAN_SOFT)).toBe('titi');
    expect(toPassportLatin('georgian', GEORGIAN_HARD)).toBe('titi');
  });

  it('ключ с апострофами различие сохраняет, паспортный — нет', () => {
    expect(toApostropheLatin('georgian', GEORGIAN_SOFT)).toBe('titi');
    expect(toApostropheLatin('georgian', GEORGIAN_HARD)).toBe("t'it'i");
    // Для латиницы апострофный ключ равен паспортному: различия там уже нет.
    expect(toApostropheLatin('latin', 'Titi')).toBe('titi');
  });

  it('kh, gh, zh, sh, dz разбираются как одна графема', () => {
    expect(latinGraphemes('khgh')).toEqual(['kh', 'gh']);
    expect(latinGraphemes('tsdzsh')).toEqual(['ts', 'dz', 'sh']);
    // «k» внутри «kh» неоднозначным не считается: ხ — отдельная буква.
    expect(latinAmbiguity('kh').georgianSpellingCount).toBe(1);
  });

  it('форма с двумя схлопнувшимися знаками допускает четыре написания', () => {
    const report = latinAmbiguity('titi');
    expect(report.georgianSpellingCount).toBe(4);
    expect(report.ambiguities.map((item) => item.grapheme)).toEqual(['t', 't']);
    expect(report.ambiguities[0]?.georgianCandidates).toEqual(['თ', 'ტ']);
  });

  it('форма без схлопывающихся знаков однозначна', () => {
    expect(latinAmbiguity('samego').georgianSpellingCount).toBe(1);
    expect(latinAmbiguity('samego').ambiguities).toHaveLength(0);
  });
});

describe('признаки сходства целочисленные', () => {
  it('совпадение даёт 10000 по каждому признаку', () => {
    expect(levenshteinBp('titi', 'titi')).toBe(10_000);
    expect(trigramBp('titi', 'titi')).toBe(10_000);
    expect(jaroWinklerBp('titi', 'titi')).toBe(10_000);
  });

  it('полное несовпадение даёт ноль по Джаро-Винклеру', () => {
    expect(jaroWinklerBp('abc', 'xyz')).toBe(0);
    expect(levenshteinBp('abc', 'xyz')).toBe(0);
  });

  it('надбавка Винклера считается не более чем по четырём знакам префикса', () => {
    // Ограничение префикса четырьмя знаками — часть самого коэффициента, а не
    // округление. Без него длинный общий префикс вытягивает к десяти тысячам
    // формы, различающиеся хвостом, — а хвост фамилии как раз и различает
    // однокоренные грузинские фамилии.
    // Джаро = 9 166; надбавка = 4 × (10 000 − 9 166) / 10 = 333.
    expect(jaroWinklerBp('abcdefgh', 'abcdefgz')).toBe(9_499);
  });

  it('веса ансамбля в сумме сто', () => {
    const { levenshteinPercent, trigramPercent, jaroWinklerPercent } =
      DEFAULT_NAME_FEATURE_WEIGHTS;
    expect(levenshteinPercent + trigramPercent + jaroWinklerPercent).toBe(100);
  });
});

describe('сравнение имён возвращает степень, а не булево', () => {
  it('совпадение в одном алфавите отмечается отдельной степенью', () => {
    const match = compareNames([latinName('Sabo', 'Tikato')], [latinName('Sabo', 'Tikato')], strong);
    expect(match.degree).toBe('identical_in_source_alphabet');
    expect(match.scoreBp).toBe(10_000);
  });

  it('совпадение только после латинизации не выдаётся за совпадение форм', () => {
    const match = compareNames(
      [latinName('Sabo', 'Titi')],
      [georgianName('საბო', GEORGIAN_HARD)],
      strong,
    );
    expect(match.degree).toBe('identical_after_latinization');
    // Ровно то, что показывают оператору: форма совпала, но она необратима.
    expect(match.georgianSpellingCount).toBeGreaterThan(1);
    expect(match.reasons).toContain('compliance.name.latinization_irreversible');
  });

  it('кириллическая форма помечается как более неоднозначная', () => {
    const match = compareNames([cyrillicName('Сабо', 'Тити')], [latinName('Sabo', 'Titi')], strong);
    expect(match.reasons).toContain('compliance.name.cyrillic_more_ambiguous');
  });

  it('разные имена не дают сильного совпадения', () => {
    const match = compareNames([latinName('Sabo', 'Tikato')], [latinName('Nuvo', 'Zerlan')], strong);
    expect(match.degree).toBe('weak');
    expect(match.scoreBp).toBeLessThan(strong.strongThresholdBp);
  });

  it('пустой набор наблюдений — «несравнимо», а не «не совпало»', () => {
    const match = compareNames([], [latinName('Sabo', 'Tikato')], strong);
    expect(match.degree).toBe('not_comparable');
    expect(match.reasons).toContain('compliance.name.not_comparable');
  });

  it('совпадение имени никогда не объявляется достаточным', () => {
    const match = compareNames([latinName('Sabo', 'Tikato')], [latinName('Sabo', 'Tikato')], strong);
    // Литеральный тип: другое значение не собралось бы.
    expect(match.sufficientAlone).toBe(false);
    expect(match.reasons).toContain('compliance.name.evidence_insufficient_alone');
  });

  it('балл ровно на пороге — сильное совпадение, на единицу выше порога — уже нет', () => {
    // Порог у каждой задачи свой (у скрининга дорог пропуск, у сверки
    // собственника — ложное совпадение), поэтому проверяется не число, а
    // сторона сравнения: равенство порогу считается его достижением.
    const left = [latinName('Sabo', 'Tikato')];
    const right = [latinName('Sabo', 'Tikaton')];
    const scoreBp = compareNames(left, right, { strongThresholdBp: 0 }).scoreBp;
    // Пара подобрана так, чтобы степень решалась именно порогом: формы не
    // совпадают ни в исходном алфавите, ни после латинизации.
    expect(scoreBp).toBeGreaterThan(0);
    expect(scoreBp).toBeLessThan(10_000);

    expect(compareNames(left, right, { strongThresholdBp: scoreBp }).degree).toBe('strong');
    expect(compareNames(left, right, { strongThresholdBp: scoreBp + 1 }).degree).toBe('weak');
  });

  it('нулевой балл — «не совпало», а не слабое совпадение', () => {
    const match = compareNames([latinName('Abc', '')], [latinName('Xyz', '')], strong);
    expect(match.scoreBp).toBe(0);
    expect(match.degree).toBe('none');
    // Пара всё равно возвращается: оператору показывают, что именно сравнивали.
    expect(match.best).not.toBeNull();
  });

  it('при равном балле побеждает совпадение в исходном алфавите', () => {
    // Обе пары дают 10 000: латинская — совпадением форм, грузинская — после
    // латинизации. Различить их обязано первое, иначе отчёт скажет «совпало
    // после латинизации» там, где формы совпали буквально.
    const match = compareNames(
      [latinName('Sabo', 'Titi')],
      [latinName('Sabo', 'Titi'), georgianName('საბო', GEORGIAN_HARD)],
      strong,
    );
    expect(match.scoreBp).toBe(10_000);
    expect(match.degree).toBe('identical_in_source_alphabet');
  });

  it('форма без схлопывающихся знаков причины о необратимости не несёт', () => {
    const match = compareNames([latinName('Nuvo', 'Zerlan')], [latinName('Nuvo', 'Zerlan')], strong);
    expect(match.georgianSpellingCount).toBe(1);
    expect(match.reasons).not.toContain('compliance.name.latinization_irreversible');
  });

  it('веса ансамбля не в сумме сто отвергаются в обе стороны', () => {
    const options = (percent: number) => ({
      strongThresholdBp: 8_000,
      weights: {
        levenshteinPercent: percent,
        trigramPercent: percent,
        jaroWinklerPercent: percent,
      },
    });
    // Недобор так же опасен, как перебор: он молча занижает все баллы сразу.
    expect(() => compareNames([latinName('Sabo', 'Titi')], [latinName('Sabo', 'Titi')], options(30))).toThrow();
    expect(() => compareNames([latinName('Sabo', 'Titi')], [latinName('Sabo', 'Titi')], options(40))).toThrow();
  });
});

describe('вес доказательства наблюдения', () => {
  it('границы диапазона законны: ноль и десять тысяч', () => {
    expect(() => nameObservation({ ...latinName('Sabo', 'Titi'), evidenceWeightBp: 0 })).not.toThrow();
    expect(() =>
      nameObservation({ ...latinName('Sabo', 'Titi'), evidenceWeightBp: 10_000 }),
    ).not.toThrow();
  });

  it('за границами диапазона наблюдение не собирается', () => {
    expect(() => nameObservation({ ...latinName('Sabo', 'Titi'), evidenceWeightBp: -1 })).toThrow(
      'compliance.basis_points.out_of_range',
    );
    expect(() =>
      nameObservation({ ...latinName('Sabo', 'Titi'), evidenceWeightBp: 10_001 }),
    ).toThrow('compliance.basis_points.out_of_range');
  });
});

describe('пороги политики', () => {
  it('порог скрининга ниже порога сверки собственника', () => {
    expect(POLICY.nameThresholds.screening.valueBp).toBeLessThan(
      POLICY.nameThresholds.ownerReconciliation.valueBp,
    );
    expect(POLICY.nameThresholds.screening.rationaleDocRef).not.toBe('');
    expect(POLICY.nameThresholds.ownerReconciliation.rationaleDocRef).not.toBe('');
  });
});
