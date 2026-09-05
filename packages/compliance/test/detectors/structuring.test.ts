import { money } from '@sdelka/money';
import { type Instant, instant } from '@sdelka/domain';
import { describe, expect, it } from 'vitest';
import { type InboundPayment, assessStructuring } from '../../src/index';
import { evidence, NOW, POLICY, POLICY_VERSION } from '../support/fixtures';

const DAY_MS = 24 * 60 * 60 * 1000;

function at(daysAgo: number): Instant {
  return instant(NOW - daysAgo * DAY_MS);
}

function payment(id: string, minor: bigint, daysAgo: number, payer = 'payer-1'): InboundPayment {
  return { paymentId: id, amount: money('GEL', minor), receivedAt: at(daysAgo), payerKey: payer };
}

const assess = (payments: readonly InboundPayment[]) =>
  assessStructuring(
    { payments, evidence: [evidence(1, 'bank_statement')] },
    POLICY_VERSION,
    POLICY.structuring,
    NOW,
  );

describe('разбиение платежа', () => {
  it('срабатывает: три платежа ниже порога в окне, в сумме порог перекрыт', () => {
    const result = assess([
      payment('p1', 1_100_000n, 5),
      payment('p2', 1_100_000n, 3),
      payment('p3', 1_100_000n, 1),
    ]);
    expect(result.outcome).toBe('review');
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.totalMinor).toBe(3_300_000n);
    expect(result.clusters[0]?.paymentIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('не срабатывает: два платежа — это добор после недоплаты', () => {
    const result = assess([payment('p1', 1_500_000n, 3), payment('p2', 1_600_000n, 1)]);
    expect(result.outcome).toBe('clear');
    expect(result.clusters).toHaveLength(0);
  });

  it('не срабатывает: три платежа, но в сумме порог не перекрыт', () => {
    const result = assess([
      payment('p1', 500_000n, 5),
      payment('p2', 500_000n, 3),
      payment('p3', 500_000n, 1),
    ]);
    expect(result.outcome).toBe('clear');
  });

  it('не срабатывает: платежи разнесены за пределы окна', () => {
    const result = assess([
      payment('p1', 1_100_000n, 30),
      payment('p2', 1_100_000n, 20),
      payment('p3', 1_100_000n, 1),
    ]);
    expect(result.outcome).toBe('clear');
  });

  it('не срабатывает: платежи от разных плательщиков', () => {
    const result = assess([
      payment('p1', 1_100_000n, 5, 'payer-1'),
      payment('p2', 1_100_000n, 3, 'payer-2'),
      payment('p3', 1_100_000n, 1, 'payer-3'),
    ]);
    expect(result.outcome).toBe('clear');
  });

  it('не срабатывает: один платёж крупнее порога дроблением не является', () => {
    const result = assess([
      payment('p1', 4_000_000n, 5),
      payment('p2', 4_000_000n, 3),
      payment('p3', 4_000_000n, 1),
    ]);
    expect(result.outcome).toBe('clear');
  });
});

/**
 * Границы. Признак сформулирован как «каждый платёж **строго ниже** порога, а в
 * сумме порог перекрыт, и всё это внутри окна» — три сравнения, у каждого своя
 * сторона границы, и ошибка на единицу в любом из них меняет исход разбора.
 */
describe('разбиение платежа: границы порога, суммы и окна', () => {
  it('платёж ровно на пороге дроблением не является: «строго ниже» — строго', () => {
    const atThreshold = POLICY.structuring.threshold.minor;
    const result = assess([
      payment('p1', atThreshold, 5),
      payment('p2', atThreshold, 3),
      payment('p3', atThreshold, 1),
    ]);
    expect(result.outcome).toBe('clear');
    expect(result.clusters).toHaveLength(0);
  });

  it('платёж на одну тетри ниже порога уже считается', () => {
    const belowThreshold = POLICY.structuring.threshold.minor - 1n;
    const result = assess([
      payment('p1', belowThreshold, 5),
      payment('p2', belowThreshold, 3),
      payment('p3', belowThreshold, 1),
    ]);
    expect(result.outcome).toBe('review');
  });

  it('сумма ровно на пороге кластер даёт: порог перекрыт равенством', () => {
    // Три платежа по трети порога: каждый строго ниже, в сумме ровно порог.
    const third = POLICY.structuring.threshold.minor / 3n;
    const result = assess([payment('p1', third, 5), payment('p2', third, 3), payment('p3', third, 1)]);
    expect(result.outcome).toBe('review');
    expect(result.clusters[0]?.totalMinor).toBe(POLICY.structuring.threshold.minor);
  });

  it('сумма на одну тетри ниже порога кластера не даёт', () => {
    const third = POLICY.structuring.threshold.minor / 3n;
    const result = assess([
      payment('p1', third - 1n, 5),
      payment('p2', third, 3),
      payment('p3', third, 1),
    ]);
    expect(result.outcome).toBe('clear');
  });

  it('разрыв ровно в окно платежи не разводит: граница включающая', () => {
    // Между первым и последним ровно семь дней — длина окна политики.
    const result = assess([
      payment('p1', 1_100_000n, 8),
      payment('p2', 1_100_000n, 5),
      payment('p3', 1_100_000n, 1),
    ]);
    expect(result.outcome).toBe('review');
    expect(result.clusters[0]?.paymentIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('разрыв на миллисекунду больше окна крайний платёж отбрасывает', () => {
    // От последнего платежа (день назад) до первого получается 7 дней и одна
    // миллисекунда — на одну больше окна.
    const beyond = instant(NOW - (8 * DAY_MS + 1));
    const result = assess([
      { paymentId: 'p1', amount: money('GEL', 1_100_000n), receivedAt: beyond, payerKey: 'payer-1' },
      payment('p2', 1_100_000n, 5),
      payment('p3', 1_100_000n, 1),
    ]);
    expect(result.outcome).toBe('clear');
  });

  it('на плательщика заводится один кластер, а не по одному на каждое окно', () => {
    // Четыре платежа подряд: окон, перекрывающих порог, здесь два, но факт один.
    const result = assess([
      payment('p1', 1_100_000n, 6),
      payment('p2', 1_100_000n, 4),
      payment('p3', 1_100_000n, 2),
      payment('p4', 1_100_000n, 1),
    ]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.paymentIds).toEqual(['p1', 'p2', 'p3']);
  });
});
