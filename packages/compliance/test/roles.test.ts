import { type Instant, instant } from '@sdelka/domain';
import { describe, expect, it } from 'vitest';
import {
  ANALYST_ROLE,
  APPROVER_ROLE,
  actor,
  authorize,
  CLIENT_ROLE,
  grantImpersonation,
  isImpersonationValid,
  MAX_IMPERSONATION_TTL_MS,
  OPERATOR_ROLE,
  REPRESENTATIVE_ROLE,
  supportPartyView,
  SUPPORT_ROLE,
} from '../src/index';
import { NOW, POLICY, WITH_PERSONAL_NUMBER, profile } from './support/fixtures';

const support = actor('support-1', SUPPORT_ROLE);
const representative = actor('rep-1', REPRESENTATIVE_ROLE);

describe('поддержка ограничена типами', () => {
  it('read-only по умолчанию: перечень полномочий закрыт', () => {
    expect([...SUPPORT_ROLE.capabilities]).toEqual(['read_deal', 'read_party', 'act_on_behalf']);
  });

  it('не видит реквизиты выплаты', () => {
    // @ts-expect-error у роли поддержки нет полномочия read_beneficiary
    expect(() => authorize(support, 'read_beneficiary')).toThrow();
  });

  it('не меняет реквизиты выплаты', () => {
    // @ts-expect-error у роли поддержки нет полномочия write_beneficiary
    expect(() => authorize(support, 'write_beneficiary')).toThrow();
  });

  it('не утверждает выплаты', () => {
    // @ts-expect-error у роли поддержки нет полномочия approve_payout
    expect(() => authorize(support, 'approve_payout')).toThrow();
  });

  it('не снимает блокировки', () => {
    // @ts-expect-error у роли поддержки нет полномочия lift_block
    expect(() => authorize(support, 'lift_block')).toThrow();
  });

  it('видит сделку и сторону', () => {
    expect(authorize(support, 'read_deal').capability).toBe('read_deal');
    expect(authorize(support, 'read_party').capability).toBe('read_party');
  });
});

describe('представитель по доверенности', () => {
  it('не меняет реквизиты', () => {
    // @ts-expect-error представитель не имеет полномочия write_beneficiary
    expect(() => authorize(representative, 'write_beneficiary')).toThrow();
  });

  it('не подтверждает код тестового перевода', () => {
    // @ts-expect-error представитель не имеет полномочия confirm_test_transfer_code
    expect(() => authorize(representative, 'confirm_test_transfer_code')).toThrow();
  });

  it('клиент оба полномочия имеет', () => {
    const client = actor('client-1', CLIENT_ROLE);
    expect(authorize(client, 'write_beneficiary').capability).toBe('write_beneficiary');
    expect(authorize(client, 'confirm_test_transfer_code').capability).toBe(
      'confirm_test_transfer_code',
    );
  });
});

describe('разделение утверждающих и разбирающих', () => {
  it('утверждающий не запускает скрининг', () => {
    const approver = actor('approver-1', APPROVER_ROLE);
    // @ts-expect-error утверждающий не имеет полномочия run_screening
    expect(() => authorize(approver, 'run_screening')).toThrow();
  });

  it('аналитик не утверждает выплаты', () => {
    const analyst = actor('analyst-1', ANALYST_ROLE);
    // @ts-expect-error аналитик не имеет полномочия approve_payout
    expect(() => authorize(analyst, 'approve_payout')).toThrow();
  });

  it('оператор не утверждает изменение реквизитов, которое сам готовит', () => {
    const operator = actor('operator-1', OPERATOR_ROLE);
    // @ts-expect-error оператор не имеет полномочия approve_beneficiary_change
    expect(() => authorize(operator, 'approve_beneficiary_change')).toThrow();
  });
});

describe('маскирование профиля для поддержки', () => {
  it('в проекции нет ни отпечатка документа, ни личного номера, ни имён', () => {
    const view = supportPartyView(
      profile({ georgianPersonalNumber: WITH_PERSONAL_NUMBER }),
      authorize(support, 'read_party'),
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(WITH_PERSONAL_NUMBER);
    expect(serialized).not.toContain(profile().document.numberFingerprint);
    expect(serialized).not.toContain('Tikato');
    expect(view.names[0]?.familyInitial).toBe('T');
    expect(view.names[0]?.familyLength).toBe(6);
  });
});

describe('работа от имени клиента', () => {
  const authority = authorize(support, 'act_on_behalf');

  it('без согласия сессия не выдаётся', () => {
    const result = grantImpersonation(
      authority,
      { grantId: 'g1', partyId: 'party-1', consentRef: null, ttlMs: 60_000 },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('compliance.role.impersonation_consent_missing');
  });

  it('срок ограничен сверху и виден в записи', () => {
    const result = grantImpersonation(
      authority,
      { grantId: 'g1', partyId: 'party-1', consentRef: 'consent-1', ttlMs: 24 * 60 * 60 * 1000 },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expiresAt).toBe(NOW + MAX_IMPERSONATION_TTL_MS);
    expect(result.value.actorId).toBe('support-1');
    expect(result.value.consentRef).toBe('consent-1');
  });

  it('истёкшая сессия недействительна', () => {
    const result = grantImpersonation(
      authority,
      { grantId: 'g1', partyId: 'party-1', consentRef: 'consent-1', ttlMs: 1_000 },
      NOW,
    );
    if (!result.ok) throw new Error('ожидалась выдача');
    expect(isImpersonationValid(result.value, NOW)).toBe(true);
    expect(isImpersonationValid(result.value, instant(NOW + 2_000) as Instant)).toBe(false);
  });
});

describe('версия политики единственная и валидная', () => {
  it('идентификатор версии соответствует формату', () => {
    expect(POLICY.version).toMatch(/^compliance\/\d{4}-\d{2}-\d{2}\.\d+$/u);
  });
});
