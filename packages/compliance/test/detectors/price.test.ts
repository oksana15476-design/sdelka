import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import { type PriceFacts, assessPrice } from '../../src/index';
import { evidence, NOW, POLICY, POLICY_VERSION } from '../support/fixtures';

const CONTRACT = money('GEL', 24_000_000n);

function facts(overrides: Partial<PriceFacts> = {}): PriceFacts {
  return {
    contractPrice: CONTRACT,
    platformAmount: CONTRACT,
    differentAmountRequested: false,
    evidence: [evidence(1, 'contract')],
    ...overrides,
  };
}

const assess = (overrides: Partial<PriceFacts> = {}) =>
  assessPrice(facts(overrides), POLICY_VERSION, POLICY.price, NOW);

describe('расхождение суммы с ценой в договоре', () => {
  it('совпадение — ничего', () => {
    const result = assess();
    expect(result.outcome).toBe('clear');
    expect(result.deltaMinor).toBe(0n);
    expect(result.suspicionAssessmentRequired).toBe(false);
  });

  it('занижение — стоп и оценка на отчёт о подозрении', () => {
    const result = assess({ platformAmount: money('GEL', 12_000_000n) });
    expect(result.outcome).toBe('stop');
    expect(result.deltaMinor).toBe(-12_000_000n);
    expect(result.deltaBp).toBe(5_000);
    expect(result.suspicionAssessmentRequired).toBe(true);
    expect(result.reasons).toContain('compliance.price.below_contract');
  });

  it('завышение тоже останавливает', () => {
    const result = assess({ platformAmount: money('GEL', 25_000_000n) });
    expect(result.outcome).toBe('stop');
    expect(result.reasons).toContain('compliance.price.above_contract');
  });

  it('допуск нулевой: расхождение в одну тетри уже стоп', () => {
    const result = assess({ platformAmount: money('GEL', 24_000_001n) });
    expect(result.outcome).toBe('stop');
    expect(result.deltaBp).toBe(1);
  });

  it('предложение указать другую сумму — блок, красная линия', () => {
    const result = assess({ differentAmountRequested: true });
    expect(result.outcome).toBe('block');
    expect(result.reasons).toContain('compliance.price.second_amount_requested');
    expect(result.suspicionAssessmentRequired).toBe(true);
  });

  it('нет договора — стоп, а не «совпадает»', () => {
    const result = assess({ contractPrice: null });
    expect(result.outcome).toBe('stop');
    expect(result.reasons).toContain('compliance.price.contract_missing');
    // Стоп из-за нехватки документа — не оценка на отчёт о подозрении:
    // договора просто ещё нет, и подозревать пока нечего. Флаг ведёт к подаче
    // отчёта в надзорную службу, и ставить его без основания нельзя.
    expect(result.suspicionAssessmentRequired).toBe(false);
  });

  it('разные валюты — стоп, а не сравнение чисел', () => {
    const result = assess({ platformAmount: money('USD', 24_000_000n) });
    expect(result.outcome).toBe('stop');
    expect(result.reasons).toContain('compliance.price.currency_mismatch');
    expect(result.deltaMinor).toBeNull();
    // Несравнимые величины — тоже не подозрение: сравнить не удалось, а не
    // «расхождение обнаружено».
    expect(result.suspicionAssessmentRequired).toBe(false);
  });

  it('нулевая цена договора читается как отсутствие цены, а не делится на ноль', () => {
    const result = assess({ contractPrice: money('GEL', 0n) });
    expect(result.outcome).toBe('stop');
    expect(result.reasons).toContain('compliance.price.contract_missing');
    expect(result.deltaBp).toBeNull();
  });
});

/**
 * Допуск по цене у действующей политики нулевой, и на нём граница «строго
 * равно» неотличима от «в пределах допуска»: любое ненулевое расхождение даёт
 * хотя бы один базисный пункт. Поэтому сторона границы проверяется на политике
 * с ненулевым допуском — иначе сравнение можно поменять, не сломав ни одного
 * теста, а вместе с ним поедет и величина, которую увидит оператор.
 */
describe('допуск по цене: сторона границы', () => {
  const tolerant = { toleranceBp: 100 };
  const withTolerance = (overrides: Partial<PriceFacts> = {}) =>
    assessPrice(facts(overrides), POLICY_VERSION, tolerant, NOW);

  it('расхождение ровно в допуск проходит, и величина остаётся в отчёте', () => {
    // 240 000 от 24 000 000 — ровно 100 базисных пунктов.
    const result = withTolerance({ platformAmount: money('GEL', 24_240_000n) });
    expect(result.outcome).toBe('clear');
    expect(result.deltaMinor).toBe(240_000n);
    expect(result.deltaBp).toBe(100);
  });

  it('расхождение на одну тетри сверх допуска останавливает', () => {
    const result = withTolerance({ platformAmount: money('GEL', 24_240_001n) });
    expect(result.outcome).toBe('stop');
    expect(result.deltaBp).toBe(101);
    expect(result.suspicionAssessmentRequired).toBe(true);
  });

  it('точное совпадение при ненулевом допуске остаётся нулевой долей', () => {
    const result = withTolerance();
    expect(result.outcome).toBe('clear');
    expect(result.deltaBp).toBe(0);
  });
});
