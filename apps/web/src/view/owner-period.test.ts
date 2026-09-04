import { describe, expect, it } from 'vitest';
import {
  type DealPartiesAttestation,
  type Journal,
  type JournalEntry,
  type TrancheRef,
  absorbShortfall,
  accrueFee,
  appendEntries,
  bankNominal,
  bankOperating,
  clientFreeAccount,
  clientLockedAccount,
  clientKey,
  clientTopUp,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  executeConversion,
  fxAccountingDiff,
  feePositions,
  fxExecution,
  identifySuspense,
  lockForTranche,
  receiveConversion,
  receiveFee,
  refundToSourceAccount,
  reverseTrancheSettlement,
  sendForConversion,
  settleTrancheToClientAccount,
  trancheSettlement,
  unlockToClientAccount,
  writeOffUnclaimed,
} from '@sdelka/ledger';
import {
  type CurrencyCode,
  type Money,
  convert,
  convertAtRate,
  fxRate,
  fxRates,
  isoDate,
  money,
  platformSpread,
  rationalFromDecimalString,
} from '@sdelka/money';
import {
  type JournalPeriod,
  type OfficialRateLookup,
  SIGNIFICANCE_WINDOW_MONTHS,
  periodJournalSummary,
  significanceApproach,
} from './owner-period';
import { SIGNIFICANCE_THRESHOLD } from './owner-economics';
import { listOwnerDeals, ownerJournal } from '@/fixtures/owner';

/**
 * Сводка проверяется **против журнала**, а не против чисел, выписанных рядом:
 * каждый сценарий строится словарём `@sdelka/ledger` и проходит `appendEntry`,
 * то есть все правила журнала. Сети здесь нет ни в одном тесте и быть не может
 * (`CLAUDE.md`, QA): мок платёжного провайдера ни разу не понадобился.
 *
 * Тавтологии («сложили и проверили, что сложилось») здесь тоже нет: у каждой
 * величины есть сценарий, где она **отличается от соседней** — начислено от
 * удержанного, удержанное от полученного, наш спред от учётной курсовой
 * разницы, принятый оборот от расчитанного.
 */

const PAYER = clientKey('payer');
// Ключ клиента — ключ личности, а не роли в сделке: одна и та же личность
// бывает плательщиком в одной сделке и получателем в другой (§2.1).
const RECIPIENT = clientKey('recipient');
const TARIFF = 'tariff-v1';

const JUNE: JournalPeriod = { from: Date.UTC(2026, 5, 1), to: Date.UTC(2026, 6, 1) };
const MAY: JournalPeriod = { from: Date.UTC(2026, 4, 1), to: Date.UTC(2026, 5, 1) };

/** Момент июня. Все сценарии живут внутри одного месяца, кроме тех, где сказано иначе. */
function at(day: number, hour = 12): string {
  return new Date(Date.UTC(2026, 5, day, hour)).toISOString();
}

function meta(id: string, day: number, hour = 12): { id: string; occurredAt: string } {
  return { id, occurredAt: at(day, hour) };
}

function tranche(id: string): TrancheRef {
  return { dealId: id, trancheId: `${id}-t1` };
}

function gel(minor: bigint): Money<'GEL'> {
  return money('GEL', minor);
}

/**
 * Подтверждение сторон берётся приведением типа — единственным способом, каким
 * его получает и домен (`packages/domain/src/tranche.ts`, там же объяснено,
 * почему приведение неизбежно).
 *
 * Здесь это законно ровно потому, что проверяется **проекция журнала**, а не
 * красная линия №1: её проверяет `packages/e2e/test/red-lines.test.ts`, где
 * подтверждение снимается с автомата и подделать его нечем.
 */
function attested(ref: TrancheRef): DealPartiesAttestation {
  return {
    dealId: ref.dealId,
    trancheId: ref.trancheId,
    payer: PAYER,
    recipient: RECIPIENT,
    evidenceRef: `evidence-${ref.dealId}`,
  } as unknown as DealPartiesAttestation;
}

function settlementOf(ref: TrancheRef) {
  return trancheSettlement(ref, PAYER, RECIPIENT, attested(ref));
}

function journalOf(entries: readonly JournalEntry[]): Journal {
  return appendEntries(emptyJournal, entries);
}

/** Деньги пришли и заперты под транш: два события, один и тот же лари. */
function funded(id: string, day: number, amount: Money<CurrencyCode>): readonly JournalEntry[] {
  const ref = tranche(id);
  return [
    clientTopUp(meta(`${id}-in`, day), PAYER, amount),
    lockForTranche(meta(`${id}-lock`, day, 13), PAYER, ref, amount),
  ];
}

function expenseEntry(
  id: string,
  day: number,
  kind: 'oracle_cost_expense' | 'psp_fee_expense',
  ref: TrancheRef,
  amount: Money<CurrencyCode>,
): JournalEntry {
  return createJournalEntry({
    ...meta(id, day),
    kind: 'settlement',
    memoKey: `ledger.entry.${kind}`,
    postings: [
      debit({ kind } as const, amount, ref),
      credit(bankOperating(amount.currency), amount, ref),
    ],
  });
}

function currencyOf(summary: ReturnType<typeof periodJournalSummary>, code: CurrencyCode) {
  return summary.byCurrency.find((item) => item.currency === code);
}

/* ------------------------------------------------- комиссия: три величины */

/**
 * Три сделки, три разные судьбы комиссии. Числа подобраны так, что совпасть
 * они не могут: начислено 1000, удержано 500, получено 300.
 */
function feeWorld(): Journal {
  const held = tranche('held');
  const paid = tranche('paid');
  const stuck = tranche('stuck');
  const heldFee = accrueFee(meta('held-fee', 4), held, gel(500n), TARIFF);
  const paidFee = accrueFee(meta('paid-fee', 5), paid, gel(300n), TARIFF);
  const stuckFee = accrueFee(meta('stuck-fee', 6), stuck, gel(200n), TARIFF);
  return journalOf([
    // Начислено и не удержано: расчёта не было вовсе.
    ...funded('held', 2, gel(100_000n)),
    heldFee,
    // Начислено, удержано, получено.
    ...funded('paid', 3, gel(100_000n)),
    paidFee,
    settleTrancheToClientAccount(meta('paid-set', 7), settlementOf(paid), gel(100_000n), paidFee),
    receiveFee(meta('paid-got', 8), paid, gel(300n)),
    // Удержано, но перевод между банками ещё не дошёл.
    ...funded('stuck', 3, gel(100_000n)),
    stuckFee,
    settleTrancheToClientAccount(meta('stuck-set', 9), settlementOf(stuck), gel(100_000n), stuckFee),
  ]);
}

describe('сводка за период: комиссия', () => {
  it('начислено, удержано и получено — три разных числа, а не одно в трёх местах', () => {
    const slice = currencyOf(periodJournalSummary(feeWorld(), JUNE), 'GEL');
    expect(slice?.fee.accrued.minor).toBe(1_000n);
    expect(slice?.fee.withheld.minor).toBe(500n);
    expect(slice?.fee.received.minor).toBe(300n);
  });

  it('начисленная комиссия — та же величина, что строка выручки fee:income', () => {
    const slice = currencyOf(periodJournalSummary(feeWorld(), JUNE), 'GEL');
    const line = slice?.revenue.find((item) => item.kind === 'fee_income');
    expect(line?.amount.minor).toBe(slice?.fee.accrued.minor);
  });

  it('период после расчётов: получено есть, начислено нет — величины не переезжают', () => {
    // Окно с одним лишь приходом комиссии на операционный счёт: начисление и
    // удержание остались в июне. Если бы три величины считались из одного
    // счёта, здесь совпали бы все три.
    const journal = feeWorld();
    const window: JournalPeriod = { from: Date.UTC(2026, 5, 8), to: Date.UTC(2026, 5, 9) };
    const slice = currencyOf(periodJournalSummary(journal, window), 'GEL');
    expect(slice?.fee.received.minor).toBe(300n);
    expect(slice?.fee.accrued.minor).toBe(0n);
    expect(slice?.fee.withheld.minor).toBe(0n);
  });
});

/* --------------------------------------------- оборот принятых средств */

describe('сводка за период: оборот принятых средств', () => {
  it('запирание под транш и расчёт того же лари оборот не удваивают', () => {
    const ref = tranche('one');
    const fee = accrueFee(meta('one-fee', 5), ref, gel(300n), TARIFF);
    const journal = journalOf([
      ...funded('one', 2, gel(100_000n)),
      fee,
      settleTrancheToClientAccount(meta('one-set', 6), settlementOf(ref), gel(100_000n), fee),
      receiveFee(meta('one-got', 7), ref, gel(300n)),
    ]);
    const slice = currencyOf(periodJournalSummary(journal, JUNE), 'GEL');
    // Пришло сто тысяч один раз — сколько бы записей их потом ни двигало.
    expect(slice?.intake.minor).toBe(100_000n);
    expect(slice?.outcomes.settled.minor).toBe(100_000n);
  });

  it('возврат оборот не уменьшает: деньги были приняты, и это отдельный факт', () => {
    const ref = tranche('back');
    const journal = journalOf([
      ...funded('back', 2, gel(100_000n)),
      unlockToClientAccount(meta('back-unlock', 4), PAYER, ref, gel(100_000n)),
      refundToSourceAccount(meta('back-out', 5), PAYER, gel(100_000n)),
    ]);
    const slice = currencyOf(periodJournalSummary(journal, JUNE), 'GEL');
    expect(slice?.intake.minor).toBe(100_000n);
    expect(slice?.outcomes.refunded.minor).toBe(100_000n);
  });

  it('исправление ошибочного зачисления оборот уменьшает', () => {
    const topUp = clientTopUp(meta('bad', 2), PAYER, gel(100_000n));
    const journal = journalOf([
      topUp,
      createJournalEntry({
        ...meta('bad-fix', 3),
        kind: 'correction',
        correctsEntryId: topUp.id,
        memoKey: 'ledger.entry.client_top_up_reversed',
        postings: [
          debit(clientFreeAccount(PAYER), gel(100_000n), { clientKey: PAYER }),
          credit(bankNominal('GEL'), gel(100_000n), { clientKey: PAYER }),
        ],
      }),
    ]);
    expect(currencyOf(periodJournalSummary(journal, JUNE), 'GEL')?.intake.minor).toBe(0n);
  });

  it('опознание непознанного поступления оборот не удваивает', () => {
    // Пул непознанных — тоже обязательство перед клиентом (пусть и без имени
    // клиента), поэтому опознание переносит долг, а не создаёт второй.
    const journal = journalOf([
      createJournalEntry({
        ...meta('unknown', 2),
        kind: 'settlement',
        memoKey: 'ledger.entry.unidentified_receipt',
        postings: [
          debit(bankNominal('GEL'), gel(100_000n)),
          credit({ kind: 'suspense_unidentified' } as const, gel(100_000n)),
        ],
      }),
      identifySuspense(meta('known', 3), PAYER, gel(100_000n)),
    ]);
    expect(currencyOf(periodJournalSummary(journal, JUNE), 'GEL')?.intake.minor).toBe(100_000n);
  });

  it('недостача: принято столько, сколько признано долгом перед клиентом', () => {
    // Плательщик отправил 100 000, дошло 99 000, разницу приняла на себя
    // платформа. Оборот принятых средств — брутто (обязательство перед
    // клиентом), расход — недостача. Что считать «объёмом операции» для
    // регулятора — вопрос открытый, и здесь закреплена строгая сторона.
    const journal = journalOf([
      absorbShortfall(meta('short', 2), PAYER, gel(99_000n), gel(1_000n)),
    ]);
    const slice = currencyOf(periodJournalSummary(journal, JUNE), 'GEL');
    expect(slice?.intake.minor).toBe(100_000n);
    expect(slice?.expenses.find((line) => line.kind === 'shortfall_expense')?.amount.minor).toBe(
      1_000n,
    );
  });
});

/* --------------------------------------------------------------- исходы */

describe('сводка за период: исходы по траншам', () => {
  function outcomeWorld(): Journal {
    const settled = tranche('s');
    const refunded = tranche('r');
    const written = tranche('w');
    const fee = accrueFee(meta('s-fee', 5), settled, gel(400n), TARIFF);
    return journalOf([
      ...funded('s', 2, gel(200_000n)),
      fee,
      settleTrancheToClientAccount(meta('s-set', 6), settlementOf(settled), gel(200_000n), fee),
      ...funded('r', 3, gel(100_000n)),
      unlockToClientAccount(meta('r-unlock', 7), PAYER, refunded, gel(100_000n)),
      ...funded('w', 4, gel(50_000n)),
      writeOffUnclaimed(meta('w-off', 8), PAYER, written, gel(50_000n)),
    ]);
  }

  it('расчёт, возврат и списание считаются по отдельности', () => {
    const summary = periodJournalSummary(outcomeWorld(), JUNE);
    expect(summary.outcomes.settled).toEqual({ deals: 1, tranches: 1 });
    expect(summary.outcomes.refunded).toEqual({ deals: 1, tranches: 1 });
    expect(summary.outcomes.written_off).toEqual({ deals: 1, tranches: 1 });
    expect(summary.unclassifiedOutflows).toEqual([]);
    const slice = currencyOf(summary, 'GEL');
    expect(slice?.outcomes.settled.minor).toBe(200_000n);
    expect(slice?.outcomes.refunded.minor).toBe(100_000n);
    expect(slice?.outcomes.written_off.minor).toBe(50_000n);
  });

  it('отмотанный расчёт исходом не считается, но и не исчезает', () => {
    const ref = tranche('rollback');
    const fee = accrueFee(meta('rb-fee', 5), ref, gel(300n), TARIFF);
    const settlement = settleTrancheToClientAccount(
      meta('rb-set', 6),
      settlementOf(ref),
      gel(100_000n),
      fee,
    );
    const journal = journalOf([
      ...funded('rollback', 2, gel(100_000n)),
      fee,
      settlement,
      reverseTrancheSettlement(meta('rb-undo', 7), settlement),
    ]);
    const summary = periodJournalSummary(journal, JUNE);
    expect(summary.outcomes.settled).toEqual({ deals: 0, tranches: 0 });
    expect(summary.settlementsReversed).toBe(1);
    expect(currencyOf(summary, 'GEL')?.outcomes.settled.minor).toBe(0n);
  });

  it('деньги ушли из транша неизвестным способом — исход назван по имени записи', () => {
    // Форма, которой словарь не знает: запертая часть опустела, встречной ноги
    // ни одного из трёх исходов нет. Посчитать такую запись нулём значит
    // потерять деньги в сводке молча.
    const ref = tranche('odd');
    const journal = journalOf([
      ...funded('odd', 2, gel(70_000n)),
      createJournalEntry({
        ...meta('odd-out', 5),
        kind: 'settlement',
        memoKey: 'ledger.entry.unknown_shape',
        postings: [
          debit(clientLockedAccount(PAYER, ref.dealId, ref.trancheId), gel(70_000n), ref),
          credit(bankNominal('GEL'), gel(70_000n), ref),
        ],
      }),
    ]);
    const summary = periodJournalSummary(journal, JUNE);
    expect(summary.unclassifiedOutflows).toEqual(['odd-out']);
    expect(summary.outcomes.settled.tranches).toBe(0);
    expect(summary.outcomes.refunded.tranches).toBe(0);
    expect(summary.outcomes.written_off.tranches).toBe(0);
  });

  it('реверс в следующем месяце снимает исход и в прошлом: сводка отвечает, как было', () => {
    const ref = tranche('late');
    const fee = accrueFee(meta('late-fee', 5), ref, gel(300n), TARIFF);
    const settlement = settleTrancheToClientAccount(
      meta('late-set', 6),
      settlementOf(ref),
      gel(100_000n),
      fee,
    );
    const undo = reverseTrancheSettlement(
      { id: 'late-undo', occurredAt: new Date(Date.UTC(2026, 6, 3, 12)).toISOString() },
      settlement,
    );
    const journal = journalOf([...funded('late', 2, gel(100_000n)), fee, settlement, undo]);
    const summary = periodJournalSummary(journal, JUNE);
    expect(summary.outcomes.settled.tranches).toBe(0);
    // Сам реверс в июнь не попал: он июльская запись.
    expect(summary.settlementsReversed).toBe(0);
  });
});

/* ------------------------------------------- выручка, расходы, результат */

describe('сводка за период: спред, учётная разница и результат', () => {
  const USD_GEL = fxRates('USD', 'GEL', {
    client: rationalFromDecimalString('2.6544'),
    reference: rationalFromDecimalString('2.6731'),
    official: rationalFromDecimalString('2.7104'),
  });
  const CONVERTED = convert(money('USD', 1_000_000n), USD_GEL, isoDate('2026-06-05'), 'trunc');
  const EXECUTION = fxExecution('cx1', CONVERTED);
  const SPREAD = platformSpread(CONVERTED, 'trunc');

  function conversionWorld(): Journal {
    return journalOf([
      clientTopUp(meta('fx-in', 4), PAYER, money('USD', 1_000_000n)),
      sendForConversion(meta('fx-send', 5), PAYER, EXECUTION),
      executeConversion(meta('fx-exec', 5, 13), PAYER, EXECUTION),
      receiveConversion(meta('fx-recv', 5, 14), PAYER, EXECUTION, SPREAD),
      // Учётная курсовая разница по официальному курсу: другой показатель и
      // другой счёт (§4.5). Платим её со своего операционного счёта.
      createJournalEntry({
        ...meta('fx-diff', 6),
        kind: 'settlement',
        memoKey: 'ledger.entry.fx_accounting_diff',
        postings: [
          debit(fxAccountingDiff, gel(1_500n)),
          credit(bankOperating('GEL'), gel(1_500n)),
        ],
      }),
    ]);
  }

  it('наш спред стоит в выручке, учётная разница — рядом и не в результате', () => {
    const slice = currencyOf(periodJournalSummary(conversionWorld(), JUNE), 'GEL');
    expect(slice?.revenueByLeg.conversion.minor).toBe(SPREAD.amount.minor);
    expect(slice?.accountingFxDifference.minor).toBe(1_500n);
    // Две величины не равны и не сложены: результат — это выручка минус прямые
    // расходы, курсовая разница в него не входит ни знаком, ни суммой.
    expect(slice?.accountingFxDifference.minor).not.toBe(slice?.revenueByLeg.conversion.minor);
    expect(slice?.result.minor).toBe(SPREAD.amount.minor);
  });

  it('конвертация не создаёт принятого оборота во встречной валюте', () => {
    const summary = periodJournalSummary(conversionWorld(), JUNE);
    expect(currencyOf(summary, 'USD')?.intake.minor).toBe(1_000_000n);
    // Лари появились на номинальном счёте, но приняты они не были: это те же
    // деньги клиента в другой валюте.
    expect(currencyOf(summary, 'GEL')?.intake.minor).toBe(0n);
  });

  it('результат — выручка минус прямые расходы, все три расхода в нём', () => {
    const ref = tranche('cost');
    const fee = accrueFee(meta('cost-fee', 5), ref, gel(1_000n), TARIFF);
    const journal = journalOf([
      ...funded('cost', 2, gel(100_000n)),
      fee,
      settleTrancheToClientAccount(meta('cost-set', 6), settlementOf(ref), gel(100_000n), fee),
      expenseEntry('cost-x1', 6, 'oracle_cost_expense', ref, gel(200n)),
      expenseEntry('cost-x2', 6, 'psp_fee_expense', ref, gel(150n)),
      absorbShortfall(meta('cost-x3', 7), PAYER, gel(9_950n), gel(50n)),
    ]);
    const slice = currencyOf(periodJournalSummary(journal, JUNE), 'GEL');
    expect(slice?.expensesTotal.minor).toBe(400n);
    expect(slice?.revenueTotal.minor).toBe(1_000n);
    expect(slice?.result.minor).toBe(600n);
  });
});

/* ------------------------------------------------------- крайние случаи */

describe('сводка за период: крайние случаи', () => {
  it('пустой период — ноль и период, а не пустой экран', () => {
    const summary = periodJournalSummary(feeWorld(), MAY);
    expect(summary.entries).toBe(0);
    expect(summary.byCurrency).toEqual([]);
    expect(summary.outcomes.settled).toEqual({ deals: 0, tranches: 0 });
    expect(summary.period).toEqual({ from: MAY.from, to: MAY.to });
  });

  it('валюта без операций строки не даёт: нулевая строка — это утверждение', () => {
    const summary = periodJournalSummary(feeWorld(), JUNE);
    expect(summary.byCurrency.map((item) => item.currency)).toEqual(['GEL']);
    expect(currencyOf(summary, 'EUR')).toBeUndefined();
  });

  it('запись с нечитаемой датой названа по имени, а не растворена в периоде', () => {
    const journal = journalOf([
      clientTopUp(meta('good', 2), PAYER, gel(100_000n)),
      clientTopUp({ id: 'nodate', occurredAt: 'вчера' }, PAYER, gel(700_000n)),
    ]);
    const summary = periodJournalSummary(journal, JUNE);
    expect(summary.undated).toEqual(['nodate']);
    expect(summary.entries).toBe(1);
    expect(currencyOf(summary, 'GEL')?.intake.minor).toBe(100_000n);
  });

  it('границы периода — полуинтервал: запись в полночь принадлежит одному месяцу', () => {
    const journal = journalOf([
      clientTopUp({ id: 'edge', occurredAt: new Date(JUNE.to).toISOString() }, PAYER, gel(1n)),
    ]);
    expect(periodJournalSummary(journal, JUNE).entries).toBe(0);
    expect(
      periodJournalSummary(journal, { from: JUNE.to, to: Date.UTC(2026, 7, 1) }).entries,
    ).toBe(1);
  });
});

/* --------------------------------------------- приближение к порогу */

const USD_OFFICIAL: Readonly<Record<string, string>> = Object.freeze({
  '2026-06-05': '2.70',
  '2026-06-06': '2.80',
});

/** Официальные курсы НБГ по дням. Дня нет в таблице — курса нет, и это `null`. */
const officialRate: OfficialRateLookup = (currency, on) => {
  if (currency !== 'USD') return null;
  const value = USD_OFFICIAL[on];
  return value === undefined ? null : fxRate('USD', 'GEL', rationalFromDecimalString(value));
};

/** Источник, который спрашивать не о чем: любой вопрос ему — уже дефект. */
const forbiddenRate: OfficialRateLookup = () => {
  throw new Error('owner-period.test.rate_asked');
};

function months(count: number): readonly JournalPeriod[] {
  return Array.from({ length: count }, (_, index) => ({
    from: Date.UTC(2026, 5 - index, 1),
    to: Date.UTC(2026, 6 - index, 1),
  }));
}

describe('приближение к порогу значимости', () => {
  it('валютный оборот считается по курсу на дату операции, а не по одному курсу на месяц', () => {
    const journal = journalOf([
      clientTopUp(meta('u1', 5), PAYER, money('USD', 1_000_000n)),
      clientTopUp(meta('u2', 6), PAYER, money('USD', 1_000_000n)),
    ]);
    const view = significanceApproach(journal, [JUNE], officialRate);
    expect(view.known).toBe(true);
    if (!view.known) return;
    // 10 000 $ по 2,70 плюс 10 000 $ по 2,80 — это 55 000 ₾, а не 54 000 и не
    // 56 000: один курс на обе даты дал бы именно их.
    expect(view.volume.minor).toBe(5_500_000n);
    expect(view.monthly.minor).toBe(5_500_000n);
    expect(view.shareBp).toBe(61);
    expect(view.headroom.minor).toBe(SIGNIFICANCE_THRESHOLD.minor - 5_500_000n);
    expect(view.warn).toBe(false);
    expect(view.crossed).toBe(false);
  });

  it('курса на дату нет — величина не посчитана, а не равна нулю', () => {
    const journal = journalOf([
      clientTopUp(meta('u1', 5), PAYER, money('USD', 1_000_000n)),
      // 7 июня курса в таблице нет.
      clientTopUp(meta('u2', 7), PAYER, money('USD', 1_000_000n)),
    ]);
    const view = significanceApproach(journal, [JUNE], officialRate);
    expect(view.known).toBe(false);
    if (view.known) return;
    expect(view.reason).toBe('missing_official_rate');
    expect(view.unpriced).toHaveLength(1);
    expect(view.unpriced[0]?.of).toBe('intake');
    expect(view.unpriced[0]?.on).toBe('2026-06-07');
    expect(view.unpriced[0]?.amount.currency).toBe('USD');
    expect(view.unpriced[0]?.amount.minor).toBe(1_000_000n);
  });

  it('лариевый оборот курса не спрашивает вовсе: пары GEL→GEL не существует', () => {
    const journal = journalOf([clientTopUp(meta('g1', 5), PAYER, gel(1_000_000n))]);
    const view = significanceApproach(journal, [JUNE], forbiddenRate);
    expect(view.known).toBe(true);
    if (!view.known) return;
    expect(view.volume.minor).toBe(1_000_000n);
  });

  it('курс не своей пары не применяется даже вручную поданный', () => {
    const journal = journalOf([clientTopUp(meta('u1', 5), PAYER, money('USD', 1_000_000n))]);
    const wrongPair: OfficialRateLookup = () =>
      fxRate('EUR', 'GEL', rationalFromDecimalString('2.90'));
    expect(() => significanceApproach(journal, [JUNE], wrongPair)).toThrow(
      'money.fx.rate_pair_mismatch',
    );
  });

  it('среднемесячный объём делится на число месяцев окна, а не на число месяцев с деньгами', () => {
    const journal = journalOf([clientTopUp(meta('g1', 5), PAYER, gel(12_000_000n))]);
    const view = significanceApproach(journal, months(SIGNIFICANCE_WINDOW_MONTHS), forbiddenRate);
    expect(view.known).toBe(true);
    if (!view.known) return;
    expect(view.months).toBe(12);
    expect(view.regulatoryWindow).toBe(true);
    expect(view.monthly.minor).toBe(1_000_000n);
  });

  it('окно короче регуляторного помечено: средняя за месяц — не средняя за год', () => {
    const view = significanceApproach(emptyJournal, [JUNE], forbiddenRate);
    expect(view.regulatoryWindow).toBe(false);
    expect(view.months).toBe(1);
  });

  it('окна нет вовсе — делителя нет, и это не ноль', () => {
    const view = significanceApproach(emptyJournal, [], forbiddenRate);
    expect(view.known).toBe(false);
    if (view.known) return;
    expect(view.reason).toBe('no_months');
  });

  it('сделок среднего размера до порога: считается из расчётов журнала', () => {
    // Два расчёта по 1 000 000 тетри (10 000 ₾) — средний размер сделки 10 000 ₾.
    // Принято 3 000 000 тетри, до порога 900 000 000 − 3 000 000 = 897 000 000,
    // то есть 897 сделок среднего размера в месяц.
    const first = tranche('d1');
    const second = tranche('d2');
    const feeOne = accrueFee(meta('d1-fee', 5), first, gel(1_000n), TARIFF);
    const feeTwo = accrueFee(meta('d2-fee', 5, 13), second, gel(1_000n), TARIFF);
    const journal = journalOf([
      ...funded('d1', 2, gel(1_000_000n)),
      ...funded('d2', 3, gel(1_000_000n)),
      clientTopUp(meta('extra', 4), PAYER, gel(1_000_000n)),
      feeOne,
      feeTwo,
      settleTrancheToClientAccount(meta('d1-set', 6), settlementOf(first), gel(1_000_000n), feeOne),
      settleTrancheToClientAccount(
        meta('d2-set', 6, 13),
        settlementOf(second),
        gel(1_000_000n),
        feeTwo,
      ),
    ]);
    const view = significanceApproach(journal, [JUNE], forbiddenRate);
    expect(view.known).toBe(true);
    if (!view.known) return;
    expect(view.settledTranches).toBe(2);
    expect(view.averageDeal?.minor).toBe(1_000_000n);
    expect(view.monthly.minor).toBe(3_000_000n);
    expect(view.dealsToThreshold).toBe(897);
  });

  it('расчётов в окне нет — среднего размера нет, и число сделок не посчитано', () => {
    const journal = journalOf([clientTopUp(meta('g1', 5), PAYER, gel(1_000_000n))]);
    const view = significanceApproach(journal, [JUNE], forbiddenRate);
    expect(view.known).toBe(true);
    if (!view.known) return;
    expect(view.averageDeal).toBeNull();
    expect(view.dealsToThreshold).toBeNull();
  });

  it('порог пройден — запас отрицательный, а сделок до порога ноль', () => {
    const journal = journalOf([clientTopUp(meta('big', 5), PAYER, gel(1_000_000_000n))]);
    const view = significanceApproach(journal, [JUNE], forbiddenRate);
    expect(view.known).toBe(true);
    if (!view.known) return;
    expect(view.crossed).toBe(true);
    expect(view.warn).toBe(true);
    expect(view.headroom.minor).toBe(SIGNIFICANCE_THRESHOLD.minor - 1_000_000_000n);
    expect(view.dealsToThreshold).toBe(0);
  });

  it('ровно порог — ещё не пройден: ст. 5(1) говорит «превышает»', () => {
    const journal = journalOf([
      clientTopUp(meta('exact', 5), PAYER, gel(SIGNIFICANCE_THRESHOLD.minor)),
    ]);
    const view = significanceApproach(journal, [JUNE], forbiddenRate);
    expect(view.known).toBe(true);
    if (!view.known) return;
    expect(view.crossed).toBe(false);
    expect(view.headroom.minor).toBe(0n);
    expect(view.shareBp).toBe(10_000);
  });
});

/* ------------------------------------------------- на настоящем журнале */

/**
 * Те же две величины — на журнале мира владельца, собранном автоматами домена
 * и словарём учёта (`fixtures/owner.ts`), а не сценарием этого файла. Сценарий
 * проверяет правило, фикстура — что правило переживает настоящий журнал: три
 * момента конвертации, комиссию в транзите, откаченную сделку и расходы,
 * проведённые задним числом.
 */
describe('сводка за период на журнале мира владельца', () => {
  const SEPTEMBER: JournalPeriod = { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1) };
  const USD_AT_OFFICIAL = fxRate('USD', 'GEL', rationalFromDecimalString('2.7104'));
  const anyDayRate: OfficialRateLookup = (currency) =>
    currency === 'USD' ? USD_AT_OFFICIAL : null;
  const noRate: OfficialRateLookup = () => null;

  it('месяц режет журнал по датам, и ни одна запись при этом не теряется', () => {
    // Журнал фикстуры начинается 31 августа и заканчивается 2 сентября: часть
    // записей в месяц не попадает, и это ровно то, что период обязан делать.
    // Сумма двух окон равна журналу — величина не потерялась и не удвоилась.
    const journal = ownerJournal();
    const august: JournalPeriod = { from: Date.UTC(2026, 7, 1), to: Date.UTC(2026, 8, 1) };
    const september = periodJournalSummary(journal, SEPTEMBER);
    const previous = periodJournalSummary(journal, august);
    expect(september.undated).toEqual([]);
    expect(previous.undated).toEqual([]);
    expect(previous.entries).toBeGreaterThan(0);
    expect(september.entries).toBeGreaterThan(previous.entries);
    expect(september.entries + previous.entries).toBe(journal.entries.length);
  });

  it('расчёты периода сходятся с оборотом сделок из экономики сделки', async () => {
    const summary = periodJournalSummary(ownerJournal(), SEPTEMBER);
    const deals = await listOwnerDeals();
    const expected = new Map<CurrencyCode, bigint>();
    for (const deal of deals) {
      for (const slice of deal.economics.byCurrency) {
        expected.set(
          slice.currency,
          (expected.get(slice.currency) ?? 0n) + slice.turnover.minor,
        );
      }
    }
    for (const slice of summary.byCurrency) {
      expect(slice.outcomes.settled.minor).toBe(expected.get(slice.currency) ?? 0n);
    }
  });

  it('комиссия периода сходится с позициями комиссии из учёта', () => {
    const journal = ownerJournal();
    const summary = periodJournalSummary(journal, SEPTEMBER);
    const positions = feePositions(journal);
    for (const slice of summary.byCurrency) {
      const own = positions.filter((item) => item.currency === slice.currency);
      const accrued = own.reduce((total, item) => total + item.accrued.minor, 0n);
      const withheld = own.reduce((total, item) => total + item.withheld.minor, 0n);
      const received = own.reduce((total, item) => total + item.received.minor, 0n);
      expect(slice.fee.accrued.minor).toBe(accrued);
      expect(slice.fee.withheld.minor).toBe(withheld);
      expect(slice.fee.received.minor).toBe(received);
    }
    // В мире владельца есть сделка с комиссией, застрявшей в транзите, —
    // значит удержано больше, чем получено, и это не совпадение чисел.
    const gelSlice = currencyOf(summary, 'GEL');
    expect(gelSlice?.fee.withheld.minor).toBeGreaterThan(gelSlice?.fee.received.minor ?? 0n);
  });

  it('валютное поступление без курса обрушает объём, а не тихо выпадает из него', () => {
    const view = significanceApproach(ownerJournal(), [SEPTEMBER], noRate);
    expect(view.known).toBe(false);
    if (view.known) return;
    expect(view.reason).toBe('missing_official_rate');
    const usd = view.unpriced.filter((item) => item.amount.currency === 'USD');
    expect(usd.length).toBeGreaterThan(0);
    expect(usd.some((item) => item.of === 'intake')).toBe(true);
  });

  it('с официальным курсом объём в лари больше лариевой ноги ровно на валютную', () => {
    const journal = ownerJournal();
    const summary = periodJournalSummary(journal, SEPTEMBER);
    const view = significanceApproach(journal, [SEPTEMBER], anyDayRate);
    expect(view.known).toBe(true);
    if (!view.known) return;
    const gelLeg = currencyOf(summary, 'GEL')?.intake.minor ?? 0n;
    const usdLeg = currencyOf(summary, 'USD')?.intake.minor ?? 0n;
    expect(usdLeg).toBeGreaterThan(0n);
    expect(view.volume.minor).toBe(
      gelLeg + convertAtRate(money('USD', usdLeg), USD_AT_OFFICIAL, 'ceil').minor,
    );
    // Порог далеко: фикстура — шесть сделок, а не девять миллионов лари в месяц.
    expect(view.crossed).toBe(false);
    expect(view.dealsToThreshold).toBeGreaterThan(0);
  });
});
