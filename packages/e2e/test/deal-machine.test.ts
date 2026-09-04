import { describe, expect, it } from 'vitest';
import {
  dealStatusOf,
  emptyWorld,
  rejectDealEvent,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyDealEvent,
  createDeal,
} from './support/acting';
import { CADASTRAL_CODE, NOW, POLICY_VERSION } from './support/fixtures';
import { toCollected, toConditionReady, toReleasePending } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);

/**
 * Guard'ы автомата сделки — `STATE-MACHINES.md` §3.
 *
 * ## Зачем файл целиком про отказы
 *
 * Шесть guard'ов сделки существовали и вызывались из продукта — но **только на
 * счастливых путях**, где они и так пропускают. Мутационный прогон, научившись
 * читать все перечни домена (а не один `GUARD_IDS`), показал это первым же
 * заходом: `DEAL_GUARDS`, заменённые на `() => true`, не роняли ни одного из
 * пятидесяти пяти сквозных тестов. Правило, которое ни разу не отказывало,
 * ничем не отличается от отсутствующего: снести его можно молча.
 *
 * Поэтому здесь каждый guard встречается в состоянии, где он **обязан
 * отказать**, и отказ разбирается поимённо, как требует §7.
 *
 * Там, где на ребре стоят два guard'а и разделить их нельзя (`paid_out` — сам
 * по себе терминальный статус, поэтому «все выплачены, но кто-то жив»
 * невыразимо), список сверяется целиком: `toEqual`, а не `toContain`. Разница
 * не косметическая — `toContain` пропустил бы снятие соседнего правила.
 */
describe('автомат сделки: правила, которые обязаны отказывать', () => {
  it('не открывает приём средств, пока получатель не совершил акт об условии', async () => {
    // Сделка без акта: `createDeal` принимает `null` — и это не крайний
    // случай, а нормальное начало, потому что акт совершает получатель, а не
    // платформа (CORE.md Ф13).
    const deal = 'deal-no-act';
    let world = createDeal(emptyWorld({ now: NOW, chainId: 'sdelka-deal-guards' }), {
      dealId: deal,
      conditionAct: null,
      objectCadastralCode: CADASTRAL_CODE,
    });
    world = applyDealEvent(world, deal, { type: 'parties_check_started' }, OPTIONS);
    world = applyDealEvent(world, deal, { type: 'parties_verified' }, OPTIONS);
    world = applyDealEvent(world, deal, { type: 'property_verified' }, OPTIONS);
    expect(dealStatusOf(world, deal)).toBe('ready');

    const refused = rejectDealEvent(world, deal, { type: 'funds_received' });
    expect(refused.code).toBe('domain.guard.failed');
    expect([...refused.failedGuards]).toEqual(['g_condition_agreed']);
  });

  it('не считает сделку обеспеченной, пока зарезервированы не все транши', async () => {
    const collected = await toCollected({ dealId: 'deal-not-reserved', trancheId: 'tranche-not-reserved' });
    expect(dealStatusOf(collected.world, 'deal-not-reserved')).toBe('funding');
    // Деньги пришли, но под транш не заперты: он в `collected`, а не `reserved`.
    expect(trancheStatusOf(collected.world, 'tranche-not-reserved')).toBe('collected');

    const refused = rejectDealEvent(collected.world, 'deal-not-reserved', { type: 'tranches_reserved' });
    expect([...refused.failedGuards]).toEqual(['g_all_tranches_reserved']);
  });

  it('не закрывает расчёт, пока транш жив и не выплачен', async () => {
    const pending = await toReleasePending({ dealId: 'deal-live', trancheId: 'tranche-live' });
    expect(dealStatusOf(pending.world, 'deal-live')).toBe('settling');
    expect(trancheStatusOf(pending.world, 'tranche-live')).toBe('release_pending');

    // Оба правила ребра отказывают, и оба названы. Разделить их на этом ребре
    // нельзя: `paid_out` терминален, поэтому «все выплачены, но кто-то жив» —
    // состояние, которого не существует. Список сверяется целиком именно
    // поэтому: снятие любого из двух меняет ответ.
    const refused = rejectDealEvent(pending.world, 'deal-live', { type: 'tranches_settled' });
    expect([...refused.failedGuards]).toEqual(['g_all_tranches_paid_out', 'g_no_live_tranche']);
  });

  it('не закрывает откат, пока транш жив и не возвращён', async () => {
    const ready = await toConditionReady({ dealId: 'deal-unwind', trancheId: 'tranche-unwind' });
    const world = applyDealEvent(ready.world, 'deal-unwind', { type: 'condition_failed' }, OPTIONS);
    expect(dealStatusOf(world, 'deal-unwind')).toBe('unwinding');
    // Сделка откатывается, а транш ещё стоит зарезервированным: деньги на месте.
    expect(trancheStatusOf(world, 'tranche-unwind')).toBe('reserved');

    const refused = rejectDealEvent(world, 'deal-unwind', { type: 'tranches_refunded' });
    expect([...refused.failedGuards]).toEqual(['g_all_tranches_refunded', 'g_no_live_tranche']);
  });

  it('не размораживает сделку одной подписью и не считает подписью того, кто заморозил', async () => {
    const collected = await toCollected({ dealId: 'deal-freeze', trancheId: 'tranche-freeze' });
    const frozen = applyDealEvent(
      collected.world,
      'deal-freeze',
      { type: 'compliance_hold', reason: 'sanctions', frozenBy: 'analyst-1' },
      OPTIONS,
    );
    expect(dealStatusOf(frozen, 'deal-freeze')).toBe('frozen');
    // Каскад: заморозка сделки останавливает её транши, иначе транш продолжит
    // идти к автовозврату по дедлайну (`CORE.md` Ф17).
    expect(trancheStatusOf(frozen, 'tranche-freeze')).toBe('frozen');

    // Один утверждающий — мало.
    expect([
      ...rejectDealEvent(frozen, 'deal-freeze', {
        type: 'unfreeze',
        userIds: ['approver-1'],
        resume: 'settling',
      }).failedGuards,
    ]).toEqual(['g_unfreeze_approvers_distinct']);

    // Готовивший сделку вторым утверждающим не считается: остаётся один.
    expect([
      ...rejectDealEvent(frozen, 'deal-freeze', {
        type: 'unfreeze',
        userIds: ['operator-1', 'approver-1'],
        resume: 'settling',
      }).failedGuards,
    ]).toEqual(['g_unfreeze_approvers_distinct']);

    // Один человек дважды — не два человека.
    expect([
      ...rejectDealEvent(frozen, 'deal-freeze', {
        type: 'unfreeze',
        userIds: ['approver-1', 'approver-1'],
        resume: 'settling',
      }).failedGuards,
    ]).toEqual(['g_unfreeze_approvers_distinct']);

    // Два разных — и сделка возвращается туда, откуда её забрали.
    const thawed = applyDealEvent(
      frozen,
      'deal-freeze',
      { type: 'unfreeze', userIds: ['approver-1', 'approver-2'], resume: 'unwinding' },
      OPTIONS,
    );
    expect(dealStatusOf(thawed, 'deal-freeze')).toBe('unwinding');
  });
});
