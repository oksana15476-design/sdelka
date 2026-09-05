import { describe, expect, it } from 'vitest';
import {
  AuditErrorCode,
  assertNoRawIdentifiers,
  auditAmount,
  auditFingerprint,
  auditRef,
  auditToken,
  fingerprintLabel,
} from '../src/index';
import { expectAuditError, fp } from './support/fixtures';

describe('персональные данные не попадают в журнал', () => {
  it('строка, похожая на IBAN, в тело записи не проходит', () => {
    const error = expectAuditError(
      () => assertNoRawIdentifiers({ beneficiary: 'GE29NB0000000101904917' }),
      AuditErrorCode.rawIdentifier,
    );
    expect(error.details['rule']).toBe('iban');
  });

  it('номер документа длиной от девяти цифр не проходит', () => {
    const error = expectAuditError(
      () => assertNoRawIdentifiers({ document: '01019049170' }),
      AuditErrorCode.rawIdentifier,
    );
    expect(error.details['rule']).toBe('digit_run');
    // В деталях путь и правило — но не само значение.
    expect(JSON.stringify(error.details)).not.toContain('01019049170');
  });

  it('телефон не проходит', () => {
    // Со знаком «плюс» в начале строка не проходит уже по форме ключа: это
    // другая проверка и другой код. Правило про телефон ловит номер **внутри**
    // строки, которая по форме ключом быть могла бы, — и утверждается именно
    // оно, иначе снятие правила осталось бы незамеченным.
    expectAuditError(
      () => assertNoRawIdentifiers({ phone: '+995322000000' }),
      AuditErrorCode.tokenInvalid,
    );
    const error = expectAuditError(
      () => assertNoRawIdentifiers({ contact: 'call+99532200' }),
      AuditErrorCode.rawIdentifier,
    );
    expect(error.details['rule']).toBe('phone');
  });

  it('свободный текст и адрес почты не проходят: в журнале только ключи', () => {
    expectAuditError(
      () => assertNoRawIdentifiers({ note: 'Иван Петров, паспорт' }),
      AuditErrorCode.tokenInvalid,
    );
    expectAuditError(
      () => assertNoRawIdentifiers({ actorId: 'ivan@example.com' }),
      AuditErrorCode.tokenInvalid,
    );
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
    const error = expectAuditError(
      () => assertNoRawIdentifiers({ items: [{ inner: { document: '01019049170' } }] }),
      AuditErrorCode.rawIdentifier,
    );
    // Путь ведёт к вложенному полю, а не к корню: иначе по отчёту не найти, где
    // именно сырое значение попало в тело записи.
    expect(error.details['path']).toBe('$.items[0].inner.document');
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
    expectAuditError(() => auditToken('сделка номер один'), AuditErrorCode.tokenInvalid);
    expectAuditError(() => auditToken(''), AuditErrorCode.tokenInvalid);
  });

  it('ссылка на сущность заморожена и сравнивается по области и ключу', () => {
    const ref = auditRef('payout', 'payout-1');
    expect(Object.isFrozen(ref)).toBe(true);
    expect(ref).toEqual({ kind: 'ref', scope: 'payout', id: 'payout-1' });
  });

  it('сумма — целые минорные единицы, валюта трёхбуквенная', () => {
    const amount = auditAmount('GEL', 125_000n);
    expect(amount.minor).toBe(125_000n);
    expectAuditError(() => auditAmount('gel', 1n), AuditErrorCode.currencyInvalid);
    expectAuditError(() => auditAmount('LARI', 1n), AuditErrorCode.currencyInvalid);
  });
});
