import {
  type Journal,
  accountBalance,
  bankNominal,
  checkLedgerInvariants,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  emptyJournal,
  negativeClientBalances,
} from '@sdelka/ledger';
import { rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import type { Intent, TrancheEvent, TrancheState } from '../src/index';
import { AMOUNT, DEAL_ID, PAYER_CLIENT_KEY, TRANCHE_ID, context } from './support/facts';
import { accept, stateAt } from './support/drive';
import { balanceBreaks, expectedBalances, mergeExpected } from './support/conservation';
import { projectIntents } from './support/ledger-projection';

const FEE_RATE = rationalFromDecimalString('0.005');
const payer = clientKey(PAYER_CLIENT_KEY);
const locked = clientLockedAccount(payer, DEAL_ID, TRANCHE_ID);
const free = clientFreeAccount(payer);

function templates(intents: readonly Intent[]): readonly string[] {
  return intents
    .filter((intent) => intent.type === 'post_journal_entry')
    .map((intent) => (intent.type === 'post_journal_entry' ? intent.template : ''));
}

/**
 * Возврат — операция с двумя моментами (FUNCTIONAL.md §3.1, по образцу
 * списания): отвязка от транша и уход денег с номинального счёта это разные
 * события, и второе идёт через внешний перевод.
 *
 * Раньше шаблон был один, и каждая проекция выбирала, какой из двух моментов
 * он значит: домен записывал отвязку и на этом останавливался, приложение —
 * внешний вывод. То есть тест на свойствах гонял не ту модель, которой
 * пользуется приложение, и ни одна из двух форм не проверялась целиком.
 */
describe('возврат: два момента, а не один', () => {
  const events: readonly TrancheEvent[] = [
    { type: 'refund_initiated' },
    { type: 'payout_result', outcome: 'settled' },
  ];

  function drive(from: TrancheState = stateAt('refund_pending')): {
    journal: Journal;
    intents: readonly Intent[];
    state: TrancheState;
  } {
    const ctx = context();
    let journal: Journal = emptyJournal;
    let state = from;
    let intents: Intent[] = [];
    // Деньги под траншем: до возврата они пришли и заперты.
    const funded = accept(
      stateAt('collecting'),
      { type: 'funds_received', amount: AMOUNT, sender: 'buyer-1', reference: 'ref-1' },
      ctx,
    );
    journal = projectIntents(journal, funded.intents, { feeRate: FEE_RATE });
    intents = [...funded.intents];
    for (const event of events) {
      const step = accept(state, event, ctx);
      state = step.state;
      journal = projectIntents(journal, step.intents, { feeRate: FEE_RATE });
      intents = [...intents, ...step.intents];
    }
    return { journal, intents, state };
  }

  it('records nothing while the instruction is out, because nothing has happened yet', () => {
    const ctx = context();
    const refunding = accept(stateAt('refund_pending'), { type: 'refund_initiated' }, ctx);
    expect(refunding.state.status).toBe('refunding');
    // Отвязка не стоит на входе в `refunding` намеренно: из него есть ребро в
    // `release_blocked` по отказу банка, а оттуда — обратно в `refund_pending`
    // и снова в `refunding`. Отвязка, стоящая на нетерминальном входе,
    // повторилась бы на каждой попытке и увела бы запертую часть в минус.
    expect(templates(refunding.intents)).toEqual([]);

    const rejected = accept(
      refunding.state,
      { type: 'payout_result', outcome: 'rejected' },
      ctx,
    );
    expect(rejected.state.status).toBe('release_blocked');
    expect(templates(rejected.intents)).toEqual([]);
  });

  it('emits both moments, in order, at the confirmed refund', () => {
    const { intents, state } = drive();
    expect(state.status).toBe('refunded');
    expect(templates(intents)).toEqual(['funds_received', 'refund_unlock', 'refund_external']);
  });

  it('leaves the tranche, the client account and the nominal account empty', () => {
    const { journal } = drive();
    // Момент 1: обязательство по траншу погашено.
    expect(accountBalance(journal, locked, 'GEL').minor).toBe(0n);
    // Момент 2: долг перед покупателем погашен, деньги ушли с номинального
    // счёта на счёт-источник (красная линия №9).
    expect(accountBalance(journal, free, 'GEL').minor).toBe(0n);
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(0n);
    expect(negativeClientBalances(journal)).toEqual([]);
    expect(checkLedgerInvariants(journal)).toEqual([]);
  });

  it('keeps the two records apart in the journal', () => {
    const { journal } = drive();
    const memos = journal.entries.map((entry) => entry.memoKey);
    // Две записи, а не одна: отвязка словарём, внешний вывод — вручную, потому
    // что конструктора внешнего вывода в `@sdelka/ledger` нет (И12.2). Шов
    // помечен и в проекции.
    expect(memos).toContain('ledger.entry.unlocked_to_client');
    // Ключ памятки — `refund_to_source`, а не `refund_external`: запись теперь
    // строит конструктор словаря `@sdelka/ledger`, а не проекция от руки.
    // Форма и порядок двух моментов не изменились, изменилось только имя, и
    // именно поэтому расхождение проекций больше невозможно.
    expect(memos).toContain('ledger.entry.refund_to_source');
    expect(memos.indexOf('ledger.entry.unlocked_to_client')).toBeLessThan(
      memos.indexOf('ledger.entry.refund_to_source'),
    );
  });

  it('matches the model built from intents', () => {
    const { journal, intents } = drive();
    const expected = expectedBalances(intents, FEE_RATE);
    expect(balanceBreaks(journal, expected)).toEqual([]);
    // Модель и журнал сходятся в пустоту: после подтверждённого возврата у
    // транша не остаётся ни одного счёта с остатком.
    expect(mergeExpected(expected, { totals: new Map() }).totals.size).toBe(0);
  });
});
