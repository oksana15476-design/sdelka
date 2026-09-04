import {
  type Journal,
  accountBalance,
  bankNominal,
  checkLedgerInvariants,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  coverageByTranche,
  emptyJournal,
  freeBalance,
  isEveryTrancheCovered,
  isFullyCovered,
  negativeClientBalances,
} from '@sdelka/ledger';
import { rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type ClientAccountFacts,
  type Intent,
  type TrancheEvent,
  type TrancheState,
  evaluateWithdrawalGuard,
} from '../src/index';
import { AMOUNT, DEAL_ID, PAYER_CLIENT_KEY, TRANCHE_ID, context } from './support/facts';
import { accept, stateAt } from './support/drive';
import { balanceBreaks, expectedBalances, mergeExpected } from './support/conservation';
import { projectIntents } from './support/ledger-projection';

const FEE_RATE = rationalFromDecimalString('0.005');
const payer = clientKey(PAYER_CLIENT_KEY);
const locked = clientLockedAccount(payer, DEAL_ID, TRANCHE_ID);
const free = clientFreeAccount(payer);

const fundsReceived: TrancheEvent = {
  type: 'funds_received',
  amount: AMOUNT,
  sender: 'buyer-1',
  reference: 'ref-1',
};

/**
 * Прогоняет путь от `collecting`, проецируя намерения в журнал. Факты о
 * запертой сумме берутся **из журнала на каждом шаге** — так же, как их обязано
 * брать приложение: `lockedAmount` объявлен приходящим из учёта, и подставлять
 * сюда собственный счётчик значило бы проверять модель против самой себя.
 */
function walkFrom(
  start: TrancheState,
  events: readonly TrancheEvent[],
): { journal: Journal; state: TrancheState; intents: readonly Intent[] } {
  let journal: Journal = emptyJournal;
  let state = start;
  let intents: Intent[] = [];
  for (const event of events) {
    const step = accept(
      state,
      event,
      context({ lockedAmount: accountBalance(journal, locked, 'GEL') }),
    );
    state = step.state;
    journal = projectIntents(journal, step.intents, { feeRate: FEE_RATE });
    intents = [...intents, ...step.intents];
  }
  return { journal, state, intents };
}

/**
 * Дыра, которую нашла сборка интерфейса, а не тесты: экран обещал поведение,
 * которого в автомате не было.
 *
 * `CABINETS.md` §3.2 блок 6 обещает «если регистрация не завершится до 18:00,
 * резерв будет снят автоматически **и деньги останутся у вас**», а §3.4 —
 * «вывод доступен, пока средства не зарезервированы». Ребро
 * `reserved → collected on reserve_expired` в автомате было, а движения денег
 * при нём не было: запирание вообще не было намерением автомата, и три проекции
 * запирали средства в трёх разных моментах. Симметричной половины —
 * расфиксации — не было ни у одной, то есть после снятия резерва деньги в учёте
 * оставались запертыми под траншем, который в интерфейсе уже считался
 * свободным.
 */
describe('откат резерва возвращает деньги в свободную часть', () => {
  const toReserved: readonly TrancheEvent[] = [fundsReceived, { type: 'reserve_requested' }];

  it('запирает средства на входе в reserved, а не на входе в collected', () => {
    const afterPayment = walkFrom(stateAt('collecting'), [fundsReceived]);
    expect(afterPayment.state.status).toBe('collected');
    // §6 и И12.2: в `collected` деньги «на вашем счёте, можете забрать».
    expect(accountBalance(afterPayment.journal, free, 'GEL').minor).toBe(AMOUNT.minor);
    expect(accountBalance(afterPayment.journal, locked, 'GEL').minor).toBe(0n);

    const afterReserve = walkFrom(stateAt('collecting'), toReserved);
    expect(afterReserve.state.status).toBe('reserved');
    expect(accountBalance(afterReserve.journal, free, 'GEL').minor).toBe(0n);
    expect(accountBalance(afterReserve.journal, locked, 'GEL').minor).toBe(AMOUNT.minor);
    // Файл транша появился и обеспечен: две проводки привязки, переносящие
    // отнесение кастодиана, на месте (FUNCTIONAL.md §3.1).
    expect(coverageByTranche(afterReserve.journal)).toHaveLength(1);
    expect(isEveryTrancheCovered(afterReserve.journal)).toBe(true);
  });

  it('расфиксирует их обратно по reserve_expired — это и есть закрытая дыра', () => {
    const rolledBack = walkFrom(stateAt('collecting'), [
      ...toReserved,
      { type: 'reserve_expired' },
    ]);
    expect(rolledBack.state.status).toBe('collected');

    // Деньги остались у клиента и снова свободны — ровно то, что обещает экран.
    expect(accountBalance(rolledBack.journal, locked, 'GEL').minor).toBe(0n);
    expect(accountBalance(rolledBack.journal, free, 'GEL').minor).toBe(AMOUNT.minor);
    // И никуда не уходили: они всё это время на номинальном счёте.
    expect(accountBalance(rolledBack.journal, bankNominal('GEL'), 'GEL').minor).toBe(
      AMOUNT.minor,
    );
    expect(negativeClientBalances(rolledBack.journal)).toEqual([]);
    expect(checkLedgerInvariants(rolledBack.journal)).toEqual([]);
    expect(isFullyCovered(rolledBack.journal)).toBe(true);

    // И модель по намерениям сходится с журналом до минорной единицы: автомат
    // велел ровно то, что записано, а не «примерно то же».
    expect(
      balanceBreaks(rolledBack.journal, expectedBalances(rolledBack.intents, FEE_RATE)),
    ).toEqual([]);
  });

  it('то же самое на втором ребре — release_blocked → collected', () => {
    // Ключ по событию, а не по статусу: `reserve_expired` ведёт в `collected` с
    // двух рёбер, и одно правило закрывает оба.
    const rolledBack = walkFrom(stateAt('collecting'), [
      ...toReserved,
      { type: 'mismatch_detected', field: 'share' },
      { type: 'reserve_expired' },
    ]);
    expect(rolledBack.state.status).toBe('collected');
    expect(accountBalance(rolledBack.journal, locked, 'GEL').minor).toBe(0n);
    expect(accountBalance(rolledBack.journal, free, 'GEL').minor).toBe(AMOUNT.minor);
    expect(checkLedgerInvariants(rolledBack.journal)).toEqual([]);
  });

  it('резерв можно взять заново, и повторного запирания при этом ровно одно', () => {
    // «Сделку можно будет провести заново» — вторая половина обещания блока 6.
    const again = walkFrom(stateAt('collecting'), [
      ...toReserved,
      { type: 'reserve_expired' },
      { type: 'reserve_requested' },
    ]);
    expect(again.state.status).toBe('reserved');
    expect(accountBalance(again.journal, locked, 'GEL').minor).toBe(AMOUNT.minor);
    expect(accountBalance(again.journal, free, 'GEL').minor).toBe(0n);
    expect(negativeClientBalances(again.journal)).toEqual([]);
    expect(checkLedgerInvariants(again.journal)).toEqual([]);
    expect(
      balanceBreaks(again.journal, mergeExpected(expectedBalances(again.intents, FEE_RATE), {
        totals: new Map(),
      })),
    ).toEqual([]);
  });
});

/**
 * И12.2: «вывод доступен, пока средства не зарезервированы». До этого батча
 * обещание было декларацией — проверить его было нечем, потому что деньги
 * запирались в момент `collected` и свободной части у транша не существовало ни
 * секунды.
 */
describe('вывод доступен ровно до резерва', () => {
  function withdrawalFacts(journal: Journal): ClientAccountFacts {
    return {
      free: freeBalance(journal, payer, 'GEL'),
      locked: [],
      requestedAmount: AMOUNT,
      sourceAccount: { accountRef: 'source-1', holderIsPayer: true },
      preparedBy: 'operator-1',
      approvals: [{ userId: 'operator-2' }, { userId: 'operator-3' }],
      activeWithdrawals: 0,
    };
  }

  it('в collected свободного остатка хватает на всю сумму', () => {
    const collected = walkFrom(stateAt('collecting'), [fundsReceived]);
    expect(
      evaluateWithdrawalGuard('g_free_balance_sufficient', withdrawalFacts(collected.journal)),
    ).toBe(true);
  });

  it('после резерва — не хватает, и это структура счёта, а не проверка', () => {
    // Запертая часть лежит на другом счёте, и `freeBalance` её не видит вовсе:
    // красная линия №1 держится этим, а не guard'ом (см. `client-account.ts`).
    const reserved = walkFrom(stateAt('collecting'), [
      fundsReceived,
      { type: 'reserve_requested' },
    ]);
    expect(
      evaluateWithdrawalGuard('g_free_balance_sufficient', withdrawalFacts(reserved.journal)),
    ).toBe(false);
  });

  it('после отката резерва — снова хватает', () => {
    const rolledBack = walkFrom(stateAt('collecting'), [
      fundsReceived,
      { type: 'reserve_requested' },
      { type: 'reserve_expired' },
    ]);
    expect(
      evaluateWithdrawalGuard('g_free_balance_sufficient', withdrawalFacts(rolledBack.journal)),
    ).toBe(true);
  });
});

/**
 * Списание транша, который **никогда не резервировался**, — надгробие на
 * изменившемся поведении.
 *
 * `release_blocked`, куда транш попал по `¬g_payer_matches`, не проходит ни
 * `collected`, ни `reserved`: файл транша пуст. Раньше `write_off` брал сумму из
 * `collectedAmount` и порождал запись, дебетующую пустой файл, — приложение
 * обязано было её не записать, и держалась эта обязанность на дисциплине
 * приложения. Теперь сумма берётся из запертого, запертого нет, и намерения не
 * возникает вовсе.
 */
describe('списание транша, под которым ничего не заперто', () => {
  it('не порождает проводки, потому что дебетовать нечего', () => {
    const ctx = context({ collectedAmount: null, lockedAmount: null });
    const blocked = accept(
      stateAt('collecting'),
      { type: 'funds_received', amount: AMOUNT, sender: 'not-the-buyer', reference: 'ref-1' },
      ctx,
    );
    expect(blocked.state.status).toBe('release_blocked');

    const written = accept(
      blocked.state,
      { type: 'write_off_approved', userIds: ['operator-2', 'operator-3'] },
      ctx,
    );
    expect(written.state.status).toBe('written_off');
    expect(
      written.intents.filter((intent) => intent.type === 'post_journal_entry'),
    ).toEqual([]);
    // Закрытие транша при этом происходит: списание — решение о судьбе
    // обязательства, а не проводка, и обязательства здесь просто нет.
    expect(written.intents.map((intent) => intent.type)).toContain('close_tranche');
  });
});
