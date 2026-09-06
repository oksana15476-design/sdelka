import { convert, fxRates, isoDate, money, rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  InvariantCode,
  type InvariantViolation,
  STOP_ACCEPTING_INVARIANT_CODES,
  accountCode,
  accrueFee,
  appendEntries,
  bankNominal,
  bankOperating,
  checkLedgerInvariants,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  clientTopUp,
  credit,
  debit,
  emptyJournal,
  fxExecution,
  fxSettlement,
  lockForTranche,
  sendForConversion,
  shortfallExpense,
  shouldStopAcceptingDeals,
  unclaimedLiability,
  writeOffUnclaimed,
} from '../src/index';
import { uncheckedEntry } from './support/unchecked-entry';
import { unguardedJournal } from './support/unguarded-journal';

/**
 * Инварианты: **что именно** докладывается и **где проходит граница окна**.
 *
 * Мутационный прогон нашёл здесь три дыры, и все три про отчёт дежурному:
 *
 *  1. «Сумма проводок записи равна нулю» — инвариант, который в целевой
 *     архитектуре держит триггер базы, — не проверялся ни одним тестом: снос
 *     `violations.push` в этой ветке не ронял ничего;
 *  2. то же самое с обеспечением невостребованных средств
 *     (`unclaimedUncovered`) — вторая проверка покрытия, которую требует §3.1;
 *  3. перечень кодов, останавливающих приём новых сделок (красная линия №3),
 *     можно было переписать целиком, и набор этого не замечал.
 *
 * Плюс возраст: границы окон (`age <= staleAfterMs`), умолчание `asOf` и
 * неразбираемая метка времени. Возраст — единственное, чем ловится «встречная
 * валюта не поставлена» (§3.3), поэтому сдвиг границы на миллисекунду здесь
 * стоит ровно столько же, сколько сдвиг порога.
 */

const owner = clientKey('c1');
const other = clientKey('c2');
const deal = { dealId: 'd1', trancheId: 't1' };
const hundredThousand = money('GEL', 100_000n);

const BASE = '2026-09-03T10:00:00Z';
/** Ровно два банковских дня по умолчанию — граница, а не «примерно тогда же». */
const TWO_DAYS_LATER = '2026-09-05T10:00:00Z';
const JUST_PAST_TWO_DAYS = '2026-09-05T10:00:00.001Z';

function at(id: string, occurredAt = BASE): { id: string; occurredAt: string } {
  return { id, occurredAt };
}

function withCode(
  violations: readonly InvariantViolation[],
  code: InvariantViolation['code'],
): readonly InvariantViolation[] {
  return violations.filter((item) => item.code === code);
}

describe('сумма проводок записи равна нулю', () => {
  /**
   * Запись, не сходящаяся повалютно, в журнал через `createJournalEntry` не
   * попадает. Но журнал приезжает из базы — в том числе с записями, сделанными
   * до появления проверки, — и второй контур обязан такую запись **назвать**:
   * код, валюту, идентификатор записи и величину расхождения.
   */
  it('reports the entry, the currency and the difference', () => {
    const journal = unguardedJournal([
      uncheckedEntry({
        id: 'broken-1',
        occurredAt: BASE,
        kind: 'settlement',
        memoKey: 'ledger.entry.client_top_up',
        postings: [
          debit(bankNominal('GEL'), hundredThousand, { clientKey: owner }),
          credit(clientFreeAccount(owner), money('GEL', 90_000n), { clientKey: owner }),
        ],
      }),
    ]);

    expect(withCode(checkLedgerInvariants(journal), InvariantCode.entryUnbalanced)).toEqual([
      {
        code: InvariantCode.entryUnbalanced,
        currency: 'GEL',
        subject: 'broken-1',
        amountMinor: 10_000n,
      },
    ]);
  });

  it('says nothing about a balanced entry', () => {
    const journal = appendEntries(emptyJournal, [clientTopUp(at('t1'), owner, hundredThousand)]);
    expect(withCode(checkLedgerInvariants(journal), InvariantCode.entryUnbalanced)).toEqual([]);
  });
});

describe('обеспечение невостребованных средств', () => {
  /**
   * §3.1: деньги, признанные чужими, уходят с номинального счёта и выпадают из
   * основного отношения покрытия. Если за ними не стоит ни операционный
   * остаток, ни транзит, они не обеспечены ничем — и это обязано быть видно
   * своим кодом, а не «где-то в общем покрытии».
   */
  it('reports unclaimed money that nothing stands behind', () => {
    const journal = unguardedJournal([
      uncheckedEntry({
        id: 'unclaimed-1',
        occurredAt: BASE,
        kind: 'settlement',
        memoKey: 'ledger.entry.unclaimed',
        postings: [
          debit(clientLockedAccount(owner, deal.dealId, deal.trancheId), hundredThousand, deal),
          credit(unclaimedLiability, hundredThousand),
        ],
      }),
    ]);

    expect(withCode(checkLedgerInvariants(journal), InvariantCode.unclaimedUncovered)).toEqual([
      {
        code: InvariantCode.unclaimedUncovered,
        currency: 'GEL',
        subject: 'unclaimed',
        amountMinor: -100_000n,
      },
    ]);
  });

  it('stays silent while the transit leg still stands behind the debt', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, hundredThousand),
      lockForTranche(at('l1'), owner, deal, hundredThousand),
      writeOffUnclaimed(at('w1'), owner, deal, hundredThousand),
    ]);
    expect(withCode(checkLedgerInvariants(journal), InvariantCode.unclaimedUncovered)).toEqual([]);
  });
});

describe('перечень кодов, останавливающих приём новых сделок', () => {
  /**
   * Тот же список поимённо перечислен в базе (`v_should_stop_accepting_deals`),
   * и сверять два списка можно только значением со значением — включая
   * порядок. Поэтому здесь он выписан целиком, а не проверен «на непустоту».
   */
  it('is exactly the five codes of the coverage red line, in the order of the view', () => {
    expect([...STOP_ACCEPTING_INVARIANT_CODES]).toEqual([
      InvariantCode.coverageBelowOne,
      InvariantCode.trancheUncovered,
      InvariantCode.clientAccountUncovered,
      InvariantCode.custodySurplus,
      InvariantCode.negativeClientBalance,
    ]);
  });

  it('does not stop acceptance on a discrepancy that is not about client coverage', () => {
    // Транзит списания висит третьи сутки: расхождение для дежурного, но
    // клиентские средства покрыты, и красная линия №3 не нарушена.
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, hundredThousand),
      lockForTranche(at('l1'), owner, deal, hundredThousand),
      writeOffUnclaimed(at('w1'), owner, deal, hundredThousand),
    ]);
    const violations = checkLedgerInvariants(journal, { asOf: JUST_PAST_TWO_DAYS });
    expect(violations.map((item) => item.code)).toEqual([InvariantCode.transitStale]);
    expect(shouldStopAcceptingDeals(journal, { asOf: JUST_PAST_TWO_DAYS })).toBe(false);
  });

  it('stops acceptance on a negative client balance alone', () => {
    const journal = unguardedJournal([
      uncheckedEntry({
        id: 'spent-1',
        occurredAt: BASE,
        kind: 'settlement',
        memoKey: 'ledger.entry.refund_to_source',
        postings: [
          debit(clientFreeAccount(owner), hundredThousand, { clientKey: owner }),
          credit(bankNominal('GEL'), hundredThousand, { clientKey: owner }),
        ],
      }),
    ]);
    expect(checkLedgerInvariants(journal).map((item) => item.code)).toContain(
      InvariantCode.negativeClientBalance,
    );
    expect(shouldStopAcceptingDeals(journal)).toBe(true);
  });
});

describe('возраст позиции: где проходит граница окна', () => {
  const staleJournal = () =>
    appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, hundredThousand),
      lockForTranche(at('l1'), owner, deal, hundredThousand),
      writeOffUnclaimed(at('w1'), owner, deal, hundredThousand),
    ]);

  it('leaves a transit position alone at exactly two days', () => {
    expect(checkLedgerInvariants(staleJournal(), { asOf: TWO_DAYS_LATER })).toEqual([]);
  });

  it('reports it one millisecond later, by account and amount', () => {
    expect(checkLedgerInvariants(staleJournal(), { asOf: JUST_PAST_TWO_DAYS })).toEqual([
      {
        code: InvariantCode.transitStale,
        currency: 'GEL',
        subject: 'transit:writeoff',
        amountMinor: 100_000n,
      },
    ]);
  });

  /**
   * «Сейчас» для журнала — это момент последнего известного факта, а не
   * системные часы: так проверка остаётся чистой функцией от журнала и
   * воспроизводится через год. Умолчание проверяется здесь: без него окно не
   * считается вовсе, и ни одна позиция никогда не становится просроченной.
   */
  it('takes the latest entry as «now» when no moment is given', () => {
    const journal = appendEntries(staleJournal(), [
      clientTopUp(at('t2', JUST_PAST_TWO_DAYS), other, money('GEL', 1n)),
    ]);
    expect(checkLedgerInvariants(journal).map((item) => item.code)).toEqual([
      InvariantCode.transitStale,
    ]);
  });

  /**
   * Неразбираемая метка времени — это не «свежо»: проверка молчит и говорит об
   * этом отсутствием возраста, а не подставляет ноль. Ноль означал бы, что
   * запись с испорченной меткой становится просроченной немедленно.
   */
  it('says nothing when the moment the position opened is unreadable', () => {
    const journal = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, hundredThousand),
      lockForTranche(at('l1'), owner, deal, hundredThousand),
      writeOffUnclaimed(at('w1', 'когда-то'), owner, deal, hundredThousand),
    ]);
    expect(checkLedgerInvariants(journal, { asOf: JUST_PAST_TWO_DAYS })).toEqual([]);
  });
});

describe('возраст открытой позиции по обмену', () => {
  const rates = fxRates('USD', 'GEL', {
    client: rationalFromDecimalString('2.6686875'),
    reference: rationalFromDecimalString('2.6875'),
    official: rationalFromDecimalString('2.7000'),
  });
  const converted = convert(money('USD', 8_000_000n), rates, isoDate('2026-09-03'), 'trunc');
  const exchange = fxExecution('x1', converted);
  const openJournal = () =>
    appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, money('USD', 8_000_000n)),
      sendForConversion(at('c1'), owner, exchange),
    ]);

  it('is not a discrepancy at exactly two days', () => {
    expect(checkLedgerInvariants(openJournal(), { asOf: TWO_DAYS_LATER })).toEqual([]);
  });

  it('becomes one a millisecond later, named by the account of that client', () => {
    expect(checkLedgerInvariants(openJournal(), { asOf: JUST_PAST_TWO_DAYS })).toEqual([
      {
        code: InvariantCode.fxPositionOpen,
        currency: 'USD',
        subject: accountCode(fxSettlement(owner, 'x1')),
        amountMinor: 8_000_000n,
      },
    ]);
  });
});

describe('возраст требования по начисленной комиссии', () => {
  const accruedJournal = () =>
    appendEntries(emptyJournal, [accrueFee(at('f1'), deal, money('GEL', 2_000n), 'tariff-1')]);

  it('is legal at exactly the window', () => {
    expect(checkLedgerInvariants(accruedJournal(), { asOf: TWO_DAYS_LATER })).toEqual([]);
  });

  it('becomes a discrepancy a millisecond later, by deal and tranche', () => {
    expect(checkLedgerInvariants(accruedJournal(), { asOf: JUST_PAST_TWO_DAYS })).toEqual([
      {
        code: InvariantCode.feeReceivableStale,
        currency: 'GEL',
        subject: 'd1:t1',
        amountMinor: 2_000n,
      },
    ]);
  });

  it('uses its own window when one is given', () => {
    expect(
      checkLedgerInvariants(accruedJournal(), {
        asOf: JUST_PAST_TWO_DAYS,
        feeStaleAfterMs: 7 * 24 * 60 * 60 * 1000,
      }),
    ).toEqual([]);
  });
});

describe('профицит довнесения считается только по выросшим файлам', () => {
  /**
   * Прирост файла — строгое неравенство: файл, который в записи не вырос,
   * довнесением не финансировался, и складывать по нему нечего. Разница видна
   * там, где признание недостачи снято, а самого признания в журнале нет
   * (журнал из базы): признанное по клиенту уходит в минус, и нулевой прирост,
   * попав в довнесённое, превратился бы в профицит из ничего.
   */
  it('does not turn a zero gain into an overfunded shortfall', () => {
    const journal = unguardedJournal([
      uncheckedEntry({
        id: 'reversal-1',
        occurredAt: BASE,
        kind: 'correction',
        correctsEntryId: 'missing-recognition',
        memoKey: 'ledger.entry.shortfall_absorbed',
        postings: [
          credit(shortfallExpense, money('GEL', 100n), { clientKey: owner }),
          debit(bankOperating('GEL'), money('GEL', 100n)),
          debit(bankNominal('GEL'), money('GEL', 50n), { clientKey: owner }),
          credit(bankNominal('GEL'), money('GEL', 50n), { clientKey: owner }),
        ],
      }),
    ]);

    expect(withCode(checkLedgerInvariants(journal), InvariantCode.shortfallOverfunded)).toEqual([]);
  });
});
