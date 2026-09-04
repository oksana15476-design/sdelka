import { AUDIT_ROLES } from '@sdelka/audit';
import type { RoleId as ComplianceRoleId } from '@sdelka/compliance';
import { describe, expect, it } from 'vitest';
import {
  type LegacyRoleId,
  LEGACY_ROLE_MAP,
  danglingLegacyTargets,
  unmappedLegacyRoles,
} from '../src/index';

/**
 * `ACTORS.md` §1 расхождение №2: «расхождение перечней молчаливое: сверить их
 * тестом отсюда нельзя, для этого нужен пакет, видящий оба». Этот пакет видит
 * оба, и с этого файла расхождение перестаёт быть молчаливым.
 *
 * ⚠ Тест **не** утверждает, что перечни сошлись. Они не сошлись: в `compliance`
 * шесть значений, в `AUDIT_ROLES` восемь, здесь двенадцать плюс два
 * нечеловеческих актора, и переименования (`client → party`,
 * `approver → financial_controller`/`head_of_operations`,
 * `oracle → oracle_source`) — правки чужих пакетов и миграция `sdelka.audit_role`.
 * Тест утверждает другое и проверяемое: **каждое чужое значение названо в
 * карте**, и каждая цель карты существует здесь. Значение, добавленное в
 * `compliance` или в `AUDIT_ROLES` без строки в карте, роняет сборку или этот
 * тест.
 */
describe('сверка перечней ролей', () => {
  it('каждое значение AUDIT_ROLES названо в карте', () => {
    expect(unmappedLegacyRoles([...AUDIT_ROLES])).toEqual([]);
  });

  it('перечень compliance покрыт картой — проверяется типом', () => {
    // `RoleId` в `compliance` это тип без рантайм-перечня, поэтому сверка
    // компиляционная: новое значение там сделает эту запись неполной.
    const coverage: Record<ComplianceRoleId, readonly string[]> = {
      operator: LEGACY_ROLE_MAP.operator,
      approver: LEGACY_ROLE_MAP.approver,
      compliance_analyst: LEGACY_ROLE_MAP.compliance_analyst,
      support: LEGACY_ROLE_MAP.support,
      representative: LEGACY_ROLE_MAP.representative,
      client: LEGACY_ROLE_MAP.client,
    };
    expect(Object.keys(coverage)).toHaveLength(6);
  });

  it('цели карты существуют в новом перечне', () => {
    expect(danglingLegacyTargets()).toEqual([]);
  });

  it('approver расщеплён на два уровня утверждения', () => {
    const target: readonly string[] = LEGACY_ROLE_MAP.approver;
    expect(target).toEqual(['financial_controller', 'head_of_operations']);
  });

  it('client переезжает в party: роль — свойство участия, а не человека', () => {
    const legacy: LegacyRoleId = 'client';
    expect(LEGACY_ROLE_MAP[legacy]).toEqual(['party']);
  });

  it('oracle — источник события, а не человек', () => {
    expect(LEGACY_ROLE_MAP.oracle).toEqual(['oracle_source']);
    expect(LEGACY_ROLE_MAP.oracle).not.toContain('oracle_operator');
  });
});
