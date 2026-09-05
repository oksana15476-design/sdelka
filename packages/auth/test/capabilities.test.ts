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

  it('двадцать семь полномочий из ACTORS.md §5.1, одно от реализации и пять из §5.1.1', () => {
    // ⚠ Документ называет три разных числа: «25 полномочий» прозой в §5,
    // «14 новых» в §12.1 п.6 и шестнадцать новых строк в таблице §5.1. Взят
    // перечень, а не число: строку легче проверить, чем арифметику. См. отчёт.
    expect(CAPABILITIES).toHaveLength(33);
    expect(CAPABILITIES).toContain('manage_access');
  });

  it('операционная механика расчёта разведена на пять, а не собрана в одно', () => {
    // `ACTORS.md` §5.1.1. Смысл разделения обязанностей в том, что готовит,
    // вносит внешний факт и двигает деньги платформы — не один человек.
    // Склеенное «вести расчёт» отменяло бы это одной строкой перечня.
    expect(CAPABILITIES.slice(-5)).toEqual([
      'prepare_settlement',
      'record_bank_outcome',
      'operate_treasury',
      'conduct_withdrawal',
      'patch_tranche_facts',
    ]);
  });

  it('порядок перечня — он же порядок меток sdelka.capability: новое только в конец', () => {
    // `ALTER TYPE … ADD VALUE` вставку в середину не делает, а порядок меток
    // виден в `ORDER BY`. Перестановка строк здесь — это молча разошедшаяся
    // сортировка в отчёте дежурному, и ловится она только тестом дрейфа в
    // `packages/db`, то есть на два пакета позже. Рубеж ставится здесь.
    expect(CAPABILITIES.indexOf('prepare_settlement')).toBe(
      CAPABILITIES.indexOf('act_on_behalf') + 1,
    );
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
      // §5.1.1: внешний факт платежа, казначейство, вывод и чёрный ход правки
      // фактов — каждый определяет, куда и сколько уйдёт.
      'record_bank_outcome',
      'operate_treasury',
      'conduct_withdrawal',
      'patch_tranche_facts',
    ] as const) {
      expect(CAPABILITY_SPECS[capability].secondFactor).toBe('step_up');
    }
  });

  it('не требуется на подготовке расчёта: она ничего не двигает сама', () => {
    // Единственное из пяти §5.1.1 без фактора. Выдача инструкций на оплату
    // проходит через утверждение, у которого фактор есть; требовать
    // подтверждение двадцать раз в день там, где цена ошибки — переделанная
    // бумага, значит приучить подтверждать не глядя.
    expect(CAPABILITY_SPECS.prepare_settlement.secondFactor).toBe('none');
    expect(capabilityEffect('prepare_settlement')).toBe('prepare');
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
        // §5.1.1: казначейство двигает деньги платформы — недостачу признаёт
        // расходом она, комиссия уходит на операционный счёт. Это `release`, и
        // Н6 связывает его наравне со снятием блокировки.
        'operate_treasury',
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

  it('казначейство связано Н6: видит маржу — не двигает деньги', () => {
    expect(separationRulesFor('operate_treasury')).toEqual(['n6_economics_not_money']);
  });

  it('механика расчёта не связана несовместимостями на фактах — иначе шаг «платформа» непроводим', () => {
    // Предмет части этих шагов — платформа (движение по невыясненным
    // поступлениям, конвертация остатка клиента), а у него фактов нет по
    // построению: `actionContextFor` отвечает «неизвестно», и полномочие,
    // связанное Н1, Н2, Н4 или Н5, не выдалось бы вовсе. То есть зачислить
    // деньги по выписке стало бы невозможно — отказ был бы не строгостью, а
    // неработающим продуктом.
    for (const capability of [
      'prepare_settlement',
      'record_bank_outcome',
      'conduct_withdrawal',
      'patch_tranche_facts',
    ] as const) {
      expect(separationRulesFor(capability)).toEqual([]);
    }
  });

  it('сужающие не связаны ничем — иначе ночью их нечем нажать', () => {
    expect(separationRulesFor('halt_intake')).toEqual([]);
    expect(separationRulesFor('freeze_participation')).toEqual([]);
    expect(separationRulesFor('confirm_incident')).toEqual([]);
  });
});
