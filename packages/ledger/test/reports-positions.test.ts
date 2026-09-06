import { money, rational } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  absorbShortfall,
  accountBalance,
  accrueFee,
  appendEntries,
  appendEntry,
  bankNominal,
  bankOperating,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  clientTopUp,
  coverage,
  credit,
  dealStatement,
  debit,
  emptyJournal,
  feeAccrualFor,
  fundShortfall,
  lockForTranche,
  negativeBankBalances,
  openFeeReceivables,
  openTransitPositions,
  settleTrancheToClientAccount,
  trancheSettlement,
  unclaimedCoverage,
  writeOffTransitArrived,
  writeOffUnclaimed,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';
import { uncheckedEntry } from './support/unchecked-entry';
import { unguardedJournal } from './support/unguarded-journal';

/**
 * Отчёты об остатках: **что попадает в позицию и когда она закрывается**.
 *
 * Мутационный прогон показал, что три отчёта проверялись только «сбоку» — через
 * инварианты, которые их читают, — и потому их собственные правила не
 * проверялись вовсе:
 *
 *  · обеспечение невостребованных средств можно было выключить целиком (снос
 *    накопления обязательств) или собрать по другим счетам — набор молчал;
 *  · позиция по требованию комиссии и позиция по транзиту не закрывались:
 *    снос `open.delete` оставлял плоскую позицию в выдаче навсегда;
 *  · транзит списания вообще переставал считаться транзитом — подмена
 *    `'terminal'` на `'intake'` в условии не роняла ничего.
 */

const owner = clientKey('c1');
const other = clientKey('c2');
const recipient = clientKey('c3');
const deal = { dealId: 'd1', trancheId: 't1' };
const secondTranche = { dealId: 'd1', trancheId: 't2' };
const hundredThousand = money('GEL', 100_000n);

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-03T10:${String(minute).padStart(2, '0')}:00Z` };
}

/** Списание невостребованных, момент 1: деньги ушли с номинального в транзит. */
function writtenOff() {
  return appendEntries(emptyJournal, [
    clientTopUp(at('t1'), owner, hundredThousand),
    lockForTranche(at('l1', 1), owner, deal, hundredThousand),
    writeOffUnclaimed(at('w1', 2), owner, deal, hundredThousand),
  ]);
}

describe('обеспечение невостребованных средств считается по своим счетам', () => {
  it('matches the debt against the transit leg it left on', () => {
    expect(unclaimedCoverage(writtenOff())).toEqual([
      {
        currency: 'GEL',
        custody: money('GEL', 100_000n),
        obligations: money('GEL', 100_000n),
        difference: money('GEL', 0n),
        covered: true,
        ratio: rational(1n, 1n),
      },
    ]);
  });

  /**
   * Обеспечением невостребованных считаются **их** счета: транзит того же пула и
   * деньги платформы в банке. Остаток номинального счёта — чужие деньги других
   * клиентов, и зачесть их сюда значило бы обеспечить один долг чужим долгом.
   */
  it('does not take the nominal account as cover for somebody else\u2019s money', () => {
    const journal = appendEntry(writtenOff(), clientTopUp(at('t2', 3), other, money('GEL', 50_000n)));
    expect(unclaimedCoverage(journal)).toEqual([
      {
        currency: 'GEL',
        custody: money('GEL', 100_000n),
        obligations: money('GEL', 100_000n),
        difference: money('GEL', 0n),
        covered: true,
        ratio: rational(1n, 1n),
      },
    ]);
  });

  it('follows the money to the operating account when the transfer arrives', () => {
    const journal = appendEntry(writtenOff(), writeOffTransitArrived(at('a1', 3), hundredThousand));
    expect(unclaimedCoverage(journal)).toEqual([
      {
        currency: 'GEL',
        custody: money('GEL', 100_000n),
        obligations: money('GEL', 100_000n),
        difference: money('GEL', 0n),
        covered: true,
        ratio: rational(1n, 1n),
      },
    ]);
  });

  it('is a separate ratio: the portfolio one does not see either side of it', () => {
    // §3.1 прямо: отношение покрытия сопоставляет номинальный счёт с
    // обязательствами по файлам и `unclaimed:liability` не видит вовсе. Значит
    // и транзит списания в него не входит — иначе списание рисовало бы профицит.
    expect(coverage(writtenOff())).toEqual([
      {
        currency: 'GEL',
        custody: money('GEL', 0n),
        obligations: money('GEL', 0n),
        difference: money('GEL', 0n),
        covered: true,
        ratio: null,
      },
    ]);
  });

  it('has nothing to say while no money has been written off', () => {
    const journal = appendEntries(emptyJournal, [clientTopUp(at('t1'), owner, hundredThousand)]);
    expect(unclaimedCoverage(journal)).toEqual([]);
  });
});

describe('позиция по транзиту', () => {
  it('names the account, the amount and the moment it opened', () => {
    expect(openTransitPositions(writtenOff())).toEqual([
      {
        accountCode: 'transit:writeoff',
        currency: 'GEL',
        openedAt: at('w1', 2).occurredAt,
        amount: money('GEL', 100_000n),
      },
    ]);
  });

  it('closes when the transfer arrives', () => {
    const journal = appendEntry(writtenOff(), writeOffTransitArrived(at('a1', 3), hundredThousand));
    expect(openTransitPositions(journal)).toEqual([]);
  });
});

describe('позиция по требованию комиссии', () => {
  const accrued = () =>
    appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, hundredThousand),
      lockForTranche(at('l1', 1), owner, deal, hundredThousand),
      accrueFee(at('f1', 2), deal, money('GEL', 2_000n), 'tariff-1'),
    ]);

  it('states the outstanding amount, the moment and whether the tranche still has money', () => {
    expect(openFeeReceivables(accrued())).toEqual([
      {
        deal,
        currency: 'GEL',
        outstanding: money('GEL', 2_000n),
        openedAt: at('f1', 2).occurredAt,
        lastMovedAt: at('f1', 2).occurredAt,
        trancheDrained: false,
      },
    ]);
  });

  it('closes when the settlement withholds it', () => {
    const journal = accrued();
    const accrual = feeAccrualFor(journal, deal);
    expect(accrual).not.toBeNull();
    const settles = trancheSettlement(
      deal,
      owner,
      recipient,
      attestDealParties(deal, owner, recipient),
    );
    const settled = appendEntry(
      journal,
      settleTrancheToClientAccount(at('s1', 3), settles, hundredThousand, accrual),
    );
    expect(openFeeReceivables(settled)).toEqual([]);
  });
});

describe('отрицательный остаток банковского счёта платформы', () => {
  /**
   * Ноль — не минус. Граница здесь именно та, на которой стоит смысл проверки:
   * пустой операционный счёт законен, а отрицательный означает перевод,
   * которого банк не исполнил бы.
   */
  it('says nothing about an operating account that came back to zero', () => {
    const recognition = absorbShortfall(at('r1', 4), other, money('GEL', 1n), hundredThousand);
    const journal = appendEntries(writtenOff(), [
      writeOffTransitArrived(at('a1', 3), hundredThousand),
      recognition,
      fundShortfall(at('fs1', 5), recognition),
    ]);

    expect(accountBalance(journal, bankOperating('GEL'), 'GEL').minor).toBe(0n);
    expect(negativeBankBalances(journal)).toEqual([]);
  });

  it('reports it once the account goes below zero', () => {
    const recognition = absorbShortfall(at('r1'), other, money('GEL', 1n), hundredThousand);
    const journal = appendEntries(emptyJournal, [
      recognition,
      fundShortfall(at('fs1', 1), recognition),
    ]);
    expect(negativeBankBalances(journal)).toEqual([
      {
        accountCode: 'bank:operating:gel',
        currency: 'GEL',
        balance: money('GEL', -100_000n),
      },
    ]);
  });
});

describe('выписка по сделке', () => {
  /**
   * Запись попадает в выписку транша, если её трогает **файл** транша, а файл
   * читается двумя способами: из кода счёта (запертая часть) и из отнесения
   * проводки. Второй способ проверялся, первый — нет: журнал приезжает из базы,
   * и запись, где отнесения нет вовсе, обязана найтись по коду счёта.
   */
  it('finds an entry by the tranche in the account code, without any attribution', () => {
    const journal = unguardedJournal([
      uncheckedEntry({
        id: 'legacy-1',
        occurredAt: at('x1').occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.unlocked_to_client',
        postings: [
          debit(clientLockedAccount(owner, deal.dealId, deal.trancheId), hundredThousand),
          credit(clientFreeAccount(owner), hundredThousand),
        ],
      }),
    ]);
    expect(dealStatement(journal, deal).events.map((event) => event.entryId)).toEqual(['legacy-1']);
  });

  it('does not take the neighbouring tranche of the same deal', () => {
    const journal = unguardedJournal([
      uncheckedEntry({
        id: 'legacy-2',
        occurredAt: at('x1').occurredAt,
        kind: 'settlement',
        memoKey: 'ledger.entry.unlocked_to_client',
        postings: [
          debit(
            clientLockedAccount(owner, secondTranche.dealId, secondTranche.trancheId),
            hundredThousand,
          ),
          credit(clientFreeAccount(owner), hundredThousand),
        ],
      }),
    ]);
    expect(dealStatement(journal, deal).events).toEqual([]);
  });

  it('keeps the fee of the neighbouring tranche out of the statement', () => {
    const journal = appendEntries(emptyJournal, [
      accrueFee(at('f1'), deal, money('GEL', 2_000n), 'tariff-1'),
      accrueFee(at('f2', 1), secondTranche, money('GEL', 3_000n), 'tariff-1'),
    ]);
    const statement = dealStatement(journal, deal);
    expect(statement.fee.map((item) => [item.deal.trancheId, item.accrued.minor])).toEqual([
      ['t1', 2_000n],
    ]);
  });
});

describe('покрытие видит только клиентские средства своей стороны', () => {
  it('counts the nominal account against client obligations', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, hundredThousand),
      lockForTranche(at('l1', 1), owner, deal, hundredThousand),
    ]);
    expect(coverage(journal)).toEqual([
      {
        currency: 'GEL',
        custody: money('GEL', 100_000n),
        obligations: money('GEL', 100_000n),
        difference: money('GEL', 0n),
        covered: true,
        ratio: rational(1n, 1n),
      },
    ]);
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(100_000n);
  });
});
