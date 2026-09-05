import { money } from '@sdelka/money';
import { type Instant, instant } from '@sdelka/domain';
import { describe, expect, it } from 'vitest';
import { type PropertyTransfer, assessFlipping } from '../../src/index';
import { evidence, NOW, POLICY, POLICY_VERSION } from '../support/fixtures';

const DAY_MS = 24 * 60 * 60 * 1000;
const CADASTRE = '00.00.00.000';

function transfer(id: string, daysAgo: number, minor: bigint | null): PropertyTransfer {
  return {
    transferId: id,
    cadastralCode: CADASTRE,
    registeredAt: instant(NOW - daysAgo * DAY_MS) as Instant,
    price: minor === null ? null : money('GEL', minor),
  };
}

const assess = (priorTransfers: readonly PropertyTransfer[], current: bigint | null = 20_000_000n) =>
  assessFlipping(
    {
      cadastralCode: CADASTRE,
      currentPrice: current === null ? null : money('GEL', current),
      priorTransfers,
      evidence: [evidence(1, 'registry_extract')],
    },
    POLICY_VERSION,
    POLICY.flipping,
    NOW,
  );

describe('быстрая перепродажа одного объекта', () => {
  it('не срабатывает: переходов нет', () => {
    const result = assess([]);
    expect(result.outcome).toBe('clear');
    expect(result.sinceLastTransferMs).toBeNull();
  });

  it('не срабатывает: последний переход старше окна', () => {
    const result = assess([transfer('t1', 200, 20_000_000n)]);
    expect(result.outcome).toBe('clear');
  });

  it('срабатывает: переход внутри окна', () => {
    const result = assess([transfer('t1', 30, 20_000_000n)]);
    expect(result.outcome).toBe('review');
    expect(result.sinceLastTransferMs).toBe(30 * DAY_MS);
    expect(result.priceJumpBp).toBe(0);
  });

  it('эскалирует при скачке цены', () => {
    const result = assess([transfer('t1', 30, 10_000_000n)], 20_000_000n);
    expect(result.outcome).toBe('stop');
    expect(result.priceJumpBp).toBe(10_000);
    expect(result.reasons).toContain('compliance.flipping.price_jump');
  });

  it('не эскалирует при скачке ниже порога', () => {
    const result = assess([transfer('t1', 30, 19_000_000n)], 20_000_000n);
    expect(result.outcome).toBe('review');
    expect(result.priceJumpBp).toBeLessThan(POLICY.flipping.priceJumpBp);
  });

  it('цена прошлого перехода неизвестна — скачок не считается, но задача есть', () => {
    const result = assess([transfer('t1', 30, null)]);
    expect(result.outcome).toBe('review');
    expect(result.priceJumpBp).toBeNull();
  });

  it('переходы другого объекта не учитываются', () => {
    const other = { ...transfer('t1', 30, 20_000_000n), cadastralCode: '11.11.11.111' };
    expect(assess([other]).outcome).toBe('clear');
  });
});

/**
 * Границы. У детектора их три: край окна, край шкалы времени и порог скачка
 * цены. Ошибка на единицу в любой из них — это разница между «сделка идёт» и
 * «сделка остановлена с оценкой на отчёт о подозрении».
 */
describe('быстрая перепродажа: границы окна и порога', () => {
  it('переход ровно на краю окна ещё считается', () => {
    const days = POLICY.flipping.window / DAY_MS;
    const result = assess([transfer('t1', days, 20_000_000n)]);
    expect(result.outcome).toBe('review');
    expect(result.sinceLastTransferMs).toBe(POLICY.flipping.window);
  });

  it('переход на миллисекунду старше окна уже не считается', () => {
    const old: PropertyTransfer = {
      transferId: 't1',
      cadastralCode: CADASTRE,
      registeredAt: instant(NOW - POLICY.flipping.window - 1) as Instant,
      price: money('GEL', 20_000_000n),
    };
    expect(assess([old]).outcome).toBe('clear');
  });

  it('переход, зарегистрированный ровно сейчас, считается', () => {
    const result = assess([transfer('t1', 0, 20_000_000n)]);
    expect(result.outcome).toBe('review');
    expect(result.sinceLastTransferMs).toBe(0);
  });

  it('переход из будущего не считается: это дефект данных реестра', () => {
    const future: PropertyTransfer = {
      transferId: 't1',
      cadastralCode: CADASTRE,
      registeredAt: instant(NOW + 1) as Instant,
      price: money('GEL', 20_000_000n),
    };
    expect(assess([future]).outcome).toBe('clear');
  });

  it('скачок ровно на пороге эскалирует: граница включающая', () => {
    // 10 000 000 → 12 000 000 — ровно 2 000 базисных пунктов.
    const result = assess([transfer('t1', 30, 10_000_000n)], 12_000_000n);
    expect(result.priceJumpBp).toBe(POLICY.flipping.priceJumpBp);
    expect(result.outcome).toBe('stop');
  });

  it('скачок на один базисный пункт ниже порога не эскалирует', () => {
    const result = assess([transfer('t1', 30, 10_000_000n)], 11_999_000n);
    expect(result.priceJumpBp).toBe(1_999);
    expect(result.outcome).toBe('review');
  });

  it('из двух переходов внутри окна берётся самый свежий', () => {
    // Старый переход дал бы скачок в 10 000 пунктов и стоп; свежий — ноль и разбор.
    const result = assess(
      [transfer('t-old', 80, 10_000_000n), transfer('t-new', 10, 20_000_000n)],
      20_000_000n,
    );
    expect(result.recentTransfers[0]?.transferId).toBe('t-new');
    expect(result.sinceLastTransferMs).toBe(10 * DAY_MS);
    expect(result.priceJumpBp).toBe(0);
    expect(result.outcome).toBe('review');
  });

  it('нулевая цена прошлого перехода скачок не считает и не делит на ноль', () => {
    const result = assess([transfer('t1', 30, 0n)], 20_000_000n);
    expect(result.priceJumpBp).toBeNull();
    expect(result.outcome).toBe('review');
  });
});
