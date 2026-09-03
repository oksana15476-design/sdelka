import {
  type Journal,
  accountBalance,
  appendEntry,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientKey,
  clientLockedAccount,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  isEveryTrancheCovered,
  isFullyCovered,
  negativeClientBalances,
  transitWriteoff,
  unclaimedLiability,
} from '@sdelka/ledger';
import { rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import { type TrancheEvent, type TrancheState } from '../src/index';
import { AMOUNT, DEAL_ID, PAYER_CLIENT_KEY, TRANCHE_ID, context } from './support/facts';
import { accept, stateAt } from './support/drive';
import { projectIntents } from './support/ledger-projection';

const client = clientLockedAccount(clientKey(PAYER_CLIENT_KEY), DEAL_ID, TRANCHE_ID);

const fundsReceived: TrancheEvent = {
  type: 'funds_received',
  amount: AMOUNT,
  sender: 'buyer-1',
  reference: 'ref-1',
};

describe('невостребованные средства доходят до проводки (FUNCTIONAL.md §3.1)', () => {
  it('closes the obligation, empties the nominal account and books the debt', () => {
    const ctx = context();
    let journal: Journal = emptyJournal;
    let state: TrancheState = stateAt('collecting');

    for (const event of [
      fundsReceived,
      { type: 'reserve_requested' } as const,
      { type: 'mismatch_detected', field: 'share' } as const,
      { type: 'write_off_approved', userIds: ['operator-2', 'operator-3'] } as const,
    ]) {
      const step = accept(state, event, ctx);
      state = step.state;
      journal = projectIntents(journal, step.intents, {
        feeRate: rationalFromDecimalString('0.005'),
      });
    }

    expect(state.status).toBe('written_off');
    // Обязательство перед клиентом закрыто...
    expect(accountBalance(journal, client, 'GEL').minor).toBe(0n);
    // ...и деньги ушли с номинального счёта: на нём не остаётся остатка без
    // признанного клиентского обязательства (случай Б, §3.1).
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(0n);
    // **Деньги в транзите, а не на операционном счёте.** §3.1 требует двух
    // моментов: номинальный счёт в одном банке, операционный в другом, и между
    // ними межбанковский перевод на день-два. Прежняя редакция записывала
    // приход на операционный счёт тем же мгновением — то есть утверждала, что
    // перевод уже дошёл, и промежуток, который §3.1 требует держать видимым,
    // не существовал вовсе.
    expect(accountBalance(journal, transitWriteoff, 'GEL').minor).toBe(AMOUNT.minor);
    expect(accountBalance(journal, bankOperating('GEL'), 'GEL').minor).toBe(0n);
    // Доходом они не стали: это долг, просто не против живого транша.
    expect(accountBalance(journal, unclaimedLiability, 'GEL').minor).toBe(AMOUNT.minor);
    expect(isFullyCovered(journal)).toBe(true);
    expect(isEveryTrancheCovered(journal)).toBe(true);
    expect(negativeClientBalances(journal)).toEqual([]);
    // Вторая проверка покрытия, которую §3.1 требует прямым текстом: транзит
    // плюс операционный счёт покрывают невостребованные обязательства. В
    // транзите они покрыты так же, как на операционном счёте, — иначе списание
    // выглядело бы расхождением на всё время перевода.
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  it('lands on the operating account only at the second moment, and that moment is not a transition', () => {
    const ctx = context();
    let journal: Journal = emptyJournal;
    let state: TrancheState = stateAt('collecting');
    for (const event of [
      fundsReceived,
      { type: 'reserve_requested' } as const,
      { type: 'mismatch_detected', field: 'share' } as const,
      { type: 'write_off_approved', userIds: ['operator-2', 'operator-3'] } as const,
    ]) {
      const step = accept(state, event, ctx);
      state = step.state;
      journal = projectIntents(journal, step.intents, {
        feeRate: rationalFromDecimalString('0.005'),
      });
    }

    // Момент 2 — «деньги дошли на операционный счёт» — приходит из банковской
    // выписки, а не из автомата: транш уже терминален, и сказать о нём автомату
    // нечего. Поэтому запись собирает приложение, и здесь она собрана руками
    // намеренно — это тот же шов, что и у самой записи списания.
    journal = appendEntry(
      journal,
      createJournalEntry({
        id: 'write-off-arrival',
        occurredAt: '2026-09-06T09:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.unclaimed_arrival',
        postings: [debit(bankOperating('GEL'), AMOUNT), credit(transitWriteoff, AMOUNT)],
      }),
    );

    expect(accountBalance(journal, transitWriteoff, 'GEL').minor).toBe(0n);
    expect(accountBalance(journal, bankOperating('GEL'), 'GEL').minor).toBe(AMOUNT.minor);
    expect(accountBalance(journal, unclaimedLiability, 'GEL').minor).toBe(AMOUNT.minor);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });
});
