import { describe, expect, it } from 'vitest';
import {
  AUDIT_ROLES,
  type AuditChain,
  type AuditRecord,
  type AuditRecordEnvelope,
  AuditErrorCode,
  RECORD_FORMAT_VERSION,
  RETIRED_AUDIT_ROLES,
  ZERO_HASH,
  appendRecord,
  auditActor,
  auditInstant,
  auditRef,
  genesisChain,
  isRetiredAuditRole,
  recordDigest,
  verifyChain,
} from '../src/index';
import { SYSTEM, at, expectAuditError, source } from './support/fixtures';

/**
 * Расщепление `approver` и пять прежде непредставленных ролей (`0023`).
 *
 * Перечень журнала был восьмизначным против четырнадцати ролей доступа:
 * `oracle_operator`, `compliance_officer`, `principal`, `auditor` и
 * `client_counsel` не отображались в него **никуда** — действие такой роли
 * записать было нечем (`ACTORS.md` §13, `DECISIONS-REVIEW.md` §K5), а
 * `financial_controller` и `head_of_operations` записывались одной меткой
 * `approver`, из-за чего запись не отвечала, кто именно утвердил (`ACTORS.md`
 * §1 расхождение №5 — класс «дефект», §5.2 — **[решение]** владельца о двух
 * уровнях).
 *
 * Здесь проверяется обе стороны правки: новые метки есть, старая не пишется, а
 * записи, сделанные **до** миграции, читаются после неё байт в байт.
 */

const ACCOUNT = auditRef('account', 'acc-1');

describe('перечень ролей журнала', () => {
  it('прежние восемь стоят первыми и в прежнем порядке', () => {
    // Порядок меток зеркалится `sdelka.audit_role`, а `ALTER TYPE ... ADD VALUE`
    // умеет только дописывать в конец. Перестановка здесь — это перестановка
    // меток в базе, то есть другой `ORDER BY` у отчёта дежурному.
    expect(AUDIT_ROLES.slice(0, 8)).toEqual([
      'operator',
      'approver',
      'compliance_analyst',
      'support',
      'representative',
      'client',
      'system',
      'oracle',
    ]);
  });

  it('семь дописаны в конец: пять непредставленных плюс два уровня утверждения', () => {
    expect(AUDIT_ROLES.slice(8)).toEqual([
      'oracle_operator',
      'compliance_officer',
      'financial_controller',
      'head_of_operations',
      'principal',
      'auditor',
      'client_counsel',
    ]);
  });

  it('выведена из употребления ровно одна метка', () => {
    expect([...RETIRED_AUDIT_ROLES]).toEqual(['approver']);
    expect(isRetiredAuditRole('approver')).toBe(true);
    expect(isRetiredAuditRole('financial_controller')).toBe(false);
    // Выведенная метка **остаётся** в перечне: иначе запись, сделанную до
    // `0023`, нельзя было бы поднять из хранилища, не солгав о ней.
    expect(AUDIT_ROLES).toContain('approver');
  });
});

describe('под выведенной меткой новая запись не делается', () => {
  it('актор с ролью approver не собирается', () => {
    // Тип отсекает это на сборке (`WritableAuditRoleId`); приведение здесь
    // изображает границу процесса, где типов нет: роль, приехавшую строкой из
    // хранилища или из чужого адаптера, отвергает проверка.
    expectAuditError(
      () => auditActor('approver-1', 'approver' as 'operator', 'approve_payout'),
      AuditErrorCode.auditRoleRetired,
    );
  });

  it('и не проходит в цепочку в обход конструктора', () => {
    // Актор собран объектом, минуя `auditActor`, — ровно так он приходит из
    // хранилища (`db/src/store/audit.ts`). Дверь в цепочку одна, и она закрыта.
    const chain = genesisChain('chain:split', at(0), SYSTEM);
    expectAuditError(
      () =>
        appendRecord(chain, {
          recordId: 'chain:split:1',
          recordedAt: at(1),
          actor: { actorId: 'approver-1', roleId: 'approver', capability: 'approve_payout' },
          subject: auditRef('deal', 'deal-1'),
          body: {
            kind: 'state_transition',
            machine: 'deal',
            from: 'draft',
            to: 'ready',
            eventKey: 'parties_confirmed',
            failedGuards: [],
          },
        }),
      AuditErrorCode.auditRoleRetired,
    );
  });

  it('смена роли под выведенной меткой отвергается с обеих сторон', () => {
    const chain = genesisChain('chain:split', at(0), SYSTEM);
    const change = (previous: 'operator' | null, next: 'operator' | null): AuditChain =>
      appendRecord(chain, {
        recordId: 'chain:split:1',
        recordedAt: at(1),
        actor: SYSTEM,
        subject: ACCOUNT,
        body: {
          kind: 'role_changed',
          previous,
          next,
          order: { kind: 'external_order', document: source(9, 'operator_note', 'hr') },
          reasonKey: 'access.role.reassigned',
        } as never,
      });
    expectAuditError(
      () => change('approver' as 'operator', 'support' as 'operator'),
      AuditErrorCode.auditRoleRetired,
    );
    expectAuditError(
      () => change('operator', 'approver' as 'operator'),
      AuditErrorCode.auditRoleRetired,
    );
  });

  it('распорядившийся сменой роли — тоже под действующей меткой', () => {
    const chain = genesisChain('chain:split', at(0), SYSTEM);
    expectAuditError(
      () =>
        appendRecord(chain, {
          recordId: 'chain:split:1',
          recordedAt: at(1),
          actor: SYSTEM,
          subject: ACCOUNT,
          body: {
            kind: 'role_changed',
            previous: null,
            next: 'support',
            order: {
              kind: 'ordered_by',
              actor: { actorId: 'approver-1', roleId: 'approver', capability: 'manage_access' },
            },
            reasonKey: 'access.role.granted',
          },
        }),
      AuditErrorCode.auditRoleRetired,
    );
  });
});

/**
 * Записи, сделанные **до** `0023`.
 *
 * Красная линия №11: журнал не редактируется. Миграция **дописывает** метки в
 * тип и не трогает ни одной записанной строки, поэтому прежняя запись обязана
 * читаться после неё ровно так же — тем же хешем, той же ролью.
 *
 * Собраны они здесь так же, как приходят из хранилища: конверт объектом, хеш
 * `recordDigest`-ом (`db/src/store/audit.ts`, `recordOfRow`). Через
 * `appendRecord` их сегодня не собрать — и это ровно то, что проверено выше.
 *
 * Хеши записаны литералами и **посчитаны на коде до правки** (`git show
 * HEAD:packages/audit/src`). Совпадение с ними и есть доказательство: канон
 * записи не сдвинулся ни на байт.
 */
describe('прежние записи читаются после миграции без изменений', () => {
  const LEGACY_ACTOR = Object.freeze({
    actorId: 'approver-1',
    roleId: 'approver' as const,
    capability: 'approve_payout',
  });
  const CHAIN_ID = 'chain:legacy';

  function sealed(envelope: AuditRecordEnvelope): AuditRecord {
    return Object.freeze({ ...envelope, recordHash: recordDigest(envelope) });
  }

  const genesis = sealed({
    version: RECORD_FORMAT_VERSION,
    chainId: CHAIN_ID,
    seq: 0,
    recordId: `${CHAIN_ID}:0`,
    prevHash: ZERO_HASH,
    recordedAt: auditInstant(Date.UTC(2026, 8, 3, 10, 0, 0)),
    actor: LEGACY_ACTOR,
    subject: auditRef('chain', CHAIN_ID),
    related: [],
    body: { kind: 'chain_opened', chainId: CHAIN_ID, formatVersion: RECORD_FORMAT_VERSION },
  });

  const approval = sealed({
    version: RECORD_FORMAT_VERSION,
    chainId: CHAIN_ID,
    seq: 1,
    recordId: `${CHAIN_ID}:1`,
    prevHash: genesis.recordHash,
    recordedAt: auditInstant(Date.UTC(2026, 8, 3, 10, 5, 0)),
    actor: LEGACY_ACTOR,
    subject: auditRef('tranche', 'tranche-1'),
    related: [],
    body: {
      kind: 'state_transition',
      machine: 'payout',
      from: 'ordered',
      to: 'settled',
      eventKey: 'payout_settled',
      failedGuards: [],
    },
  });

  const chain: AuditChain = Object.freeze({
    chainId: CHAIN_ID,
    records: Object.freeze([genesis, approval]),
  });

  it('хеш прежней записи не сдвинулся', () => {
    expect(genesis.recordHash).toBe(
      'a242a29f39ffc5804883095fb1ed2710a50417e56df6eb4785283b0c2df635c5',
    );
    expect(approval.recordHash).toBe(
      'd09c1b24ce162cdabb83b6fb1e1fc0bfd4b3c3257989bd402f56fcf6f5f9a3bf',
    );
  });

  it('цепочка с прежней меткой цела', () => {
    expect(verifyChain(chain).intact).toBe(true);
  });

  it('роль читается как записана: подмены новой меткой не происходит', () => {
    // Читать `approver` как `financial_controller` было бы догадкой: какой из
    // двух уровней стоял за прежней записью, не знает никто, и восстановить это
    // задним числом нечем. Догадка в вечном журнале хуже неполноты.
    expect(chain.records.map((record) => record.actor.roleId)).toEqual(['approver', 'approver']);
  });
});
