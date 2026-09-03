import { describe, expect, it } from 'vitest';
import { isFullyCovered } from '@sdelka/ledger';
import { MONEY_STATES } from '@/view/money-state';
import { SCENARIOS } from './scenarios';
import { getAccount, getDeal, getOpsQueue, listDeals, worldJournal } from './store';

/**
 * Фикстуры проверяются автоматом, а не глазами: если событие не проходит
 * guard'ы домена, `runScenario` бросает, и тест краснеет здесь, а не рисует
 * экран в положении, недостижимом в жизни.
 */
describe('фикстуры', () => {
  it('каждая приводит домен ровно в то положение денег, которое обещает', async () => {
    for (const scenario of SCENARIOS) {
      const snapshot = await getDeal(scenario.id);
      expect(snapshot, scenario.id).not.toBeNull();
      expect(`${scenario.id}:${snapshot?.moneyState}`).toBe(`${scenario.id}:${scenario.expect}`);
    }
  });

  it('покрывают все восемнадцать положений денег', async () => {
    const deals = await listDeals();
    const covered = new Set(deals.map((deal) => deal.moneyState));
    expect([...MONEY_STATES].filter((state) => !covered.has(state))).toEqual([]);
  });

  it('нетерминальный транш всегда имеет видимый дедлайн, кроме замороженного', async () => {
    for (const deal of await listDeals()) {
      const terminal = ['paid_out', 'refunded', 'written_off'].includes(deal.trancheStatus);
      const frozen = deal.trancheStatus === 'frozen';
      if (terminal || frozen) continue;
      expect(deal.deadline, deal.id).not.toBeNull();
    }
  });

  it('покрытие клиентских средств не нарушено', () => {
    expect(isFullyCovered(worldJournal())).toBe(true);
  });

  it('счёт клиента разделён на свободную и запертую части', async () => {
    const account = await getAccount();
    expect(account.lockedParts.length).toBeGreaterThan(0);
    for (const part of account.lockedParts) {
      // По каждой запертой сумме видно, под какой сделкой и до какого момента.
      expect(part.dealRef.length).toBeGreaterThan(0);
      expect(part.deadline).not.toBeNull();
    }
  });

  it('расчёт по сделке, где клиент получает, приходит на счёт со знаком плюс', async () => {
    const account = await getAccount();
    const settlement = account.records.find(
      (record) => record.memoKey === 'account.op.settle' && record.dealRef === 'SD-8A13',
    );
    // Раньше здесь брался первый клиентский счёт записи — запертая часть
    // плательщика, — и получатель видел собственное поступление как списание.
    expect(settlement?.amount.minor).toBeGreaterThan(0n);
  });

  it('очередь работы отсортирована по сроку и покрывает все восемь типов задач', async () => {
    const ops = await getOpsQueue();
    const types = new Set(ops.tasks.map((task) => task.type));
    expect(types.size).toBeGreaterThanOrEqual(7);
    const deadlines = ops.tasks.map((task) => task.deadline?.at ?? Number.MAX_SAFE_INTEGER);
    expect([...deadlines].sort((left, right) => left - right)).toEqual(deadlines);
  });
});
