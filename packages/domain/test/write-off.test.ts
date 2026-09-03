import {
  type Journal,
  accountBalance,
  bankNominal,
  clientAccount,
  emptyJournal,
  isEveryTrancheCovered,
  isFullyCovered,
  negativeClientBalances,
  writeoffExpense,
} from '@sdelka/ledger';
import { rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import { type TrancheEvent, type TrancheState } from '../src/index';
import { AMOUNT, DEAL_ID, TRANCHE_ID, context } from './support/facts';
import { accept, stateAt } from './support/drive';
import { projectIntents } from './support/ledger-projection';

const client = clientAccount(DEAL_ID, TRANCHE_ID);

const fundsReceived: TrancheEvent = {
  type: 'funds_received',
  amount: AMOUNT,
  sender: 'buyer-1',
  reference: 'ref-1',
};

describe('списание транша доходит до проводки (FUNCTIONAL.md §3.1)', () => {
  it('closes the client obligation against the platform expense and keeps coverage', () => {
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
    // ...за счёт платформы, а не других клиентов: номинальный счёт не тронут.
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(AMOUNT.minor);
    // Остаток `writeoff:expense` кредитовый, то есть по знаку это не расход:
    // деньги по траншу собраны и остались на номинальном счёте, а обязательство
    // снято. §3.1 называет счёт расходным и описывает списание как расход
    // платформы — на собранных средствах это не сходится. Вынесено владельцу.
    expect(accountBalance(journal, writeoffExpense, 'GEL').minor).toBe(-AMOUNT.minor);
    expect(isFullyCovered(journal)).toBe(true);
    expect(isEveryTrancheCovered(journal)).toBe(true);
    expect(negativeClientBalances(journal)).toEqual([]);
  });
});
