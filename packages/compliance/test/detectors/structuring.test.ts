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
