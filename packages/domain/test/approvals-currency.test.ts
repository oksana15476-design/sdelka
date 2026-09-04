import { type Money, fxRate, isoDate, money, rationalFromDecimalString } from '@sdelka/money';
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

/**
 * Официальный курс Нацбанка на дату создания транша, 2,50 лари за доллар.
 *
 * Пара валют больше не лежит соседними полями рядом с дробью: её несёт сам
 * курс (`FxRate`), и подставить множитель одной пары под направление другой
 * здесь нечем.
 */
const official: OfficialRateAtCreation = {
  asOf: CREATED_ON,
  rate: fxRate('USD', 'GEL', rationalFromDecimalString('2.50')),
};

const approvals = (amount: Money<'USD' | 'GEL'>, rate: OfficialRateAtCreation | null): number | null =>
  requiredApprovals(policy, amount, rate, CREATED_ON);

describe('пороги утверждений в валюте, отличной от лари (FUNCTIONAL.md §4.3.1)', () => {
  it('keeps the lari ladder exactly as it was, boundary included', () => {
    // Нулевой ступени в лестнице нет: релиз без человека запрещён при любой
    // сумме (CRO-risk.md). Прежняя первая ступень разрешала автоисполнение до
    // 30 000 ₾ и была недостижима только из-за минимума сделки.
    expect(approvals(money('GEL', 1n), null)).toBe(1);
    expect(approvals(money('GEL', 3_000_000n), null)).toBe(1);
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
    expect(approvals(money('USD', 1_200_000n), official)).toBe(1);
    expect(approvals(money('GEL', 3_000_000n), null)).toBe(1);
    // На тетри выше границы — уже следующая ступень, тоже в обеих валютах.
    expect(approvals(money('GEL', 3_000_001n), null)).toBe(1);
    expect(approvals(money('USD', 1_200_001n), official)).toBe(1);
  });

  it('rounds the converted amount up to the minor unit, and only that', () => {
    // 1 200 000,4 тетри после пересчёта — это 1 200 001 тетри, а не 1 200 000:
    // округление вверх защищает от погрешности курса. Дальше сравнение обычное.
    const rate: OfficialRateAtCreation = {
      ...official,
      rate: fxRate('USD', 'GEL', rationalFromDecimalString('2.5000001')),
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
      rate: fxRate('USD', 'GEL', rationalFromDecimalString('2.70')),
    };
    const clientRate: OfficialRateAtCreation = {
      ...official,
      rate: fxRate('USD', 'GEL', rationalFromDecimalString('2.6686875')),
    };
    expect(approvals(amount, officialRate)).toBe(1);
    expect(approvals(amount, clientRate)).toBe(1);
  });

  it('refuses closed when the rate is missing, stale or of another pair', () => {
    expect(approvals(money('USD', 2_000_000n), null)).toBeNull();
    // Курс на другую дату — не курс на дату создания. Ближайший не подставляем.
    expect(approvals(money('USD', 2_000_000n), { ...official, asOf: isoDate('2026-09-04') })).toBeNull();
    // Чужая пара — отказ, а не исключение. Сумма в долларах, курс евровый:
    // `convertAtRate` на такой паре бросает, и если бы guard дал ей дойти до
    // вызова, шаг упал бы вместо того, чтобы остановить выплату.
    const eurRate: OfficialRateAtCreation = {
      ...official,
      rate: fxRate('EUR', 'GEL', rationalFromDecimalString('2.50')),
    };
    expect(approvals(money('USD', 2_000_000n), eurRate)).toBeNull();
    // Правая половина пары чужая: пересчитанное в евро сравнивать с лестницей
    // в лари нельзя — это разные деньги, а не разные числа.
    const toEur: OfficialRateAtCreation = {
      ...official,
      rate: fxRate('USD', 'EUR', rationalFromDecimalString('2.50')),
    };
    expect(approvals(money('USD', 2_000_000n), toEur)).toBeNull();
    // Нулевой курс до guard'а больше не доходит: его отвергает конструктор
    // величины. Проверка в guard'е остаётся второй линией — значение приходит
    // из базы, где конструктора не было, — и здесь она проверяется на
    // значении, собранном мимо него, ровно как оно и придёт из базы.
    const zeroFromStorage = {
      ...official,
      rate: { base: 'USD', quote: 'GEL', value: rationalFromDecimalString('0') },
    } as OfficialRateAtCreation;
    expect(approvals(money('USD', 2_000_000n), zeroFromStorage)).toBeNull();
    expect(() => fxRate('USD', 'GEL', rationalFromDecimalString('0'))).toThrow();
  });
});

describe('guard g_approvals_sufficient на валютном транше', () => {
  const usdAmount = money('USD', 2_000_000n);

  it('lets a currency tranche be paid out once the approvals are collected', () => {
    const ctx = context({
      requiredAmount: usdAmount,
      collectedAmount: usdAmount,
      // Валютный транш заперт в своей валюте: базовая фикстура несёт лари.
      lockedAmount: usdAmount,
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
      // Валютный транш заперт в своей валюте: базовая фикстура несёт лари.
      lockedAmount: usdAmount,
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
      // Валютный транш заперт в своей валюте: базовая фикстура несёт лари.
      lockedAmount: usdAmount,
      officialRateAtCreation: null,
      approvals: [{ userId: 'operator-2' }, { userId: 'operator-3' }],
    });
    expect(
      reject(stateAt('release_pending'), { type: 'release_authorized' }, ctx).failedGuards,
    ).toContain('g_approvals_sufficient');
  });
});

describe('автоматический релиз запрещён при любой сумме', () => {
  it('has no tier that allows a payout without a human approval', () => {
    // Регрессия: первая ступень раньше разрешала автоисполнение до 30 000 ₾.
    // На текущем минимуме сделки она недостижима — и потому опасна: включилась
    // бы молча в день снижения минимума. CRO-risk.md: релиз без человека
    // запрещён при любой сумме.
    for (const tier of DEFAULT_APPROVAL_POLICY.tiers) {
      // Ноль стал невыразим и по типу (`ApprovalTierRequirement` в
      // `guards.ts`), поэтому сравнение с ним требует приведения. Само
      // надгробие остаётся рантайм-проверкой: лестница — версионируемая
      // политика, приведением в неё можно занести что угодно, и запрет обязан
      // стоять на обоих рубежах.
      expect((tier.requiredApprovals as number | null) === 0).toBe(false);
    }
  });

  it('requires at least one approval for the smallest possible amount', () => {
    expect(requiredApprovals(DEFAULT_APPROVAL_POLICY, money('GEL', 1n), null, CREATED_ON)).toBe(1);
  });
});
