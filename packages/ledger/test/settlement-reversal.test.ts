import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type JournalEntry,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  accountBalance,
  accrueFee,
  appendEntries,
  appendEntry,
  bankNominal,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  clientTopUp,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  feeReceivable,
  lockForTranche,
  reverseFeeAccrual,
  reverseTrancheSettlement,
  settleTrancheToClientAccount,
  trancheSettlement,
  transitFee,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';

const buyer = clientKey('c1');
const seller = clientKey('c2');
const dealA = { dealId: 'A', trancheId: 't1' };
const dealB = { dealId: 'B', trancheId: 't2' };
const GROSS = money('GEL', 100_000n);
const FEE = money('GEL', 1_000n);
const NET = money('GEL', 99_000n);

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-04T10:${String(minute).padStart(2, '0')}:00Z` };
}

function expectCode(run: () => unknown, code: LedgerErrorCodeType): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
  }
}

function settlesA() {
  return trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller));
}

/** Полностью обеспеченный транш: деньги пришли и заперты под сделку A. */
function lockedUnderA(amount = GROSS) {
  return appendEntries(emptyJournal, [
    clientTopUp(at('f1'), buyer, amount),
    lockForTranche(at('f2', 1), buyer, dealA, amount),
  ]);
}

/** Начисление и расчёт по траншу: журнал в состоянии «комиссия удержана». */
function settled(): { journal: ReturnType<typeof lockedUnderA>; settlement: JournalEntry } {
  const accrual = accrueFee(at('a1', 2), dealA, FEE, 'plan-1');
  const settlement = settleTrancheToClientAccount(at('a2', 3), settlesA(), GROSS, accrual);
  return { journal: appendEntries(lockedUnderA(), [accrual, settlement]), settlement };
}

/**
 * Реверс расчёта — §3.1, и он был **невыразим**.
 *
 * **Проба (снята до правки).** Обратная запись собиралась конструктором без
 * замечаний, а `appendEntry` отвечал на неё:
 *
 * ```
 * CONSTRUCTOR OK
 * APPEND THREW: ledger.journal.fee_accrued_twice
 *   {"id":"a3","accruedBy":"a1","dealId":"A","trancheId":"t1"}
 * ```
 *
 * Причина — в `journal.ts`: признак начисления читался структурно, «чистый
 * дебет `fee:receivable` с отнесением к траншу». У реверса расчёта такой дебет
 * есть, потому что расчёт требование **гасил**, а реверс его возвращает. То
 * есть механизм запрещал не то, что собирался: не второе начисление, а возврат
 * требования, снятого этим же расчётом, — ровно тот класс дефекта, что уже
 * чинился в §3.1.
 *
 * Обе стороны правила проверяются здесь: реверс проходит, второе начисление —
 * по-прежнему нет.
 */
describe('реверс расчёта выразим, идемпотентность начисления цела', () => {
  it('кладёт полный реверс расчёта в журнал и возвращает деньги плательщику', () => {
    const { journal, settlement } = settled();
    const reversed = appendEntry(journal, reverseTrancheSettlement(at('a3', 10), settlement));

    // Деньги вернулись в файл транша, из файла получателя ушли.
    expect(
      accountBalance(reversed, clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), 'GEL')
        .minor,
    ).toBe(GROSS.minor);
    expect(accountBalance(reversed, clientFreeAccount(seller), 'GEL').minor).toBe(0n);
    // Комиссия ушла из транзита, требование снова открыто: доход признан,
    // расчёта нет — «начислено и не удержано». Это состояние выразимо, и
    // снимает его отдельная запись (`reverseFeeAccrual`), а не эта.
    expect(accountBalance(reversed, transitFee, 'GEL').minor).toBe(0n);
    expect(accountBalance(reversed, feeReceivable, 'GEL').minor).toBe(FEE.minor);
    expect(accountBalance(reversed, bankNominal('GEL'), 'GEL').minor).toBe(GROSS.minor);
  });

  it('второе начисление по тому же траншу отвергается по-прежнему', () => {
    const { journal, settlement } = settled();
    const reversed = appendEntry(journal, reverseTrancheSettlement(at('b3', 10), settlement));
    // И до реверса, и после него: «начислено» — величина транша, а не счётчик
    // вызовов (§4.6, Ф16). Послабление для реверса не открывает эту дверь.
    expectCode(
      () => appendEntry(journal, accrueFee(at('b4', 11), dealA, FEE, 'plan-1')),
      LedgerErrorCode.journalFeeAccruedTwice,
    );
    expectCode(
      () => appendEntry(reversed, accrueFee(at('b5', 12), dealA, FEE, 'plan-1')),
      LedgerErrorCode.journalFeeAccruedTwice,
    );
  });

  it('не пропускает начисление, притворившееся исправлением', () => {
    // Ссылка на исправляемую запись — не пропуск. Цель, которая требование по
    // комиссии не гасила, возвращать нечего: такой дебет — начисление, и он
    // сталкивается с уже сделанным.
    const { journal } = settled();
    expectCode(
      () =>
        appendEntry(
          journal,
          createJournalEntry({
            ...at('c3', 10),
            kind: 'correction',
            correctsEntryId: 'f2',
            memoKey: 'ledger.entry.fee_accrued',
            postings: [
              debit(feeReceivable, FEE, dealA),
              credit({ kind: 'fee_income' } as const, FEE, dealA),
            ],
          }),
        ),
      LedgerErrorCode.journalFeeAccruedTwice,
    );
  });

  it('возвращает требование не больше снятого: второй возврат той же комиссии — начисление', () => {
    // Частичный реверс одной только комиссии: клиентское обязательство не
    // двигается, поэтому объявление расчёта такой записи не нужно, и правило
    // «один реверс на расчёт» её не касается. Возвращать можно ровно столько,
    // сколько цель сняла, — иначе требование растёт из ниоткуда.
    const { journal, settlement } = settled();
    const feeLegBack = (id: string) =>
      createJournalEntry({
        ...at(id, 10),
        kind: 'correction',
        correctsEntryId: settlement.id,
        memoKey: 'ledger.entry.fee_withholding_reversed',
        postings: [debit(feeReceivable, FEE, dealA), credit(transitFee, FEE, dealA)],
      });
    const once = appendEntry(journal, feeLegBack('d3'));
    expect(accountBalance(once, feeReceivable, 'GEL').minor).toBe(FEE.minor);
    expectCode(() => appendEntry(once, feeLegBack('d4')), LedgerErrorCode.journalFeeAccruedTwice);
  });

  it('отматывает расчёт один раз', () => {
    // Комиссии нет вовсе — значит требование по комиссии второй реверс не
    // трогает, и остановить его правилом о начислении нечем. Останавливает
    // правило о самом реверсе: первый вернул деньги целиком, второй увёл бы
    // файл получателя в минус.
    const settlement = settleTrancheToClientAccount(at('e2', 3), settlesA(), GROSS);
    const journal = appendEntries(lockedUnderA(), [settlement]);
    const reversed = appendEntry(journal, reverseTrancheSettlement(at('e3', 10), settlement));
    expectCode(
      () => appendEntry(reversed, reverseTrancheSettlement(at('e4', 11), settlement)),
      LedgerErrorCode.journalSettlementReversedTwice,
    );
  });

  it('снятие начисления после реверса расчёта проходит, повторное начисление — нет', () => {
    // §4.4: сделка ушла в возвратную ветвь. Реверс расчёта и снятие начисления
    // — два разных факта, и они складываются: требование закрывается, доход
    // снимается, а начислить заново по этому траншу по-прежнему нельзя.
    const accrual = accrueFee(at('g1', 2), dealA, FEE, 'plan-1');
    const settlement = settleTrancheToClientAccount(at('g2', 3), settlesA(), GROSS, accrual);
    let journal = appendEntries(lockedUnderA(), [accrual, settlement]);
    journal = appendEntry(journal, reverseTrancheSettlement(at('g3', 10), settlement));
    journal = appendEntry(journal, reverseFeeAccrual(at('g4', 11), accrual));
    expect(accountBalance(journal, feeReceivable, 'GEL').minor).toBe(0n);
    expectCode(
      () => appendEntry(journal, accrueFee(at('g5', 12), dealA, FEE, 'plan-1')),
      LedgerErrorCode.journalFeeAccruedTwice,
    );
  });

  it('зеркалит саму запись расчёта, а не пересчитывает суммы', () => {
    const { settlement } = settled();
    const reversal = reverseTrancheSettlement(at('h3', 10), settlement);
    expect(reversal.correctsEntryId).toBe(settlement.id);
    expect(reversal.kind).toBe('correction');
    expect(reversal.settles).toBe(settlement.settles);
    expect(reversal.postings).toHaveLength(settlement.postings.length);
    for (const [index, posting] of reversal.postings.entries()) {
      const source = settlement.postings[index];
      expect(source).toBeDefined();
      if (source === undefined) return;
      expect(posting.account).toBe(source.account);
      expect(posting.amount).toBe(source.amount);
      expect(posting.attribution).toBe(source.attribution);
      expect(posting.direction).toBe(source.direction === 'debit' ? 'credit' : 'debit');
    }
    expect(NET.minor).toBe(GROSS.minor - FEE.minor);
  });

  it('отматывает только расчёт: чужой записи и чужому объявлению отказ', () => {
    const { journal, settlement } = settled();
    // Запись без объявления расчёта: зеркалить нечего — движения обязательства
    // между владельцами в ней нет, и «реверс» такой записи означал бы другую
    // операцию.
    const topUp = journal.entries[0];
    expect(topUp).toBeDefined();
    if (topUp === undefined) return;
    expectCode(
      () => reverseTrancheSettlement(at('i3', 10), topUp),
      LedgerErrorCode.entryReversalTargetNotSettlement,
    );
    // Исправление исправления — отдельная операция со своей ссылкой.
    const reversal = reverseTrancheSettlement(at('i4', 11), settlement);
    expectCode(
      () => reverseTrancheSettlement(at('i5', 12), reversal),
      LedgerErrorCode.entryReversalTargetNotSettlement,
    );
  });

  it('реверс по одной сделке не открывает начисление по другой', () => {
    const { journal, settlement } = settled();
    const reversed = appendEntry(journal, reverseTrancheSettlement(at('j3', 10), settlement));
    // Ключ идемпотентности — пара «сделка, транш»: соседний транш реверсом
    // сделки A не задет ни в одну сторону.
    const other = appendEntry(reversed, accrueFee(at('j4', 11), dealB, FEE, 'plan-1'));
    expect(accountBalance(other, feeReceivable, 'GEL').minor).toBe(FEE.minor + FEE.minor);
  });
});
