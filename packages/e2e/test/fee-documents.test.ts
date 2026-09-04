import { describe, expect, it } from 'vitest';
import { money } from '@sdelka/money';
import {
  accountBalance,
  accountCode,
  bankOperating,
  checkLedgerInvariants,
  clientFreeAccount,
  dealStatement,
  feePositions,
} from '@sdelka/ledger';
import {
  advance,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyTrancheEvent,
  receiveExternalPayment,
  receiveTrancheFee,
} from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  DAY_MS,
  GEL,
  POLICY_VERSION,
  TARIFF_VERSION,
} from './support/fixtures';
import { toPayingOut } from './support/paths';

const SETTLED = trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE });
const FEE = 300_000n;
const NET = 19_700_000n;

/**
 * Сценарий 14 — комиссия как две встречные величины и выписка по сделке.
 *
 * Правило `CORE.md` Ф16: **начислено, удержано и получено — три разные
 * величины**. До E14 все три были одним числом: расчёт кредитовал `fee:income`
 * прямо в своей записи, и «доход признан» нельзя было отличить от «деньги у
 * нас». Здесь это проверяется прогоном, а не чтением конструктора.
 */
describe('комиссия и выписка по сделке', () => {
  it('оформляет комиссию двумя встречными фактами и показывает три величины раздельно', async () => {
    const DEAL = 'deal-fee-documents';
    const TRANCHE = 'tranche-fee-documents';

    const path = await toPayingOut({ dealId: DEAL, trancheId: TRANCHE });
    let world = applyTrancheEvent(
      path.world,
      TRANCHE,
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paid_out');

    // --- Две записи, а не одна ---
    const memos = world.journal.entries.map((entry) => entry.memoKey);
    expect(memos).toContain('ledger.entry.fee_accrued');
    expect(memos).toContain('ledger.entry.tranche_settled');
    // Порядок значим: удержание без начисления уводит требование платформы в
    // минус, и это ловит `platformAssetNegative`.
    expect(memos.indexOf('ledger.entry.fee_accrued')).toBeLessThan(
      memos.indexOf('ledger.entry.tranche_settled'),
    );

    // --- Версия тарифного плана — факт журнала (И14.3) ---
    const accrual = world.journal.entries.find(
      (entry) => entry.memoKey === 'ledger.entry.fee_accrued',
    );
    expect(accrual?.accrues?.tariffVersionId).toBe(TARIFF_VERSION);
    expect(accrual?.accrues?.fee.minor).toBe(FEE);

    // --- Три величины ---
    const withheld = feePositions(world.journal).find((item) => item.deal.trancheId === TRANCHE);
    expect(withheld?.accrued.minor).toBe(FEE);
    // Требование погашено расчётом: начисленного, но не удержанного, нет.
    expect(withheld?.notWithheld.minor).toBe(0n);
    expect(withheld?.withheld.minor).toBe(FEE);
    // ⚠ Получено — ноль. Межбанковский перевод идёт день-два, и до его прихода
    // «удержано» не выдаётся за «получено» (`FUNCTIONAL.md` §3.1).
    expect(withheld?.received.minor).toBe(0n);
    expect(withheld?.inTransit.minor).toBe(FEE);
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(0n);

    world = receiveTrancheFee(world, DEAL, TRANCHE, money(GEL, FEE));
    const received = feePositions(world.journal).find((item) => item.deal.trancheId === TRANCHE);
    expect(received?.received.minor).toBe(FEE);
    expect(received?.inTransit.minor).toBe(0n);
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(FEE);
    expect(checkLedgerInvariants(world.journal)).toEqual([]);
  });

  it('замечает зависшую в транзите комиссию по возрасту, а не по покрытию', async () => {
    const DEAL = 'deal-fee-stuck';
    const TRANCHE = 'tranche-fee-transit';

    const path = await toPayingOut({ dealId: DEAL, trancheId: TRANCHE });
    let world = applyTrancheEvent(
      path.world,
      TRANCHE,
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    ).world;

    // Покрытие не нарушено: деньги клиентов на месте, в транзите наши. Поэтому
    // расхождение выражается **возрастом позиции**, а не покрытием, — и
    // «получено» перестаёт наступать молча.
    expect(checkLedgerInvariants(world.journal)).toEqual([]);

    // Порог считается от отметки записи, а не от часов мира: проверка учёта —
    // чистая функция, системного времени она не спрашивает. Поэтому мир
    // двигается вперёд и делает **новую** запись.
    world = advance(world, 3 * DAY_MS);
    let stuck: unknown = null;
    try {
      receiveExternalPayment(world, path.buyerKey, money(GEL, 1_000n));
    } catch (error) {
      stuck = error;
    }
    expect(stuck).toBeInstanceOf(Error);
    expect(String(stuck)).toContain('ledger.invariant.transit_stale');
  });

  it('собирает выписку по сделке для обеих сторон', async () => {
    const DEAL = 'deal-statement';
    const TRANCHE = 'tranche-statement';

    const path = await toPayingOut({ dealId: DEAL, trancheId: TRANCHE });
    let world = applyTrancheEvent(
      path.world,
      TRANCHE,
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    ).world;
    world = receiveTrancheFee(world, DEAL, TRANCHE, money(GEL, FEE));

    const statement = dealStatement(world.journal, { dealId: DEAL, trancheId: TRANCHE });
    const kinds = statement.events.map((event) => event.memoKey);
    // Запирание, расчёт, начисление и приход комиссии — события одной сделки.
    expect(kinds).toContain('ledger.entry.locked_for_tranche');
    expect(kinds).toContain('ledger.entry.fee_accrued');
    expect(kinds).toContain('ledger.entry.tranche_settled');
    expect(kinds).toContain('ledger.entry.fee_received');

    // --- Главная строка получателя на месте ---
    // Записи попадают в выписку **целиком**, а не только проводками файла
    // транша: зачисление нетто отнесено к файлу получателя, и при фильтрации по
    // файлу транша сторона не увидела бы, сколько ей пришло.
    const settlement = statement.events.find(
      (event) => event.memoKey === 'ledger.entry.tranche_settled',
    );
    const toRecipient = settlement?.postings.find(
      (posting) =>
        posting.direction === 'credit' &&
        posting.accountCode === accountCode(clientFreeAccount(path.sellerKey)),
    );
    expect(toRecipient?.amount.minor).toBe(NET);
    // И строка плательщика — в той же записи: сколько списано с файла транша.
    const fromPayer = settlement?.postings.find(
      (posting) => posting.direction === 'debit' && posting.accountCode.includes(TRANCHE),
    );
    expect(fromPayer?.amount.minor).toBe(20_000_000n);

    // Текста в выписке нет — только ключи локализации: три языка (§5).
    for (const event of statement.events) {
      expect(event.memoKey).toMatch(/^ledger\.entry\.[a-z_]+$/u);
    }

    // Три величины комиссии приезжают вместе с выпиской, а не считаются
    // получателем самостоятельно.
    expect(statement.fee).toHaveLength(1);
    expect(statement.fee[0]?.received.minor).toBe(FEE);
  });
});
