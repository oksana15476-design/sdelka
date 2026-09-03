import { describe, expect, it } from 'vitest';
import {
  AuditError,
  AuditErrorCode,
  assertNoRawIdentifiers,
  auditAmount,
  auditFingerprint,
  auditRef,
  auditToken,
  fingerprintLabel,
} from '../src/index';
import { fp } from './support/fixtures';

describe('персональные данные не попадают в журнал', () => {
  it('строка, похожая на IBAN, в тело записи не проходит', () => {
    expect(() => assertNoRawIdentifiers({ beneficiary: 'GE29NB0000000101904917' })).toThrow(
      AuditError,
    );
  });

  it('номер документа длиной от девяти цифр не проходит', () => {
    try {
      assertNoRawIdentifiers({ document: '01019049170' });
      expect.unreachable();
    } catch (error) {
      expect((error as AuditError).code).toBe(AuditErrorCode.rawIdentifier);
      // В деталях путь и правило — но не само значение.
      expect(JSON.stringify((error as AuditError).details)).not.toContain('01019049170');
    }
  });

  it('телефон не проходит', () => {
    expect(() => assertNoRawIdentifiers({ phone: '+995322000000' })).toThrow(AuditError);
  });

  it('свободный текст и адрес почты не проходят: в журнале только ключи', () => {
    expect(() => assertNoRawIdentifiers({ note: 'Иван Петров, паспорт' })).toThrow(AuditError);
    expect(() => assertNoRawIdentifiers({ actorId: 'ivan@example.com' })).toThrow(AuditError);
  });

  it('отпечаток того же значения проходит', () => {
    const value = { document: auditFingerprint('document_number', fp(7)) };
    expect(() => assertNoRawIdentifiers(value)).not.toThrow();
  });

  it('отпечаток из одних цифр не путается с номером документа', () => {
    // fp(7) — это 63 нуля и семёрка: под правило «девять цифр подряд» он
    // подпадает по форме, но отпечатком быть не перестаёт.
    expect(() => assertNoRawIdentifiers({ digest: fp(7) })).not.toThrow();
    expect(() => assertNoRawIdentifiers({ anything: fp(7) })).not.toThrow();
  });

  it('непрозрачные поля поставщика не разбираются', () => {
    expect(() => assertNoRawIdentifiers({ token: 'MIIB+GE29NB0000000101904917==' })).not.toThrow();
    expect(() => assertNoRawIdentifiers({ proof: 'AB12CDEFGHIJKLMNOPQR' })).not.toThrow();
  });

  it('проверка идёт вглубь массивов и вложенных объектов', () => {
    expect(() =>
      assertNoRawIdentifiers({ items: [{ inner: { phone: '+995322000000' } }] }),
    ).toThrow(AuditError);
  });

  it('метка отпечатка короче отпечатка и не восстанавливает его', () => {
    const value = auditFingerprint('account', fp(0x0a));
    expect(fingerprintLabel(value)).toHaveLength(8);
    expect(value.digest.startsWith(fingerprintLabel(value))).toBe(true);
  });
});

describe('значения журнала', () => {
  it('идентификатор — технический ключ, не текст', () => {
    expect(auditToken('deal-1')).toBe('deal-1');
    expect(() => auditToken('сделка номер один')).toThrow(AuditError);
    expect(() => auditToken('')).toThrow(AuditError);
  });

  it('ссылка на сущность заморожена и сравнивается по области и ключу', () => {
    const ref = auditRef('payout', 'payout-1');
    expect(Object.isFrozen(ref)).toBe(true);
    expect(ref).toEqual({ kind: 'ref', scope: 'payout', id: 'payout-1' });
  });

  it('сумма — целые минорные единицы, валюта трёхбуквенная', () => {
    const amount = auditAmount('GEL', 125_000n);
    expect(amount.minor).toBe(125_000n);
    expect(() => auditAmount('gel', 1n)).toThrow(AuditError);
    expect(() => auditAmount('LARI', 1n)).toThrow(AuditError);
  });
});
