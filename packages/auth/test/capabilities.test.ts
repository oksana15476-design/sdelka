import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_SPECS,
  capabilitiesWithEffect,
  capabilityEffect,
  separationRulesFor,
} from '../src/index';

describe('перечень полномочий', () => {
  it('значения не повторяются', () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });

  it('каждое полномочие разобрано в обоих местах разбора', () => {
    // Смысл теста не в проверке — компилятор уже её сделал, — а в том, чтобы
    // при падении было видно, где именно перечень разъехался с разбором.
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_SPECS[capability]).toBeDefined();
      expect(separationRulesFor(capability)).toBeInstanceOf(Array);
    }
  });

  it('двадцать семь полномочий из ACTORS.md §5.1 плюс одно, введённое реализацией', () => {
    // ⚠ Документ называет три разных числа: «25 полномочий» прозой в §5,
    // «14 новых» в §12.1 п.6 и шестнадцать новых строк в таблице §5.1. Взят
    // перечень, а не число: строку легче проверить, чем арифметику. См. отчёт.
    expect(CAPABILITIES).toHaveLength(28);
    expect(CAPABILITIES).toContain('manage_access');
  });
});

describe('второй фактор', () => {
  it('требуется на всём, что двигает деньги или меняет реквизиты', () => {
    for (const capability of [
      'approve_payout',
      'approve_beneficiary_change',
      'approve_lift_block',
      'lift_block',
      'lift_halt',
      'write_beneficiary',
      'confirm_test_transfer_code',
      'manage_settings',
    ] as const) {
      expect(CAPABILITY_SPECS[capability].secondFactor).toBe('step_up');
    }
  });

  it('не требуется на сужающих: стоп-кран работает ночью с чужого телефона', () => {
    for (const capability of ['halt_intake', 'freeze_participation', 'confirm_incident'] as const) {
      expect(CAPABILITY_SPECS[capability].secondFactor).toBe('none');
      expect(capabilityEffect(capability)).toBe('narrow');
    }
  });
});

describe('классы действий', () => {
  it('расширяющие названы поимённо', () => {
    expect([...capabilitiesWithEffect('release')].sort()).toEqual(
      [
        'adjudicate_screening',
        'approve_beneficiary_change',
        'approve_lift_block',
        'approve_payout',
        'lift_block',
        'lift_halt',
      ].sort(),
    );
  });

  it('чтение ничего не двигает и в журнал построчно не пишется', () => {
    for (const capability of capabilitiesWithEffect('read')) {
      expect(CAPABILITY_SPECS[capability].journaled).toBe(false);
    }
  });

  it('всё, что не чтение, попадает в журнал', () => {
    for (const capability of CAPABILITIES) {
      if (CAPABILITY_SPECS[capability].effect === 'read') continue;
      expect(CAPABILITY_SPECS[capability].journaled).toBe(true);
    }
  });
});

describe('несовместимости привязаны к полномочиям', () => {
  it('утверждение выплаты связано тремя сразу', () => {
    expect(separationRulesFor('approve_payout')).toEqual([
      'n1_preparer_not_approver',
      'n2_observer_not_approver',
      'n3_levels_distinct',
      'n6_economics_not_money',
    ]);
  });

  it('сужающие не связаны ничем — иначе ночью их нечем нажать', () => {
    expect(separationRulesFor('halt_intake')).toEqual([]);
    expect(separationRulesFor('freeze_participation')).toEqual([]);
    expect(separationRulesFor('confirm_incident')).toEqual([]);
  });
});
