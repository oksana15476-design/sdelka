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
  shouldStopAcceptingDeals,
} from '@sdelka/ledger';
import { money, rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import type { TrancheEvent } from '../src/index';
import {
  AMOUNT,
  DEAL_ID,
  PAYER_CLIENT_KEY,
  RECIPIENT_CLIENT_KEY,
  TRANCHE_ID,
  context,
} from './support/facts';
import { accept, stateAt } from './support/drive';
import { balanceBreaks, expectedBalances, mergeExpected } from './support/conservation';
import { projectIntents } from './support/ledger-projection';

const FEE_RATE = rationalFromDecimalString('0.005');
const payer = clientKey(PAYER_CLIENT_KEY);
const recipient = clientKey(RECIPIENT_CLIENT_KEY);
const locked = clientLockedAccount(payer, DEAL_ID, TRANCHE_ID);
const deal = { dealId: DEAL_ID, trancheId: TRANCHE_ID };

const fundsReceived: TrancheEvent = {
  type: 'funds_received',
  amount: AMOUNT,
  sender: 'buyer-1',
  reference: 'ref-1',
};

const FEE = money('GEL', AMOUNT.minor / 200n);

/**
 * Мутация, которую верификатор пронёс мимо всего набора инвариантов:
 * **обязательство перед получателем не возникает вовсе.** Деньги уходят с
 * номинального счёта, комиссия при этом выведена честно, запись сходится в
 * ноль — и `checkLedgerInvariants` возвращает пустой список.
 *
 * Почему ни один инвариант учёта её не видит. Все они смотрят на журнал
 * изнутри: сумма записи, покрытие по файлу, отрицательный остаток, профицит.
 * Здесь у файла транша исчезают **сразу и деньги, и долг** — расхождение
 * симметрично с обеих сторон, поэтому покрытие остаётся равным единице, а
 * профицита нет. Заявка «профицит и недостача теперь видны» была верна только
 * для двух форм, которые лежали в тестах.
 *
 * Ловится это единственным способом — сравнением с внешним счётом: сколько
 * автомат велел двигать и куда. Этот тест держит обе стороны видимыми: что
 * учёт молчит, и что модель по намерениям — нет.
 */
describe('исчезновение обязательства перед получателем', () => {
  /**
   * Деньги под траншем: пришли и **заперты**. Резерв в сценарии появился не для
   * красоты — запирание перестало быть склеенным с зачислением и стало
   * намерением входа в `reserved` (FUNCTIONAL.md §3.1). Без этого шага файл
   * транша пуст, и мутация ниже дебетовала бы не «исчезнувшее обязательство», а
   * счёт, на котором ничего не было, — то есть тест проверял бы другое.
   */
  function fundedJournal(): { journal: Journal; expected: ReturnType<typeof expectedBalances> } {
    const received = accept(stateAt('collecting'), fundsReceived, context());
    const reserved = accept(received.state, { type: 'reserve_requested' }, context());
    const intents = [...received.intents, ...reserved.intents];
    return {
      journal: projectIntents(emptyJournal, intents, { feeRate: FEE_RATE }),
      expected: expectedBalances(intents, FEE_RATE),
    };
  }

  /**
   * Расчёт, в котором обязательство перед получателем не порождается: запертая
   * часть плательщика дебетуется, номинальный счёт кредитуется на **всю**
   * сумму, комиссия выведена на операционный. Свободной части получателя запись
   * не касается вовсе.
   */
  function vanishingSettlement(journal: Journal): Journal {
    return appendEntry(
      journal,
      createJournalEntry({
        id: 'vanishing',
        occurredAt: '2026-09-03T12:00:00Z',
        kind: 'settlement',
        memoKey: 'ledger.entry.tranche_settled',
        postings: [
          debit(locked, AMOUNT, deal),
          credit(bankNominal('GEL'), AMOUNT, deal),
          credit({ kind: 'fee_income' }, FEE),
          debit(bankOperating('GEL'), FEE),
        ],
      }),
    );
  }

  it('passes every ledger invariant, which is the point', () => {
    const journal = vanishingSettlement(fundedJournal().journal);

    // Запись собирается: ни один из контуров `createJournalEntry` её не
    // отвергает — движения обязательства между владельцами в ней нет, файл
    // клиентских средств она не наращивает, доход выведен.
    expect(journal.entries).toHaveLength(3);
    expect(isFullyCovered(journal)).toBe(true);
    expect(isEveryTrancheCovered(journal)).toBe(true);
    expect(negativeClientBalances(journal)).toEqual([]);
    expect(checkLedgerInvariants(journal)).toEqual([]);
    // И приём новых сделок не останавливается: для учёта не произошло ничего.
    expect(shouldStopAcceptingDeals(journal)).toBe(false);

    // А произошло вот что: у получателя нет ничего, номинальный счёт пуст —
    // деньги ушли с него целиком, — и в файле транша не осталось ни долга, ни
    // средств. Расхождение симметрично с обеих сторон, поэтому покрытие и
    // равно единице: не потому, что всё на месте, а потому, что исчезло всё
    // сразу.
    expect(accountBalance(journal, clientFreeAccount(recipient), 'GEL').minor).toBe(0n);
    expect(accountBalance(journal, bankNominal('GEL'), 'GEL').minor).toBe(0n);
    expect(accountBalance(journal, locked, 'GEL').minor).toBe(0n);
  });

  it('is caught by the model built from intents, naming both accounts', () => {
    const funded = fundedJournal();
    const paidOut = accept(stateAt('paying_out'), { type: 'payout_result', outcome: 'settled' }, context());
    const expected = mergeExpected(
      funded.expected,
      expectedBalances(paidOut.intents, FEE_RATE),
    );

    // Честная проекция расхождений не даёт.
    const honest = projectIntents(funded.journal, paidOut.intents, { feeRate: FEE_RATE });
    expect(balanceBreaks(honest, expected)).toEqual([]);

    // Мутация — даёт, и поимённо: обязательства перед получателем нет, а с
    // номинального счёта ушло на всю сумму больше, чем велено.
    const breaks = balanceBreaks(vanishingSettlement(funded.journal), expected);
    expect(breaks).toEqual([
      {
        account: 'bank:nominal:gel|GEL',
        expectedMinor: AMOUNT.minor - FEE.minor,
        actualMinor: 0n,
      },
      {
        account: `client:${RECIPIENT_CLIENT_KEY}:free|GEL`,
        expectedMinor: AMOUNT.minor - FEE.minor,
        actualMinor: 0n,
      },
    ]);
  });
});
