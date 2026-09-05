import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type Account,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  accountCode,
  accountType,
  appendEntries,
  appendEntry,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientFreeAccount,
  clientFundsFile,
  clientKey,
  clientLockedAccount,
  clientTopUp,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  fundsOwnership,
  isClientCustodyAccount,
  isClientObligationAccount,
  lockForTranche,
  poolDirection,
  trancheSettlement,
  transitWriteoff,
  unclaimedLiability,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';
import { unguardedJournal } from './support/unguarded-journal';

const buyer = clientKey('c1');
/** Постороннее лицо: к сделке A отношения не имеет ни в какой роли. */
const stranger = clientKey('c9');
const dealA = { dealId: 'A', trancheId: 't1' };
const dealB = { dealId: 'B', trancheId: 't1' };
const suspense: Account = { kind: 'suspense_unidentified' };
const sum = money('GEL', 100_000n);
const lockedA = clientLockedAccount(buyer, dealA.dealId, dealA.trancheId);

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-03T10:${String(minute).padStart(2, '0')}:00Z` };
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

/** Деньги покупателя пришли и заперты под транш сделки A. */
function lockedUnderA() {
  return appendEntries(emptyJournal, [
    clientTopUp(at('f1'), buyer, sum),
    lockForTranche(at('f2', 5), buyer, dealA, sum),
  ]);
}

/**
 * Принадлежность счёта клиентским обязательствам выводится из объявленной
 * природы счёта, а не из перечня имён.
 *
 * Перечень дважды оказывался неполным, и оба раза тихо: сначала мимо него
 * прошла отмывка через `suspense:unidentified`, потом — та же самая через
 * `unclaimed:liability`, которого в перечне не было. Теперь новый счёт обязан
 * объявить, чьи на нём деньги и откуда у них файл, иначе таблица
 * `ACCOUNT_NATURE` не компилируется, — и попадает во все проверки сам.
 */
describe('классификация счетов выводится, а не перечисляется', () => {
  it('counts every declared client liability as a client obligation', () => {
    for (const account of [
      clientFreeAccount(buyer),
      lockedA,
      suspense,
      unclaimedLiability,
    ] satisfies readonly Account[]) {
      expect(fundsOwnership(account)).toBe('client');
      expect(accountType(account)).toBe('liability');
      // Ровно это и было дырой: `unclaimed:liability` не считался движением
      // обязательства вообще, поэтому увод денег через него был невидим.
      expect(isClientObligationAccount(account)).toBe(true);
    }
  });

  it('counts every declared client asset as custody', () => {
    expect(isClientCustodyAccount(bankNominal('GEL'))).toBe(true);
    expect(isClientCustodyAccount(transitWriteoff)).toBe(true);
    expect(isClientCustodyAccount(bankOperating('GEL'))).toBe(false);
  });

  it('makes every pool declare its direction, and that direction is the guard', () => {
    expect(poolDirection(suspense)).toBe('intake');
    expect(poolDirection(unclaimedLiability)).toBe('terminal');
    expect(poolDirection(transitWriteoff)).toBe('terminal');
    expect(poolDirection(lockedA)).toBeNull();
    expect(clientFundsFile(bankNominal('GEL'))).toBe('in_attribution');
    expect(clientFundsFile(lockedA)).toBe('owner_in_code');
    expect(clientFundsFile(bankOperating('GEL'))).toBeNull();
    // Счёт из плана §3.1, которого в коде не было вовсе. Он ничем не отличался
    // бы от любого счёта, заведённого через полгода, — и попал под защиту в
    // момент объявления своей природы, без единой правки перечня.
    expect(accountCode(transitWriteoff)).toBe('transit:writeoff');
  });
});

describe('атака 1: двухзаписная отмывка через пул-вход (suspense)', () => {
  it('refuses the first entry: an owned obligation cannot go back into the intake pool', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('s1', 10),
          kind: 'settlement',
          memoKey: 'ledger.entry.suspense_received',
          postings: [debit(lockedA, sum, dealA), credit(suspense, sum)],
        }),
      LedgerErrorCode.entryObligationIntoIntakePool,
    );
  });

  it('refuses it with the custody re-filed to the stranger as well', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('s2', 10),
          kind: 'settlement',
          memoKey: 'ledger.entry.suspense_received',
          postings: [
            debit(lockedA, sum, dealA),
            credit(suspense, sum),
            credit(bankNominal('GEL'), sum, dealA),
            debit(bankNominal('GEL'), sum, { clientKey: stranger }),
          ],
        }),
      LedgerErrorCode.entryObligationIntoIntakePool,
    );
  });
});

describe('атака 2: та же отмывка через пул-выход (unclaimed:liability)', () => {
  it('refuses the first entry: the stranger file grows and nobody paid for it', () => {
    // Воспроизведение дефекта. Прежде эта запись собиралась: `unclaimed`
    // не был обязательством в перечне, кредит кастодиана был отнесён к траншу
    // A и проходил проверку красной линии №1, а прирост файла постороннего
    // лица не проверял никто.
    expectCode(
      () =>
        createJournalEntry({
          ...at('u1', 10),
          kind: 'settlement',
          memoKey: 'ledger.entry.written_off',
          postings: [
            debit(lockedA, sum, dealA),
            credit(unclaimedLiability, sum),
            credit(bankNominal('GEL'), sum, dealA),
            debit(bankNominal('GEL'), sum, { clientKey: stranger }),
          ],
        }),
      LedgerErrorCode.entryClientFileGainUnfunded,
    );
  });

  it('refuses the second entry on its own: the pool does not pay out to a client', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('u2', 15),
          kind: 'settlement',
          memoKey: 'ledger.entry.suspense_identified',
          postings: [
            debit(unclaimedLiability, sum),
            credit(clientFreeAccount(stranger), sum, { clientKey: stranger }),
          ],
        }),
      LedgerErrorCode.entryTerminalPoolPayout,
    );
  });

  it('leaves the buyer money where it was: nothing of the scheme assembles', () => {
    const journal = lockedUnderA();
    expect(checkLedgerInvariants(journal)).toEqual([]);
    // Третий шаг схемы — `lockForTranche(stranger, B)` — нечем питать: у
    // постороннего лица свободных денег не появилось.
    expect(() =>
      appendEntry(journal, lockForTranche(at('u3', 20), stranger, dealB, sum)),
    ).not.toThrow();
    // Запись соберётся, но журнал немедленно докладывает отрицательный остаток
    // счёта постороннего: взять сумму было неоткуда.
    const withLock = appendEntry(journal, lockForTranche(at('u4', 25), stranger, dealB, sum));
    expect(checkLedgerInvariants(withLock)).not.toEqual([]);
  });
});

/**
 * Атака 3 — своя, придуманная против уже исправленной конструкции.
 *
 * Она бьёт не в перечень, а в **новый счёт**: `transit:writeoff` в коде учёта
 * до этого батча не существовал вовсе. Если защита всё ещё держится на знании
 * имён, счёт, заведённый последним, обязан её обойти.
 *
 * Схема законна на первых двух шагах — это ровно списание невостребованного из
 * §3.1, «два момента, а не один», — и ломается на третьем.
 */
describe('атака 3: отмывка через счёт, которого в коде не было (transit:writeoff)', () => {
  const writeOffMoment1 = () =>
    createJournalEntry({
      ...at('t1', 10),
      kind: 'settlement',
      memoKey: 'ledger.entry.written_off',
      postings: [
        debit(lockedA, sum, dealA),
        credit(bankNominal('GEL'), sum, dealA),
        debit(transitWriteoff, sum),
        credit(unclaimedLiability, sum),
      ],
    });

  it('accepts the write-off exactly as §3.1 spells it, in two moments', () => {
    let journal = appendEntry(lockedUnderA(), writeOffMoment1());
    journal = appendEntry(
      journal,
      createJournalEntry({
        ...at('t2', 15),
        kind: 'settlement',
        memoKey: 'ledger.entry.writeoff_arrived',
        postings: [debit(bankOperating('GEL'), sum), credit(transitWriteoff, sum)],
      }),
    );
    // Долг остался долгом и остался обеспеченным — вторая проверка покрытия
    // из §3.1, ради которой транзитный счёт и существует.
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  it('refuses to hand the written-off money to an unrelated client', () => {
    const journal = appendEntry(lockedUnderA(), writeOffMoment1());
    expect(journal.entries).toHaveLength(3);
    // Деньги идут за обязательством — файл постороннего сходится копейка в
    // копейку, прирост обеспечения ни у кого нулевой. Проверка прироста файла
    // такую запись пропускает: она безупречна по форме.
    expectCode(
      () =>
        createJournalEntry({
          ...at('t3', 20),
          kind: 'settlement',
          memoKey: 'ledger.entry.suspense_identified',
          postings: [
            debit(unclaimedLiability, sum),
            credit(clientFreeAccount(stranger), sum, { clientKey: stranger }),
            credit(transitWriteoff, sum),
            debit(bankNominal('GEL'), sum, { clientKey: stranger }),
          ],
        }),
      // Ловит объявленное направление пула, а не форма записи: терминальный пул
      // обратно к клиенту не выходит, пока §3.1 помечает порядок как [открыто].
      LedgerErrorCode.entryTerminalPoolPayout,
    );
  });
});

/**
 * Атака 4 — своя. Расчёт **с верным объявлением сторон**, но деньги остаются в
 * файле транша: обязательство переезжает к получателю, обеспечение — нет.
 *
 * Объявление здесь ни при чём: и плательщик, и получатель, и сделка названы
 * верно, и подтверждение домена выдано именно на них. Ловится приростом файла —
 * обеспечение транша выросло относительно его обязательств, и заплатить за это
 * было нечем. Раньше запись собиралась, а расхождение всплывало только в
 * отчётности, уже после факта.
 */
describe('атака 4: расчёт, при котором деньги остаются в файле транша', () => {
  it('refuses a settlement whose custody never leaves the tranche file', () => {
    const settles = trancheSettlement(
      dealA,
      buyer,
      stranger,
      attestDealParties(dealA, buyer, stranger),
    );
    expectCode(
      () =>
        createJournalEntry({
          ...at('p1', 10),
          kind: 'settlement',
          memoKey: 'ledger.entry.tranche_settled',
          settles,
          postings: [
            debit(lockedA, sum, dealA),
            credit(clientFreeAccount(stranger), sum, { clientKey: stranger }),
            credit(bankNominal('GEL'), sum, dealA),
            debit(bankNominal('GEL'), sum, dealA),
          ],
        }),
      LedgerErrorCode.entryClientFileGainUnfunded,
    );
  });

  it('still refuses the same shape without any declaration at all', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('p2', 15),
          kind: 'settlement',
          memoKey: 'ledger.entry.tranche_settled',
          postings: [
            debit(lockedA, sum, dealA),
            credit(clientFreeAccount(stranger), sum, { clientKey: stranger }),
            credit(bankNominal('GEL'), sum, dealA),
            debit(bankNominal('GEL'), sum, dealA),
          ],
        }),
      LedgerErrorCode.entryClientOwnerMismatch,
    );
  });
});

/**
 * Атака 5 — своя, самая дешёвая: пометить те же записи исправлениями.
 *
 * Все прочие запреты `correction` пропускают, и до этого батча пропускала бы и
 * проверка прироста файла. Ссылка на исправляемую запись выглядела достаточной
 * гарантией — пока не выяснилось, что её никто не проверял: строкой мог быть
 * любой набор символов, в том числе идентификатор записи, которой нет.
 */
describe('атака 5: те же схемы, помеченные исправлением', () => {
  it('refuses the pool laundering even when it claims to correct something', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('c1', 10),
          kind: 'correction',
          correctsEntryId: 'f2',
          memoKey: 'ledger.entry.written_off',
          postings: [
            debit(lockedA, sum, dealA),
            credit(unclaimedLiability, sum),
            credit(bankNominal('GEL'), sum, dealA),
            debit(bankNominal('GEL'), sum, { clientKey: stranger }),
          ],
        }),
      LedgerErrorCode.entryClientFileGainUnfunded,
    );
    expectCode(
      () =>
        createJournalEntry({
          ...at('c2', 15),
          kind: 'correction',
          correctsEntryId: 'f2',
          memoKey: 'ledger.entry.suspense_identified',
          postings: [
            debit(unclaimedLiability, sum),
            credit(clientFreeAccount(stranger), sum, { clientKey: stranger }),
          ],
        }),
      LedgerErrorCode.entryClientFileGainUnfunded,
    );
  });

  it('still lets a correction unwind a recognised shortfall', () => {
    // Единственная поблажка исправлению: снятое признание расхода платформы
    // считается финансированием. §3.1, случай А, отмотанный назад — прирост
    // файла здесь не прирост, а снятие прежней недостачи.
    const entry = createJournalEntry({
      ...at('c3', 20),
      kind: 'correction',
      correctsEntryId: 'f2',
      memoKey: 'ledger.entry.shortfall_reversed',
      postings: [
        debit(lockedA, money('GEL', 100_000n), dealA),
        credit(bankNominal('GEL'), money('GEL', 99_900n), dealA),
        credit({ kind: 'shortfall_expense' }, money('GEL', 100n)),
      ],
    });
    expect(entry.postings).toHaveLength(3);
  });

  it('refuses a correction that points at an entry the journal does not have', () => {
    const journal = lockedUnderA();
    const entry = createJournalEntry({
      ...at('c4', 25),
      kind: 'correction',
      correctsEntryId: 'no-such-entry',
      memoKey: 'ledger.entry.shortfall_reversed',
      postings: [
        debit(lockedA, money('GEL', 100_000n), dealA),
        credit(bankNominal('GEL'), money('GEL', 99_900n), dealA),
        credit({ kind: 'shortfall_expense' }, money('GEL', 100n)),
      ],
    });
    expectCode(
      () => appendEntry(journal, entry),
      LedgerErrorCode.journalCorrectionTargetMissing,
    );
  });

  /**
   * Остаток, который эта конструкция не закрывала, — **закрыт этажом выше**.
   *
   * Прежняя редакция теста фиксировала его как известный: исправление, в
   * котором прирост чужого файла подпёрт встречным кредитом расхода платформы,
   * собиралось и ложилось в журнал. Здесь, у конструктора записи, оно
   * по-прежнему собирается — журнала он не видит, — но `appendEntry` его больше
   * не принимает: исправление обязано быть зеркалом своей цели, а файла
   * постороннего лица цель (`f2`, привязка денег покупателя к траншу) не
   * трогала (`journal.ts`, `assertCorrectionMirrorsTarget`).
   *
   * Второй контур при этом никуда не делся: журнал приходит и из базы, в том
   * числе с записями, сделанными до появления правила, — и в таком журнале файл
   * постороннего лица виден в профиците.
   */
  it('refuses a correction propped up by a platform expense, and still sees the damage', () => {
    const journal = lockedUnderA();
    const entry = createJournalEntry({
      ...at('c5', 30),
      kind: 'correction',
      correctsEntryId: 'f2',
      memoKey: 'ledger.entry.shortfall_reversed',
      postings: [
        debit(lockedA, sum, dealA),
        credit({ kind: 'shortfall_expense' }, sum),
        credit(bankNominal('GEL'), sum, dealA),
        debit(bankNominal('GEL'), sum, { clientKey: stranger }),
      ],
    });
    expectCode(() => appendEntry(journal, entry), LedgerErrorCode.journalCorrectionNotMirror);
    const codes = checkLedgerInvariants(
      unguardedJournal([...journal.entries, entry]),
    ).map((item) => item.code);
    expect(codes).toContain('ledger.invariant.custody_surplus');
  });
});
