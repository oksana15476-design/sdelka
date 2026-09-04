import {
  type Journal,
  accountBalance,
  appendEntry,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientFreeAccount,
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
import { money, rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import { type TrancheEvent, type TrancheState, RejectionCode } from '../src/index';
import { AMOUNT, DEAL_ID, PAYER_CLIENT_KEY, TRANCHE_ID, context } from './support/facts';
import { accept, reject, stateAt, walk } from './support/drive';
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

/**
 * Путь в `release_blocked`, **не заходящий в `reserved`**: деньги собраны, но
 * ни разу не запирались под траншем — они в свободной части счёта покупателя.
 * Тот же путь, которым `g_funds_locked` был найден на выплате.
 */
const TO_BLOCKED_WITHOUT_RESERVE: readonly TrancheEvent[] = [
  fundsReceived,
  { type: 'refund_requested', reason: 'buyer_asked' },
  { type: 'refund_initiated' },
  { type: 'payout_result', outcome: 'rejected' },
];

describe('списание транша с пустым файлом (E14, дефект «списание стало бесследным»)', () => {
  it('is refused when the money never got locked under this tranche', () => {
    // Файл транша пуст: деньги в свободной части счёта покупателя. До E14
    // двоих утверждающих хватало, чтобы увести транш в `written_off` **без
    // единой записи в журнале**: сумма списания берётся из запертого, а при
    // пустом файле намерения проводки не возникает вовсе.
    const ctx = context({ lockedAmount: money('GEL', 0n) });
    const blocked = walk(stateAt('collecting'), TO_BLOCKED_WITHOUT_RESERVE, ctx);
    expect(blocked.status).toBe('release_blocked');

    const error = reject(
      blocked,
      { type: 'write_off_approved', userIds: ['operator-2', 'operator-3'] },
      ctx,
    );
    expect(error.code).toBe(RejectionCode.guardFailed);
    expect(error.failedGuards).toContain('g_write_off_covers_collected');
    // Утверждений при этом достаточно: отказ даёт именно необеспеченность, а
    // не число подписей — иначе тест был бы зелёным по чужой причине.
    expect(error.failedGuards).not.toContain('g_write_off_approvers_distinct');
  });

  it('does not silently close the obligation it cannot move', () => {
    // Форма дефекта целиком: статус утверждает «обязательство закрыто, деньги
    // ушли с номинального счёта», а журнал не меняется. Терминальное состояние
    // с ложным смыслом хуже отказа: транш закрыт, обязательство перед
    // клиентом стоит, и увидеть это больше негде.
    const ctx = context({ lockedAmount: money('GEL', 0n) });
    let journal: Journal = emptyJournal;
    let state: TrancheState = stateAt('collecting');
    for (const event of TO_BLOCKED_WITHOUT_RESERVE) {
      const step = accept(state, event, ctx);
      state = step.state;
      journal = projectIntents(journal, step.intents, {
        feeRate: rationalFromDecimalString('0.005'),
      });
    }
    const before = journal.entries.length;
    const result = reject(
      state,
      { type: 'write_off_approved', userIds: ['operator-2', 'operator-3'] },
      ctx,
    );
    expect(result.code).toBe(RejectionCode.guardFailed);
    // Транш остался там, где его разбирает человек, а деньги — обязательством
    // перед клиентом: их выход отсюда — возврат, а не списание.
    expect(state.status).toBe('release_blocked');
    expect(journal.entries).toHaveLength(before);
    expect(accountBalance(journal, clientFreeAccount(clientKey(PAYER_CLIENT_KEY)), 'GEL').minor).toBe(
      AMOUNT.minor,
    );
    expect(accountBalance(journal, client, 'GEL').minor).toBe(0n);
  });

  it('still allows the write-off of a tranche whose file is full', () => {
    // Обратная половина: там, где деньги действительно заперты под траншем,
    // списание проходит ровно как прежде. Guard закрывает случай, а не операцию.
    const ctx = context();
    const blocked = walk(
      stateAt('collecting'),
      [fundsReceived, { type: 'reserve_requested' }, { type: 'mismatch_detected', field: 'share' }],
      ctx,
    );
    const written = accept(
      blocked,
      { type: 'write_off_approved', userIds: ['operator-2', 'operator-3'] },
      ctx,
    );
    expect(written.state.status).toBe('written_off');
    expect(
      written.intents.some(
        (intent) => intent.type === 'post_journal_entry' && intent.template === 'write_off',
      ),
    ).toBe(true);
  });

  it('still allows the write-off of a tranche that never collected anything', () => {
    // Второй законный случай, и он не тот же самый: платёж третьего лица на
    // транш **не зачисляется**, обязательства перед клиентом не возникает — и
    // закрывать нечего. Отсюда и отдельный guard вместо `g_funds_locked`,
    // который отказал бы и здесь. Проверка стоит рядом с предыдущей нарочно:
    // между «нечего закрывать» и «есть что закрывать, и оно лежит не там»
    // проходит вся разница списания.
    const ctx = context({ collectedAmount: null, lockedAmount: null });
    const blocked = accept(
      stateAt('collecting'),
      { type: 'funds_received', amount: AMOUNT, sender: 'not-the-buyer', reference: 'ref-1' },
      ctx,
    );
    const written = accept(
      blocked.state,
      { type: 'write_off_approved', userIds: ['operator-2', 'operator-3'] },
      ctx,
    );
    expect(written.state.status).toBe('written_off');
    expect(written.intents.filter((intent) => intent.type === 'post_journal_entry')).toEqual([]);
  });
});
