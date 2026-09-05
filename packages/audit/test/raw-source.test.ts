import { describe, expect, it } from 'vitest';
import {
  AuditErrorCode,
  type CapturedRawSource,
  attestRawSource,
  captureRawSource,
  rawSourceDigest,
  rawSourceRef,
  verifyRawSource,
} from '../src/index';
import { at, expectAuditError } from './support/fixtures';

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
    expectAuditError(
      () =>
        rawSourceRef({
          sourceKind: 'contract',
          storageRef: 'documents/x',
          mediaType: 'application/pdf',
          byteLength: -1,
          digest: rawSourceDigest(BYTES),
          receivedAt: at(1),
          provider: 'cabinet',
        }),
      AuditErrorCode.rawSourceByteLengthInvalid,
    );
  });
});

describe('засвидетельствованный отпечаток', () => {
  function captured(bytes: Uint8Array): CapturedRawSource {
    return captureRawSource({
      sourceKind: 'registry_extract',
      storageRef: 'documents/2026/09/03/0001',
      mediaType: 'application/json',
      receivedAt: at(1),
      provider: 'registry',
      bytes,
    });
  }

  it('длина и отпечаток выводятся из байтов, а не принимаются полями', () => {
    const ref = captured(BYTES);
    expect(ref.byteLength).toBe(BYTES.length);
    expect(ref.digest).toBe(rawSourceDigest(BYTES));
    expect(verifyRawSource(BYTES, ref)).toBe(true);
  });

  it('байты в ссылку по-прежнему не попадают', () => {
    expect(JSON.stringify(captured(BYTES))).not.toContain('cadastral');
  });

  it('записанная ссылка сводится с теми же байтами', () => {
    const ref = refFor(BYTES);
    expect(attestRawSource(BYTES, ref).digest).toBe(ref.digest);
  });

  it('подменённый байт: отказ исключением, а не false', () => {
    const ref = refFor(BYTES);
    const tampered = Uint8Array.from(BYTES);
    const first = tampered[0];
    if (first === undefined) {
      expect.unreachable();
      return;
    }
    tampered[0] = first ^ 0x01;
    const error = expectAuditError(
      () => attestRawSource(tampered, ref),
      AuditErrorCode.rawSourceNotAttested,
    );
    // Подмена содержимого и подобранная коллизия различимы в отчёте.
    expect(error.details['reason']).toBe('digest');
  });

  it('другая длина названа своей причиной', () => {
    const ref = refFor(BYTES);
    const error = expectAuditError(
      () => attestRawSource(BYTES.slice(0, BYTES.length - 1), ref),
      AuditErrorCode.rawSourceNotAttested,
    );
    expect(error.details['reason']).toBe('byte_length');
  });

  it('в деталях отказа нет ни байтов, ни отпечатка', () => {
    // Значение в детали не кладём никогда: сработавшая проверка — это ровно тот
    // момент, когда в деталях оказался бы чужой документ.
    const error = expectAuditError(
      () => attestRawSource(new TextEncoder().encode('other'), refFor(BYTES)),
      AuditErrorCode.rawSourceNotAttested,
    );
    expect(Object.keys(error.details)).toEqual(['reason']);
  });

  it('ссылка, принятая на слово, засвидетельствованной не считается — проверка типом', () => {
    const claimed = refFor(BYTES);
    // Значение то же самое, но `AttestedDigest` получить иначе, чем предъявив
    // байты, нельзя. Проверка компилятором, а не рантаймом: пропустить её
    // можно только приведением типа, и оно будет видно в ревью.
    // @ts-expect-error ссылка без предъявленных байтов не является CapturedRawSource
    const forged: CapturedRawSource = claimed;
    expect(forged.digest).toBe(claimed.digest);
  });
});
