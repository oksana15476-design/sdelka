import { describe, expect, it } from 'vitest';
import {
  accountBalance,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientFreeAccount,
  clientLockedAccount,
  coverage,
  createJournalEntry,
  credit,
  debit,
  shouldStopAcceptingDeals,
  transitWriteoff,
  unclaimedCoverage,
  unclaimedLiability,
} from '@sdelka/ledger';
import {
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyTrancheEvent,
  receiveWriteOffTransit,
} from './support/acting';
import { DEAL_AMOUNT, GEL, POLICY_VERSION } from './support/fixtures';
import { toCollected, toReserved } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION, { taskKind: 'source_of_funds' });
/** Деньги уже на свободной части счёта: возврат их туда не зачисляет заново. */
const ROLLBACK = trancheOptions(POLICY_VERSION, {
  taskKind: 'source_of_funds',
  creditRoute: 'already_on_client_account',
});
const DEAL = 'deal-unclaimed';
const TRANCHE = 'tranche-unclaimed';

/**
 * Сценарий 17 — невостребованные средства (`FUNCTIONAL.md` §3.1, случай Б).
 *
 * Клиент не найден, возврат невозможен, сделка мертва. Обязательство по траншу
 * закрывается, и деньги обязаны **уйти с номинального счёта**: на нём допустимы
 * только средства клиентов, а остаток без признанного клиентского
 * обязательства делает счёт нечистым.
 *
 * Здесь сходятся три правила, и каждое проверяется прогоном:
 *
 * 1. `g_write_off_approvers_distinct` — списание утверждают два разных
 *    человека, и ни один из них не готовил операцию. Это единственная
 *    операция, которой человек закрывает чужое обязательство своей волей, и
 *    цена ошибки — вся сумма транша;
 * 2. **два момента, а не один.** Счета в разных банках, перевод идёт день-два,
 *    и всё это время долг стоит против транзитного актива. Прежняя редакция
 *    записывала списание одной записью прямо на операционный счёт — то есть
 *    утверждала, что межбанковский перевод уже дошёл;
 * 3. **из терминального пула деньги обратно к клиенту не выходят.** Порядок
 *    обращения с невостребованными помечен в §3.1 как [открыто]; до ответа
 *    юриста выдача содержимого пула лицу невыразима записью.
 */
describe('невостребованные средства', () => {
  it('списывается двумя утверждениями, в два момента, и обратно к клиенту не выходит', async () => {
    const reserved = await toReserved({ dealId: DEAL, trancheId: TRANCHE });
    // Расхождение увело транш в разбор, разбор ничем не кончился: клиента не
    // нашли, возвращать некуда.
    let world = applyTrancheEvent(
      reserved.world,
      TRANCHE,
      { type: 'mismatch_detected', field: 'payer.unreachable' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_blocked');
    const locked = clientLockedAccount(reserved.buyerKey, DEAL, TRANCHE);
    expect(accountBalance(world.journal, locked, GEL).minor).toBe(20_000_000n);

    // --- Одна учётная запись списание не утверждает ---
    expect([
      ...rejectTrancheEvent(world, TRANCHE, { type: 'write_off_approved', userIds: ['operator-2'] })
        .failedGuards,
    ]).toEqual(['g_write_off_approvers_distinct']);

    // --- Тот, кто готовил операцию, вторым утверждающим не считается ---
    expect(trancheOf(world, TRANCHE).facts.preparedBy).toBe('operator-1');
    expect([
      ...rejectTrancheEvent(world, TRANCHE, {
        type: 'write_off_approved',
        userIds: ['operator-1', 'operator-2'],
      }).failedGuards,
    ]).toEqual(['g_write_off_approvers_distinct']);

    // --- Один человек дважды — не два человека ---
    expect([
      ...rejectTrancheEvent(world, TRANCHE, {
        type: 'write_off_approved',
        userIds: ['operator-2', 'operator-2'],
      }).failedGuards,
    ]).toEqual(['g_write_off_approvers_distinct']);

    // --- Момент 1: два разных утверждения, обязательство закрыто ---
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'write_off_approved', userIds: ['operator-2', 'operator-3'] },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('written_off');

    // Файл транша пуст с обеих сторон, деньги ушли с номинального счёта в
    // транзит и стали долгом невостребованных — но ещё не дошли.
    expect(accountBalance(world.journal, locked, GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, transitWriteoff, GEL).minor).toBe(20_000_000n);
    expect(accountBalance(world.journal, unclaimedLiability, GEL).minor).toBe(20_000_000n);
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(0n);

    // Основное отношение покрытия невостребованных не видит вовсе — это прямое
    // указание §3.1, — а вторая проверка их видит и находит обеспеченными
    // транзитом. Промежуток между банками виден, а не спрятан.
    expect(coverage(world.journal).find((item) => item.currency === GEL)?.obligations.minor).toBe(0n);
    const unclaimed = unclaimedCoverage(world.journal).find((item) => item.currency === GEL);
    expect(unclaimed?.obligations.minor).toBe(20_000_000n);
    expect(unclaimed?.custody.minor).toBe(20_000_000n);
    expect(unclaimed?.covered).toBe(true);
    expect(checkLedgerInvariants(world.journal)).toEqual([]);
    expect(shouldStopAcceptingDeals(world.journal)).toBe(false);

    // --- Момент 2: деньги дошли на операционный счёт ---
    // Это не переход транша: он терминален с момента 1, а приход подтверждает
    // банковская выписка.
    world = receiveWriteOffTransit(world, DEAL_AMOUNT);
    expect(accountBalance(world.journal, transitWriteoff, GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(20_000_000n);
    expect(accountBalance(world.journal, unclaimedLiability, GEL).minor).toBe(20_000_000n);
    expect(checkLedgerInvariants(world.journal)).toEqual([]);

    // --- Выдать содержимое пула лицу нечем ---
    // Вторая запись двухзаписной отмывки через невостребованные: обязательство
    // перед X закрыто по всем правилам, а содержимое пула «возвращается»
    // постороннему Z. По отдельности обе записи выглядят безупречно.
    expect(() =>
      createJournalEntry({
        id: 'unclaimed-payout',
        occurredAt: new Date(world.now).toISOString(),
        kind: 'settlement',
        memoKey: 'ledger.entry.illegal',
        postings: [
          debit(unclaimedLiability, { currency: GEL, minor: 20_000_000n }),
          credit(clientFreeAccount(reserved.sellerKey), { currency: GEL, minor: 20_000_000n }, {
            clientKey: reserved.sellerKey,
          }),
        ],
      }),
    ).toThrow('ledger.entry.terminal_pool_payout');

    // И то же самое с переносом кастодиана — форма, которая «сходится»:
    // деньги переезжают с операционного счёта обратно на номинальный.
    expect(() =>
      createJournalEntry({
        id: 'unclaimed-payout-funded',
        occurredAt: new Date(world.now).toISOString(),
        kind: 'settlement',
        memoKey: 'ledger.entry.illegal',
        postings: [
          debit(unclaimedLiability, { currency: GEL, minor: 20_000_000n }),
          credit(clientFreeAccount(reserved.sellerKey), { currency: GEL, minor: 20_000_000n }, {
            clientKey: reserved.sellerKey,
          }),
          credit(bankOperating(GEL), { currency: GEL, minor: 20_000_000n }),
          debit(bankNominal(GEL), { currency: GEL, minor: 20_000_000n }, {
            clientKey: reserved.sellerKey,
          }),
        ],
      }),
    ).toThrow('ledger.entry.terminal_pool_payout');
  });

  /**
   * Списание закрывает **то обязательство, которое дебетует** — и только его.
   *
   * Путь сюда не выдуман: `collected --refund_requested--> refund_pending
   * --refund_initiated--> refunding --payout_result(rejected)-->
   * release_blocked` в `reserved` не заходит ни разу, поэтому файл транша пуст,
   * а деньги лежат в **свободной** части счёта покупателя. Они его собственные
   * и отзывные (красная линия №7), выход для них — возврат, а не списание.
   *
   * Раньше такой транш уходил в `written_off` **бесследно**: сумма записи
   * берётся из файла транша, пустой файл не порождал намерения проводки вовсе,
   * и в журнале не оставалось ничего — при том что статус утверждает «долг
   * закрыт, деньги ушли с номинального счёта».
   *
   * Guard `g_write_off_covers_collected` появился в этом же батче, и сквозной
   * контур его **не проверял**: мутационный прогон, научившись читать все
   * перечни домена, нашёл его непокрытым вместе с шестью guard'ами сделки.
   */
  it('не списывает собранное, которое лежит в свободной части, а не в файле транша', async () => {
    const collected = await toCollected({
      dealId: 'deal-unclaimed-free',
      trancheId: 'tranche-unclaimed-free',
    });
    const tranche = 'tranche-unclaimed-free';
    let world = applyTrancheEvent(collected.world, tranche, { type: 'refund_requested', reason: 'buyer.requested' }, ROLLBACK).world;
    world = applyTrancheEvent(world, tranche, { type: 'refund_initiated' }, ROLLBACK).world;
    world = applyTrancheEvent(world, tranche, { type: 'payout_result', outcome: 'rejected' }, ROLLBACK).world;
    expect(trancheStatusOf(world, tranche)).toBe('release_blocked');

    // Собрано — да; заперто — нет. Ровно та пара, которую `g_funds_locked`
    // различить не может: у него пустое собранное и незапертое собранное
    // сливаются в один отказ.
    const facts = trancheOf(world, tranche).facts;
    expect(facts.collectedAmount?.minor).toBe(20_000_000n);
    const file = clientLockedAccount(collected.buyerKey, 'deal-unclaimed-free', tranche);
    expect(accountBalance(world.journal, file, GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, clientFreeAccount(collected.buyerKey), GEL).minor).toBe(
      20_000_000n,
    );

    // Два разных утверждающих — и всё равно отказ, потому что закрывать этим
    // списанием нечего: обязательство стоит не там, куда смотрит запись.
    const refused = rejectTrancheEvent(world, tranche, {
      type: 'write_off_approved',
      userIds: ['operator-2', 'operator-3'],
    });
    expect(refused.code).toBe('domain.guard.failed');
    expect([...refused.failedGuards]).toEqual(['g_write_off_covers_collected']);

    // Журнал не сдвинулся ни на запись, обязательство перед клиентом целое.
    expect(accountBalance(world.journal, clientFreeAccount(collected.buyerKey), GEL).minor).toBe(
      20_000_000n,
    );
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
    expect(checkLedgerInvariants(world.journal)).toEqual([]);
  });
});
