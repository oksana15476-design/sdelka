import { describe, expect, it } from 'vitest';
import { AuditError, AuditErrorCode, canonical, canonicalDigest } from '../src/index';

describe('каноническая форма', () => {
  it('перестановка ключей не меняет хеш', () => {
    expect(canonicalDigest({ a: 1, b: 'x', c: [1, 2] })).toBe(
      canonicalDigest({ c: [1, 2], b: 'x', a: 1 }),
    );
  });

  it('вложенные объекты тоже приводятся к порядку', () => {
    expect(canonicalDigest({ outer: { z: 1, a: 2 } })).toBe(
      canonicalDigest({ outer: { a: 2, z: 1 } }),
    );
  });

  it('1n, 1 и "1" дают разные хеши', () => {
    const asBigint = canonicalDigest({ amount: 1n });
    const asNumber = canonicalDigest({ amount: 1 });
    const asString = canonicalDigest({ amount: '1' });
    expect(new Set([asBigint, asNumber, asString]).size).toBe(3);
  });

  it('true и "true" различимы', () => {
    expect(canonicalDigest(true)).not.toBe(canonicalDigest('true'));
  });

  it('null и отсутствие поля различимы', () => {
    expect(canonicalDigest({ a: null })).not.toBe(canonicalDigest({}));
  });

  it('строки с длиной: склейка соседних полей не даёт коллизии', () => {
    expect(canonicalDigest({ a: 'x', b: 'yz' })).not.toBe(canonicalDigest({ a: 'xy', b: 'z' }));
  });

  it('нецелое число отвергается — сумма в плавающей точке запрещена', () => {
    expect(() => canonical({ amount: 12.5 })).toThrow(AuditError);
    try {
      canonical({ amount: 12.5 });
    } catch (error) {
      expect((error as AuditError).code).toBe(AuditErrorCode.canonicalNonIntegerNumber);
      expect((error as AuditError).details['path']).toBe('$.amount');
    }
  });

  it('NaN и Infinity отвергаются', () => {
    expect(() => canonical(Number.NaN)).toThrow(AuditError);
    expect(() => canonical(Number.POSITIVE_INFINITY)).toThrow(AuditError);
  });

  it('undefined в поле отвергается: после базы оно неотличимо от отсутствия', () => {
    expect(() => canonical({ a: undefined })).toThrow(AuditError);
  });

  it('функция, дата и Map отвергаются', () => {
    expect(() => canonical({ f: () => 1 })).toThrow(AuditError);
    expect(() => canonical({ d: new Date(0) })).toThrow(AuditError);
    expect(() => canonical({ m: new Map() })).toThrow(AuditError);
  });

  it('цикл отвергается, а не зацикливается', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonical(cyclic)).toThrow(AuditError);
  });

  it('повтор одного и того же объекта в разных ветвях циклом не считается', () => {
    const shared = { a: 1 };
    expect(() => canonical({ left: shared, right: shared })).not.toThrow();
  });

  it('слишком глубокая вложенность отвергается', () => {
    let deep: unknown = 1;
    for (let index = 0; index < 40; index += 1) {
      deep = { deep };
    }
    expect(() => canonical(deep)).toThrow(AuditError);
  });
});
