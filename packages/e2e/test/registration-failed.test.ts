import { describe, expect, it } from 'vitest';
import { assessRefundDestination, accountFingerprint, payerKeyForDomain } from '@sdelka/compliance';
import { accountBalance, bankNominal, clientFreeAccount, coverage } from '@sdelka/ledger';
import {
  advance,
  applyDealEvent,
  applyTrancheEvent,
  dealStatusOf,
  lockFundsForTranche,
  receiveExternalPayment,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
  unlockFundsFromTranche,
} from '../src/index';
import {
  BUYER,
  DAY_MS,
  DEAL_AMOUNT,
  GEL,
  NOW,
  POLICY_VERSION,
  SELLER,
  fp,
  registryWithoutTransfer,
} from './support/fixtures';
import { openDeal } from './support/open';

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на счёте клиента: откат резерва их туда возвращает, а не зачисляет. */
const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const DEAL = 'deal-unwound';
const TRANCHE = 'tranche-unwound';

/**
 * Сценарий 2 — регистрация не состоялась: откат по дедлайну и возврат на
 * счёт-источник.
 */
describe('регистрация не состоялась', () => {
  it('откатывает транш по дедлайну и возвращает средства на счёт-источник', async () => {
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = opened.world;

    world = applyTrancheEvent(world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;
    world = receiveExternalPayment(world, opened.buyerKey, DEAL_AMOUNT);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'funds_received', amount: DEAL_AMOUNT, sender: payerKeyForDomain(BUYER.document), reference: 'payment-1' },
      ROLLBACK,
    ).world;
    world = applyDealEvent(world, DEAL, { type: 'funds_received' }, OPTIONS);
    world = applyTrancheEvent(world, TRANCHE, { type: 'reserve_requested' }, OPTIONS).world;
    world = lockFundsForTranche(world, TRANCHE, DEAL_AMOUNT);
    world = applyDealEvent(world, DEAL, { type: 'tranches_reserved' }, OPTIONS);
    world = applyDealEvent(world, DEAL, { type: 'filing_registered', applicationId: 'app-2' }, OPTIONS);

    // Реестр показывает, что перехода права нет.
    expect(registryWithoutTransfer().paidExtract('cadastral-2')).toBeNull();

    world = advance(world, DAY_MS);

    // ⚠ Планировщик, пришедший по дедлайну к зарезервированному траншу, не
    // может его сдвинуть: ребра `reserved → deadline_reached` в таблице нет,
    // хотя §1.5 ставит дедлайн на входе в `reserved`, а §5 обещает «отсечку
    // рабочего дня». Отчёт, расхождение 9.
    const stuck = rejectTrancheEvent(world, TRANCHE, { type: 'deadline_reached' });
    expect(stuck.code).toBe('domain.transition.not_allowed');

    // Штатный откат идёт в два шага: сначала снятие резерва, потом дедлайн.
    const expired = applyTrancheEvent(world, TRANCHE, { type: 'reserve_expired' }, ROLLBACK);
    world = expired.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('collected');
    // Откат резерва проводки зачисления больше не порождает: она привязана к
    // событию `funds_received`, а не к входу в `collected`. Прежняя редакция
    // придумывала поступление, которого не было, — деньги уже лежали в файле
    // транша, и вторая проводка удваивала и обязательство, и отнесение
    // кастодиана. Ни один инвариант учёта этого не ловил: обеспечение сходилось
    // с обеих сторон.
    expect(expired.transition.intents).not.toContainEqual(
      expect.objectContaining({ type: 'post_journal_entry', template: 'funds_received' }),
    );
    // Подавленное намерение осталось ровно одно — то, что было при приёме
    // средств: деньги пришли раньше отдельной записью.
    expect(world.suppressed.filter((item) => item.trancheId === TRANCHE)).toHaveLength(1);
    // Блокировка реквизитов снята: уходим из резерва не в выплату.
    expect(trancheOf(world, TRANCHE).beneficiary.locked).toBe(false);

    world = unlockFundsFromTranche(world, TRANCHE, DEAL_AMOUNT);
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(20_000_000n);

    world = applyTrancheEvent(world, TRANCHE, { type: 'deadline_reached' }, ROLLBACK).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refund_pending');
    // И12.3: о возврате узнают обе стороны, а не только покупатель.
    expect(world.notifications).toContainEqual({ audience: 'both', messageKey: 'tranche.refund_pending.both' });

    world = applyDealEvent(world, DEAL, { type: 'condition_failed' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('unwinding');

    // Возврат только на счёт-источник, на имя плательщика — без исключений.
    const sourceAccount = accountFingerprint(fp(700));
    const destination = assessRefundDestination(
      {
        sourceAccount,
        sourceHolder: BUYER.document,
        requestedAccount: sourceAccount,
        requestedHolder: BUYER.document,
        sanctionsFrozen: false,
        evidence: [],
      },
      POLICY_VERSION,
      NOW,
    );
    expect(destination.outcome).toBe('clear');

    world = applyTrancheEvent(world, TRANCHE, { type: 'refund_initiated' }, ROLLBACK).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunding');
    world = applyTrancheEvent(world, TRANCHE, { type: 'payout_result', outcome: 'settled' }, ROLLBACK).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunded');

    world = applyDealEvent(world, DEAL, { type: 'tranches_refunded' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('unwound');

    // Деньги ушли с номинального счёта и обязательства перед покупателем нет.
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(0n);
    const gel = coverage(world.journal).find((item) => item.currency === GEL);
    expect(gel?.difference.minor).toBe(0n);
  });
});
