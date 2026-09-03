import { type Money, isoDate, money, rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type ApprovalPolicy,
  type OfficialRateAtCreation,
  DEFAULT_APPROVAL_POLICY,
  RejectionCode,
  requiredApprovals,
} from '../src/index';
import { CREATED_ON, context } from './support/facts';
import { accept, reject, stateAt } from './support/drive';

const policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY;

/** Официальный курс Нацбанка на дату создания транша, 2,50 лари за доллар. */
const official: OfficialRateAtCreation = {
  asOf: CREATED_ON,
  from: 'USD',
  to: 'GEL',
  rate: rationalFromDecimalString('2.50'),
};

const approvals = (amount: Money<'USD' | 'GEL'>, rate: OfficialRateAtCreation | null): number | null =>
  requiredApprovals(policy, amount, rate, CREATED_ON);

describe('пороги утверждений в валюте, отличной от лари (FUNCTIONAL.md §4.3.1)', () => {
  it('keeps the lari ladder exactly as it was, boundary included', () => {
    expect(approvals(money('GEL', 2_999_999n), null)).toBe(0);
    // Граница ступени включительно: 30 000 ₾ — это ещё нулевая ступень.
    expect(approvals(money('GEL', 3_000_000n), null)).toBe(0);
    expect(approvals(money('GEL', 3_000_001n), null)).toBe(1);
    expect(approvals(money('GEL', 15_000_000n), null)).toBe(1);
    expect(approvals(money('GEL', 50_000_000n), null)).toBe(2);
    // Свыше 500 000 ₾ на пилоте не берём: утверждений не набрать, отказ закрытый.
    expect(approvals(money('GEL', 50_000_001n), null)).toBeNull();
  });

  it('converts by the official rate on the creation date', () => {
    // 20 000 USD по 2,50 — это 50 000 ₾: вторая ступень, одно утверждение.
    expect(approvals(money('USD', 2_000_000n), official)).toBe(1);
    // 240 000 USD по 2,50 — 600 000 ₾: выше потолка пилота.
    expect(approvals(money('USD', 24_000_000n), official)).toBeNull();
  });

  it('treats a boundary amount exactly as the same amount in lari', () => {
    // 12 000 USD по 2,50 — ровно 30 000 ₾, граница нулевой ступени. Две суммы,
    // равные до копейки, обязаны требовать одного числа подписей: асимметрия
    // здесь читалась бы как ошибка системы и однажды была бы «починена» в
    // неверную сторону (FUNCTIONAL.md §4.3.1).
    expect(approvals(money('USD', 1_200_000n), official)).toBe(0);
    expect(approvals(money('GEL', 3_000_000n), null)).toBe(0);
    // На тетри выше границы — уже следующая ступень, тоже в обеих валютах.
    expect(approvals(money('GEL', 3_000_001n), null)).toBe(1);
    expect(approvals(money('USD', 1_200_001n), official)).toBe(1);
  });

  it('rounds the converted amount up to the minor unit, and only that', () => {
    // 1 200 000,4 тетри после пересчёта — это 1 200 001 тетри, а не 1 200 000:
    // округление вверх защищает от погрешности курса. Дальше сравнение обычное.
    const rate: OfficialRateAtCreation = {
      ...official,
      rate: rationalFromDecimalString('2.5000001'),
    };
    // 12 000 USD × 2,5000001 = 30 000,0012 ₾ → 3 000 001 тетри (вверх) → ступень 1.
    expect(approvals(money('USD', 1_200_000n), rate)).toBe(1);
  });

  it('uses the official rate even where the client rate would land a tier lower', () => {
    // 11 240 USD: по клиентскому курсу 2,6686875 — 29 996,05 ₾ (нулевая
    // ступень), по официальному 2,70 — 30 348 ₾ (первая). Клиентский курс
    // содержит наш спред, то есть мы влияли бы на собственный контрольный порог.
    // Ступень здесь меняет курс, а не направление округления ступени.
    const amount = money('USD', 1_124_000n);
    const officialRate: OfficialRateAtCreation = {
      ...official,
      rate: rationalFromDecimalString('2.70'),
    };
    const clientRate: OfficialRateAtCreation = {
      ...official,
      rate: rationalFromDecimalString('2.6686875'),
    };
    expect(approvals(amount, officialRate)).toBe(1);
    expect(approvals(amount, clientRate)).toBe(0);
  });

  it('refuses closed when the rate is missing, stale or of another pair', () => {
    expect(approvals(money('USD', 2_000_000n), null)).toBeNull();
    // Курс на другую дату — не курс на дату создания. Ближайший не подставляем.
    expect(approvals(money('USD', 2_000_000n), { ...official, asOf: isoDate('2026-09-04') })).toBeNull();
    expect(approvals(money('USD', 2_000_000n), { ...official, from: 'EUR' })).toBeNull();
    expect(approvals(money('USD', 2_000_000n), { ...official, to: 'EUR' })).toBeNull();
    expect(
      approvals(money('USD', 2_000_000n), { ...official, rate: rationalFromDecimalString('0') }),
    ).toBeNull();
  });
});

describe('guard g_approvals_sufficient на валютном транше', () => {
  const usdAmount = money('USD', 2_000_000n);

  it('lets a currency tranche be paid out once the approvals are collected', () => {
    const ctx = context({
      requiredAmount: usdAmount,
      collectedAmount: usdAmount,
      officialRateAtCreation: official,
      preparedBy: 'operator-1',
      approvals: [{ userId: 'operator-2' }],
    });
    expect(accept(stateAt('release_pending'), { type: 'release_authorized' }, ctx).state.status).toBe(
      'paying_out',
    );
  });

  it('still refuses when the approvals are short', () => {
    const ctx = context({
      requiredAmount: usdAmount,
      collectedAmount: usdAmount,
      officialRateAtCreation: official,
      approvals: [],
    });
    const error = reject(stateAt('release_pending'), { type: 'release_authorized' }, ctx);
    expect(error.code).toBe(RejectionCode.guardFailed);
    expect(error.failedGuards).toContain('g_approvals_sufficient');
  });

  it('refuses when there is no official rate for the creation date', () => {
    // Раньше это был единственный исход для любого валютного транша: guard не
    // проходил никогда, и выплатить его было нельзя вовсе.
    const ctx = context({
      requiredAmount: usdAmount,
      collectedAmount: usdAmount,
      officialRateAtCreation: null,
      approvals: [{ userId: 'operator-2' }, { userId: 'operator-3' }],
    });
    expect(
      reject(stateAt('release_pending'), { type: 'release_authorized' }, ctx).failedGuards,
    ).toContain('g_approvals_sufficient');
  });
});
