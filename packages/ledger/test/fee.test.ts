import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  InvariantCode,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  accountBalance,
  accrueFee,
  appendEntries,
  appendEntry,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientFreeAccount,
  clientKey,
  clientTopUp,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  feePositions,
  feeReceivable,
  lockForTranche,
  receiveFee,
  reverseFeeAccrual,
  settleTrancheToClientAccount,
  trancheSettlement,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';

const buyer = clientKey('c1');
const seller = clientKey('c2');
const dealA = { dealId: 'A', trancheId: 't1' };
const dealB = { dealId: 'B', trancheId: 't1' };
const feeIncome = { kind: 'fee_income' } as const;
const transitFeeAccount = { kind: 'transit_fee' } as const;

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

function lockedUnderA(amount: bigint) {
  return appendEntries(emptyJournal, [
    clientTopUp(at('f1'), buyer, money('GEL', amount)),
    lockForTranche(at('f2', 5), buyer, dealA, money('GEL', amount)),
  ]);
}

/**
 * Ф16 и история И14.3: начислено, удержано и получено — три разные величины и
 * три состояния. FUNCTIONAL.md §4.1: удержание оформляется **двумя встречными
 * фактами**, а не «уменьшенным платежом», и от этого зависит, признаётся ли
 * налоговой базой наше вознаграждение или весь оборот через номинальный счёт.
 */
describe('комиссия: начислено, удержано, получено', () => {
  it('recognises the fee against a receivable without moving any money', () => {
    const journal = appendEntry(
      emptyJournal,
      accrueFee(at('a1'), dealA, money('GEL', 500n), 'plan-2026-01'),
    );
    expect(accountBalance(journal, feeIncome, 'GEL').minor).toBe(500n);
    expect(accountBalance(journal, feeReceivable, 'GEL').minor).toBe(500n);
    // Ни одного банковского счёта запись не тронула: начисление — не платёж.
    expect(accountBalance(journal, bankOperating('GEL'), 'GEL').minor).toBe(0n);
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(0n);

    const position = feePositions(journal)[0];
    expect(position?.deal).toEqual(dealA);
    expect([position?.accrued.minor, position?.notWithheld.minor, position?.withheld.minor]).toEqual(
      [500n, 500n, 0n],
    );
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  it('walks the fee through all three states and keeps them apart', () => {
    const accrual = accrueFee(at('a1'), dealA, money('GEL', 500n), 'plan-2026-01');
    let journal = appendEntry(lockedUnderA(100_000n), accrual);

    const accrued = feePositions(journal)[0];
    expect([accrued?.notWithheld.minor, accrued?.inTransit.minor, accrued?.received.minor]).toEqual(
      [500n, 0n, 0n],
    );

    journal = appendEntry(
      journal,
      settleTrancheToClientAccount(
        at('a2', 10),
        trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
        money('GEL', 100_000n),
        accrual,
      ),
    );
    const withheld = feePositions(journal)[0];
    expect([
      withheld?.notWithheld.minor,
      withheld?.inTransit.minor,
      withheld?.received.minor,
    ]).toEqual([0n, 500n, 0n]);

    journal = appendEntry(journal, receiveFee(at('a3', 20), dealA, money('GEL', 500n)));
    const received = feePositions(journal)[0];
    expect([
      received?.notWithheld.minor,
      received?.inTransit.minor,
      received?.received.minor,
    ]).toEqual([0n, 0n, 500n]);
    // И14.1, четвёртый критерий: на конец дня остатка `fee:income` на
    // номинальном счёте нет — там ровно обязательство перед получателем.
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(99_500n);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  it('keeps the tariff plan version in the journal, on the accrual and on its reversal', () => {
    // §4.2: «на каждой сделке хранится идентификатор версии плана, применённой
    // в момент создания — иначе через год нельзя воспроизвести, почему списали
    // именно столько». Журнал переживает сделку и читается отдельно от неё.
    const accrual = accrueFee(at('a1'), dealA, money('GEL', 500n), 'plan-2026-01');
    const reversal = reverseFeeAccrual(at('a2', 10), accrual);
    expect(accrual.accrues?.tariffVersionId).toBe('plan-2026-01');
    expect(accrual.accrues?.deal).toEqual(dealA);
    expect(reversal.accrues?.tariffVersionId).toBe('plan-2026-01');
  });

  it('refuses a fee accrual declaration the postings do not match', () => {
    // Объявление необязательно, но ложным быть не может — тот же контракт, что
    // у объявления расчёта, минус обязательность.
    expectCode(
      () =>
        createJournalEntry({
          ...at('a9'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fee_accrued',
          accrues: { deal: dealA, fee: money('GEL', 500n), tariffVersionId: 'plan-2026-01' },
          postings: [
            debit(feeReceivable, money('GEL', 900n), dealA),
            credit(feeIncome, money('GEL', 900n), dealA),
          ],
        }),
      LedgerErrorCode.entryFeeAccrualMismatch,
    );
    // …и объявление с чужой сделкой к этому признанию не подходит.
    expectCode(
      () =>
        createJournalEntry({
          ...at('a10'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fee_accrued',
          accrues: { deal: dealB, fee: money('GEL', 500n), tariffVersionId: 'plan-2026-01' },
          postings: [
            debit(feeReceivable, money('GEL', 500n), dealA),
            credit(feeIncome, money('GEL', 500n), dealA),
          ],
        }),
      LedgerErrorCode.entryFeeAccrualMismatch,
    );
  });

  it('refuses to withhold an accrual issued for another deal', () => {
    const foreign = accrueFee(at('a1'), dealB, money('GEL', 500n), 'plan-2026-01');
    expectCode(
      () =>
        settleTrancheToClientAccount(
          at('a2', 10),
          trancheSettlement(dealA, buyer, seller, attestDealParties(dealA, buyer, seller)),
          money('GEL', 100_000n),
          foreign,
        ),
      LedgerErrorCode.entryFeeAccrualMismatch,
    );
  });

  it('reverses the accrual when the deal goes down the refund branch', () => {
    // §4.4: отмена до конвертации — комиссия за расчёт не начисляется. Уже
    // записанное начисление снимается исправлением со ссылкой (красная линия
    // №11), а не правкой журнала.
    const accrual = accrueFee(at('a1'), dealA, money('GEL', 500n), 'plan-2026-01');
    const journal = appendEntries(emptyJournal, [accrual, reverseFeeAccrual(at('a2', 10), accrual)]);
    expect(accountBalance(journal, feeIncome, 'GEL').minor).toBe(0n);
    expect(accountBalance(journal, feeReceivable, 'GEL').minor).toBe(0n);
    expect(journal.entries[1]?.correctsEntryId).toBe('a1');
    expect(feePositions(journal).map((item) => item.accrued.minor)).toEqual([0n]);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });
});

/**
 * Исключение в `assertPlatformIncomeSweptToOperating` — единственное и именное.
 * Прежний комментарий обещал его на будущее; счёт требований появился, и
 * исключение обязано быть **условием**, а не перечнем счетов.
 */
describe('признание дохода против требования платформы', () => {
  it('accepts income recognised against a platform receivable', () => {
    const entry = createJournalEntry({
      ...at('x1'),
      kind: 'settlement',
      memoKey: 'ledger.entry.fee_accrued',
      postings: [
        debit(feeReceivable, money('GEL', 500n)),
        credit(feeIncome, money('GEL', 500n)),
      ],
    });
    expect(entry.postings).toHaveLength(2);
  });

  it('withdraws the exception as soon as the entry credits client funds', () => {
    // Иначе послабление стало бы дверью: доход признан «против требования», а
    // клиентское обязательство в той же записи выросло — то есть комиссия
    // осталась в клиентских деньгах (красная линия №2).
    //
    // Ни одной проводки по операционному счёту в записи нет намеренно: иначе
    // отказ объяснялся бы ею, а не снятым послаблением, и снятие условия
    // прошло бы мимо теста.
    expectCode(
      () =>
        createJournalEntry({
          ...at('x2'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fee_accrued',
          postings: [
            debit(feeReceivable, money('GEL', 500n)),
            credit(feeIncome, money('GEL', 500n)),
            debit({ kind: 'shortfall_expense' } as const, money('GEL', 100n), {
              clientKey: buyer,
            }),
            credit(clientFreeAccount(buyer), money('GEL', 100n), { clientKey: buyer }),
          ],
        }),
      LedgerErrorCode.entryPlatformIncomeNotSwept,
    );
  });

  it('does not let a receivable created and cleared in one entry stand in for the sweep', () => {
    // Чистое движение, а не валовый дебет: требование, начисленное и тут же
    // списанное, требованием не является — та же дыра, что была у «вывода туда
    // и обратно» по операционному счёту.
    expectCode(
      () =>
        createJournalEntry({
          ...at('x3'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fee_accrued',
          postings: [
            debit(feeReceivable, money('GEL', 500n)),
            credit(feeIncome, money('GEL', 500n)),
            credit(feeReceivable, money('GEL', 500n)),
            debit({ kind: 'psp_fee_expense' } as const, money('GEL', 500n)),
          ],
        }),
      LedgerErrorCode.entryPlatformIncomeNotSwept,
    );
  });

  it('still refuses income recognised against nothing at all', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('x4'),
          kind: 'settlement',
          memoKey: 'ledger.entry.payout',
          postings: [
            debit({ kind: 'psp_fee_expense' } as const, money('GEL', 500n)),
            credit(feeIncome, money('GEL', 500n)),
          ],
        }),
      LedgerErrorCode.entryPlatformIncomeNotSwept,
    );
  });
});

describe('требование платформы деньгами не является', () => {
  it('refuses to fund a client file by writing off a receivable', () => {
    // `assertNoUnfundedClientFileGain` пускает прирост клиентского файла только
    // против **денег платформы, ушедших с её банковского счёта**. Требование —
    // не деньги: списать его в пользу клиента значит нарисовать обеспечение из
    // обещания. До появления роли счёта оба были «активом платформы» и эта
    // форма собралась бы.
    expectCode(
      () =>
        createJournalEntry({
          ...at('z1'),
          kind: 'settlement',
          memoKey: 'ledger.entry.shortfall_funded',
          postings: [
            debit(bankNominal('GEL'), money('GEL', 500n), { clientKey: buyer }),
            credit(feeReceivable, money('GEL', 500n), dealA),
          ],
        }),
      LedgerErrorCode.entryClientFileGainUnfunded,
    );
  });

  it('refuses to fund a client file with money still in transit to us', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('z2'),
          kind: 'settlement',
          memoKey: 'ledger.entry.shortfall_funded',
          postings: [
            debit(bankNominal('GEL'), money('GEL', 500n), { clientKey: buyer }),
            credit(transitFeeAccount, money('GEL', 500n), dealA),
          ],
        }),
      LedgerErrorCode.entryClientFileGainUnfunded,
    );
  });
});

describe('транзит комиссии виден как расхождение, когда висит слишком долго', () => {
  it('does not accept a receivable driven below zero as normal', () => {
    const journal = appendEntry(
      emptyJournal,
      createJournalEntry({
        ...at('y1'),
        kind: 'settlement',
        memoKey: 'ledger.entry.fee_received',
        postings: [
          debit(bankOperating('GEL'), money('GEL', 500n), dealA),
          credit(transitFeeAccount, money('GEL', 500n), dealA),
        ],
      }),
    );
    // Получение комиссии, которой не удерживали: транзит ушёл в минус.
    expect(
      checkLedgerInvariants(journal).map((item) => [item.code, item.subject, item.amountMinor]),
    ).toEqual([[InvariantCode.platformAssetNegative, 'transit:fee', -500n]]);
  });
});
