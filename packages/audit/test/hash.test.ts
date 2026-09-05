import { describe, expect, it } from 'vitest';
import {
  AuditErrorCode,
  HASH_DOMAIN,
  ZERO_HASH,
  auditInstant,
  canonicalDigest,
  digestOfBytes,
  digestOfParts,
  sha256Hex,
} from '../src/index';
import { expectAuditError } from './support/fixtures';

describe('хеш', () => {
  it('отпечаток байтов совпадает с известным вектором SHA-256', () => {
    // Пустой вход. Третья сторона обязана уметь пересчитать это `sha256sum`,
    // поэтому доменного префикса в отпечатке байтов нет.
    expect(digestOfBytes(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(digestOfBytes(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('доменный префикс меняет хеш: чужой хеш нельзя выдать за хеш записи', () => {
    expect(digestOfParts(['x'])).not.toBe(digestOfParts(['x'], 'sdelka/other/v1'));
    expect(digestOfParts(['x'])).toBe(digestOfParts(['x'], HASH_DOMAIN));
  });

  it('длина части входит в хеш: склейка частей не даёт коллизии', () => {
    expect(digestOfParts(['ab', 'c'])).not.toBe(digestOfParts(['a', 'bc']));
  });

  it('нулевой хеш — 64 нуля и он валиден по форме', () => {
    expect(ZERO_HASH).toHaveLength(64);
    expect(sha256Hex(ZERO_HASH)).toBe(ZERO_HASH);
  });

  it('строка не той формы отвергается', () => {
    // Верхний регистр отвергается наравне с мусором: два написания одного хеша
    // дали бы две разные строки под один и тот же смысл, и сравнение цепочек
    // стало бы зависеть от того, кто их записал.
    expectAuditError(() => sha256Hex('ZZ'), AuditErrorCode.hashInvalid);
    expectAuditError(() => sha256Hex('A'.repeat(64)), AuditErrorCode.hashInvalid);
  });

  it('время в журнале целое и неотрицательное', () => {
    expect(auditInstant(0)).toBe(0);
    expectAuditError(() => auditInstant(1.5), AuditErrorCode.instantInvalid);
    expectAuditError(() => auditInstant(-1), AuditErrorCode.instantInvalid);
  });

  it('хеш значения зависит от значения', () => {
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
  });
});
