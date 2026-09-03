import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  InvariantCode,
  appendEntry,
  bankNominal,
  checkLedgerInvariants,
  clientKey,
  clientLockedAccount,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  shouldStopAcceptingDeals,
} from '../src/index';
import { uncheckedEntry } from './support/unchecked-entry';

const dealA = { dealId: 'A', trancheId: 't1' };
const dealB = { dealId: 'B', trancheId: 't1' };
// Владелец счёта — ключ личности (FUNCTIONAL.md §2.1): один клиент, один счёт
// на все его сделки в любых ролях. Здесь он один и тот же во всех записях.
const owner = clientKey('c1');


describe('инварианты учёта в коде', () => {
  it('reports nothing on a clean journal', () => {
    const journal = appendEntry(
      emptyJournal,
      createJournalEntry({
        id: 'e1',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.funds_received',
        postings: [
          debit(bankNominal('USD'), money('USD', 100n), dealA),
          credit(clientLockedAccount(owner, 'A', 't1'), money('USD', 100n), dealA),
        ],
      }),
    );
    expect(checkLedgerInvariants(journal)).toEqual([]);
    expect(shouldStopAcceptingDeals(journal)).toBe(false);
  });

  it('reports a negative client balance and stops accepting deals', () => {
    const journal = appendEntry(
      emptyJournal,
      createJournalEntry({
        id: 'e1',
        occurredAt: '2026-09-03T10:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.payout',
        postings: [
          debit(clientLockedAccount(owner, 'A', 't1'), money('USD', 50n), dealA),
          credit(bankNominal('USD'), money('USD', 50n), dealA),
        ],
      }),
    );
    const codes = checkLedgerInvariants(journal).map((violation) => violation.code);
    expect(codes).toContain(InvariantCode.negativeClientBalance);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });

  it('reports a per-tranche shortfall that the portfolio hides', () => {
    let journal = emptyJournal;
    for (const [id, deal] of [
      ['e1', dealA],
      ['e2', dealB],
    ] as const) {
      journal = appendEntry(
        journal,
        createJournalEntry({
          id,
          occurredAt: '2026-09-03T10:00:00Z',
          kind: 'settlement',
          memoKey: 'ledger.entry.funds_received',
          postings: [
            debit(bankNominal('USD'), money('USD', 100n), deal),
            credit(
              clientLockedAccount(owner, deal.dealId, deal.trancheId),
              money('USD', 100n),
              deal,
            ),
          ],
        }),
      );
    }
    // Конструктор такую запись уже не соберёт (красная линия №1, FUNCTIONAL.md
    // §3.1), поэтому расхождение кладётся в журнал в обход него: проверка
    // инвариантов обязана находить его и в готовом журнале.
    journal = appendEntry(
      journal,
      uncheckedEntry({
        id: 'e3',
        occurredAt: '2026-09-03T12:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.payout',
        postings: [
          debit(clientLockedAccount(owner, 'B', 't1'), money('USD', 100n), dealB),
          credit(bankNominal('USD'), money('USD', 100n), dealA),
        ],
      }),
    );
    const violations = checkLedgerInvariants(journal);
    // Расхождение двустороннее, и теперь видно обе стороны: у файла A средств
    // не хватает, у файла B они остались без обязательства. Раньше вторая
    // сторона молчала — профицит по файлу считался покрытием, и ровно этим
    // зазором проходила двухзаписная схема (дебет обязательства одной записью,
    // увод денег другой).
    expect(violations.map((violation) => violation.code)).toEqual([
      InvariantCode.trancheUncovered,
      InvariantCode.custodySurplus,
    ]);
    expect(violations[0]?.subject).toBe('A:t1');
    expect(violations[0]?.amountMinor).toBe(-100n);
    expect(violations[1]?.subject).toBe('B:t1');
    expect(violations[1]?.amountMinor).toBe(100n);
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });
});
