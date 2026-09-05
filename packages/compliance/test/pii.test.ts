import { describe, expect, it } from 'vitest';
import {
  accountFingerprint,
  assessPayer,
  assessRefundDestination,
  compareNames,
  documentNumberFingerprint,
  fingerprintLabel,
  logSafeDecision,
  logSafeNameMatch,
  nameDigest,
  verifyBeneficiaryHolder,
} from '../src/index';
import {
  ACCOUNT_OTHER,
  ACCOUNT_SOURCE,
  BUYER_DOCUMENT,
  BUYER_NAMES,
  evidence,
  NOW,
  OTHER_DOCUMENT,
  OTHER_NAMES,
  POLICY,
  POLICY_VERSION,
  profile,
} from './support/fixtures';

const strong = { strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp };

describe('персональные данные не попадают в решение', () => {
  it('решение детектора плательщика не содержит ни имени, ни отпечатка документа', () => {
    const result = assessPayer(
      {
        buyerDocument: BUYER_DOCUMENT,
        origin: {
          kind: 'external_transfer',
          payerDocument: OTHER_DOCUMENT,
          senderNameMatch: compareNames(BUYER_NAMES, OTHER_NAMES, strong),
        },
        relationship: { kind: 'unrelated_third_party' },
        evidence: [evidence(1)],
      },
      POLICY_VERSION,
      NOW,
    );
    const serialized = JSON.stringify(logSafeDecision(result));
    expect(serialized).not.toContain('Tikato');
    expect(serialized).not.toContain('Zerlan');
    expect(serialized).not.toContain(BUYER_DOCUMENT.numberFingerprint);
    expect(serialized).not.toContain(OTHER_DOCUMENT.numberFingerprint);
  });

  it('внутреннее движение не тащит владельца остатка в журнальную проекцию', () => {
    const result = assessPayer(
      {
        buyerDocument: BUYER_DOCUMENT,
        origin: { kind: 'internal_balance', accountHolder: BUYER_DOCUMENT },
        relationship: { kind: 'self' },
        evidence: [evidence(1)],
      },
      POLICY_VERSION,
      NOW,
    );
    expect(result.outcome).toBe('clear');
    expect(JSON.stringify(logSafeDecision(result))).not.toContain(BUYER_DOCUMENT.numberFingerprint);
  });

  it('решение по возврату не содержит отпечатков счетов', () => {
    const result = assessRefundDestination(
      {
        sourceAccount: ACCOUNT_SOURCE,
        sourceHolder: BUYER_DOCUMENT,
        requestedAccount: ACCOUNT_OTHER,
        requestedHolder: BUYER_DOCUMENT,
        sanctionsFrozen: false,
        evidence: [],
      },
      POLICY_VERSION,
      NOW,
    );
    const serialized = JSON.stringify(logSafeDecision(result));
    expect(serialized).not.toContain(ACCOUNT_SOURCE);
    expect(serialized).not.toContain(ACCOUNT_OTHER);
  });

  it('журнальная проекция сравнения имён не содержит самих форм', () => {
    const match = compareNames(BUYER_NAMES, BUYER_NAMES, strong);
    // В самом объекте сравнения паспортная форма есть — она нужна оператору.
    expect(JSON.stringify(match)).toContain('tikato');
    // В журнал уходит проекция без неё.
    expect(JSON.stringify(logSafeNameMatch(match))).not.toContain('tikato');
    expect(logSafeNameMatch(match).left?.familyInitial).toBe('T');
  });

  it('дайджест имени не восстанавливает имя', () => {
    const digest = nameDigest('latin', 'Sabo', 'Tikato');
    expect(digest).toEqual({
      alphabet: 'latin',
      givenInitial: 'S',
      givenLength: 4,
      familyInitial: 'T',
      familyLength: 6,
    });
  });

  it('метка отпечатка короче отпечатка и не восстанавливает его', () => {
    expect(fingerprintLabel(ACCOUNT_SOURCE)).toHaveLength(8);
    expect(ACCOUNT_SOURCE.startsWith(fingerprintLabel(ACCOUNT_SOURCE))).toBe(true);
  });

  it('дайджест грузинской формы считает символы, а не байты', () => {
    expect(nameDigest('georgian', 'საბო', 'თითი').familyLength).toBe(4);
  });

  /**
   * Грузинские буквы помещаются в одну кодовую единицу, и на них проверка выше
   * проходит одинаково при обоих способах счёта. Разойдутся они только на знаке
   * вне основной плоскости: там `length` считает суррогатную пару за два. Мера
   * длины — знаки; если она однажды станет мерой кодовых единиц, оператор
   * увидит у имени из четырёх знаков длину восемь и решит, что это другое имя.
   */
  it('дайджест считает знаки и вне основной плоскости', () => {
    const outsideBmp = '\u{10400}\u{10401}';
    expect(outsideBmp.length).toBe(4);
    const digest = nameDigest('latin', outsideBmp, outsideBmp);
    expect(digest.givenLength).toBe(2);
    expect(digest.familyLength).toBe(2);
    expect(digest.givenInitial).toBe('\u{10400}');
  });
});

/**
 * Проекция объявляет свои поля перечнем, и перечень — это и есть обещание.
 * `Decision` структурно вложен в решения, которые несут больше: у сверки
 * владельца счёта в том же объекте лежит `nameMatch` с паспортными формами
 * обоих имён. Проекция, собранная «всё, что пришло, плюс поля», выглядит
 * работающей и молча выносит эти формы в журнал.
 */
describe('журнальная проекция несёт ровно объявленные поля', () => {
  const verification = verifyBeneficiaryHolder(
    {
      account: ACCOUNT_SOURCE,
      holderNames: BUYER_NAMES,
      holderDocument: null,
      ownershipEvidence: null,
    },
    profile(),
    POLICY,
    NOW,
  );

  it('решение сверки владельца счёта теряет разбор имён по дороге в журнал', () => {
    expect(verification.nameMatch.best?.leftPassportLatin).toBe('sabotikato');
    const projection = logSafeDecision(verification);
    expect(Object.keys(projection).sort()).toEqual([
      'decidedAt',
      'evidence',
      'outcome',
      'policyVersionId',
      'reasons',
    ]);
    expect(JSON.stringify(projection)).not.toContain('tikato');
    expect(JSON.stringify(projection)).not.toContain('Tikato');
  });

  it('проекция сравнения имён несёт перечень знаков, а не разбор', () => {
    const match = compareNames(BUYER_NAMES, BUYER_NAMES, strong);
    const projection = logSafeNameMatch(match);
    expect(Object.keys(projection).sort()).toEqual([
      'ambiguousGraphemes',
      'degree',
      'features',
      'georgianSpellingCount',
      'left',
      'reasons',
      'right',
      'scoreBp',
    ]);
    // В `Sabo Tikato` три схлопывающихся знака — `t`, `k`, `t`; в журнал уходят
    // сами знаки, а позиция и грузинские прообразы остаются в разборе оператора.
    expect([...projection.ambiguousGraphemes]).toEqual(['t', 'k', 't']);
    expect(projection.georgianSpellingCount).toBe(8);
  });
});

/**
 * Отпечаток — единственная форма, в которой номер документа попадает в пакет.
 * Всё, что проверка формата пропускает, приходит в решение под видом отпечатка:
 * сырой номер с приписанным хвостом, тот же хеш в другом регистре (сравнение
 * «тот же документ» промахнётся) или короткая метка вместо самого отпечатка.
 */
describe('формат отпечатка проверяется целиком', () => {
  it('строка с посторонним хвостом отпечатком не является', () => {
    expect(() => accountFingerprint(`${ACCOUNT_SOURCE}0`)).toThrow(
      'compliance.fingerprint.invalid',
    );
    expect(() => accountFingerprint(`AB-${ACCOUNT_SOURCE}`)).toThrow(
      'compliance.fingerprint.invalid',
    );
    expect(() => accountFingerprint(`${ACCOUNT_SOURCE}\nxx`)).toThrow(
      'compliance.fingerprint.invalid',
    );
  });

  it('верхний регистр отпечатком не является: иначе один хеш даст два значения', () => {
    expect(() => documentNumberFingerprint(ACCOUNT_SOURCE.toUpperCase())).toThrow(
      'compliance.fingerprint.invalid',
    );
  });

  it('короткая строка отпечатком не является: метка — не отпечаток', () => {
    expect(() => accountFingerprint(fingerprintLabel(ACCOUNT_SOURCE))).toThrow(
      'compliance.fingerprint.invalid',
    );
    expect(() => accountFingerprint(ACCOUNT_SOURCE.slice(0, 63))).toThrow(
      'compliance.fingerprint.invalid',
    );
  });

  it('в сообщении об ошибке нет самого значения', () => {
    const raw = 'AB1234567';
    try {
      documentNumberFingerprint(raw);
      throw new Error('ожидался отказ');
    } catch (error) {
      expect(JSON.stringify(error instanceof Error ? error.message : error)).not.toContain(raw);
      const details = (error as { details?: Record<string, string> }).details ?? {};
      expect(JSON.stringify(details)).not.toContain(raw);
      expect(details['kind']).toBe('document_number');
    }
  });
});
