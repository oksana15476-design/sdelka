import { describe, expect, it } from 'vitest';
import {
  AUDIT_ROLES,
  RAW_SOURCE_KINDS,
  RELEASE_CONDITION_KINDS,
  auditActor,
  auditAmount,
  auditInstant,
  policyRef,
} from '@sdelka/audit';
import {
  ANALYST_ROLE,
  APPROVER_ROLE,
  CLIENT_ROLE,
  EVIDENCE_KINDS,
  OPERATOR_ROLE,
  REPRESENTATIVE_ROLE,
  SUPPORT_ROLE,
  identityKey,
} from '@sdelka/compliance';
import { RELEASE_CONDITION_TYPES, instant } from '@sdelka/domain';
import { clientKey } from '@sdelka/ledger';
import { CURRENCY_CODES, isCurrencyCode } from '@sdelka/money';
import {
  toClientKey,
} from '@sdelka/app';
import { BUYER_DOCUMENT, POLICY_VERSION } from './support/fixtures';

/**
 * Сверка перечней, продублированных в разных пакетах.
 *
 * `packages/audit/src/record.ts` прямо пишет: «Расхождение перечней молчаливое:
 * сверить их тестом отсюда нельзя, для этого нужен пакет, видящий оба».
 * `packages/e2e` и есть тот пакет.
 */
describe('сверка перечней между пакетами', () => {
  it('каждая роль комплаенса имеет метку в журнале аудита', () => {
    // Прежде перечни сверялись на равенство, и равными они быть перестали:
    // `0023` дописала в журнал семь меток — пять ролей, которым записи не было
    // вовсе, и два уровня утверждения вместо одного `approver` (`ACTORS.md` §13,
    // §1 расхождение №5). Перечень комплаенса при этом не рос: он покрывает
    // комплаенс-периметр, а не штат целиком.
    //
    // Поэтому утверждение стало односторонним и осталось проверяемым: роль
    // комплаенса, которой нет метки, — это действие, которое нечем записать.
    // Обратную сторону (метка журнала без роли доступа) держит
    // `auth/test/legacy.test.ts` — тот пакет видит оба перечня целиком.
    const complianceRoles = [
      SUPPORT_ROLE,
      OPERATOR_ROLE,
      APPROVER_ROLE,
      ANALYST_ROLE,
      REPRESENTATIVE_ROLE,
      CLIENT_ROLE,
    ].map((role) => role.id);
    for (const role of complianceRoles) {
      expect(AUDIT_ROLES, role).toContain(role);
    }
  });

  it('⚠ `approver` в комплаенсе — одна роль на оба уровня утверждения', () => {
    // Надгробие. В журнале метка `approver` выведена из употребления: два
    // уровня утверждения принадлежат разным людям с разными полномочиями
    // (`ACTORS.md` §5.2 — **[решение]**), и запись «утвердил approver» не
    // говорит, кто утвердил. В `packages/compliance` расщепления ещё нет, и
    // роль оттуда в журнал сегодня не пишет: актор записи выводится из
    // `Authority` (`app/src/authority.ts`, `requireAuditRole`), то есть из
    // перечня `@sdelka/auth`, где оба уровня разведены.
    expect(APPROVER_ROLE.id).toBe('approver');
    expect(AUDIT_ROLES).toContain('financial_controller');
    expect(AUDIT_ROLES).toContain('head_of_operations');
  });

  it('перечень типов условия у домена и у журнала аудита один и тот же', () => {
    expect([...RELEASE_CONDITION_KINDS]).toEqual([...RELEASE_CONDITION_TYPES]);
  });

  it('журнал аудита умеет сослаться на каждый вид доказательства комплаенса', () => {
    for (const kind of EVIDENCE_KINDS) {
      expect(RAW_SOURCE_KINDS).toContain(kind);
    }
  });

  it('версия политики комплаенса ложится в ссылку журнала аудита без преобразования', () => {
    expect(() => policyRef(POLICY_VERSION)).not.toThrow();
  });

  /* --- Ниже — швы, которые сверить нечем. Тесты-надгробия. --- */

  it('⚠ полномочие в записи аудита не сверяется с перечнем комплаенса', () => {
    // `AuditActor.capability` — свободная строка. Полномочия, которого нет ни в
    // одной роли, ничто не остановит, а журнал не редактируется.
    expect(() => auditActor('operator-1', 'operator', 'release_funds')).not.toThrow();
  });

  it('⚠ валюта в записи аудита не сверяется с перечнем @sdelka/money', () => {
    expect(isCurrencyCode('XYZ')).toBe(false);
    expect(CURRENCY_CODES).not.toContain('XYZ');
    expect(() => auditAmount('XYZ', 1n)).not.toThrow();
  });

  it('⚠ ключ личности не является ключом счёта: перевода между ними в пакетах нет', () => {
    // `ledger/src/accounts.ts` называет перевод «заботой compliance»; функции
    // перевода в `@sdelka/compliance` нет, и ключ личности в учёт не проходит.
    expect(() => clientKey(identityKey(BUYER_DOCUMENT))).toThrow('ledger.account.invalid_identifier');
    // Мост живёт в приложении — здесь.
    expect(() => toClientKey(BUYER_DOCUMENT)).not.toThrow();
  });

  it('⚠ домен принимает отрицательное время, журнал аудита — нет', () => {
    // «Дата до 1970 года — заведомо подделанная запись задним числом»
    // (`audit/src/instant.ts`). У домена такой проверки нет, а тип времени
    // там объявлен источником истины.
    expect(() => instant(-1)).not.toThrow();
    expect(() => auditInstant(-1)).toThrow();
  });
});
