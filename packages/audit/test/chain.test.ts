import { describe, expect, it } from 'vitest';
import * as audit from '../src/index';
import { AuditError, AuditErrorCode, ZERO_HASH, appendRecord, verifyChain } from '../src/index';
import {
  ANALYST,
  CLIENT,
  COMPLIANCE_POLICY,
  FOREIGN_HASH,
  OPERATOR,
  SYSTEM,
  TRANCHE,
  at,
  dossierChain,
  newChain,
  source,
} from './support/fixtures';

function decision(recordId: string, minutes: number) {
  return {
    recordId,
    recordedAt: at(minutes),
    actor: ANALYST,
    subject: TRANCHE,
    body: {
      kind: 'decision_made' as const,
      outcomeKey: 'clear',
      policy: COMPLIANCE_POLICY,
      reasonKeys: [],
      evidence: [source(1)] as const,
    },
  };
}

describe('append-only', () => {
  it('добавление возвращает новую цепочку и не трогает старую', () => {
    const before = newChain();
    const after = appendRecord(before, decision('rec-1', 1));
    expect(before.records).toHaveLength(1);
    expect(after.records).toHaveLength(2);
    expect(after).not.toBe(before);
  });

  it('цепочка, массив записей и сама запись заморожены', () => {
    const chain = appendRecord(newChain(), decision('rec-1', 1));
    const record = chain.records[1];
    expect(Object.isFrozen(chain)).toBe(true);
    expect(Object.isFrozen(chain.records)).toBe(true);
    expect(record !== undefined && Object.isFrozen(record)).toBe(true);
    expect(record !== undefined && Object.isFrozen(record.body)).toBe(true);
  });

  it('в экспортах пакета нет ни одной операции над существующей записью', () => {
    // Перебором, а не на глаз: имя, начинающееся с update/set/mutate/delete/
    // remove/patch/edit, в append-only журнале означает ошибку проектирования.
    const forbidden = /^(update|set|mutate|delete|remove|patch|edit|revoke|rewrite)/u;
    const offenders = Object.keys(audit).filter((name) => forbidden.test(name));
    expect(offenders).toEqual([]);
  });

  it('генезис несёт нулевой предыдущий хеш и открывает цепочку', () => {
    const chain = newChain();
    const genesis = chain.records[0];
    expect(genesis?.seq).toBe(0);
    expect(genesis?.prevHash).toBe(ZERO_HASH);
    expect(genesis?.body.kind).toBe('chain_opened');
    expect(verifyChain(chain).intact).toBe(true);
  });

  it('каждая следующая запись несёт хеш предыдущей', () => {
    const chain = dossierChain();
    for (let index = 1; index < chain.records.length; index += 1) {
      expect(chain.records[index]?.prevHash).toBe(chain.records[index - 1]?.recordHash);
    }
  });
});

describe('что цепочка отвергает при построении', () => {
  it('запись задним числом — не принимается вовсе, а не только замечается потом', () => {
    const chain = appendRecord(newChain(), decision('rec-1', 5));
    expect(() => appendRecord(chain, decision('rec-2', 4))).toThrow(AuditError);
    try {
      appendRecord(chain, decision('rec-2', 4));
    } catch (error) {
      expect((error as AuditError).code).toBe(AuditErrorCode.recordTimeRegression);
    }
  });

  it('одинаковое время допустимо: две записи в одну миллисекунду — норма', () => {
    const chain = appendRecord(newChain(), decision('rec-1', 5));
    expect(() => appendRecord(chain, decision('rec-2', 5))).not.toThrow();
  });

  it('повтор идентификатора записи отвергается', () => {
    const chain = appendRecord(newChain(), decision('rec-1', 1));
    expect(() => appendRecord(chain, decision('rec-1', 2))).toThrow(AuditError);
  });

  it('исправление несуществующей записи отвергается', () => {
    const chain = newChain();
    expect(() =>
      appendRecord(chain, {
        recordId: 'rec-fix',
        recordedAt: at(1),
        actor: OPERATOR,
        subject: TRANCHE,
        body: {
          kind: 'correction',
          correctsRecordId: 'rec-missing',
          reasonKey: 'x.y',
          basis: source(9, 'operator_note', 'sdelka.console'),
          attributes: {},
        },
      }),
    ).toThrow(AuditError);
  });

  it('исправление самого себя отвергается', () => {
    const chain = newChain();
    expect(() =>
      appendRecord(chain, {
        recordId: 'rec-fix',
        recordedAt: at(1),
        actor: OPERATOR,
        subject: TRANCHE,
        body: {
          kind: 'correction',
          correctsRecordId: 'rec-fix',
          reasonKey: 'x.y',
          basis: source(9, 'operator_note', 'sdelka.console'),
          attributes: {},
        },
      }),
    ).toThrow(AuditError);
  });

  it('метка времени, покрывающая чужой хеш, отвергается', () => {
    const chain = appendRecord(newChain(), decision('rec-1', 1));
    expect(() =>
      appendRecord(chain, {
        recordId: 'rec-stamp',
        recordedAt: at(2),
        actor: SYSTEM,
        subject: TRANCHE,
        body: {
          kind: 'timestamp_token',
          coversRecordId: 'rec-1',
          coveredHash: FOREIGN_HASH,
          timestamp: {
            provider: 'tsa-independent',
            issuedAt: at(2),
            digest: FOREIGN_HASH,
            token: 'opaque==',
          },
        },
      }),
    ).toThrow(AuditError);
  });

  it('сырой идентификатор в теле записи не проходит', () => {
    const chain = newChain();
    expect(() =>
      appendRecord(chain, {
        recordId: 'rec-view',
        recordedAt: at(1),
        actor: CLIENT,
        subject: TRANCHE,
        body: {
          kind: 'personal_data_viewed',
          purposeKey: 'support.request',
          fields: ['GE29NB0000000101904917'],
        },
      }),
    ).toThrow(AuditError);
  });

  it('в цепочку без генезиса добавить нечего', () => {
    expect(() => appendRecord({ chainId: 'chain:x', records: [] }, decision('rec-1', 1))).toThrow(
      AuditError,
    );
  });
});
