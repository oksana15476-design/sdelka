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
