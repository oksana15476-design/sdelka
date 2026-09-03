import {
  type Journal,
  accountBalance,
  bankNominal,
  bankOperating,
  clientKey,
  clientLockedAccount,
  emptyJournal,
  isEveryTrancheCovered,
  isFullyCovered,
  negativeClientBalances,
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
        // Списание получателя не касается, но проекция одна на все шаблоны.
        recipientClientKey: 'seller-1',
      });
    }

    expect(state.status).toBe('written_off');
    // Обязательство перед клиентом закрыто...
    expect(accountBalance(journal, client, 'GEL').minor).toBe(0n);
    // ...и деньги ушли с номинального счёта: на нём не остаётся остатка без
    // признанного клиентского обязательства (случай Б, §3.1).
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(0n);
    expect(accountBalance(journal, bankOperating('GEL'), 'GEL').minor).toBe(AMOUNT.minor);
    // Доходом они не стали: это долг, просто не против живого транша.
    expect(accountBalance(journal, unclaimedLiability, 'GEL').minor).toBe(AMOUNT.minor);
    expect(isFullyCovered(journal)).toBe(true);
    expect(isEveryTrancheCovered(journal)).toBe(true);
    expect(negativeClientBalances(journal)).toEqual([]);
  });
});
