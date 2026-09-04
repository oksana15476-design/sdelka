import { describe, expect, it } from 'vitest';
import {
  appendEntry,
  accountBalance,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientAccountOwner,
  clientFreeAccount,
  clientLockedAccount,
  coverageByTranche,
  createJournalEntry,
  credit,
  feePositions,
  debit,
  isClientObligationAccount,
  shortfallExpense,
  shouldStopAcceptingDeals,
  trancheSettlement,
} from '@sdelka/ledger';
import type { ClientKey, JournalEntry } from '@sdelka/ledger';
import { type Intent, reduceTranche } from '@sdelka/domain';
import { money } from '@sdelka/money';
import {
  applyTrancheEvent,
  approve,
  contextFor,
  coverageOk,
  payerOf,
  receiveTrancheFee,
  recipientOf,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  BANK_RESPONSE_SOURCE,
  BUYER,
  DEAL_AMOUNT,
  GEL,
  POLICY_VERSION,
  SELLER,
  THIRD_PARTY,
  TWO_ROLE,
} from './support/fixtures';
import { toPayingOut, toReleasePending, toReserved } from './support/paths';

/**
 * Подлинное намерение расчёта, снятое с автомата.
 *
 * Единственный способ получить `DealPartiesAttestation` за пределами домена:
 * значение этого типа невозможно построить кодом, и учёт его тоже не выдаёт.
 * Редьюсер вызывается вхолостую — мир при этом не меняется, — и намерение
 * достаётся из результата перехода.
 */
function settlementIntentOf(
  world: Parameters<typeof contextFor>[0],
  trancheId: string,
): Extract<Intent, { type: 'post_settlement_entry' }> {
  const runtime = trancheOf(world, trancheId);
  const result = reduceTranche(
    runtime.state,
    { type: 'payout_result', outcome: 'settled' },
    contextFor(world, runtime),
  );
  if (!result.ok) {
    throw new Error(`e2e.test.settlement_unreachable:${result.error.code}`);
  }
  const intent = result.value.intents.find((item) => item.type === 'post_settlement_entry');
  if (intent === undefined || intent.type !== 'post_settlement_entry') {
    throw new Error('e2e.test.settlement_intent_missing');
  }
  return intent;
}

const SETTLED = trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE });

const FEE = 300_000n;
const NET = 19_700_000n;

/**
 * Сценарий 10 — красные линии №1 и №2 в сквозном прогоне.
 *
 * Обе проверяются **прогоном**, а не чтением конструктора: модульный тест
 * учёта показывает, что запись такой-то формы собирается или не собирается, а
 * здесь деньги проходят весь путь от инструкций на оплату до терминального
 * состояния, и после каждого шага пересчитываются инварианты.
 */
describe('красные линии в сквозном прогоне', () => {
  it('не оставляет комиссию платформы на номинальном счёте (красная линия №2)', async () => {
    const DEAL = 'deal-fee-sweep';
    const TRANCHE = 'tranche-fee-sweep';

    const path = await toPayingOut({ dealId: DEAL, trancheId: TRANCHE });
    let world = path.world;
    // До расчёта на номинальном счёте лежит вся сумма транша и она вся —
    // обязательство перед покупателем.
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(0n);

    world = applyTrancheEvent(world, TRANCHE, { type: 'payout_result', outcome: 'settled' }, SETTLED).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paid_out');

    // --- Комиссия: две встречные записи, а не одна (`CORE.md` Ф16, И14.1) ---
    // Начисление признаёт доход против требования платформы, расчёт это
    // требование гасит и кладёт деньги в транзит. Формулировка красной линии
    // при этом уточнена и в документе: «не хранится на номинальном счёте» — а
    // не «в тот же миг лежит на операционном»; межбанк идёт день-два.
    const accrual = world.journal.entries.find(
      (entry) => entry.memoKey === 'ledger.entry.fee_accrued',
    );
    const settlement = world.journal.entries.find(
      (entry) => entry.memoKey === 'ledger.entry.tranche_settled',
    );
    expect(accrual).toBeDefined();
    expect(settlement).toBeDefined();
    if (accrual === undefined || settlement === undefined) throw new Error('unreachable');
    const income = accrual.postings.find(
      (posting) => posting.account.kind === 'fee_income' && posting.direction === 'credit',
    );
    const receivable = accrual.postings.find(
      (posting) => posting.account.kind === 'fee_receivable' && posting.direction === 'debit',
    );
    expect(income?.amount.minor).toBe(FEE);
    expect(receivable?.amount.minor).toBe(FEE);
    // Расчёт гасит требование и уводит комиссию в транзит **в той же записи**:
    // без дебета `transit:fee` она не сходится повалютно, то есть красная линия
    // №2 держится теперь балансом, а не проверкой.
    const closed = settlement.postings.find(
      (posting) => posting.account.kind === 'fee_receivable' && posting.direction === 'credit',
    );
    const transit = settlement.postings.find(
      (posting) => posting.account.kind === 'transit_fee' && posting.direction === 'debit',
    );
    expect(closed?.amount.minor).toBe(FEE);
    expect(transit?.amount.minor).toBe(FEE);

    // --- Прогон, а не чтение: на номинальном счёте ровно обязательство ---
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(NET);
    expect(accountBalance(world.journal, clientFreeAccount(path.sellerKey), GEL).minor).toBe(NET);
    // На операционном счёте комиссии **ещё нет**: перевод не дошёл. Три
    // величины видны раздельно, и «удержано» не выдаётся за «получено».
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(0n);
    const positionBeforeArrival = feePositions(world.journal).find(
      (item) => item.deal.trancheId === TRANCHE,
    );
    expect(positionBeforeArrival?.accrued.minor).toBe(FEE);
    expect(positionBeforeArrival?.notWithheld.minor).toBe(0n);
    expect(positionBeforeArrival?.withheld.minor).toBe(FEE);
    expect(positionBeforeArrival?.received.minor).toBe(0n);
    expect(positionBeforeArrival?.inTransit.minor).toBe(FEE);

    // --- Перевод дошёл: тот же факт банковской выписки, что у списания ---
    world = receiveTrancheFee(world, DEAL, TRANCHE, money(GEL, FEE));
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(FEE);
    const positionAfterArrival = feePositions(world.journal).find(
      (item) => item.deal.trancheId === TRANCHE,
    );
    expect(positionAfterArrival?.received.minor).toBe(FEE);
    expect(positionAfterArrival?.inTransit.minor).toBe(0n);
    // Файл транша пуст с обеих сторон: ни обязательства, ни средств.
    const file = coverageByTranche(world.journal).find(
      (item) => item.deal.trancheId === TRANCHE && item.currency === GEL,
    );
    expect(file?.obligations.minor).toBe(0n);
    expect(file?.custody.minor).toBe(0n);
    // Профицита нет: забытая комиссия выглядела бы именно им.
    expect(checkLedgerInvariants(world.journal)).toEqual([]);
    expect(shouldStopAcceptingDeals(world.journal)).toBe(false);

    // --- Обратная проверка: прежний ручной вывод теперь создаёт недостачу ---
    // Так выглядела удалённая `sweepFeeToOperating`. Раньше она была нужна,
    // потому что расчёт оставлял комиссию в файле транша; сегодня файл уже пуст,
    // и та же запись уводит его в минус. Это и есть причина, по которой вывод
    // не может остаться отдельным шагом «на всякий случай».
    const staleSweep: JournalEntry = createJournalEntry({
      id: 'stale-fee-sweep',
      occurredAt: new Date(world.now).toISOString(),
      kind: 'settlement',
      memoKey: 'ledger.entry.fee_swept_to_operating',
      postings: [
        debit(bankOperating(GEL), { currency: GEL, minor: FEE }),
        credit(bankNominal(GEL), { currency: GEL, minor: FEE }, { dealId: DEAL, trancheId: TRANCHE }),
      ],
    });
    const broken = appendEntry(world.journal, staleSweep);
    expect(checkLedgerInvariants(broken).map((item) => item.code)).toContain(
      'ledger.invariant.tranche_uncovered',
    );
    expect(shouldStopAcceptingDeals(broken)).toBe(true);
  });

  it('не пускает деньги, запертые под сделку А, в обеспечение сделки Б другого лица (красная линия №1)', async () => {
    const DEAL_A = 'deal-a-lock';
    const TRANCHE_A = 'tranche-a-lock';
    const DEAL_B = 'deal-b-lock';
    const TRANCHE_B = 'tranche-b-lock';

    // Две сделки, четыре разных человека: покупатель Б к сделке А отношения не
    // имеет вовсе. Именно этот случай прежняя проверка учёта пропускала —
    // расчёт по сделке А кредитовал свободную часть **произвольного** клиента.
    // Сделка А доведена до поручения, сделка Б заведена в том же мире и
    // остаётся зарезервированной: два файла существуют одновременно, и это
    // единственная обстановка, в которой проверяемое правило вообще имеет смысл.
    const a = await toPayingOut({ dealId: DEAL_A, trancheId: TRANCHE_A, buyer: BUYER, seller: SELLER });
    const b = await toReserved({
      dealId: DEAL_B,
      trancheId: TRANCHE_B,
      buyer: THIRD_PARTY,
      seller: TWO_ROLE,
      world: a.world,
    });
    let world = b.world;
    expect(trancheStatusOf(world, TRANCHE_A)).toBe('paying_out');
    expect(trancheStatusOf(world, TRANCHE_B)).toBe('reserved');
    // Четыре разных лица, четыре разных ключа счёта.
    expect(new Set([a.buyerKey, a.sellerKey, b.buyerKey, b.sellerKey]).size).toBe(4);

    const lockedA = clientLockedAccount(a.buyerKey, DEAL_A, TRANCHE_A);
    const lockedB = clientLockedAccount(b.buyerKey, DEAL_B, TRANCHE_B);
    expect(accountBalance(world.journal, lockedA, GEL).minor).toBe(20_000_000n);
    expect(accountBalance(world.journal, lockedB, GEL).minor).toBe(20_000_000n);

    const occurredAt = new Date(world.now).toISOString();
    const amount = { currency: GEL, minor: 20_000_000n };

    // --- Дверь 1: перенос между файлами напрямую ---
    expect(() =>
      createJournalEntry({
        id: 'cross-lock',
        occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.illegal',
        postings: [
          debit(lockedA, amount, { dealId: DEAL_A, trancheId: TRANCHE_A }),
          credit(lockedB, amount, { dealId: DEAL_B, trancheId: TRANCHE_B }),
        ],
      }),
    ).toThrow('ledger.entry.locked_to_locked');

    // --- Дверь 2: обязательство переезжает к постороннему без объявления ---
    expect(() =>
      createJournalEntry({
        id: 'cross-owner',
        occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.illegal',
        postings: [
          debit(lockedA, amount, { dealId: DEAL_A, trancheId: TRANCHE_A }),
          credit(clientFreeAccount(b.buyerKey), amount, { clientKey: b.buyerKey }),
        ],
      }),
    ).toThrow('ledger.entry.client_owner_mismatch');

    // --- Объявление, которое приложение не может выписать себе само ---
    //
    // ⚠ Раньше на этом месте объявление собиралось прямо здесь, вызовом
    // `trancheSettlement(...)` с любыми сторонами: тест показывал, что запись с
    // объявлением про чужую сделку отвергается, но само объявление изготавливал
    // тот же, кто строил проводки. Сегодня четвёртый аргумент обязателен, и
    // построить его нечем: у `DealPartiesAttestation` ambient-ключ. Взять
    // подтверждение можно только одним способом — получить его от автомата
    // вместе с намерением расчёта.
    const genuine = settlementIntentOf(world, TRANCHE_A);
    expect(genuine.dealId).toBe(DEAL_A);
    expect(genuine.recipientClientKey).toBe(a.sellerKey);

    // --- Дверь 3: подтверждение с сделки А предъявляется по сделке Б ---
    expect(() =>
      trancheSettlement(
        { dealId: DEAL_B, trancheId: TRANCHE_B },
        b.buyerKey,
        b.sellerKey,
        genuine.attestation,
      ),
    ).toThrow('ledger.settlement.attestation_mismatch');

    // --- Дверь 3а: подтверждение подлинное, а получателя подменили ---
    // Именно эта подмена и была прежней дырой: получатель приезжал в проводку
    // свободным параметром приложения. Теперь он назван в подтверждении, и
    // подстановка постороннего ломает сверку, а не проходит молча.
    expect(() =>
      trancheSettlement(
        { dealId: DEAL_A, trancheId: TRANCHE_A },
        a.buyerKey,
        b.buyerKey,
        genuine.attestation,
      ),
    ).toThrow('ledger.settlement.attestation_mismatch');

    // --- Дверь 3б: объявление подлинное, но постройка ему не соответствует ---
    // Объявление не индульгенция: каждая проводка сверяется с ним, и свободная
    // часть постороннего лица в записи расчёта по сделке А — посторонний счёт.
    const settlesA = trancheSettlement(
      { dealId: DEAL_A, trancheId: TRANCHE_A },
      a.buyerKey,
      a.sellerKey,
      genuine.attestation,
    );
    expect(() =>
      createJournalEntry({
        id: 'cross-declared',
        occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.illegal',
        settles: settlesA,
        postings: [
          debit(lockedA, amount, { dealId: DEAL_A, trancheId: TRANCHE_A }),
          credit(clientFreeAccount(b.buyerKey), amount, { clientKey: b.buyerKey }),
        ],
      }),
    ).toThrow('ledger.entry.settlement_shape_mismatch');

    // --- Дверь 4: обязательство уводится в пул-вход ---
    // Первый шаг двухзаписной отмывки: обязательство по траншу А гасится в пул
    // без владельца, вторая запись опознаёт деньги на постороннее лицо.
    // Условие запрета — объявленное направление пула, а не имя счёта, поэтому
    // та же атака через `unclaimed:liability` разбирается в отдельном сценарии.
    expect(() =>
      createJournalEntry({
        id: 'into-suspense',
        occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.illegal',
        postings: [
          debit(lockedA, amount, { dealId: DEAL_A, trancheId: TRANCHE_A }),
          credit({ kind: 'suspense_unidentified' }, amount),
        ],
      }),
    ).toThrow('ledger.entry.obligation_into_intake_pool');

    // --- Законный путь: сделка А рассчитывается и файл Б не шелохнулся ---
    world = applyTrancheEvent(
      world,
      TRANCHE_A,
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE_A)).toBe('paid_out');
    expect(accountBalance(world.journal, lockedB, GEL).minor).toBe(20_000_000n);
    expect(accountBalance(world.journal, clientFreeAccount(b.buyerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, clientFreeAccount(b.sellerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, clientFreeAccount(a.sellerKey), GEL).minor).toBe(NET);

    // --- Сквозная проверка всего журнала ---
    // Ни одна запись не переносит обязательство между владельцами без
    // объявления, а каждое объявление называет тот же транш и тех же лиц,
    // которых знает автомат: получатель приезжает в проводку из состояния
    // транша, заведённого сделкой.
    const runtimeA = trancheOf(world, TRANCHE_A);
    let declared = 0;
    for (const entry of world.journal.entries) {
      const debited = new Set<ClientKey>();
      const credited = new Set<ClientKey>();
      for (const posting of entry.postings) {
        if (!isClientObligationAccount(posting.account)) continue;
        const owner = clientAccountOwner(posting.account);
        if (owner === null) continue;
        (posting.direction === 'debit' ? debited : credited).add(owner);
      }
      const crosses = [...debited].some((from) => [...credited].some((to) => from !== to));
      if (!crosses) continue;
      declared += 1;
      expect(entry.settles).not.toBeNull();
      expect(entry.settles?.deal).toEqual({ dealId: DEAL_A, trancheId: TRANCHE_A });
      expect(entry.settles?.payer).toBe(payerOf(runtimeA));
      expect(entry.settles?.recipient).toBe(recipientOf(runtimeA));
      expect(entry.settles?.recipient).toBe(a.sellerKey);
    }
    // Такая запись в прогоне ровно одна — расчёт по сделке А.
    expect(declared).toBe(1);
    expect(checkLedgerInvariants(world.journal)).toEqual([]);
    expect(DEAL_AMOUNT.minor).toBe(20_000_000n);
  });

  it('не выпускает выплату при покрытии клиентских средств меньше единицы (красная линия №3)', async () => {
    const DEAL = 'deal-coverage';
    const TRANCHE = 'tranche-coverage';

    const pending = await toReleasePending({ dealId: DEAL, trancheId: TRANCHE });
    // Два утверждения набраны: единственное, чего может не хватать ниже, —
    // покрытие.
    let world = approve(pending.world, TRANCHE, 'approver-1');
    world = approve(world, TRANCHE, 'approver-2');
    const runtime = trancheOf(world, TRANCHE);
    const healthy = contextFor(world, runtime);
    expect(healthy.facts.coverageOk).toBe(true);

    // Недостача, а не выдумка: банк списал деньги с номинального счёта, и
    // обязательство перед покупателем осталось непокрытым. Отнесение — файл
    // того самого транша.
    const damaged = appendEntry(
      world.journal,
      createJournalEntry({
        id: 'bank-shortfall',
        occurredAt: new Date(world.now).toISOString(),
        kind: 'settlement',
        memoKey: 'ledger.entry.shortfall',
        postings: [
          debit(shortfallExpense, { currency: GEL, minor: 1n }),
          credit(bankNominal(GEL), { currency: GEL, minor: 1n }, { dealId: DEAL, trancheId: TRANCHE }),
        ],
      }),
    );
    expect(coverageOk(damaged)).toBe(false);
    // Красная линия №3: приём новых сделок останавливается автоматически.
    expect(shouldStopAcceptingDeals(damaged)).toBe(true);

    // ⚠ Мир с недостачей собрать через `sealed` нельзя — она и есть нарушение
    // инварианта, и шаг с ней не состоится. Поэтому контекст автомата собран
    // здесь из повреждённого журнала напрямую: проверяется, что при таком
    // покрытии ребро `release_pending → paying_out` **непроходимо**, а не то,
    // что мир до него не доживёт.
    const context = { ...healthy, facts: { ...healthy.facts, coverageOk: coverageOk(damaged) } };
    const refused = reduceTranche(runtime.state, { type: 'release_authorized' }, context);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect([...refused.error.failedGuards]).toEqual(['g_coverage_ok']);
    }
    // При здоровом покрытии то же самое ребро проходимо: отказ вызван именно
    // покрытием, а не недобором утверждений или пакетом доказательств.
    const allowed = reduceTranche(runtime.state, { type: 'release_authorized' }, healthy);
    expect(allowed.ok).toBe(true);
  });
});
