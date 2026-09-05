import { describe, expect, it } from 'vitest';
import * as audit from '../src/index';
import { AuditErrorCode, ZERO_HASH, appendRecord, verifyChain } from '../src/index';
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
  expectAuditError,
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
    expectAuditError(
      () => appendRecord(chain, decision('rec-2', 4)),
      AuditErrorCode.recordTimeRegression,
    );
  });

  it('одинаковое время допустимо: две записи в одну миллисекунду — норма', () => {
    const chain = appendRecord(newChain(), decision('rec-1', 5));
    expect(() => appendRecord(chain, decision('rec-2', 5))).not.toThrow();
  });

  it('повтор идентификатора записи отвергается', () => {
    const chain = appendRecord(newChain(), decision('rec-1', 1));
    expectAuditError(
      () => appendRecord(chain, decision('rec-1', 2)),
      AuditErrorCode.recordIdDuplicate,
    );
  });

  it('исправление несуществующей записи отвергается', () => {
    const chain = newChain();
    expectAuditError(
      () =>
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
      AuditErrorCode.correctionTargetMissing,
    );
  });

  it('исправление самого себя названо самоссылкой, а не пропавшей целью', () => {
    // Две проверки подряд ловят один и тот же вход: самоссылку и отсутствие
    // цели. Цели с таким идентификатором в цепочке заведомо нет — предыдущая
    // проверка уже отвергла бы повтор, — поэтому снятие проверки самоссылки
    // роняет вызов на следующей строке, с другим кодом. Разница между
    // «исправление ссылается на себя» и «исправляемой записи нет» — это разница
    // между ошибкой вызывающего и разрывом досье, и дежурный обязан видеть
    // именно свою.
    const chain = newChain();
    expectAuditError(
      () =>
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
      AuditErrorCode.correctionSelfReference,
    );
  });

  it('исправление, ссылающееся на запись из другой цепочки, отвергается как пропавшая цель', () => {
    // Соседний вход к предыдущему: идентификатор не свой, но и не найден.
    // Держит границу между двумя кодами с другой стороны.
    const chain = appendRecord(newChain(), decision('rec-1', 1));
    expectAuditError(
      () =>
        appendRecord(chain, {
          recordId: 'rec-fix',
          recordedAt: at(2),
          actor: OPERATOR,
          subject: TRANCHE,
          body: {
            kind: 'correction',
            correctsRecordId: 'rec-1-of-another-chain',
            reasonKey: 'x.y',
            basis: source(9, 'operator_note', 'sdelka.console'),
            attributes: {},
          },
        }),
      AuditErrorCode.correctionTargetMissing,
    );
  });

  it('метка времени, покрывающая чужой хеш, отвергается', () => {
    const chain = appendRecord(newChain(), decision('rec-1', 1));
    expectAuditError(
      () =>
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
      AuditErrorCode.timestampTargetMissing,
    );
  });

  it('сырой идентификатор в теле записи не проходит', () => {
    const chain = newChain();
    const error = expectAuditError(
      () =>
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
      AuditErrorCode.rawIdentifier,
    );
    expect(error.details['rule']).toBe('iban');
    // Само значение в детали не попадает — иначе проверка сама несла бы в лог
    // то, что она не пускает в журнал.
    expect(JSON.stringify(error.details)).not.toContain('GE29NB');
  });

  it('в цепочку без генезиса добавить нечего', () => {
    expectAuditError(
      () => appendRecord({ chainId: 'chain:x', records: [] }, decision('rec-1', 1)),
      AuditErrorCode.chainEmpty,
    );
  });
});
