import { describe, expect, it } from 'vitest';
import {
  APPROVAL_LEVELS,
  BENEFICIARY_DISCLOSURE,
  CAPABILITIES,
  CAPABILITY_SPECS,
  DUTY_CAPABILITIES,
  NON_HUMAN_ACTORS,
  ROLE_CAPABILITIES,
  ROLE_IDS,
  ROLE_SPECS,
  approvalLevelViolations,
  beneficiaryDisclosure,
  effectiveCapabilities,
  roleHasCapability,
  roleInvariantViolations,
} from '../src/index';

describe('карта ролей', () => {
  it('тринадцать носителей: двенадцать ролей доступа плюс дежурство как режим', () => {
    // `ACTORS.md` §3.1 перечисляет 13 строк, но одна из них — `ДЖ`, и она прямо
    // помечена «не роль, флаг onDuty». Ролей в перечне поэтому двенадцать.
    expect(ROLE_IDS).toHaveLength(12);
    expect(ROLE_IDS).toContain('principal');
    expect(ROLE_IDS).toContain('oracle_operator');
    expect(ROLE_IDS).not.toContain('system');
    expect(ROLE_IDS).not.toContain('oracle_source');
    expect(NON_HUMAN_ACTORS).toEqual(['system', 'oracle_source']);
  });

  it('инварианты карты выдержаны', () => {
    expect(roleInvariantViolations()).toEqual([]);
  });

  it('уровень утверждения даёт ровно одна роль на каждый уровень', () => {
    expect(approvalLevelViolations()).toEqual([]);
    expect(APPROVAL_LEVELS.financial_controller).toBe(1);
    expect(APPROVAL_LEVELS.head_of_operations).toBe(2);
  });

  it('каждая роль и каждое полномочие описаны', () => {
    for (const roleId of ROLE_IDS) {
      expect(ROLE_SPECS[roleId].source).not.toBe('');
      expect(ROLE_CAPABILITIES[roleId].length).toBeGreaterThan(0);
    }
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_SPECS[capability].source).not.toBe('');
    }
  });
});

describe('владелец', () => {
  it('не имеет права утверждения выплаты — ни первым уровнем, ни вторым', () => {
    expect(roleHasCapability('principal', 'approve_payout')).toBe(false);
    expect(APPROVAL_LEVELS.principal).toBeNull();
  });

  it('не снимает блокировок, не останавливает приём и не работает от имени', () => {
    for (const forbidden of [
      'lift_block',
      'approve_lift_block',
      'lift_halt',
      'halt_intake',
      'write_beneficiary',
      'act_on_behalf',
      'approve_beneficiary_change',
    ] as const) {
      expect(roleHasCapability('principal', forbidden)).toBe(false);
    }
  });

  it('не видит имён клиентов и не видит реквизитов', () => {
    // §4.5: роль, видящая и деньги, и персональные данные, — одна украденная
    // сессия до полного досье на клиентскую базу.
    expect(roleHasCapability('principal', 'read_party')).toBe(false);
    expect(beneficiaryDisclosure('principal')).toBe('none');
  });

  it('видит экономику и двигает рычаги', () => {
    expect(roleHasCapability('principal', 'read_economics')).toBe(true);
    expect(roleHasCapability('principal', 'manage_settings')).toBe(true);
  });
});

describe('поддержка', () => {
  it('не имеет полномочия на реквизиты ни на чтение, ни на запись', () => {
    expect(roleHasCapability('support', 'read_beneficiary')).toBe(false);
    expect(roleHasCapability('support', 'write_beneficiary')).toBe(false);
  });

  it('никогда не видит значения реквизитов — ни маски, ни по исключению', () => {
    expect(beneficiaryDisclosure('support')).toBe('status_only');
  });

  it('не утверждает выплаты — её утверждение нечем даже собрать', () => {
    expect(roleHasCapability('support', 'approve_payout')).toBe(false);
    expect(APPROVAL_LEVELS.support).toBeNull();
  });
});

describe('реквизиты выплаты', () => {
  it('полного значения не видит ни одна внутренняя роль', () => {
    for (const roleId of ROLE_IDS) {
      if (ROLE_SPECS[roleId].audience === 'client') continue;
      expect(BENEFICIARY_DISCLOSURE[roleId]).not.toBe('full');
    }
  });

  it('оператор реквизиты не вводит: полномочие снято (ACTORS.md §4.2)', () => {
    expect(roleHasCapability('operator', 'write_beneficiary')).toBe(false);
  });
});

describe('дежурство', () => {
  it('режим поверх ОП, ФК, РО и больше ни поверх чего', () => {
    const eligible = ROLE_IDS.filter((roleId) => ROLE_SPECS[roleId].dutyEligible);
    expect(eligible).toEqual(['operator', 'financial_controller', 'head_of_operations']);
  });

  it('добавляет ровно три сужающих полномочия и не убирает ничего', () => {
    const base = ROLE_CAPABILITIES.operator;
    const onDuty = effectiveCapabilities('operator', true);
    for (const capability of base) expect(onDuty).toContain(capability);
    for (const capability of DUTY_CAPABILITIES) expect(onDuty).toContain(capability);
    expect(DUTY_CAPABILITIES).toHaveLength(3);
  });

  it('роли, которая не дежурит, флаг дежурства ничего не добавляет', () => {
    // §7.1: дежурство — режим поверх ОП, ФК и РО, и больше ни поверх чего.
    // Проверка стояла только на выдаче сессии; здесь второй рубеж, потому что
    // флаг приезжает из хранилища вместе с сессией.
    const onDuty = effectiveCapabilities('compliance_analyst', true);
    expect(onDuty).toEqual(ROLE_CAPABILITIES.compliance_analyst);
    for (const capability of DUTY_CAPABILITIES) {
      if (roleHasCapability('compliance_analyst', capability)) continue;
      expect(onDuty).not.toContain(capability);
    }
  });

  it('не даёт снять остановку — расширяющего полномочия у дежурства нет', () => {
    expect(effectiveCapabilities('operator', true)).not.toContain('lift_halt');
    for (const capability of DUTY_CAPABILITIES) {
      expect(CAPABILITY_SPECS[capability].effect).toBe('narrow');
    }
  });
});

describe('операционная механика расчёта — ACTORS.md §5.1.1', () => {
  const SETTLEMENT = [
    'prepare_settlement',
    'record_bank_outcome',
    'operate_treasury',
    'conduct_withdrawal',
    'patch_tranche_facts',
  ] as const;

  it('оператор готовит расчёт, вносит внешний факт, ведёт вывод и правит факты', () => {
    for (const capability of [
      'prepare_settlement',
      'record_bank_outcome',
      'conduct_withdrawal',
      'patch_tranche_facts',
    ] as const) {
      expect(roleHasCapability('operator', capability)).toBe(true);
    }
  });

  it('казначейство — у ФК, и больше ни у кого', () => {
    // §6.7: ежедневная сверка, покрытие, пофайловое обеспечение. Конвертация,
    // довнесение недостачи и получение комиссии — это они и есть.
    const holders = ROLE_IDS.filter((roleId) => roleHasCapability(roleId, 'operate_treasury'));
    expect(holders).toEqual(['financial_controller']);
  });

  it('оператор не двигает деньги платформы, ФК не готовит расчёт', () => {
    // Разделение обязанностей выражено **перечнем**, а не дисциплиной: одна
    // учётная запись между обязательством и его покрытием — это и есть то, что
    // §6.7 запрещает ФК прозой («готовить операцию, которую утверждает»).
    expect(roleHasCapability('operator', 'operate_treasury')).toBe(false);
    for (const capability of [
      'prepare_settlement',
      'record_bank_outcome',
      'conduct_withdrawal',
      'patch_tranche_facts',
    ] as const) {
      expect(roleHasCapability('financial_controller', capability)).toBe(false);
    }
  });

  it('ни одно из пяти не достаётся владельцу, стороне, поддержке и аудитору', () => {
    // Н6 для владельца проверяется классом действия (`roleInvariantViolations`),
    // здесь — поимённо и для остальных: полномочие механики расчёта у стороны
    // означало бы, что клиент зачисляет себе деньги по выписке.
    for (const roleId of ['principal', 'party', 'support', 'auditor', 'client_counsel'] as const) {
      for (const capability of SETTLEMENT) {
        expect(roleHasCapability(roleId, capability), `${roleId}:${capability}`).toBe(false);
      }
    }
  });

  it('дежурство ни одного из пяти не добавляет', () => {
    // §7.3: дежурство добавляет только сужающие. Все пять — `prepare` и
    // `release`, то есть в ночную смену с чужого телефона их не появляется.
    const onDuty = effectiveCapabilities('financial_controller', true);
    const base = ROLE_CAPABILITIES.financial_controller;
    for (const capability of SETTLEMENT) {
      if (base.includes(capability)) continue;
      expect(onDuty).not.toContain(capability);
    }
  });
});

describe('стоп-кран и заморозка участия — разные механизмы', () => {
  it('сторона останавливает своё участие и не останавливает платформу', () => {
    expect(roleHasCapability('party', 'freeze_participation')).toBe(true);
    expect(roleHasCapability('party', 'halt_intake')).toBe(false);
  });

  it('сотрудник останавливает платформу', () => {
    expect(roleHasCapability('operator', 'halt_intake')).toBe(true);
    expect(roleHasCapability('support', 'halt_intake')).toBe(true);
  });
});
