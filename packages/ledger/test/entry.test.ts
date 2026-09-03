import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  LedgerError,
  LedgerErrorCode,
  balanceByCurrency,
  bankNominal,
  bankOperating,
  clientKey,
  clientLockedAccount,
  createJournalEntry,
  credit,
  debit,
} from '../src/index';

const deal = { dealId: 'd1', trancheId: 't1' };
// Владелец счёта — ключ личности (FUNCTIONAL.md §2.1): один клиент, один счёт
// на все его сделки в любых ролях. Здесь он один и тот же во всех записях.
const owner = clientKey('c1');
const client = clientLockedAccount(owner, deal.dealId, deal.trancheId);
const feeIncome = { kind: 'fee_income' } as const;
const fxIncome = { kind: 'fx_income' } as const;

function expectCode(run: () => unknown, code: LedgerErrorCode): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
  }
}

describe('journal entry: сумма проводок равна нулю', () => {
  it('accepts the FUNCTIONAL.md §3.3 funding entry', () => {
    const entry = createJournalEntry({
      id: 'e1',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.funds_received',
      postings: [
        debit(bankNominal('USD'), money('USD', 8_000_000n), deal),
        credit(client, money('USD', 8_000_000n), deal),
      ],
    });
    expect(entry.postings).toHaveLength(2);
    expect(entry.correctsEntryId).toBeNull();
    expect([...balanceByCurrency(entry.postings).values()]).toEqual([0n]);
  });

  it('rejects an unbalanced entry instead of storing it', () => {
    expectCode(
      () =>
        createJournalEntry({
          id: 'e2',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.funds_received',
          postings: [
            debit(bankNominal('USD'), money('USD', 8_000_000n), deal),
            credit(client, money('USD', 7_999_999n), deal),
          ],
        }),
      LedgerErrorCode.entryUnbalanced,
    );
  });

  it('balances every currency separately, not in conversion', () => {
    // Одна запись конвертации из FUNCTIONAL.md §3.3, шаг 2: обе ноги внутри
    // одной записи, каждая валюта сходится сама по себе.
    //
    // Спред приходит на операционный счёт, а не на номинальный: §3.3 шаг 2
    // показывает его кредитом `fx:income` против номинального счёта, то есть
    // оставляет доход платформы на счёте клиентских средств. Красная линия №2
    // запрещает это не только комиссии — `fx:income` такой же наш доход (§4.1),
    // и `convertClientBalance` в приложении делит поступление ровно так же.
    // Купленные по рыночному курсу 21 500 000 лари приходят двумя ногами:
    // клиентская часть на номинальный счёт, спред — сразу на операционный.
    const entry = createJournalEntry({
      id: 'e3',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.conversion',
      postings: [
        debit(client, money('USD', 8_000_000n), deal),
        credit(bankNominal('USD'), money('USD', 8_000_000n), deal),
        debit(bankNominal('GEL'), money('GEL', 21_349_500n), deal),
        credit(client, money('GEL', 21_349_500n), deal),
        debit(bankOperating('GEL'), money('GEL', 150_500n)),
        credit(fxIncome, money('GEL', 150_500n)),
      ],
    });
    expect([...balanceByCurrency(entry.postings).values()]).toEqual([0n, 0n]);
    // На номинальном счёте — ровно клиентская сумма по клиентскому курсу,
    // спред на операционном: 21 349 500 + 150 500 = 21 500 000 по рыночному.
    const gelOn = (kind: 'bank_nominal' | 'bank_operating'): bigint =>
      entry.postings
        .filter((posting) => posting.account.kind === kind && posting.amount.currency === 'GEL')
        .reduce(
          (total, posting) =>
            posting.direction === 'debit'
              ? total + posting.amount.minor
              : total - posting.amount.minor,
          0n,
        );
    expect(gelOn('bank_nominal')).toBe(21_349_500n);
    expect(gelOn('bank_operating')).toBe(150_500n);

    // А «сходится в пересчёте» — не сходится: курс не заменяет проводку.
    expectCode(
      () =>
        createJournalEntry({
          id: 'e4',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.conversion',
          postings: [
            debit(bankNominal('GEL'), money('GEL', 21_500_000n), deal),
            credit(client, money('USD', 8_000_000n), deal),
          ],
        }),
      LedgerErrorCode.entryUnbalanced,
    );
  });

  it('requires at least two postings and strictly positive amounts', () => {
    expectCode(
      () =>
        createJournalEntry({
          id: 'e5',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.funds_received',
          postings: [debit(bankNominal('USD'), money('USD', 0n), deal)],
        }),
      LedgerErrorCode.entryTooFewPostings,
    );
    expectCode(
      () =>
        createJournalEntry({
          id: 'e6',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.funds_received',
          postings: [
            debit(bankNominal('USD'), money('USD', -1n), deal),
            credit(client, money('USD', -1n), deal),
          ],
        }),
      LedgerErrorCode.postingNonPositiveAmount,
    );
  });

  it('ties a correction to the entry it corrects and forbids the reference elsewhere', () => {
    expectCode(
      () =>
        createJournalEntry({
          id: 'e7',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'correction',
          memoKey: 'ledger.entry.correction',
          postings: [
            debit(client, money('GEL', 100n), deal),
            credit(bankNominal('GEL'), money('GEL', 100n), deal),
          ],
        }),
      LedgerErrorCode.entryCorrectionWithoutReference,
    );
    expectCode(
      () =>
        createJournalEntry({
          id: 'e8',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.funds_received',
          correctsEntryId: 'e1',
          postings: [
            debit(bankNominal('GEL'), money('GEL', 100n), deal),
            credit(client, money('GEL', 100n), deal),
          ],
        }),
      LedgerErrorCode.entrySettlementWithReference,
    );
  });

  it('accepts the settlement entry where fee income is recognised and swept in the same journal', () => {
    const entry = createJournalEntry({
      id: 'e9',
      occurredAt: '2026-09-03T10:00:00Z',
      kind: 'settlement',
      memoKey: 'ledger.entry.payout',
      postings: [
        debit(client, money('GEL', 21_349_500n), deal),
        credit(bankNominal('GEL'), money('GEL', 21_349_500n), deal),
        credit(feeIncome, money('GEL', 106_747n)),
        debit(bankOperating('GEL'), money('GEL', 106_747n)),
      ],
    });
    expect(entry.postings).toHaveLength(4);
  });

  it('refuses to recognise platform income without moving it off the nominal account', () => {
    // Прежняя редакция этой же записи (без ноги операционного счёта) считалась
    // законной: комиссия признавалась доходом и оставалась на номинальном
    // счёте до отдельного вывода, забыть который ничего не мешало. Красная
    // линия №2 требует вывода «в том же журнале» — теперь буквально.
    expectCode(
      () =>
        createJournalEntry({
          id: 'e10',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.payout',
          postings: [
            debit(client, money('GEL', 21_349_500n), deal),
            credit(bankNominal('GEL'), money('GEL', 21_242_753n), deal),
            credit(feeIncome, money('GEL', 106_747n)),
          ],
        }),
      LedgerErrorCode.entryPlatformIncomeNotSwept,
    );
    // Вывод «туда и обратно» — тоже не вывод. Прежняя редакция проверки
    // складывала **валовые** дебеты операционного счёта, поэтому запись, где
    // комиссия выведена дебетом 106 747 и той же записью возвращена кредитом
    // 106 747, проходила: на операционном счёте ноль, комиссия осталась на
    // номинальном, а проверка рапортовала о выводе. Считается чистое движение.
    expectCode(
      () =>
        createJournalEntry({
          id: 'e12',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.payout',
          postings: [
            debit(client, money('GEL', 21_349_500n), deal),
            credit(bankNominal('GEL'), money('GEL', 21_349_500n), deal),
            credit(feeIncome, money('GEL', 106_747n)),
            debit(bankOperating('GEL'), money('GEL', 106_747n)),
            credit(bankOperating('GEL'), money('GEL', 106_747n)),
            debit(bankNominal('GEL'), money('GEL', 106_747n), deal),
          ],
        }),
      LedgerErrorCode.entryPlatformIncomeNotSwept,
    );
    // Частичный вывод — тоже не вывод: остаток комиссии на номинальном счёте
    // ничем не отличается от полной комиссии на нём.
    expectCode(
      () =>
        createJournalEntry({
          id: 'e11',
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.payout',
          postings: [
            debit(client, money('GEL', 21_349_500n), deal),
            credit(bankNominal('GEL'), money('GEL', 21_342_753n), deal),
            credit(feeIncome, money('GEL', 106_747n)),
            debit(bankOperating('GEL'), money('GEL', 100_000n)),
          ],
        }),
      LedgerErrorCode.entryPlatformIncomeNotSwept,
    );
  });
});
