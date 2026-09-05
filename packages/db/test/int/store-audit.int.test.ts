import {
  type AuditBody,
  type AuditChain,
  appendRecord,
  auditActor,
  auditAmount,
  auditFingerprint,
  auditInstant,
  auditRef,
  genesisChain,
  policyRef,
  rawSourceRef,
  verifyChain,
} from '@sdelka/audit';
import { expect, it } from 'vitest';
import { DbError, DbErrorCode } from '../../src/errors.ts';
import { appendAudit, readChain } from '../../src/store/audit.ts';
import { dbSuite, withRollback } from './support/pg.ts';

/**
 * Круг «мир → база → мир» по журналу аудита.
 *
 * Доказательство круга здесь дешевле, чем где бы то ни было, и потому строже:
 * хеш записи считается по канонической форме **всего** конверта. Совпадение
 * `recordDigest(прочитанное)` с записанным `record_hash` означает, что чтение
 * вернуло ту же запись до последнего поля тела; расхождение в одном байте
 * `jsonb` его ломает. Сверять поля руками не нужно — и хорошо, что не нужно:
 * ручная сверка проверяет те поля, которые вспомнил автор.
 */
const { run, title, pool } = await dbSuite('хранилище: журнал аудита');

const CHAIN = 'chain-store';
const ACTOR = auditActor('operator-store', 'operator', 'payout.approve');

const EVIDENCE = rawSourceRef({
  sourceKind: 'payment_provider_response',
  storageRef: 'documents/psp/2026/03/01/1',
  mediaType: 'application/json',
  byteLength: 512,
  digest: 'b'.repeat(64),
  receivedAt: auditInstant(Date.UTC(2026, 2, 1, 10, 0, 0)),
  provider: 'psp.acme',
});

function orderedBody(): AuditBody {
  return {
    kind: 'payout_ordered',
    idempotencyKey: 'idem.payout.tranche-store',
    // Сумма — `bigint` за пределами 2^53. Она и проверяет круг: приведение к
    // `number` запрещено красной линией №4, а поломка была бы тихой.
    amount: auditAmount('GEL', 9_223_372_036_854_775_808n),
    beneficiary: auditFingerprint('account', 'c'.repeat(64)),
    policy: policyRef('payout/2026-01-01.1'),
    evidencePackage: [EVIDENCE],
  };
}

function chainOfThree(): AuditChain {
  const genesis = genesisChain(CHAIN, auditInstant(Date.UTC(2026, 2, 1, 9, 0, 0)), ACTOR);
  const ordered = appendRecord(genesis, {
    recordId: `${CHAIN}:1`,
    recordedAt: auditInstant(Date.UTC(2026, 2, 1, 10, 0, 0)),
    actor: ACTOR,
    subject: auditRef('payout', 'pay-store'),
    related: [auditRef('tranche', 'tranche-store')],
    body: orderedBody(),
  });
  return appendRecord(ordered, {
    recordId: `${CHAIN}:2`,
    recordedAt: auditInstant(Date.UTC(2026, 2, 1, 11, 0, 0)),
    actor: ACTOR,
    subject: auditRef('payout', 'pay-store'),
    body: {
      kind: 'payout_result',
      outcome: 'settled',
      response: EVIDENCE,
      reasonKey: null,
    },
  });
}

run(title, () => {
  it('прочитанная цепочка равна записанной и цела', async () => {
    if (pool === null) return;
    const source = chainOfThree();
    await withRollback(pool, async (client) => {
      const outcome = await appendAudit(client, source.records);
      expect(outcome).toEqual({ written: 3, repeated: 0 });
      const read = await readChain(client, CHAIN);
      expect(read).toEqual(source);
      expect(verifyChain(read).intact).toBe(true);
    });
  });

  it('сцепка сохраняется: каждая запись ссылается на хеш предыдущей', async () => {
    if (pool === null) return;
    const source = chainOfThree();
    await withRollback(pool, async (client) => {
      await appendAudit(client, source.records);
      const read = await readChain(client, CHAIN);
      for (let index = 1; index < read.records.length; index += 1) {
        expect(read.records[index]?.prevHash).toBe(read.records[index - 1]?.recordHash);
      }
    });
  });

  it('повтор дописывания не задваивает цепочку', async () => {
    if (pool === null) return;
    const source = chainOfThree();
    await withRollback(pool, async (client) => {
      await appendAudit(client, source.records);
      const again = await appendAudit(client, source.records);
      expect(again).toEqual({ written: 0, repeated: 3 });
      const read = await readChain(client, CHAIN);
      expect(read.records).toHaveLength(3);
    });
  });

  it('другая запись на занятом месте цепочки — конфликт, а не повтор', async () => {
    if (pool === null) return;
    const source = chainOfThree();
    // Другая цепочка с тем же именем: у её записей те же номера, но другое
    // время и, значит, другой хеш. Подмена звена не имеет права выглядеть как
    // повтор.
    const other = appendRecord(
      genesisChain(CHAIN, auditInstant(Date.UTC(2026, 2, 1, 9, 0, 0)), ACTOR),
      {
        recordId: `${CHAIN}:1-other`,
        recordedAt: auditInstant(Date.UTC(2026, 2, 1, 12, 0, 0)),
        actor: ACTOR,
        subject: auditRef('payout', 'pay-store'),
        body: orderedBody(),
      },
    );
    await withRollback(pool, async (client) => {
      await appendAudit(client, source.records);
      const error = await appendAudit(client, [other.records[1]!]).catch(
        (item: unknown) => item,
      );
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe(DbErrorCode.stepConflict);
    });
  });

  it('цепочки без генезиса не бывает: чтение отсутствующей — отказ с именем', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      const error = await readChain(client, 'chain-nobody').catch((item: unknown) => item);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe(DbErrorCode.auditGenesisRequired);
    });
  });

  it('подменённое тело ломает хеш и ловится на чтении', async () => {
    if (pool === null) return;
    const source = chainOfThree();
    await withRollback(pool, async (client) => {
      await appendAudit(client, source.records);
      // Правку журнала аудита запрещают и гранты, и триггер, поэтому подмена
      // делается тем единственным способом, каким её может сделать носитель:
      // от имени владельца схемы, с временно снятым триггером. Именно от такой
      // порчи и защищает хеш — и это единственная защита, которая переживает
      // доступ к диску.
      await client.query('SET LOCAL ROLE sdelka_owner');
      await client.query('ALTER TABLE sdelka.audit_record DISABLE TRIGGER forbid_audit_mutation');
      await client.query(
        `UPDATE sdelka.audit_record
            SET body = jsonb_set(body, '{outcome}', '"rejected"')
          WHERE chain_id = $1 AND seq = 2`,
        [CHAIN],
      );
      const error = await readChain(client, CHAIN).catch((item: unknown) => item);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe(DbErrorCode.auditRecordHashMismatch);
    });
  });
});
