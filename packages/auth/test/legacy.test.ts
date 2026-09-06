import { AUDIT_ROLES } from '@sdelka/audit';
import type { RoleId as ComplianceRoleId } from '@sdelka/compliance';
import { describe, expect, it } from 'vitest';
import {
  type JournalRoleId,
  JOURNAL_ROLE_MAP,
  RETIRED_JOURNAL_ROLES,
  danglingJournalTargets,
  unmappedJournalRoles,
} from '../src/index';

/**
 * `ACTORS.md` §1 расхождение №2: «расхождение перечней молчаливое: сверить их
 * тестом отсюда нельзя, для этого нужен пакет, видящий оба». Этот пакет видит
 * оба, и с этого файла расхождение перестаёт быть молчаливым.
 *
 * ⚠ Тест **не** утверждает, что перечни совпали по числу значений. Они не
 * совпали и не должны: в `compliance` шесть, в `AUDIT_ROLES` пятнадцать, здесь
 * двенадцать ролей плюс два нечеловеческих актора. Одна из пятнадцати меток —
 * `approver` — выведена из употребления и живёт только ради прежних записей, а
 * `client` и `oracle` остаются прежними **именами** действующих ролей
 * (`DECISIONS-REVIEW.md` §O1).
 *
 * Тест утверждает проверяемое: **каждое чужое значение названо в карте**, и
 * каждая цель карты существует здесь. Значение, добавленное в `compliance` или
 * в `AUDIT_ROLES` без строки в карте, роняет сборку или этот тест.
 */
describe('сверка перечней ролей', () => {
  it('каждое значение AUDIT_ROLES названо в карте', () => {
    expect(unmappedJournalRoles([...AUDIT_ROLES])).toEqual([]);
  });

  it('и обратно: каждая метка карты есть в AUDIT_ROLES', () => {
    // Сверка в одну сторону пропустила бы метку, придуманную здесь и не
    // заведённую в журнале: роль записывалась бы значением, которого база не
    // знает, и падало бы это на вставке, а не на сборке.
    const known = new Set<string>(AUDIT_ROLES);
    expect(Object.keys(JOURNAL_ROLE_MAP).filter((label) => !known.has(label))).toEqual([]);
  });

  it('перечень compliance покрыт картой — проверяется типом', () => {
    // `RoleId` в `compliance` это тип без рантайм-перечня, поэтому сверка
    // компиляционная: новое значение там сделает эту запись неполной.
    const coverage: Record<ComplianceRoleId, readonly string[]> = {
      operator: JOURNAL_ROLE_MAP.operator,
      approver: JOURNAL_ROLE_MAP.approver,
      compliance_analyst: JOURNAL_ROLE_MAP.compliance_analyst,
      support: JOURNAL_ROLE_MAP.support,
      representative: JOURNAL_ROLE_MAP.representative,
      client: JOURNAL_ROLE_MAP.client,
    };
    expect(Object.keys(coverage)).toHaveLength(6);
  });

  it('сверка по пустому перечню — ошибка, а не «всё сошлось»', () => {
    // Единственное значение аргумента, при котором сверка отвечала «нарушений
    // нет», ничего не сверив: перечень, приехавший пустым, выглядел зелёным.
    expect(() => unmappedJournalRoles([])).toThrow();
  });

  it('чужое значение вне карты видно поимённо', () => {
    expect(unmappedJournalRoles(['operator', 'notary'])).toEqual(['notary']);
  });

  it('цели карты существуют в новом перечне', () => {
    expect(danglingJournalTargets()).toEqual([]);
  });

  it('approver расщеплён на два уровня утверждения и выведен из употребления', () => {
    const target: readonly string[] = JOURNAL_ROLE_MAP.approver;
    expect(target).toEqual(['financial_controller', 'head_of_operations']);
    // Строка осталась ради прежних записей: журнал не редактируется, и запись,
    // сделанная до `0023`, обязана читаться после неё.
    expect([...RETIRED_JOURNAL_ROLES]).toEqual(['approver']);
  });

  it('оба уровня утверждения имеют собственную метку', () => {
    // Ради этого расщепление и делалось: «утвердил approver» не отвечало на
    // вопрос, кто именно утвердил (`ACTORS.md` §1 расхождение №5, §5.2).
    expect(JOURNAL_ROLE_MAP.financial_controller).toEqual(['financial_controller']);
    expect(JOURNAL_ROLE_MAP.head_of_operations).toEqual(['head_of_operations']);
  });

  it('пять прежде непредставленных ролей названы в карте своими именами', () => {
    for (const role of [
      'oracle_operator',
      'compliance_officer',
      'principal',
      'auditor',
      'client_counsel',
    ] as const) {
      expect(JOURNAL_ROLE_MAP[role]).toEqual([role]);
    }
  });

  it('client остаётся прежним именем party: роль — свойство участия', () => {
    const legacy: JournalRoleId = 'client';
    expect(JOURNAL_ROLE_MAP[legacy]).toEqual(['party']);
  });

  it('oracle — источник события, а не человек', () => {
    expect(JOURNAL_ROLE_MAP.oracle).toEqual(['oracle_source']);
    expect(JOURNAL_ROLE_MAP.oracle).not.toContain('oracle_operator');
    // Оператор оракула — человек, и с `0023` у него своя метка.
    expect(JOURNAL_ROLE_MAP.oracle_operator).toEqual(['oracle_operator']);
  });
});
