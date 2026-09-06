import {
  type AuditActor,
  type AuditRecord,
  type AuditRecordEnvelope,
  AUDIT_ROLES,
  RECORD_FORMAT_VERSION,
  ZERO_HASH,
  appendRecord,
  auditActor,
  auditInstant,
  auditRef,
  auditToken,
  genesisChain,
  policyRef,
  recordDigest,
  verifyChain,
} from '@sdelka/audit';
import { expect, it } from 'vitest';
import { APP_ROLE } from '../../src/roles.ts';
import { appendAudit, readChain } from '../../src/store/audit.ts';
import { dbSuite, withRollback } from './support/pg.ts';

/**
 * Миграция `0023` в базе: метки дописаны, записанное не тронуто.
 *
 * Здесь проверяется то, чего не проверить без кластера:
 *
 * 1. **Прежняя метка принимается и возвращается как есть.** Запись с ролью
 *    `approver` — такие лежат в журнале с до-`0023` времён — вставляется,
 *    читается и сходится по хешу. Красная линия №11: журнал не редактируется, и
 *    расширение типа не имеет права поменять прочтение записанного.
 * 2. **Новые метки доезжают до колонки.** `principal` в `role_id` — это и есть
 *    снятие блокера E16-12: изменение настройки владельцем стало записываемым
 *    не только в типах, но и в базе.
 * 3. **Права роли приложения не изменились.** Дописывание меток в перечень их
 *    не касается, но утверждать это на глаз нельзя: инвариант 21 проверяется
 *    грантами, а не рассуждением.
 */
const { run, title, pool } = await dbSuite('журнал аудита: расщепление роли (0023)');

const T0 = Date.UTC(2026, 2, 1, 9, 0, 0);

/**
 * Запись, сделанная **до** `0023`.
 *
 * Собрана конвертом, а не `appendRecord`: под выведенной из употребления меткой
 * новая запись сегодня не собирается вовсе (`audit/test/role-split.test.ts`), а
 * прежние в журнале есть. Именно так их поднимает и хранилище — `recordOfRow`.
 */
function legacyRecord(): AuditRecord {
  const actor: AuditActor = Object.freeze({
    actorId: 'approver-1',
    roleId: 'approver' as const,
    capability: 'approve_payout',
  });
  const chainId = 'chain-legacy-role';
  const seal = (envelope: AuditRecordEnvelope): AuditRecord =>
    Object.freeze({ ...envelope, recordHash: recordDigest(envelope) });
  return seal({
    version: RECORD_FORMAT_VERSION,
    chainId,
    seq: 0,
    recordId: `${chainId}:0`,
    prevHash: ZERO_HASH,
    recordedAt: auditInstant(T0),
    actor,
    subject: auditRef('chain', chainId),
    related: [],
    body: { kind: 'chain_opened', chainId, formatVersion: RECORD_FORMAT_VERSION },
  });
}

run(title, () => {
  it('перечень базы знает все пятнадцать меток, включая прежнюю', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      const labels = await client.query<{ label: string }>(
        `SELECT enumlabel AS label
           FROM pg_enum
           JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
          WHERE pg_type.typname = 'audit_role'
          ORDER BY enumsortorder`,
      );
      // Порядок сверяется тоже: метки перечня упорядочены, и порядок виден в
      // `ORDER BY` любого отчёта.
      expect(labels.rows.map((row) => row.label)).toEqual([...AUDIT_ROLES]);
    });
  });

  it('запись с прежней меткой читается после миграции без изменений', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      const record = legacyRecord();
      expect(await appendAudit(client, [record])).toEqual({ written: 1, repeated: 0 });
      const read = await readChain(client, record.chainId);
      // `readChain` пересчитывает хеш конверта и падает при расхождении, то есть
      // равенство ниже — это равенство **до последнего поля**, а не по виду.
      expect(read).toEqual({ chainId: record.chainId, records: [record] });
      expect(read.records[0]?.actor.roleId).toBe('approver');
      expect(verifyChain(read).intact).toBe(true);
    });
  });

  it('владелец записывает изменение настройки собой — E16-12 доезжает до колонки', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      const owner = auditActor('acc-principal', 'principal', 'manage_settings');
      const chain = appendRecord(genesisChain('chain-setting-role', auditInstant(T0), owner), {
        recordId: 'chain-setting-role:1',
        recordedAt: auditInstant(T0 + 60_000),
        actor: owner,
        subject: auditRef('setting', 'deal_currencies'),
        body: {
          kind: 'setting_changed',
          change: 'introduced',
          setting: auditToken('deal_currencies'),
          next: Object.freeze(['GEL']),
          orderedBy: owner,
          reasonKey: 'settings.reason.owner_decision',
          policy: policyRef('deal_currencies/2026-09-04.1'),
          effectiveFrom: auditInstant(T0 + 60_000),
        },
      });
      expect(await appendAudit(client, chain.records)).toEqual({ written: 2, repeated: 0 });
      const read = await readChain(client, 'chain-setting-role');
      expect(read.records.map((item) => item.actor.roleId)).toEqual(['principal', 'principal']);
      expect(read).toEqual(chain);
    });
  });

  it('оба уровня утверждения различимы в колонке, а не только в теле', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      const controller = auditActor('approver-1', 'financial_controller', 'approve_payout');
      const head = auditActor('approver-2', 'head_of_operations', 'approve_payout');
      const transition = (from: string, to: string) =>
        ({
          kind: 'state_transition',
          machine: 'payout',
          from,
          to,
          eventKey: 'payout_approved',
          failedGuards: [],
        }) as const;
      let chain = genesisChain('chain-two-levels', auditInstant(T0), controller);
      chain = appendRecord(chain, {
        recordId: 'chain-two-levels:1',
        recordedAt: auditInstant(T0 + 60_000),
        actor: controller,
        subject: auditRef('payout', 'payout-1'),
        body: transition('prepared', 'approved_level_1'),
      });
      chain = appendRecord(chain, {
        recordId: 'chain-two-levels:2',
        recordedAt: auditInstant(T0 + 120_000),
        actor: head,
        subject: auditRef('payout', 'payout-1'),
        body: transition('approved_level_1', 'approved'),
      });
      await appendAudit(client, chain.records);
      const roles = await client.query<{ role_id: string }>(
        `SELECT role_id FROM sdelka.audit_record WHERE chain_id = 'chain-two-levels' ORDER BY seq`,
      );
      // До `0023` все три строки были бы `approver`, и «четыре глаза» по журналу
      // не доказывались: кто дал уровень 1, а кто уровень 2, в записи не стояло.
      expect(roles.rows.map((row) => row.role_id)).toEqual([
        'financial_controller',
        'financial_controller',
        'head_of_operations',
      ]);
    });
  });

  it('права роли приложения на журнал не изменились: только SELECT и INSERT', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      const granted = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_schema = 'sdelka' AND table_name = 'audit_record'
          ORDER BY privilege_type`,
        [APP_ROLE],
      );
      // Правка перечня прав не касается, но проверяется это грантами, а не
      // рассуждением: инвариант 21, `CORE.md` Ф11.
      expect(granted.rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT']);
    });
  });
});
