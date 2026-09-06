import { convert, fxRates, isoDate, money, rationalFromDecimalString } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type ClientKey,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  type TrancheRef,
  accountCode,
  bankNominal,
  bankOperating,
  clientFileGains,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  createJournalEntry,
  credit,
  debit,
  feeReceivable,
  fxExecution,
  fxSettlement,
  transitFee,
  trancheSettlement,
  unclaimedLiability,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';

/**
 * Проверки конструктора записи: **какая именно** ошибка и с какими деталями.
 *
 * Мутационный прогон нашёл здесь два вида пробелов. Первый: проверки, которые
 * можно снести целиком, — сверка идентификаторов расчёта и обмена, форма
 * расчёта («ни одного постороннего счёта», «направление задано», «объявление
 * применено»), сверка довнесения с его объявлением. Второй, и он дороже:
 * проверки, которые срабатывают, но **называют не то** — код ошибки и детали
 * (какой счёт, какой файл, какая сторона) подменялись без единого падения.
 * Дежурный действует по коду и по деталям, поэтому здесь утверждаются они, а
 * не факт отказа.
 */

const payer = clientKey('c1');
const recipient = clientKey('c2');
const stranger = clientKey('c3');
const deal: TrancheRef = { dealId: 'd1', trancheId: 't1' };
const neighbour: TrancheRef = { dealId: 'd1', trancheId: 't2' };
const gross = money('GEL', 100_000n);

const settles = trancheSettlement(
  deal,
  payer,
  recipient,
  attestDealParties(deal, payer, recipient),
);

const locked = clientLockedAccount(payer, deal.dealId, deal.trancheId);
const recipientFree = clientFreeAccount(recipient);
const nominal = bankNominal('GEL');

function at(id: string): { id: string; occurredAt: string } {
  return { id, occurredAt: '2026-09-03T10:00:00Z' };
}

function expectFailure(
  run: () => unknown,
  code: LedgerErrorCodeType,
  details?: Readonly<Record<string, string>>,
): LedgerError {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
    if (details !== undefined) {
      expect((error as LedgerError).details).toMatchObject(details);
    }
    return error as LedgerError;
  }
  throw new Error('unreachable');
}

describe('объявление расчёта проверяет свои идентификаторы', () => {
  it('rejects a separator in the deal, the tranche, the payer and the recipient', () => {
    const cases: readonly [TrancheRef, ClientKey, ClientKey, string][] = [
      [{ dealId: 'd:1', trancheId: 't1' }, payer, recipient, 'dealId'],
      [{ dealId: 'd1', trancheId: 't:1' }, payer, recipient, 'trancheId'],
      [deal, 'c|1' as ClientKey, recipient, 'payer'],
      [deal, payer, 'c|2' as ClientKey, 'recipient'],
    ];
    for (const [ref, from, to, field] of cases) {
      expectFailure(
        () => trancheSettlement(ref, from, to, attestDealParties(ref, from, to)),
        LedgerErrorCode.accountInvalidIdentifier,
        { field },
      );
    }
  });

  it('refuses one and the same person on both sides', () => {
    expectFailure(
      () => trancheSettlement(deal, payer, payer, attestDealParties(deal, payer, payer)),
      LedgerErrorCode.settlementSelfDealing,
      { dealId: 'd1', trancheId: 't1', clientKey: payer },
    );
  });
});

describe('объявление обмена', () => {
  const rates = fxRates('USD', 'GEL', {
    client: rationalFromDecimalString('2.6686875'),
    reference: rationalFromDecimalString('2.6875'),
    official: rationalFromDecimalString('2.7000'),
  });
  const converted = convert(money('USD', 8_000_000n), rates, isoDate('2026-09-03'), 'trunc');

  it('rejects a conversion key that could not be part of an account code', () => {
    expectFailure(
      () => fxExecution('x:1', converted),
      LedgerErrorCode.accountInvalidIdentifier,
      { field: 'conversionId' },
    );
  });

  /**
   * Нулевая нога — не обмен. Проверяются **обе** стороны по отдельности: пока
   * условие требовало, чтобы неположительными были обе сразу, объявление
   * «отдали восемьдесят тысяч, получили ноль» собиралось молча.
   */
  it('rejects a leg of nothing on either side', () => {
    // Одна тетри по курсу 0,0001 — это ноль лари после усечения: исходная нога
    // положительна, встречная пуста. Ровно та пара, на которой видно, что
    // стороны проверяются по отдельности.
    const thinRates = fxRates('USD', 'GEL', {
      client: rationalFromDecimalString('0.0001'),
      reference: rationalFromDecimalString('2.6875'),
      official: rationalFromDecimalString('2.7000'),
    });
    const nothingBack = convert(money('USD', 1n), thinRates, isoDate('2026-09-03'), 'trunc');
    expect(nothingBack.source.minor).toBe(1n);
    expect(nothingBack.target.minor).toBe(0n);
    expectFailure(
      () => fxExecution('x1', nothingBack),
      LedgerErrorCode.entryConversionDeclarationMismatch,
      { conversionId: 'x1' },
    );
  });

  it('rejects a declaration that no posting applies', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e1'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fx_sent_for_conversion',
          converts: fxExecution('x1', converted),
          postings: [
            debit(nominal, gross, { clientKey: payer }),
            credit(clientFreeAccount(payer), gross, { clientKey: payer }),
          ],
        }),
      LedgerErrorCode.entryConversionUndeclared,
      { conversionId: 'x1', reason: 'not_applied' },
    );
  });

  /**
   * Сумма проводки обязана быть **ровно** одной из объявленных ног, а не «той
   * же валютой». Иначе объявляется обмен на восемьдесят тысяч, а двигается
   * сколько угодно.
   */
  it('rejects a leg in the declared currency but not in the declared amount', () => {
    const execution = fxExecution('x1', converted);
    const settlementAccount = fxSettlement(payer, 'x1');
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e2'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fx_received',
          converts: execution,
          postings: [
            debit(nominal, money('GEL', 1n), { clientKey: payer }),
            credit(settlementAccount, money('GEL', 1n), { clientKey: payer }),
          ],
        }),
      LedgerErrorCode.entryConversionUndeclared,
      {
        account: accountCode(settlementAccount),
        amount: 'GEL 1',
        target: `GEL ${converted.target.minor}`,
      },
    );
  });
});

describe('отнесение проводки', () => {
  /**
   * Файл счёта с владельцем в коде и отнесение проводки обязаны совпасть
   * **целиком**: совпадения одной сделки мало — транш входит в файл наравне с
   * ней. Ошибка называет и отнесение, и файл: без обоих дежурному не видно,
   * что с чем разошлось.
   */
  it('names both the attribution and the file when a tranche account is attributed elsewhere', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e3'),
          kind: 'settlement',
          memoKey: 'ledger.entry.locked_for_tranche',
          postings: [
            debit(locked, gross, neighbour),
            credit(clientFreeAccount(payer), gross, { clientKey: payer }),
          ],
        }),
      LedgerErrorCode.postingAttributionMismatch,
      { account: accountCode(locked), attribution: 'd1:t2', file: 'd1:t1' },
    );
  });

  /**
   * У пула файла нет по объявлению. Отнесение на пуловой проводке означало бы,
   * что деньги одновременно и в файле, и вне файлов, — и пофайловая сверка
   * считала бы их дважды.
   */
  it('rejects an attribution on a pooled posting by its own code', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e4'),
          kind: 'settlement',
          memoKey: 'ledger.entry.suspense_identified',
          postings: [
            debit({ kind: 'suspense_unidentified' }, gross, { clientKey: payer }),
            credit(nominal, gross, { clientKey: payer }),
          ],
        }),
      LedgerErrorCode.postingClientAttributionMismatch,
      { account: 'suspense:unidentified', attribution: payer },
    );
  });
});

describe('движение обязательства между владельцами', () => {
  it('names who was debited and who was credited', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e5'),
          kind: 'settlement',
          memoKey: 'ledger.entry.tranche_settled',
          postings: [
            debit(clientFreeAccount(payer), gross, { clientKey: payer }),
            credit(recipientFree, gross, { clientKey: recipient }),
          ],
        }),
      LedgerErrorCode.entryClientOwnerMismatch,
      { debited: payer, credited: recipient },
    );
  });
});

describe('форма расчёта', () => {
  const fail = (
    postings: Parameters<typeof createJournalEntry>[0]['postings'],
    kind: 'settlement' | 'correction' = 'settlement',
  ) =>
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e6'),
          kind,
          ...(kind === 'correction' ? { correctsEntryId: 'e0' } : {}),
          memoKey: 'ledger.entry.tranche_settled',
          settles,
          postings,
        }),
      LedgerErrorCode.entrySettlementShapeMismatch,
    );

  it('refuses an outsider account in the record', () => {
    const error = fail([
      debit(locked, gross, deal),
      credit(recipientFree, money('GEL', 60_000n), { clientKey: recipient }),
      credit(clientFreeAccount(stranger), money('GEL', 40_000n), { clientKey: stranger }),
      credit(nominal, gross, deal),
      debit(nominal, money('GEL', 60_000n), { clientKey: recipient }),
      debit(nominal, money('GEL', 40_000n), { clientKey: stranger }),
    ]);
    expect(error.details).toMatchObject({ account: accountCode(clientFreeAccount(stranger)) });
  });

  it('refuses money going backwards into the locked part', () => {
    const error = fail([
      credit(locked, gross, deal),
      debit(recipientFree, gross, { clientKey: recipient }),
      debit(nominal, gross, deal),
      credit(nominal, gross, { clientKey: recipient }),
    ]);
    expect(error.details).toMatchObject({ account: accountCode(locked), direction: 'credit' });
  });

  it('refuses taking money out of the free part of the recipient', () => {
    const error = fail([
      debit(locked, money('GEL', 60_000n), deal),
      debit(recipientFree, money('GEL', 40_000n), { clientKey: recipient }),
      credit(nominal, gross, deal),
    ]);
    expect(error.details).toMatchObject({
      account: accountCode(recipientFree),
      direction: 'debit',
    });
  });

  /**
   * Объявление обязано быть **применено**: запись, в которой запертая часть
   * плательщика не участвует вовсе, расчётом не является, и объявление на ней —
   * попытка получить право на межвладельческое движение задаром.
   */
  it('refuses a declaration that no posting applies', () => {
    const error = fail([debit(nominal, gross, deal), credit(nominal, gross, deal)]);
    expect(error.details).toMatchObject({ account: accountCode(locked), reason: 'not_applied' });
  });

  /**
   * Сверяется отнесение **клиентских** счетов средств. Комиссия, отнесённая к
   * соседнему траншу, формой расчёта не отвергается: её связь со сделкой держат
   * `feePositions` и идемпотентность начисления, а не эта проверка. Развилка
   * («обязана ли форма расчёта требовать свой транш и у счетов комиссии»)
   * вынесена владельцу — см. `docs/product/DECISIONS-REVIEW.md`.
   */
  it('does not measure the attribution of platform accounts', () => {
    const entry = createJournalEntry({
      ...at('e7'),
      kind: 'settlement',
      memoKey: 'ledger.entry.tranche_settled',
      settles,
      postings: [
        debit(locked, gross, deal),
        credit(recipientFree, money('GEL', 98_000n), { clientKey: recipient }),
        credit(feeReceivable, money('GEL', 2_000n), neighbour),
        credit(nominal, gross, deal),
        debit(nominal, money('GEL', 98_000n), { clientKey: recipient }),
        debit(transitFee, money('GEL', 2_000n), neighbour),
      ],
    });
    expect(entry.postings).toHaveLength(6);
  });
});

describe('потолок удержания', () => {
  /**
   * Потолок — доля **от брутто**, взятого с запертой части. Запись, которая с
   * запертой части не взяла ничего, мерить нечем: доли от нуля не существует.
   * Здесь запертая часть тронута в обе стороны на одну сумму (объявление
   * применено, брутто нулевое), а деньги отматываются со свободной части
   * получателя — и это законное исправление, а не удержание сверх потолка.
   */
  it('does not measure a record that took nothing from the locked part', () => {
    const entry = createJournalEntry({
      ...at('e8'),
      kind: 'correction',
      correctsEntryId: 'e0',
      memoKey: 'ledger.entry.tranche_settlement_reversed',
      settles,
      postings: [
        debit(locked, gross, deal),
        credit(locked, gross, deal),
        debit(recipientFree, money('GEL', 40_000n), { clientKey: recipient }),
        credit(nominal, money('GEL', 40_000n), { clientKey: recipient }),
      ],
    });
    expect(entry.kind).toBe('correction');
  });

  it('still measures a record that took something', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e9'),
          kind: 'settlement',
          memoKey: 'ledger.entry.tranche_settled',
          settles,
          postings: [
            debit(locked, gross, deal),
            credit(recipientFree, money('GEL', 97_000n), { clientKey: recipient }),
            credit(feeReceivable, money('GEL', 3_000n), deal),
            credit(nominal, gross, deal),
            debit(nominal, money('GEL', 97_000n), { clientKey: recipient }),
            debit(transitFee, money('GEL', 3_000n), deal),
          ],
        }),
      LedgerErrorCode.entryFeeExceedsCeiling,
      { gross: '100000', withheld: '3000', cap: '2000' },
    );
  });
});

describe('требование по комиссии связывается со сделкой только отнесением', () => {
  it('rejects a withholding leg that does not name the tranche', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e10'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fee_withheld',
          postings: [debit(transitFee, money('GEL', 2_000n), deal), credit(feeReceivable, money('GEL', 2_000n))],
        }),
      LedgerErrorCode.postingFeeWithoutTrancheAttribution,
      { account: 'fee:receivable', attribution: '' },
    );
  });
});

describe('пулы: вход и выход', () => {
  /**
   * Обязательство без владельца в пул-вход не переезжает, но и запрет на
   * выдачу из терминального пула проверяется **своим** правилом: обе формы
   * похожи, и назвать одну именем другой значит отправить дежурного не туда.
   */
  it('calls draining the terminal pool by its own name', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e11'),
          kind: 'settlement',
          memoKey: 'ledger.entry.unclaimed',
          postings: [
            debit(unclaimedLiability, gross),
            credit({ kind: 'suspense_unidentified' }, gross),
          ],
        }),
      LedgerErrorCode.entryTerminalPoolPayout,
      { account: 'unclaimed:liability' },
    );
  });
});

describe('довнесение недостачи сверяется со своим объявлением', () => {
  const funds = { recognisedEntryId: 'r1', owner: payer, amount: gross };

  it('is not a correction', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e12'),
          kind: 'correction',
          correctsEntryId: 'e0',
          memoKey: 'ledger.entry.shortfall_funded',
          funds,
          postings: [
            debit(nominal, gross, { clientKey: payer }),
            credit(bankOperating('GEL'), gross),
          ],
        }),
      LedgerErrorCode.entryShortfallFundingMismatch,
      { kind: 'correction' },
    );
  });

  it('names the file when the gain lands somewhere else', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e13'),
          kind: 'settlement',
          memoKey: 'ledger.entry.shortfall_funded',
          funds,
          postings: [debit(nominal, gross, deal), credit(bankOperating('GEL'), gross)],
        }),
      LedgerErrorCode.entryShortfallFundingMismatch,
      { file: 'd1:t1', currency: 'GEL', minor: '100000' },
    );
  });

  it('requires the gain to be exactly what was declared', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e14'),
          kind: 'settlement',
          memoKey: 'ledger.entry.shortfall_funded',
          funds,
          postings: [
            debit(nominal, money('GEL', 60_000n), { clientKey: payer }),
            credit(bankOperating('GEL'), money('GEL', 60_000n)),
          ],
        }),
      LedgerErrorCode.entryShortfallFundingMismatch,
      { declared: '100000', gained: '60000' },
    );
  });

  it('requires the money leaving the platform account to be exactly what was declared', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e15'),
          kind: 'settlement',
          memoKey: 'ledger.entry.shortfall_funded',
          funds,
          postings: [
            debit(nominal, gross, { clientKey: payer }),
            debit({ kind: 'psp_fee_expense' }, money('GEL', 50_000n)),
            credit(bankOperating('GEL'), money('GEL', 150_000n)),
          ],
        }),
      LedgerErrorCode.entryShortfallFundingMismatch,
      { declared: '100000', funded: '150000' },
    );
  });
});

describe('прирост обеспечения файла', () => {
  /**
   * Прирост — это пришедшие в файл клиентские **активы** минус прибавившиеся в
   * нём обязательства. Сторона счёта здесь решает знак: перепутать актив с
   * обязательством значит увидеть перелив там, где его нет, и не увидеть там,
   * где он есть.
   */
  it('counts custody as a gain and an obligation as its opposite', () => {
    expect(
      clientFileGains([
        debit(nominal, gross, { clientKey: payer }),
        credit(bankOperating('GEL'), gross),
      ]),
    ).toEqual([{ source: { clientKey: payer }, currency: 'GEL', minor: 100_000n }]);

    expect(
      clientFileGains([
        credit(clientFreeAccount(payer), gross, { clientKey: payer }),
        debit(bankOperating('GEL'), gross),
      ]),
    ).toEqual([{ source: { clientKey: payer }, currency: 'GEL', minor: -100_000n }]);
  });
});

describe('сумма проводки', () => {
  it('rejects a posting of nothing', () => {
    expectFailure(
      () =>
        createJournalEntry({
          ...at('e16'),
          kind: 'settlement',
          memoKey: 'ledger.entry.client_top_up',
          postings: [
            debit(nominal, money('GEL', 0n), { clientKey: payer }),
            credit(clientFreeAccount(payer), money('GEL', 0n), { clientKey: payer }),
          ],
        }),
      LedgerErrorCode.postingNonPositiveAmount,
      { account: 'bank:nominal:gel', amount: '0' },
    );
  });
});
