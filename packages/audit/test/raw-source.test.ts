import { describe, expect, it } from 'vitest';
import { AuditError, rawSourceDigest, rawSourceRef, verifyRawSource } from '../src/index';
import { at } from './support/fixtures';

const BYTES = new TextEncoder().encode('{"registered":true,"cadastral":"aa-bb"}');

function refFor(bytes: Uint8Array) {
  return rawSourceRef({
    sourceKind: 'registry_extract',
    storageRef: 'documents/2026/09/03/0001',
    mediaType: 'application/json',
    byteLength: bytes.length,
    digest: rawSourceDigest(bytes),
    receivedAt: at(1),
    provider: 'registry',
  });
}

describe('сырой ответ источника', () => {
  it('сходится сам с собой', () => {
    expect(verifyRawSource(BYTES, refFor(BYTES))).toBe(true);
  });

  it('изменённый на один байт ответ перестаёт сходиться с записью', () => {
    const ref = refFor(BYTES);
    const tampered = Uint8Array.from(BYTES);
    const first = tampered[0];
    if (first === undefined) {
      expect.unreachable();
      return;
    }
    tampered[0] = first ^ 0x01;
    expect(verifyRawSource(tampered, ref)).toBe(false);
  });

  it('ответ другой длины не сходится, даже если начало совпадает', () => {
    const ref = refFor(BYTES);
    expect(verifyRawSource(BYTES.slice(0, BYTES.length - 1), ref)).toBe(false);
  });

  it('сами байты в ссылку не попадают: в записи только отпечаток и адрес', () => {
    const ref = refFor(BYTES);
    const serialized = JSON.stringify(ref);
    expect(serialized).not.toContain('cadastral');
    expect(serialized).toContain(ref.digest);
  });

  it('отрицательная длина отвергается', () => {
    expect(() =>
      rawSourceRef({
        sourceKind: 'contract',
        storageRef: 'documents/x',
        mediaType: 'application/pdf',
        byteLength: -1,
        digest: rawSourceDigest(BYTES),
        receivedAt: at(1),
        provider: 'cabinet',
      }),
    ).toThrow(AuditError);
  });
});
