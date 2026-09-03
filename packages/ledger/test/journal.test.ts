import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  LedgerError,
  LedgerErrorCode,
  accountCode,
  appendEntries,
  appendEntry,
  bankNominal,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
} from '../src/index';

const deal = { dealId: 'd1', trancheId: 't1' };
// Владелец счёта — ключ личности (FUNCTIONAL.md §2.1): один клиент, один счёт
// на все его сделки в любых ролях. Здесь он один и тот же во всех записях.
const owner = clientKey('c1');


function entry(id: string) {
  return createJournalEntry({
    id,
    occurredAt: '2026-09-03T10:00:00Z',
    kind: 'settlement',
    memoKey: 'ledger.entry.funds_received',
    postings: [
      debit(bankNominal('USD'), money('USD', 100n), deal),
      credit(clientLockedAccount(owner, deal.dealId, deal.trancheId), money('USD', 100n), deal),
    ],
  });
}

describe('журнал только дополняется', () => {
  it('returns a new journal and leaves the previous one untouched', () => {
    const first = appendEntry(emptyJournal, entry('e1'));
    const second = appendEntry(first, entry('e2'));
    expect(emptyJournal.entries).toHaveLength(0);
    expect(first.entries).toHaveLength(1);
    expect(second.entries).toHaveLength(2);
  });

  it('refuses a duplicate entry id', () => {
    const journal = appendEntry(emptyJournal, entry('e1'));
    try {
      appendEntry(journal, entry('e1'));
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe(LedgerErrorCode.journalDuplicateEntryId);
    }
  });

  it('freezes stored entries so an accidental write fails loudly', () => {
    const journal = appendEntries(emptyJournal, [entry('e1'), entry('e2')]);
    expect(Object.isFrozen(journal.entries)).toBe(true);
    expect(Object.isFrozen(journal.entries[0])).toBe(true);
    expect(() => {
      (journal.entries as unknown as { push: (value: unknown) => void }).push(entry('e3'));
    }).toThrow(TypeError);
  });

  it('renders the documented account codes', () => {
    expect(accountCode(bankNominal('GEL'))).toBe('bank:nominal:gel');
    // Коды счёта клиента из FUNCTIONAL.md §3.1 после E12-1: свободная и
    // запертая части. Сегменты `free` и `tranche` фиксированные, а не
    // позиционные — иначе сделка с идентификатором `free` даёт код чужого счёта.
    expect(accountCode(clientFreeAccount(owner))).toBe('client:c1:free');
    expect(accountCode(clientLockedAccount(owner, 'd1', 't1'))).toBe('client:c1:tranche:d1:t1');
    expect(accountCode({ kind: 'psp_fee_expense' })).toBe('psp:fee:expense');
    expect(accountCode({ kind: 'oracle_cost_expense' })).toBe('oracle:cost:expense');
    expect(accountCode({ kind: 'suspense_unidentified' })).toBe('suspense:unidentified');
    expect(() => accountCode(clientLockedAccount(owner, 'd:1', 't1'))).toThrow(LedgerError);
    // Ключ личности содержит двоеточие (`страна:тип:отпечаток`) и на месте
    // ключа счёта неприемлем: перевод одного в другое — забота compliance.
    expect(() => clientKey('GE:passport:abc')).toThrow(LedgerError);
  });
});
