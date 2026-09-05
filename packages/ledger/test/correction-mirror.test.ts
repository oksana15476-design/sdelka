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
  transitWriteoff,
  unclaimedLiability,
  writeOffUnclaimed,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';

const victim = clientKey('c1');
const seller = clientKey('c2');
/** Постороннее лицо: к сделке A отношения не имеет ни в какой роли. */
const stranger = clientKey('c9');
const dealA = { dealId: 'A', trancheId: 't1' };
const SUM = money('GEL', 100_000n);
const FEE = money('GEL', 1_000n);

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-05T10:${String(minute).padStart(2, '0')}:00Z` };
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

/** Законный путь целиком: деньги пришли, заперлись под транш и списаны в пул. */
function writtenOff() {
  return appendEntries(emptyJournal, [
    clientTopUp(at('e1'), victim, SUM),
    lockForTranche(at('e2', 5), victim, dealA, SUM),
    writeOffUnclaimed(at('e3', 10), victim, dealA, SUM),
  ]);
}

/**
 * Атака из находки: содержимое терминального пула выдаётся постороннему лицу
 * записью-исправлением.
 *
 * Кастодиан едет вместе с обязательством — ровно поэтому прирост каждого файла
 * ровно нулевой и все проверки конструктора молчат. Единственное, что отличало
 * эту запись от точно такой же с `kind: 'settlement'`, — ранний выход
 * `assertNoPayoutFromTerminalPool` на исправлениях.
 */
function poolPayoutToStranger(id: string, correctsEntryId: string): JournalEntry {
  return createJournalEntry({
    ...at(id, 15),
    kind: 'correction',
    correctsEntryId,
    memoKey: 'ledger.entry.unclaimed',
    postings: [
      debit(unclaimedLiability, SUM),
      credit(clientFreeAccount(stranger), SUM, { clientKey: stranger }),
      credit(transitWriteoff, SUM),
      debit(bankNominal('GEL'), SUM, { clientKey: stranger }),
    ],
  });
}

describe('исправление — зеркало своей цели', () => {
  it('отвергает выдачу невостребованных средств постороннему лицу', () => {
    // Прогон до правки: запись принималась, `client:c9:free` = 100 000 ₾,
    // покрытие 1/1, `checkLedgerInvariants()` пуст, стоп-кран молчал.
    const journal = writtenOff();
    expectCode(
      () => appendEntry(journal, poolPayoutToStranger('e4', 'e3')),
      LedgerErrorCode.journalCorrectionNotMirror,
    );
    // Деньги остались там, где их оставило законное списание.
    expect(accountBalance(journal, clientFreeAccount(stranger), 'GEL').minor).toBe(0n);
    expect(accountBalance(journal, unclaimedLiability, 'GEL').minor).toBe(SUM.minor);
  });

  it('различает «цель не относится к делу» и «цели нет вовсе» разными ключами', () => {
    const journal = writtenOff();
    // Цель есть, но к содержанию исправления отношения не имеет: `e1` —
    // зачисление, к списанию невостребованного не относящееся.
    expectCode(
      () => appendEntry(journal, poolPayoutToStranger('e5', 'e1')),
      LedgerErrorCode.journalCorrectionNotMirror,
    );
    // Цели нет в журнале вовсе — это другое нарушение и другой ключ.
    expectCode(
      () => appendEntry(journal, poolPayoutToStranger('e6', 'no-such-entry')),
      LedgerErrorCode.journalCorrectionTargetMissing,
    );
  });

  it('называет причину: счёт мимо цели, та же сторона, больше цели', () => {
    const journal = writtenOff();
    const reasonOf = (entry: JournalEntry): string => {
      try {
        appendEntry(journal, entry);
        expect.unreachable();
      } catch (error) {
        return (error as LedgerError).details.reason ?? '';
      }
    };
    // Счёт постороннего лица цель не трогала.
    expect(reasonOf(poolPayoutToStranger('r1', 'e3'))).toBe('account_not_in_target');
    // Та же сторона, что и у цели: не отмена списания, а второе такое же.
    expect(
      reasonOf(
        createJournalEntry({
          ...at('r2', 16),
          kind: 'correction',
          correctsEntryId: 'e3',
          memoKey: 'ledger.entry.unclaimed',
          postings: [
            debit(clientLockedAccount(victim, dealA.dealId, dealA.trancheId), SUM, dealA),
            credit(bankNominal('GEL'), SUM, dealA),
            debit(transitWriteoff, SUM),
            credit(unclaimedLiability, SUM),
          ],
        }),
      ),
    ).toBe('same_direction');
    // Обратная сторона, но вдвое: цель отдаётся один раз.
    expect(
      reasonOf(
        createJournalEntry({
          ...at('r3', 17),
          kind: 'correction',
          correctsEntryId: 'e3',
          memoKey: 'ledger.entry.unclaimed',
          postings: [
            credit(
              clientLockedAccount(victim, dealA.dealId, dealA.trancheId),
              money('GEL', 200_000n),
              dealA,
            ),
            debit(bankNominal('GEL'), money('GEL', 200_000n), dealA),
            credit(transitWriteoff, money('GEL', 200_000n)),
            debit(unclaimedLiability, money('GEL', 200_000n)),
          ],
        }),
      ),
    ).toBe('exceeds_target');
  });

  it('пропускает отмену ошибочного списания — зеркало цели целиком', () => {
    // То самое законное исправление, ради которого послабление и существует:
    // деньги возвращаются ровно туда, откуда пришли, и ровно тому файлу.
    const journal = writtenOff();
    const undone = appendEntry(
      journal,
      createJournalEntry({
        ...at('u1', 20),
        kind: 'correction',
        correctsEntryId: 'e3',
        memoKey: 'ledger.entry.unclaimed',
        postings: [
          credit(clientLockedAccount(victim, dealA.dealId, dealA.trancheId), SUM, dealA),
          debit(bankNominal('GEL'), SUM, dealA),
          credit(transitWriteoff, SUM),
          debit(unclaimedLiability, SUM),
        ],
      }),
    );
    expect(accountBalance(undone, unclaimedLiability, 'GEL').minor).toBe(0n);
    expect(
      accountBalance(
        undone,
        clientLockedAccount(victim, dealA.dealId, dealA.trancheId),
        'GEL',
      ).minor,
    ).toBe(SUM.minor);
    // Второй раз ту же цель отмотать нельзя: цель отдаётся один раз.
    expectCode(
      () =>
        appendEntry(
          undone,
          createJournalEntry({
            ...at('u2', 21),
            kind: 'correction',
            correctsEntryId: 'e3',
            memoKey: 'ledger.entry.unclaimed',
            postings: [
              credit(clientLockedAccount(victim, dealA.dealId, dealA.trancheId), SUM, dealA),
              debit(bankNominal('GEL'), SUM, dealA),
              credit(transitWriteoff, SUM),
              debit(unclaimedLiability, SUM),
            ],
          }),
        ),
      LedgerErrorCode.journalCorrectionNotMirror,
    );
  });
});

describe('законные исправления продукта проходят', () => {
  function settled(): { journal: ReturnType<typeof writtenOff>; settlement: JournalEntry } {
    const settles = trancheSettlement(
      dealA,
      victim,
      seller,
      attestDealParties(dealA, victim, seller),
    );
    const accrual = accrueFee(at('s3', 6), dealA, FEE, 'plan-1');
    const settlement = settleTrancheToClientAccount(at('s4', 7), settles, SUM, accrual);
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('s1'), victim, SUM),
      lockForTranche(at('s2', 5), victim, dealA, SUM),
      accrual,
      settlement,
    ]);
    return { journal, settlement };
  }

  it('reverseTrancheSettlement — зеркало записи расчёта', () => {
    const { journal, settlement } = settled();
    const reversed = appendEntry(journal, reverseTrancheSettlement(at('s5', 8), settlement));
    expect(accountBalance(reversed, clientFreeAccount(seller), 'GEL').minor).toBe(0n);
    expect(
      accountBalance(reversed, clientLockedAccount(victim, dealA.dealId, dealA.trancheId), 'GEL')
        .minor,
    ).toBe(SUM.minor);
  });

  it('reverseFeeAccrual — обратная пара к начислению', () => {
    const accrual = accrueFee(at('a1'), dealA, FEE, 'plan-1');
    const journal = appendEntries(emptyJournal, [accrual, reverseFeeAccrual(at('a2', 1), accrual)]);
    expect(accountBalance(journal, feeReceivable, 'GEL').minor).toBe(0n);
    expect(journal.entries).toHaveLength(2);
  });

  it('оба реверса подряд: расчёт снят, начисление снято', () => {
    const { journal, settlement } = settled();
    const accrual = accrueFee(at('s3', 6), dealA, FEE, 'plan-1');
    let after = appendEntry(journal, reverseTrancheSettlement(at('s5', 8), settlement));
    after = appendEntry(after, reverseFeeAccrual(at('s6', 9), accrual));
    expect(accountBalance(after, feeReceivable, 'GEL').minor).toBe(0n);
  });
});
