import { describe, expect, it } from 'vitest';
import { type AuditChain, recordDigest, verifyChain } from '../src/index';
import { dossierChain, dropRecord, duplicateRecord, newChain, replaceRecord } from './support/fixtures';

/** Разбор ответа проверки: без него `firstBreak` не виден системе типов. */
function breakOf(result: ReturnType<typeof verifyChain>) {
  if (result.intact) {
    expect.unreachable();
    throw new Error('unreachable');
  }
  return result;
}

const TAMPERED_BODY = {
  kind: 'evidence_attached' as const,
  evidence: {
    kind: 'raw_source' as const,
    sourceKind: 'operator_note' as const,
    storageRef: 'documents/2026/09/03/9999',
    mediaType: 'application/json',
    byteLength: 1,
    digest: '0'.repeat(64),
    receivedAt: 0,
    provider: 'nobody',
  },
};

describe('целостность цепочки', () => {
  it('нетронутая цепочка целостна и отдаёт головной хеш', () => {
    const chain = dossierChain();
    const result = verifyChain(chain);
    expect(result.intact).toBe(true);
    expect(result.head).toBe(chain.records[chain.records.length - 1]?.recordHash);
  });

  it('подмена тела записи k: разрыв ровно на k, и он один', () => {
    const chain = dossierChain();
    const forged = replaceRecord(chain, 3, (record) =>
      Object.freeze({ ...record, body: TAMPERED_BODY as typeof record.body }),
    );
    const result = breakOf(verifyChain(forged));
    expect(result.firstBreak.index).toBe(3);
    expect(result.firstBreak.kind).toBe('hash_mismatch');
    expect(result.breakCount).toBe(1);
  });

  it('подмена с пересчётом хеша записи k рвёт связь у k+1', () => {
    // Так выглядит попытка «починить» подделку: хеш записи сходится сам с собой,
    // но следующая запись всё ещё ссылается на прежний.
    const chain = dossierChain();
    const forged = replaceRecord(chain, 3, (record) => {
      const envelope = { ...record, body: TAMPERED_BODY as typeof record.body };
      return Object.freeze({ ...envelope, recordHash: recordDigest(envelope) });
    });
    const result = breakOf(verifyChain(forged));
    expect(result.firstBreak.index).toBe(4);
    expect(result.firstBreak.kind).toBe('prev_hash_mismatch');
    expect(result.breakCount).toBe(1);
  });

  it('удаление записи k видно на её месте разом по номеру и по хешу', () => {
    const chain = dossierChain();
    const result = breakOf(verifyChain(dropRecord(chain, 3)));
    expect(result.firstBreak.index).toBe(3);
    expect(result.breaks.map((item) => item.kind)).toContain('seq_gap');
    expect(result.breaks.map((item) => item.kind)).toContain('prev_hash_mismatch');
  });

  it('вставка записи видна как повтор номера', () => {
    const chain = dossierChain();
    const result = breakOf(verifyChain(duplicateRecord(chain, 3)));
    expect(result.firstBreak.index).toBe(4);
    expect(result.breaks.map((item) => item.kind)).toContain('seq_duplicate');
  });

  it('переписанный хвост отличим от одиночной подмены числом разрывов', () => {
    const chain = dossierChain();
    let forged: AuditChain = chain;
    for (let index = 4; index < chain.records.length; index += 1) {
      forged = replaceRecord(forged, index, (record) =>
        Object.freeze({ ...record, body: TAMPERED_BODY as typeof record.body }),
      );
    }
    const result = breakOf(verifyChain(forged));
    expect(result.firstBreak.index).toBe(4);
    expect(result.breakCount).toBe(chain.records.length - 4);
  });

  it('пустая цепочка не целостна: она неотличима от цепочки с отрезанным началом', () => {
    const result = breakOf(verifyChain({ chainId: 'chain:x', records: [] }));
    expect(result.firstBreak.kind).toBe('genesis_missing');
    expect(result.head).toBeNull();
  });

  it('цепочка без открывающей записи распознаётся как обезглавленная', () => {
    const chain = dossierChain();
    const result = breakOf(verifyChain(dropRecord(chain, 0)));
    expect(result.breaks.map((item) => item.kind)).toContain('genesis_missing');
  });

  it('перенос записи из чужой цепочки виден по chainId', () => {
    const chain = newChain();
    const other = newChain('chain:deal-2');
    const alien = other.records[0];
    if (alien === undefined) {
      expect.unreachable();
      return;
    }
    const forged: AuditChain = { chainId: chain.chainId, records: [...chain.records, alien] };
    const result = breakOf(verifyChain(forged));
    expect(result.breaks.map((item) => item.kind)).toContain('chain_id_mismatch');
  });

  it('время, поехавшее назад в уже сохранённой цепочке, распознаётся отдельно', () => {
    const chain = dossierChain();
    const forged = replaceRecord(chain, 5, (record) => {
      const envelope = { ...record, recordedAt: 0 as typeof record.recordedAt };
      return Object.freeze({ ...envelope, recordHash: recordDigest(envelope) });
    });
    const result = breakOf(verifyChain(forged));
    expect(result.breaks.map((item) => item.kind)).toContain('time_regression');
  });
});
