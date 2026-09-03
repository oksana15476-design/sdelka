import { describe, expect, it } from 'vitest';
import {
  assessPayer,
  assessRefundDestination,
  compareNames,
  fingerprintLabel,
  logSafeDecision,
  logSafeNameMatch,
  nameDigest,
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
} from './support/fixtures';

const strong = { strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp };

describe('персональные данные не попадают в решение', () => {
  it('решение детектора плательщика не содержит ни имени, ни отпечатка документа', () => {
    const result = assessPayer(
      {
        buyerDocument: BUYER_DOCUMENT,
        payerDocument: OTHER_DOCUMENT,
        relationship: { kind: 'unrelated_third_party' },
        senderNameMatch: compareNames(BUYER_NAMES, OTHER_NAMES, strong),
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
});
