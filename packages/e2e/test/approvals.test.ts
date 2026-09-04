import { describe, expect, it } from 'vitest';
import { requiredApprovals } from '@sdelka/domain';
import { accountBalance, clientFreeAccount } from '@sdelka/ledger';
import {
  applyTrancheEvent,
  approve,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import { CREATED_ON, DEAL_AMOUNT, GEL, POLICY_VERSION, SMALL_AMOUNT } from './support/fixtures';
import { toReleasePending } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);

/**
 * Сценарий 13 — утверждения перед выпуском поручения.
 *
 * `g_approvals_sufficient` — единственное, что стоит между собранным пакетом
 * доказательств и деньгами в банке. `CRO-risk.md`: автоматический релиз
 * запрещён **при любой сумме**, поэтому ступени с нулём утверждений в политике
 * нет и быть не может, а на 200 000 ₾ действует вторая ступень — две подписи.
 *
 * Проверяется не только счёт подписей, но и кто именно их поставил: учётная
 * запись, готовившая операцию, утверждающей не считается, и один человек не
 * становится двумя, нажав кнопку дважды. Это то же правило «четырёх глаз», что
 * у списания и разморозки, и цена ошибки здесь — вся сумма сделки.
 */
describe('утверждения перед выпуском поручения', () => {
  it('не выпускает поручение, пока не набраны две подписи разных людей', async () => {
    const DEAL = 'deal-approvals';
    const TRANCHE = 'tranche-approvals';

    const pending = await toReleasePending({ dealId: DEAL, trancheId: TRANCHE });
    let world = pending.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');
    // Политика на этой сумме требует ровно двух подписей — не «одну, если
    // сумма невелика»: ступени с нулём в перечне нет.
    const facts = trancheOf(world, TRANCHE).facts;
    expect(requiredApprovals(facts.approvalPolicy, DEAL_AMOUNT, null, CREATED_ON)).toBe(2);

    // --- Ни одной подписи ---
    expect([...rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' }).failedGuards]).toEqual([
      'g_approvals_sufficient',
    ]);

    // --- Подпись того, кто готовил операцию, не считается ---
    // Оператор, собравший поручение, не может его же и утвердить: иначе
    // «четыре глаза» — это два глаза, посмотревшие дважды.
    expect(facts.preparedBy).toBe('operator-1');
    world = approve(world, TRANCHE, 'operator-1');
    expect([...rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' }).failedGuards]).toEqual([
      'g_approvals_sufficient',
    ]);

    // --- Одна настоящая подпись: мало ---
    world = approve(world, TRANCHE, 'approver-1');
    expect([...rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' }).failedGuards]).toEqual([
      'g_approvals_sufficient',
    ]);

    // --- Тот же человек второй раз: не второй человек ---
    world = approve(world, TRANCHE, 'approver-1');
    expect(trancheOf(world, TRANCHE).facts.approvals).toHaveLength(3);
    expect([...rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' }).failedGuards]).toEqual([
      'g_approvals_sufficient',
    ]);

    // --- Две подписи разных людей: поручение уходит ---
    world = approve(world, TRANCHE, 'approver-2');
    world = applyTrancheEvent(world, TRANCHE, { type: 'release_authorized' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paying_out');
    expect(trancheOf(world, TRANCHE).payouts).toHaveLength(1);
    // До ответа банка получателю не зачислено ничего: подпись открывает
    // поручение, а не расчёт.
    expect(accountBalance(world.journal, clientFreeAccount(pending.sellerKey), GEL).minor).toBe(0n);
  });

  it('на меньшей сумме требует одну подпись — но не ноль', async () => {
    const DEAL = 'deal-approvals-small';
    const TRANCHE = 'tranche-approvals-small';

    // 100 000 ₾ — первая ступень. Она существует именно для того, чтобы
    // показать: даже там, где подпись одна, она обязательна.
    const pending = await toReleasePending({
      dealId: DEAL,
      trancheId: TRANCHE,
      amount: SMALL_AMOUNT,
    });
    let world = pending.world;
    const facts = trancheOf(world, TRANCHE).facts;
    expect(requiredApprovals(facts.approvalPolicy, SMALL_AMOUNT, null, CREATED_ON)).toBe(1);

    expect([...rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' }).failedGuards]).toEqual([
      'g_approvals_sufficient',
    ]);
    world = approve(world, TRANCHE, 'approver-1');
    world = applyTrancheEvent(world, TRANCHE, { type: 'release_authorized' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paying_out');
  });
});
