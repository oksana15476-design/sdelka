import { describe, expect, it } from 'vitest';
import { requiredApprovals } from '@sdelka/domain';
import { accountBalance, clientFreeAccount } from '@sdelka/ledger';
import { STAFF } from './support/actors';
import {
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyTrancheEvent,
  approve,
} from './support/acting';
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

    // --- Подпись того, кто готовил операцию, теперь невозможна вовсе ---
    // Прежде она ставилась и отсеивалась guard'ом: `approve(world, TRANCHE,
    // 'operator-1')` был просто строкой. Сегодня подпись ставится под
    // полномочием `approve_payout`, а его у оператора нет ни при каких
    // условиях — рубеж переехал с guard'а на право, и это ужесточение.
    expect(facts.preparedBy).toBe('operator-1');
    expect(() => approve(world, TRANCHE, STAFF.operator)).toThrow('app.authority.denied');

    // Guard домена при этом на месте и по-прежнему считает имена: подпись,
    // пришедшая из хранилища мимо полномочия, отсеется и им.
    expect([...rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' }).failedGuards]).toEqual([
      'g_approvals_sufficient',
    ]);

    // --- Одна настоящая подпись: мало ---
    world = approve(world, TRANCHE, STAFF.controller);
    expect([...rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' }).failedGuards]).toEqual([
      'g_approvals_sufficient',
    ]);

    // --- Тот же человек второй раз: не второй человек ---
    world = approve(world, TRANCHE, STAFF.controller);
    expect(trancheOf(world, TRANCHE).facts.approvals).toHaveLength(2);
    expect([...rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' }).failedGuards]).toEqual([
      'g_approvals_sufficient',
    ]);

    // --- Две подписи одного уровня: тоже не кворум ---
    // Второй финансовый контролёр — другой человек, и guard домена (он считает
    // **имена**) такую пару пропустил бы. Кворум считает **уровни**: ступень на
    // 200 000 ₾ требует уровень 1 плюс уровень 2, а двух первых подписей не
    // бывает (`ACTORS.md` §5.2). Ошибка здесь стоит всей суммы сделки.
    const twoLevelOne = approve(world, TRANCHE, {
      key: 'controller2',
      roleId: 'financial_controller',
      accountId: 'approver-1b',
      personId: 'person-approver-1b',
    });
    expect(() =>
      applyTrancheEvent(twoLevelOne, TRANCHE, { type: 'release_authorized' }, OPTIONS),
    ).toThrow('app.quorum.not_met:auth.quorum.level_two_missing');

    // --- Две подписи разных людей: поручение уходит ---
    world = approve(world, TRANCHE, STAFF.head);
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
    world = approve(world, TRANCHE, STAFF.controller);
    world = applyTrancheEvent(world, TRANCHE, { type: 'release_authorized' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paying_out');
  });
});
