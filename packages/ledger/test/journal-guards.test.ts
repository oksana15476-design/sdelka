import { convert, fxRates, isoDate, money, rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type Journal,
  type JournalEntry,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  accountCode,
  accrueFee,
  appendEntries,
  appendEntry,
  bankNominal,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  clientTopUp,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  feeAccrualFor,
  feeReceivable,
  fxExecution,
  fxSettlement,
  lockForTranche,
  sendForConversion,
  settleTrancheToClientAccount,
  transitFee,
  trancheSettlement,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';

/**
 * Правила журнала — те, которым нужна история, а не одна запись.
 *
 * Мутационный прогон нашёл здесь три пробела:
 *
 *  · проверка «запись — это запись целиком» не проверялась ни одним тестом:
 *    все пять полей можно было снести, и негодная запись доходила до правил,
 *    которые падали на ней `TypeError` без кода и без имени поля;
 *  · переиспользование ключа конверсии проверялось только целиком совпавшим
 *    объявлением: подмена «или» на «и» в обеих сверках (пара валют и размер
 *    ног) не роняла ничего, то есть обмен с **одной** изменённой стороной
 *    проходил под старым ключом;
 *  · «расчёт отматывается один раз» не отличало реверс расчёта от исправления,
 *    которое клиентское обязательство не двигает вовсе, — а именно это
 *    различие правило и обещает.
 */

const owner = clientKey('c1');
const recipient = clientKey('c2');
const deal = { dealId: 'd1', trancheId: 't1' };
const hundredThousand = money('GEL', 100_000n);
const fee = money('GEL', 2_000n);

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-03T10:${String(minute).padStart(2, '0')}:00Z` };
}

function expectFailure(
  run: () => unknown,
  code: LedgerErrorCodeType,
  details?: Readonly<Record<string, string>>,
): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
    if (details !== undefined) {
      expect((error as LedgerError).details).toMatchObject(details);
    }
  }
}

describe('запись обязана быть записью целиком', () => {
  const sound = clientTopUp(at('t1'), owner, hundredThousand);
  const broken = (patch: Record<string, unknown>): JournalEntry =>
    ({ ...sound, ...patch }) as unknown as JournalEntry;

  it('names the field that is missing or of the wrong kind', () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ id: 42 }, 'id'],
      [{ id: '' }, 'id'],
      [{ occurredAt: undefined }, 'occurredAt'],
      [{ kind: 'whatever' }, 'kind'],
      [{ postings: 'two' }, 'postings'],
      [{ memoKey: undefined }, 'memoKey'],
      [{ correctsEntryId: undefined }, 'correctsEntryId'],
      [{ settles: undefined }, 'settles'],
      [{ converts: undefined }, 'converts'],
      [{ accrues: undefined }, 'accrues'],
      [{ funds: undefined }, 'funds'],
    ];
    for (const [patch, field] of cases) {
      expectFailure(
        () => appendEntry(emptyJournal, broken(patch)),
        LedgerErrorCode.journalEntryMalformed,
        { field },
      );
    }
  });

  /**
   * Идентификатор в деталях — пустая строка, а не само негодное значение:
   * детали ошибки объявлены строками, и подставлять туда число значило бы
   * отдавать наружу значение, форму которого мы только что отвергли.
   */
  it('does not put a non-string identifier into the details', () => {
    try {
      appendEntry(emptyJournal, broken({ id: 42 }));
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).details).toEqual({ id: '', field: 'id' });
    }
  });

  it('accepts a sound entry', () => {
    expect(appendEntry(emptyJournal, sound).entries).toHaveLength(1);
  });
});

describe('ключ конверсии называет один обмен', () => {
  const rates = fxRates('USD', 'GEL', {
    client: rationalFromDecimalString('2.6686875'),
    reference: rationalFromDecimalString('2.6875'),
    official: rationalFromDecimalString('2.7000'),
  });
  const eightyThousand = money('USD', 8_000_000n);
  const converted = convert(eightyThousand, rates, isoDate('2026-09-03'), 'trunc');
  const opened = () =>
    appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, eightyThousand),
      sendForConversion(at('c1', 1), owner, fxExecution('x1', converted)),
    ]);

  /** Вторая нога того же ключа — та же пара валют, не больше первоначальных. */
  const secondLeg = (id: string, declaration: ReturnType<typeof fxExecution>): JournalEntry =>
    createJournalEntry({
      ...at(id, 2),
      kind: 'settlement',
      memoKey: 'ledger.entry.fx_sent_for_conversion',
      converts: declaration,
      postings: [
        credit(bankNominal('USD'), eightyThousand, { clientKey: owner }),
        debit(fxSettlement(owner, 'x1'), eightyThousand, { clientKey: owner }),
      ],
    });

  it('refuses a second declaration whose target leg alone grew', () => {
    // Исходная нога та же, встречная больше: обмен не тот, а ключ старый.
    // Сверяются обе стороны по отдельности — иначе под тем же ключом можно
    // объявить любую встречную сумму, лишь бы исходная совпала.
    const richer = convert(
      eightyThousand,
      fxRates('USD', 'GEL', {
        client: rationalFromDecimalString('3.0000'),
        reference: rationalFromDecimalString('3.1000'),
        official: rationalFromDecimalString('3.2000'),
      }),
      isoDate('2026-09-03'),
      'trunc',
    );
    expect(richer.target.minor).toBeGreaterThan(converted.target.minor);
    expectFailure(
      () => appendEntry(opened(), secondLeg('c2', fxExecution('x1', richer))),
      LedgerErrorCode.journalConversionKeyReused,
      { account: accountCode(fxSettlement(owner, 'x1')), reason: 'legs_exceed_opening' },
    );
  });

  it('refuses a second declaration whose target currency alone changed', () => {
    const toEuro = convert(
      eightyThousand,
      fxRates('USD', 'EUR', {
        client: rationalFromDecimalString('0.9000'),
        reference: rationalFromDecimalString('0.9100'),
        official: rationalFromDecimalString('0.9200'),
      }),
      isoDate('2026-09-03'),
      'trunc',
    );
    expectFailure(
      () => appendEntry(opened(), secondLeg('c3', fxExecution('x1', toEuro))),
      LedgerErrorCode.journalConversionKeyReused,
      { reason: 'currency_pair' },
    );
  });

  it('accepts an under-delivery declared honestly under the same key', () => {
    const smaller = convert(money('USD', 4_000_000n), rates, isoDate('2026-09-03'), 'trunc');
    const journal = appendEntry(
      opened(),
      createJournalEntry({
        ...at('c4', 2),
        kind: 'settlement',
        memoKey: 'ledger.entry.fx_sent_for_conversion',
        converts: fxExecution('x1', smaller),
        postings: [
          credit(bankNominal('USD'), money('USD', 4_000_000n), { clientKey: owner }),
          debit(fxSettlement(owner, 'x1'), money('USD', 4_000_000n), { clientKey: owner }),
        ],
      }),
    );
    expect(journal.entries).toHaveLength(3);
  });
});

describe('исправление — зеркало своей цели', () => {
  /**
   * Сообщение обязано называть **сколько** двинуло исправление и сколько
   * двинула цель: без знака этих величин дежурный не отличит «отматывают не в
   * ту сторону» от «отматывают слишком много».
   */
  it('reports the movement of the correction and of its target with their signs', () => {
    const topUp = clientTopUp(at('t1'), owner, hundredThousand);
    const journal = appendEntry(emptyJournal, topUp);
    const sameWayAgain = createJournalEntry({
      ...at('x1', 1),
      kind: 'correction',
      correctsEntryId: topUp.id,
      memoKey: 'ledger.entry.client_top_up',
      postings: [
        debit(bankNominal('GEL'), hundredThousand, { clientKey: owner }),
        credit(clientFreeAccount(owner), hundredThousand, { clientKey: owner }),
      ],
    });
    expectFailure(
      () => appendEntry(journal, sameWayAgain),
      LedgerErrorCode.journalCorrectionNotMirror,
      {
        account: 'bank:nominal:gel',
        file: owner,
        reason: 'same_direction',
        moved: '100000',
        target: '100000',
      },
    );
  });
});

describe('расчёт отматывается один раз', () => {
  const settled = (): { journal: Journal; settlement: JournalEntry } => {
    const base = appendEntries(emptyJournal, [
      clientTopUp(at('t1'), owner, hundredThousand),
      lockForTranche(at('l1', 1), owner, deal, hundredThousand),
      accrueFee(at('f1', 2), deal, fee, 'tariff-1'),
    ]);
    const accrual = feeAccrualFor(base, deal);
    const settlement = settleTrancheToClientAccount(
      at('s1', 3),
      trancheSettlement(deal, owner, recipient, attestDealParties(deal, owner, recipient)),
      hundredThousand,
      accrual,
    );
    return { journal: appendEntry(base, settlement), settlement };
  };

  /** Частичный реверс: обязательство возвращается плательщику, комиссия — нет. */
  const partialReversal = (target: JournalEntry, id: string): JournalEntry => {
    const settles = target.settles;
    if (settles === null) throw new Error('цель не расчёт');
    return createJournalEntry({
      ...at(id, 4),
      kind: 'correction',
      correctsEntryId: target.id,
      memoKey: 'ledger.entry.tranche_settlement_reversed',
      settles,
      postings: [
        credit(clientLockedAccount(owner, deal.dealId, deal.trancheId), hundredThousand, deal),
        debit(bankNominal('GEL'), hundredThousand, deal),
      ],
    });
  };

  /** Возврат одного лишь требования по комиссии: клиентских денег не касается. */
  const feeOnlyCorrection = (target: JournalEntry, id: string): JournalEntry =>
    createJournalEntry({
      ...at(id, 5),
      kind: 'correction',
      correctsEntryId: target.id,
      memoKey: 'ledger.entry.fee_accrual_reversed',
      postings: [debit(feeReceivable, fee, deal), credit(transitFee, fee, deal)],
    });

  /**
   * Признак реверса — объявление расчёта на исправлении. Исправление **без**
   * объявления клиентское обязательство не двигает и вторым реверсом не
   * является: его ограничивает свой предел — вернуть больше, чем цель сняла,
   * нельзя.
   */
  it('lets a fee-only correction follow a reversal', () => {
    const { journal, settlement } = settled();
    const afterReversal = appendEntry(journal, partialReversal(settlement, 'x1'));
    const afterFee = appendEntry(afterReversal, feeOnlyCorrection(settlement, 'x2'));
    expect(afterFee.entries).toHaveLength(6);
  });

  it('lets a reversal follow a fee-only correction', () => {
    const { journal, settlement } = settled();
    const afterFee = appendEntry(journal, feeOnlyCorrection(settlement, 'x2'));
    const afterReversal = appendEntry(afterFee, partialReversal(settlement, 'x1'));
    expect(afterReversal.entries).toHaveLength(6);
  });

  it('still refuses a second reversal of the same settlement', () => {
    const { journal, settlement } = settled();
    const once = appendEntry(journal, partialReversal(settlement, 'x1'));
    expectFailure(
      () => appendEntry(once, partialReversal(settlement, 'x3')),
      LedgerErrorCode.journalSettlementReversedTwice,
      { correctsEntryId: settlement.id, reversedBy: 'x1', dealId: 'd1', trancheId: 't1' },
    );
  });
});
