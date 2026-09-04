import { describe, expect, it } from 'vitest';
import {
  type AllocationInput,
  type ChargesBearer,
  CHARGES_BEARERS,
  INTAKE_REASON_KEYS,
  allocateIncoming,
  allocationBalances,
} from '../src/index';
import { gel, usd } from './support/fixtures';

const REQUIRED = gel(20_000_000n);
const TOLERANCE = gel(5_000n);

function input(overrides: Partial<AllocationInput> = {}): AllocationInput {
  return {
    required: REQUIRED,
    freeBefore: gel(0n),
    incoming: REQUIRED,
    tolerance: TOLERANCE,
    chargesBearer: 'shared',
    ...overrides,
  };
}

function run(overrides: Partial<AllocationInput> = {}) {
  const args = input(overrides);
  const plan = allocateIncoming(args);
  // Сходимость проверяется на каждом кейсе, а не отдельным тестом: план, который
  // не сходится, — это дыра в учёте, и она обязана падать там же, где возникла.
  expect(allocationBalances(args, plan)).toBe(true);
  return plan;
}

describe('пришло ровно требуемое', () => {
  it('транш зачисляется, свободная часть пуста', () => {
    const plan = run();
    expect(plan.kind).toBe('exact');
    expect(plan.toTranche.minor).toBe(REQUIRED.minor);
    expect(plan.shortfall.minor).toBe(0n);
    expect(plan.freeAfter.minor).toBe(0n);
  });
});

describe('переплата', () => {
  it('транш ровно на требуемую, излишек в свободную часть сразу', () => {
    const plan = run({ incoming: gel(20_100_000n) });
    expect(plan.kind).toBe('overpayment');
    expect(plan.toTranche.minor).toBe(REQUIRED.minor);
    expect(plan.freeAfter.minor).toBe(100_000n);
    expect(plan.reasons).toContain(INTAKE_REASON_KEYS.allocationOverpayment);
  });

  it('излишек не ждёт закрытия сделки: он уже в свободной части', () => {
    // `ROADMAP.md` И2.1 критерий 4 говорит обратное и подлежит правке
    // (`FUNCTIONAL.md` §4.3.2 [решение, исправляет предыдущее], красная линия №7).
    const plan = run({ incoming: gel(30_000_000n) });
    expect(plan.freeAfter.minor).toBe(10_000_000n);
  });
});

describe('недоплата в пределах допуска — случай А, платформа доносит', () => {
  it('ровно допуск проходит', () => {
    const plan = run({ incoming: gel(20_000_000n - 5_000n) });
    expect(plan.kind).toBe('shortfall_absorbed');
    expect(plan.toTranche.minor).toBe(REQUIRED.minor);
    expect(plan.shortfall.minor).toBe(5_000n);
  });

  it('допуск плюс одна минорная единица уже не проходит', () => {
    const plan = run({ incoming: gel(20_000_000n - 5_001n) });
    expect(plan.kind).toBe('insufficient');
    expect(plan.missing.minor).toBe(5_001n);
  });

  it('недостача вынесена отдельным полем, а не спрятана в сумме транша', () => {
    const plan = run({ incoming: gel(20_000_000n - 100n) });
    // Транш на полную сумму, но 100 из них платформа ещё не донесла: до второй
    // записи транш не обеспечен, и это обязано быть видно (`FUNCTIONAL.md` §3.1).
    expect(plan.toTranche.minor).toBe(REQUIRED.minor);
    expect(plan.shortfall.minor).toBe(100n);
  });
});

describe('различает причина, а не размер', () => {
  it('отправитель оплатил все расходы — недостача не покрывается ни при каком размере', () => {
    const plan = run({ incoming: gel(20_000_000n - 1n), chargesBearer: 'sender_pays_all' });
    expect(plan.kind).toBe('insufficient');
    expect(plan.reasons).toContain(INTAKE_REASON_KEYS.shortfallCausePayer);
  });

  it('поле отнесения расходов не прочитано — ведёт себя как «платит отправитель»', () => {
    const plan = run({ incoming: gel(20_000_000n - 1n), chargesBearer: 'unknown' });
    expect(plan.kind).toBe('insufficient');
    expect(plan.reasons).toContain(INTAKE_REASON_KEYS.shortfallCauseUnknown);
  });

  it('расходы разделены или на получателе — срез корреспондента законен', () => {
    for (const bearer of ['shared', 'beneficiary_pays'] as const) {
      const plan = run({ incoming: gel(20_000_000n - 1n), chargesBearer: bearer });
      expect(plan.kind).toBe('shortfall_absorbed');
      expect(plan.reasons).toContain(INTAKE_REASON_KEYS.shortfallCauseCorrespondent);
    }
  });

  it('перечень видов отнесения расходов закрыт и каждый имеет исход', () => {
    for (const bearer of CHARGES_BEARERS satisfies readonly ChargesBearer[]) {
      expect(() => run({ incoming: gel(19_999_999n), chargesBearer: bearer })).not.toThrow();
    }
  });
});

describe('недоплата сверх допуска', () => {
  it('на транш не зачисляется, деньги на счёте клиента, показана недостающая сумма', () => {
    const plan = run({ incoming: gel(19_900_000n) });
    expect(plan.kind).toBe('insufficient');
    expect(plan.toTranche.minor).toBe(0n);
    expect(plan.freeAfter.minor).toBe(19_900_000n);
    expect(plan.missing.minor).toBe(100_000n);
    expect(plan.reasons).toContain(INTAKE_REASON_KEYS.shortfallAwaitsTopUp);
  });
});

describe('дробные платежи считаются той же формулой', () => {
  it('три трети накапливают транш ровно на требуемую сумму', () => {
    const third = gel(6_666_667n);
    const first = run({ incoming: third, freeBefore: gel(0n) });
    expect(first.kind).toBe('insufficient');

    const second = run({ incoming: third, freeBefore: first.freeAfter });
    expect(second.kind).toBe('insufficient');

    const third_ = run({ incoming: gel(6_666_666n), freeBefore: second.freeAfter });
    expect(third_.kind).toBe('exact');
    expect(third_.toTranche.minor).toBe(REQUIRED.minor);
  });

  it('допуск применяется один раз к итогу, а не к каждому платежу', () => {
    // Три платежа, каждый на 4000 минорных меньше своей трети: по отдельности
    // каждый «в допуске», суммарно недостача 12 000 — втрое больше объявленного.
    const short = gel(6_662_667n);
    const first = run({ incoming: short });
    const second = run({ incoming: short, freeBefore: first.freeAfter });
    const last = run({ incoming: gel(6_662_666n), freeBefore: second.freeAfter });
    expect(last.kind).toBe('insufficient');
    expect(last.missing.minor).toBe(12_000n);
  });
});

describe('поступление в чужой валюте', () => {
  it('не отвергается и не зачисляется на транш — ложится на счёт клиента в своей валюте', () => {
    const plan = run({ incoming: usd(8_000_000n) });
    expect(plan.kind).toBe('wrong_currency');
    expect(plan.toClientFree.currency).toBe('USD');
    expect(plan.toTranche.minor).toBe(0n);
    expect(plan.reasons).toContain(INTAKE_REASON_KEYS.allocationWrongCurrency);
  });

  it('свободный остаток в чужой валюте — ошибка вызывающего, а не исход правила', () => {
    expect(() => allocateIncoming(input({ freeBefore: usd(1n) }))).toThrow();
  });
});

describe('отрицательные суммы отвергаются', () => {
  it('отрицательное поступление не разносится', () => {
    expect(() => allocateIncoming(input({ incoming: gel(-1n) }))).toThrow();
  });

  it('отрицательный допуск не разносится', () => {
    expect(() => allocateIncoming(input({ tolerance: gel(-1n) }))).toThrow();
  });
});

describe('сходимость плана', () => {
  it('подделанный план с недостачей за счёт клиента не сходится', () => {
    const args = input({ incoming: gel(20_000_000n - 100n) });
    const plan = allocateIncoming(args);
    const forged = { ...plan, shortfall: gel(0n) };
    expect(allocationBalances(args, forged)).toBe(false);
  });
});
