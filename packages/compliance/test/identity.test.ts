import { describe, expect, it } from 'vitest';
import {
  compareNames,
  countryCode,
  documentNumberFingerprint,
  identityCompleteness,
  identityKey,
  reconcileOwner,
  sameIdentity,
} from '../src/index';
import {
  BUYER_DOCUMENT,
  document,
  latinName,
  NOW,
  OTHER_DOCUMENT,
  POLICY,
  profile,
  WITH_PERSONAL_NUMBER,
  fp,
  GE,
} from './support/fixtures';

const strong = { strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp };

describe('ключ личности — страна, тип и номер документа', () => {
  it('ключ собирается из трёх частей документа', () => {
    expect(identityKey(BUYER_DOCUMENT)).toBe(
      `${BUYER_DOCUMENT.issuingCountry}:passport:${BUYER_DOCUMENT.numberFingerprint}`,
    );
  });

  it('один номер, выданный разными странами, — разные личности', () => {
    const left = { ...BUYER_DOCUMENT, issuingCountry: GE };
    expect(sameIdentity(left, BUYER_DOCUMENT)).toBe(false);
  });

  it('один номер при разном типе документа — разные личности', () => {
    const left = { ...BUYER_DOCUMENT, type: 'national_id' as const };
    expect(sameIdentity(left, BUYER_DOCUMENT)).toBe(false);
  });

  it('совпадение всех трёх частей — та же личность', () => {
    expect(sameIdentity(BUYER_DOCUMENT, document(1))).toBe(true);
    expect(sameIdentity(BUYER_DOCUMENT, OTHER_DOCUMENT)).toBe(false);
  });

  it('грузинский личный номер в ключ не входит вовсе', () => {
    // Аргумент `identityKey` — документ; поля личного номера в нём нет,
    // поэтому собрать ключ из личного номера невозможно по типу.
    const withNumber = profile({ georgianPersonalNumber: WITH_PERSONAL_NUMBER });
    const without = profile({ georgianPersonalNumber: null });
    expect(identityKey(withNumber.document)).toBe(identityKey(without.document));
  });
});

describe('профиль без грузинского личного номера полноценен', () => {
  it('полнота идентификации не зависит от личного номера', () => {
    const without = identityCompleteness(profile({ georgianPersonalNumber: null }), NOW);
    const withNumber = identityCompleteness(
      profile({ georgianPersonalNumber: WITH_PERSONAL_NUMBER }),
      NOW,
    );
    expect(without.complete).toBe(true);
    expect(withNumber.complete).toBe(true);
    expect(without.missing).toEqual(withNumber.missing);
  });

  it('отсутствие личного номера — заметка, а не недостающее', () => {
    const without = identityCompleteness(profile({ georgianPersonalNumber: null }), NOW);
    expect(without.notes).toContain('compliance.identity.georgian_personal_number_absent');
    expect(without.missing).not.toContain('compliance.identity.georgian_personal_number_absent');
  });

  it('отказ от селфи не влияет на полноту', () => {
    expect(identityCompleteness(profile({ biometrics: 'declined' }), NOW).complete).toBe(true);
  });

  it('без латинской формы имени профиль неполон: платёж физически невозможен', () => {
    const georgianOnly = profile({
      names: [
        {
          alphabet: 'georgian',
          given: 'საბო',
          family: 'თითი',
          source: 'identity_document',
          evidenceWeightBp: 10_000,
        },
      ],
    });
    const result = identityCompleteness(georgianOnly, NOW);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('compliance.identity.latin_name_missing');
  });

  it('просроченный документ ломает полноту', () => {
    const expired = profile({
      document: { ...BUYER_DOCUMENT, expiresAt: Date.UTC(2020, 0, 1) },
    });
    expect(identityCompleteness(expired, NOW).missing).toContain(
      'compliance.identity.document_expired',
    );
  });
});

describe('сверка собственника ведётся по номеру документа', () => {
  const identicalName = compareNames(
    [latinName('Sabo', 'Tikato')],
    [latinName('Sabo', 'Tikato')],
    strong,
  );
  const differentName = compareNames(
    [latinName('Sabo', 'Tikato')],
    [latinName('Nuvo', 'Zerlan')],
    strong,
  );

  it('совпадение номера устанавливает собственника', () => {
    expect(reconcileOwner('matched', differentName).outcome).toBe('established');
  });

  it('расхождение номера опровергает, даже при точном совпадении имени', () => {
    expect(reconcileOwner('mismatched', identicalName).outcome).toBe('refuted');
  });

  it('отсутствие номера — «оснований нет», даже при точном совпадении имени', () => {
    const result = reconcileOwner('absent', identicalName);
    expect(result.outcome).toBe('insufficient');
    expect(result.reasons).toContain('compliance.owner.document_number_missing');
    expect(result.reasons).toContain('compliance.owner.name_secondary_signal_only');
  });
});

describe('код страны валидируется', () => {
  it('двухбуквенный верхний регистр', () => {
    expect(countryCode('GE')).toBe('GE');
    expect(() => countryCode('ge')).toThrow('compliance.country_code.invalid');
    expect(() => countryCode('GEO')).toThrow('compliance.country_code.invalid');
  });

  it('отпечаток обязан быть 64 знаками шестнадцатеричного хеша', () => {
    expect(documentNumberFingerprint(fp(1))).toHaveLength(64);
    expect(() => documentNumberFingerprint('AB1234567')).toThrow('compliance.fingerprint.invalid');
  });

  it('сырое значение не попадает в детали ошибки отпечатка', () => {
    try {
      documentNumberFingerprint('AB1234567');
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('AB1234567');
    }
  });
});
