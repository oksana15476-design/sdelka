import {
  AUDIT_PRIMARY_METHODS,
  AUDIT_RECORD_KINDS,
  AUDIT_SECOND_FACTOR_KINDS,
  type AuditPrimaryMethod,
  type AuditRecordKind,
  type AuditSecondFactorKind,
  type RoleChangedBody,
  RETIRED_AUDIT_ROLES,
  type SessionDeniedBody,
  type SessionEstablishedBody,
  appendRecord,
  auditActor,
  auditFingerprint,
  auditInstant,
  auditRef,
  auditToken,
  genesisChain,
  policyRef,
  verifyChain,
} from '@sdelka/audit';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ROLE_BY_ROLE,
  AUTH_EVENT_JOURNAL,
  AUTH_EVENT_KINDS,
  AUTH_REASON_KEYS,
  type AuthEventKind,
  AuthError,
  AuthErrorCode,
  PRIMARY_METHODS,
  type PrimaryMethod,
  RETIRED_JOURNAL_ROLES,
  ROLE_CHANGE_REASON_KEYS,
  type RoleChangeJournalEntry,
  type RoleId,
  SECOND_FACTOR_KINDS,
  type SecondFactorKind,
  type SessionDeniedJournalEntry,
  type SessionEstablishedJournalEntry,
  accountId,
  auditRoleFor,
  collidingAuditRoles,
  fingerprint,
  personId,
  requireAuditRole,
  roleChangeEntry,
  rolesWithoutAuditRole,
  sessionDenied,
  sessionDeniedEntry,
  sessionEstablished,
  sessionEstablishedEntry,
  unjournaledAuthEventKinds,
} from '../src/index';
import { NOW, sessionFor } from './support';

/**
 * Связь двух пакетов — здесь, потому что этот файл видит оба.
 *
 * Тот же приём, что в `legacy.test.ts`: рабочий код `packages/auth` на
 * `@sdelka/audit` не ссылается (журнал обязан пережить переделку
 * аутентификации), карта в `src/journal.ts` записана литералами, а сверку с
 * настоящими перечнями ведёт тест. Расхождение перестаёт быть молчаливым:
 * событие без вида записи, вид записи без тела, перечень способов входа,
 * разошедшийся с журналом, — всё это роняет либо сборку, либо этот файл.
 */

const CHAIN_ID = 'chain:auth';
const SYSTEM = auditActor('system', 'system', null);
const DEVICE = 'a'.repeat(64);
const NETWORK = 'b'.repeat(64);

function chain() {
  return genesisChain(CHAIN_ID, auditInstant(NOW), SYSTEM);
}

/**
 * Разметка значений — единственное, что делает граница: заготовка несёт
 * примитивы, конструкторы журнала превращают их в размеченные значения.
 * Пропущенное поле здесь не собирается, а не обнаруживается в проде.
 */
function establishedBody(entry: SessionEstablishedJournalEntry): SessionEstablishedBody {
  return {
    kind: 'session_established',
    sessionId: auditToken(entry.sessionId),
    primaryMethod: entry.primaryMethod,
    secondFactor: entry.secondFactor,
    expiresAt: auditInstant(entry.expiresAt),
    device: entry.device === null ? null : auditFingerprint('device', entry.device),
    network: entry.network === null ? null : auditFingerprint('network_address', entry.network),
  };
}

function deniedBody(entry: SessionDeniedJournalEntry): SessionDeniedBody {
  return {
    kind: 'session_denied',
    primaryMethod: entry.primaryMethod,
    reasonKey: entry.reasonKey,
    device: entry.device === null ? null : auditFingerprint('device', entry.device),
    network: entry.network === null ? null : auditFingerprint('network_address', entry.network),
  };
}

function roleChangedBody(entry: RoleChangeJournalEntry): RoleChangedBody {
  const order =
    entry.order.kind === 'ordered_by'
      ? ({
          kind: 'ordered_by' as const,
          actor: auditActor(
            entry.order.accountId,
            requireAuditRole(entry.order.roleId),
            'manage_access',
          ),
        } as const)
      : // Распоряжение вне системы: журнал требует документ, и приложить его
        // может только тот, у кого есть сырой ответ источника. Этот тест такой
        // ветви не собирает — она проверяется в `packages/audit`.
        null;
  if (order === null) throw new Error('unreachable');
  if (entry.previous === null) {
    if (entry.next === null) throw new Error('unreachable');
    return {
      kind: 'role_changed',
      previous: null,
      next: entry.next,
      order,
      reasonKey: entry.reasonKey,
    };
  }
  return {
    kind: 'role_changed',
    previous: entry.previous,
    next: entry.next,
    order,
    reasonKey: entry.reasonKey,
  };
}

describe('каждому событию — место в журнале либо названный пробел', () => {
  it('карта покрывает ровно перечень событий', () => {
    expect(Object.keys(AUTH_EVENT_JOURNAL).sort()).toEqual([...AUTH_EVENT_KINDS].sort());
  });

  it('каждый названный вид записи существует в @sdelka/audit', () => {
    // Ради этой строки задача и делалась: до неё `session_established`,
    // `session_denied` и `role_changed` в `AUDIT_RECORD_KINDS` отсутствовали, и
    // событиям входа было некуда лечь.
    const known = new Set<string>(AUDIT_RECORD_KINDS);
    const targets = Object.values(AUTH_EVENT_JOURNAL).filter(
      (target): target is Exclude<typeof target, null> => target !== null,
    );
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((target) => !known.has(target))).toEqual([]);
  });

  it('вид записи известен и типом, а не только строкой', () => {
    // Литералы карты обязаны быть значениями `AuditRecordKind`: опечатка в
    // имени вида не собирается.
    const typed: readonly AuditRecordKind[] = ['session_established', 'session_denied', 'role_changed'];
    expect(typed).toHaveLength(3);
  });

  it('события без вида записи перечислены поимённо', () => {
    // Пробел, названный поимённо, — не то же самое, что пробел. Появление
    // здесь нового вида события (или закрытие пробела) роняет тест, и решение
    // принимается осознанно, а не молчанием.
    const expected: readonly AuthEventKind[] = [
      'session_revoked',
      'second_factor_verified',
      'duty_started',
      'duty_ended',
      'authorization_granted',
      'authorization_denied',
    ];
    expect([...unjournaledAuthEventKinds()]).toEqual([...expected]);
  });
});

describe('перечни способов входа не разошлись с журналом', () => {
  it('перечни совпадают построчно', () => {
    expect([...AUDIT_PRIMARY_METHODS]).toEqual([...PRIMARY_METHODS]);
    expect([...AUDIT_SECOND_FACTOR_KINDS]).toEqual([...SECOND_FACTOR_KINDS]);
  });

  it('совпадение проверяется и типом, в обе стороны', () => {
    // Взаимная присваиваемость: значение, добавленное в один перечень и
    // забытое в другом, не соберётся.
    const toAudit: AuditPrimaryMethod = 'magic_link' satisfies PrimaryMethod;
    const fromAudit: PrimaryMethod = 'passkey' satisfies AuditPrimaryMethod;
    const factorToAudit: AuditSecondFactorKind = 'webauthn' satisfies SecondFactorKind;
    const factorFromAudit: SecondFactorKind = 'sms' satisfies AuditSecondFactorKind;
    expect([toAudit, fromAudit, factorToAudit, factorFromAudit]).toHaveLength(4);
  });
});

describe('вход ложится в цепочку', () => {
  const session = sessionFor('financial_controller', 'acc-fc', {
    primary: {
      method: 'passkey',
      at: NOW,
      device: fingerprint(DEVICE),
      network: fingerprint(NETWORK),
    },
  });

  it('заготовка несёт всё, чего требует тело записи', () => {
    const entry = sessionEstablishedEntry(sessionEstablished(session, 'webauthn'));
    const appended = appendRecord(chain(), {
      recordId: 'rec-login',
      recordedAt: auditInstant(entry.recordedAt),
      actor: auditActor(entry.subjectAccount, requireAuditRole(session.roleId), null),
      subject: auditRef('account', entry.subjectAccount),
      body: establishedBody(entry),
    });
    const body = appended.records[1]?.body;
    expect(body?.kind).toBe('session_established');
    expect(body?.kind === 'session_established' && body.device?.digest).toBe(DEVICE);
    expect(verifyChain(appended).intact).toBe(true);
  });

  it('роль сессии записывается ролью журнала', () => {
    // `financial_controller` → `financial_controller`. До миграции `0023` здесь
    // стоял `approver` — одна метка на оба уровня утверждения, из-за чего запись
    // не отвечала, кто именно утвердил (`ACTORS.md` §1 расхождение №5).
    expect(requireAuditRole(session.roleId)).toBe('financial_controller');
  });
});

describe('отказ во входе ложится в цепочку вместе с отпечатками', () => {
  it('отпечатки доезжают до записи', () => {
    const event = sessionDenied(
      { accountId: accountId('acc-fc'), personId: personId('per-fc'), roleId: null, onDuty: false },
      'magic_link',
      AUTH_REASON_KEYS.primaryMethodNotAllowedForConsole,
      NOW,
      fingerprint(DEVICE),
      fingerprint(NETWORK),
    );
    const entry = sessionDeniedEntry(event);
    const appended = appendRecord(chain(), {
      recordId: 'rec-denied',
      recordedAt: auditInstant(entry.recordedAt),
      // Роль на отказе не установлена: пишет система, а не отказавшийся.
      actor: SYSTEM,
      subject: auditRef('account', entry.subjectAccount),
      body: deniedBody(entry),
    });
    const body = appended.records[1]?.body;
    expect(body?.kind === 'session_denied' && body.network?.digest).toBe(NETWORK);
    expect(body?.kind === 'session_denied' && body.reasonKey).toBe(
      AUTH_REASON_KEYS.primaryMethodNotAllowedForConsole,
    );
  });

  it('ключ причины отказа — годный ключ журнала', () => {
    // Журнал отвергает свободный текст формой `AUDIT_TOKEN`. Все ключи причин
    // обязаны проходить её: иначе отказ во входе не записывается вообще.
    for (const key of Object.values(AUTH_REASON_KEYS)) {
      expect(() => auditToken(key)).not.toThrow();
    }
  });
});

describe('смена роли ложится одной записью', () => {
  const order = {
    kind: 'ordered_by' as const,
    accountId: accountId('acc-admin'),
    roleId: 'head_of_operations' as const,
  };

  it('прежняя и новая роль стоят рядом', () => {
    const entry = roleChangeEntry({
      account: accountId('acc-1'),
      from: 'operator',
      to: 'support',
      order,
      at: NOW,
    });
    expect(entry.previous).toBe('operator');
    expect(entry.next).toBe('support');
    expect(entry.reasonKey).toBe(ROLE_CHANGE_REASON_KEYS.reassigned);

    const appended = appendRecord(chain(), {
      recordId: 'rec-role',
      recordedAt: auditInstant(entry.recordedAt),
      actor: SYSTEM,
      subject: auditRef('account', entry.subjectAccount),
      body: roleChangedBody(entry),
    });
    expect(appended.records[1]?.body.kind).toBe('role_changed');
    expect(verifyChain(appended).intact).toBe(true);
  });

  it('первичное назначение и снятие различаются ключом причины', () => {
    expect(
      roleChangeEntry({ account: accountId('acc-1'), from: null, to: 'support', order, at: NOW })
        .reasonKey,
    ).toBe(ROLE_CHANGE_REASON_KEYS.granted);
    expect(
      roleChangeEntry({ account: accountId('acc-1'), from: 'support', to: null, order, at: NOW })
        .reasonKey,
    ).toBe(ROLE_CHANGE_REASON_KEYS.revoked);
  });

  it('смена роли на ту же самую не превращается в запись', () => {
    expect(() =>
      roleChangeEntry({
        account: accountId('acc-1'),
        from: 'operator',
        to: 'operator',
        order,
        at: NOW,
      }),
    ).toThrow(AuthError);
  });
});

describe('расхождение перечней ролей закрыто, а не спрятано', () => {
  it('ролей без метки журнала не осталось ни одной', () => {
    // Было пять (`oracle_operator`, `compliance_officer`, `principal`,
    // `auditor`, `client_counsel`), и практическое следствие было не крайним
    // случаем, а обычным путём: `manage_settings` есть ровно у `principal`, то
    // есть изменение настройки владельцем записать было нечем (E16-12).
    expect([...rolesWithoutAuditRole()]).toEqual([]);
  });

  it('каждая роль доступа записывается **своей** меткой', () => {
    // Карта целиком, значением: вывод её из `JOURNAL_ROLE_MAP` не должен
    // молча поменяться — метка роли уходит в вечный журнал.
    expect({ ...AUDIT_ROLE_BY_ROLE }).toEqual({
      party: 'client',
      representative: 'representative',
      operator: 'operator',
      oracle_operator: 'oracle_operator',
      compliance_analyst: 'compliance_analyst',
      compliance_officer: 'compliance_officer',
      financial_controller: 'financial_controller',
      head_of_operations: 'head_of_operations',
      support: 'support',
      principal: 'principal',
      auditor: 'auditor',
      client_counsel: 'client_counsel',
      system: 'system',
      oracle_source: 'oracle',
    });
  });

  it('двух ролей на одну метку не осталось', () => {
    // Обратная сторона предыдущего: пока `financial_controller` и
    // `head_of_operations` делили `approver`, запись «утвердил approver» не
    // говорила, кто утвердил, и «четыре глаза» по журналу не доказывались.
    expect([...collidingAuditRoles()]).toEqual([]);
  });

  it('выведенная из употребления метка не выдаётся ни одной роли', () => {
    // `approver` остаётся в перечне журнала ради прежних записей и не
    // назначается никому: подстановка её новой записи вернула бы ровно ту
    // неполноту, ради устранения которой перечень и расщеплён.
    expect(Object.values(AUDIT_ROLE_BY_ROLE)).not.toContain('approver');
    expect([...RETIRED_JOURNAL_ROLES]).toEqual([...RETIRED_AUDIT_ROLES]);
  });

  it('роль без метки — отказ, а не похожая роль', () => {
    // Ролей без метки сегодня нет, поэтому отказ проверяется значением,
    // которого в перечне нет вовсе: так в этот код приходит роль из хранилища
    // и из чужого адаптера, где типов нет. Отказ обязан остаться отказом —
    // `undefined` вместо метки ушёл бы в вечный журнал записью без роли.
    const unknown = 'notary' as RoleId;
    expect(auditRoleFor(unknown)).toBeNull();
    try {
      requireAuditRole(unknown);
      throw new Error('ожидался отказ');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe(AuthErrorCode.auditRoleUnmapped);
    }
  });

  it('владелец записывает изменение настройки собой — блокер E16-12 снят', () => {
    // Проверка по существу, а не по карте: актор собирается тем же
    // конструктором, что и в проде, и запись ложится в цепочку.
    const actor = auditActor('acc-principal', requireAuditRole('principal'), 'manage_settings');
    expect(actor.roleId).toBe('principal');
    const appended = appendRecord(chain(), {
      recordId: 'rec-setting',
      recordedAt: auditInstant(NOW),
      actor,
      subject: auditRef('setting', 'deal_currencies'),
      body: {
        kind: 'setting_changed',
        change: 'introduced',
        setting: auditToken('deal_currencies'),
        next: Object.freeze(['GEL']),
        orderedBy: actor,
        reasonKey: 'settings.reason.owner_decision',
        policy: policyRef('deal_currencies/2026-09-04.1'),
        effectiveFrom: auditInstant(NOW),
      },
    });
    expect(appended.records[1]?.actor.roleId).toBe('principal');
    expect(verifyChain(appended).intact).toBe(true);
  });

  it('смена уровня утверждения записывается сменой, а не пустой записью', () => {
    // До `0023` это был отказ: обе роли записывались как `approver`, и
    // настоящая смена уровня превращалась в «из approver в approver».
    const entry = roleChangeEntry({
      account: accountId('acc-1'),
      from: 'financial_controller',
      to: 'head_of_operations',
      order: { kind: 'ordered_by', accountId: accountId('acc-admin'), roleId: 'principal' },
      at: NOW,
    });
    expect(entry.previous).toBe('financial_controller');
    expect(entry.next).toBe('head_of_operations');
    const appended = appendRecord(chain(), {
      recordId: 'rec-level',
      recordedAt: auditInstant(entry.recordedAt),
      actor: SYSTEM,
      subject: auditRef('account', entry.subjectAccount),
      body: roleChangedBody(entry),
    });
    expect(verifyChain(appended).intact).toBe(true);
  });

  it('нечеловеческие акторы соответствие имеют', () => {
    expect(auditRoleFor('system')).toBe('system');
    expect(auditRoleFor('oracle_source')).toBe('oracle');
  });
});
