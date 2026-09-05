import { describe, expect, it } from 'vitest';
import { money } from '@sdelka/money';
import {
  type IntakePolicy,
  type ToleranceDisclosure,
  INTAKE_REASON_KEYS,
  PROPOSED_INTAKE_POLICY,
  effectiveTolerance,
  intakePolicyVersionId,
  toleranceFor,
} from '../src/index';
import { NOW, at, gel, usd } from './support/fixtures';

const REQUIRED = gel(20_000_000n);

function disclosure(overrides: Partial<ToleranceDisclosure> = {}): ToleranceDisclosure {
  const byPolicy = toleranceFor(REQUIRED, PROPOSED_INTAKE_POLICY);
  return {
    dealId: 'deal-1',
    trancheId: 't1',
    requiredAmount: REQUIRED,
    tolerance: byPolicy.kind === 'declared' ? byPolicy.amount : gel(0n),
    policyVersionId: PROPOSED_INTAKE_POLICY.version,
    disclosedAt: at(-60_000),
    ...overrides,
  };
}

describe('раскрытие допуска — записанный факт, а не свойство экрана', () => {
  it('раскрытый допуск применяется', () => {
    const effective = effectiveTolerance(REQUIRED, PROPOSED_INTAKE_POLICY, disclosure(), NOW);
    // 200 000 лари × 0,5% = 1000 лари = 100 000 минорных; абсолют 50 лари меньше.
    expect(effective.amount.minor).toBe(5_000n);
    expect(effective.reasons).toContain(INTAKE_REASON_KEYS.toleranceApplied);
  });

  it('факта раскрытия нет — допуск ноль', () => {
    const effective = effectiveTolerance(REQUIRED, PROPOSED_INTAKE_POLICY, null, NOW);
    expect(effective.amount.minor).toBe(0n);
    expect(effective.reasons).toContain(INTAKE_REASON_KEYS.toleranceNotDisclosed);
  });

  it('раскрыто позже поступления — то же, что не раскрыто вовсе', () => {
    const late = disclosure({ disclosedAt: at(60_000) });
    const effective = effectiveTolerance(REQUIRED, PROPOSED_INTAKE_POLICY, late, NOW);
    expect(effective.amount.minor).toBe(0n);
    expect(effective.reasons).toContain(INTAKE_REASON_KEYS.toleranceDisclosedAfterPayment);
  });

  it('раскрытие ровно в момент поступления — не «позже»', () => {
    // Задним числом объявить нельзя, но одновременность задним числом не
    // является: инструкция и платёж легко попадают в одну миллисекунду, и
    // строгая сторона границы здесь молча обнулила бы объявленный допуск.
    const simultaneous = disclosure({ disclosedAt: NOW });
    const effective = effectiveTolerance(REQUIRED, PROPOSED_INTAKE_POLICY, simultaneous, NOW);
    expect(effective.amount.minor).toBe(5_000n);
    expect(effective.reasons).not.toContain(INTAKE_REASON_KEYS.toleranceDisclosedAfterPayment);
  });

  it('раскрытие на миллисекунду позже поступления допуск обнуляет', () => {
    const late = disclosure({ disclosedAt: at(1) });
    const effective = effectiveTolerance(REQUIRED, PROPOSED_INTAKE_POLICY, late, NOW);
    expect(effective.amount.minor).toBe(0n);
    expect(effective.reasons).toContain(INTAKE_REASON_KEYS.toleranceDisclosedAfterPayment);
  });

  it('раскрыто под другую требуемую сумму — факт устарел, допуск ноль', () => {
    const stale = disclosure({ requiredAmount: gel(19_000_000n) });
    const effective = effectiveTolerance(REQUIRED, PROPOSED_INTAKE_POLICY, stale, NOW);
    expect(effective.amount.minor).toBe(0n);
    expect(effective.reasons).toContain(INTAKE_REASON_KEYS.toleranceDisclosureStale);
  });

  it('раскрыто в другой валюте — факт устарел, допуск ноль', () => {
    const stale = disclosure({ requiredAmount: usd(20_000_000n) });
    const effective = effectiveTolerance(REQUIRED, PROPOSED_INTAKE_POLICY, stale, NOW);
    expect(effective.amount.minor).toBe(0n);
  });

  it('объявленная величина в другой валюте — тоже устаревший факт, а не старая политика', () => {
    // Сумма та же, а объявленный допуск в долларах: применить его к требованию
    // в лари можно только через курс, то есть через внешний факт, которого в
    // объявлении не было. Причина именно «факт устарел»: «старая политика»
    // сказала бы оператору, что величину надо сверить с нынешней, а сверять
    // нечего.
    const foreign = disclosure({ tolerance: usd(5_000n) });
    const effective = effectiveTolerance(REQUIRED, PROPOSED_INTAKE_POLICY, foreign, NOW);
    expect(effective.amount.minor).toBe(0n);
    expect(effective.reasons).toEqual([INTAKE_REASON_KEYS.toleranceDisclosureStale]);
  });

  it('объявленный ноль — это «допуск нулевой», а не «допуск не раскрыт»', () => {
    // Ноль объявлен и показан стороне: строгое равенство суммы. Причина «не
    // раскрыт» на этом же нуле означала бы, что обещания не было вовсе, — а оно
    // было, и A2 доказывается именно им.
    const strict = disclosure({ tolerance: gel(0n) });
    const effective = effectiveTolerance(REQUIRED, PROPOSED_INTAKE_POLICY, strict, NOW);
    expect(effective.amount.minor).toBe(0n);
    expect(effective.reasons).toEqual([INTAKE_REASON_KEYS.toleranceZero]);
  });
});

describe('смена политики не расширяет допуск задним числом', () => {
  const otherVersion = intakePolicyVersionId('intake/2026-01-01.1');

  it('объявили меньше, чем позволяет нынешняя политика — применяется объявленное', () => {
    const modest = disclosure({ tolerance: gel(1_000n), policyVersionId: otherVersion });
    const effective = effectiveTolerance(REQUIRED, PROPOSED_INTAKE_POLICY, modest, NOW);
    expect(effective.amount.minor).toBe(1_000n);
    expect(effective.reasons).toContain(INTAKE_REASON_KEYS.toleranceDisclosureOlderPolicy);
  });

  it('объявили больше, чем позволяет нынешняя политика — применяется нынешняя', () => {
    const generous = disclosure({ tolerance: gel(999_999n), policyVersionId: otherVersion });
    const effective = effectiveTolerance(REQUIRED, PROPOSED_INTAKE_POLICY, generous, NOW);
    expect(effective.amount.minor).toBe(5_000n);
  });

  it('политика перестала объявлять допуск для валюты — допуск ноль', () => {
    const narrowed: IntakePolicy = Object.freeze({
      ...PROPOSED_INTAKE_POLICY,
      tolerance: Object.freeze({
        ...PROPOSED_INTAKE_POLICY.tolerance,
        absolute: Object.freeze([money('USD', 2_000n)]),
      }),
    });
    const effective = effectiveTolerance(REQUIRED, narrowed, disclosure(), NOW);
    expect(effective.amount.minor).toBe(0n);
    // Две причины, и обе нужны: первая объясняет, почему нынешняя политика даёт
    // ноль, вторая — что объявление было и оно от прежней политики. Одна без
    // другой читается либо как «мы ничего не обещали», либо как «обещание
    // потеряли».
    expect(effective.reasons).toEqual([
      INTAKE_REASON_KEYS.toleranceCurrencyNotDeclared,
      INTAKE_REASON_KEYS.toleranceDisclosureOlderPolicy,
    ]);
  });
});
