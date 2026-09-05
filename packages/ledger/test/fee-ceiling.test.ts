import { money, rational } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEE_CEILING,
  type JournalEntry,
  LedgerError,
  type LedgerErrorCode as LedgerErrorCodeType,
  LedgerErrorCode,
  accountBalance,
  accrueFee,
  appendEntries,
  appendEntry,
  assertAccountIdentifier,
  bankNominal,
  bankOperating,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  clientTopUp,
  createJournalEntry,
  credit,
  debit,
  emptyJournal,
  feeCeiling,
  feeCeilingCap,
  feePositions,
  feeReceivable,
  lockForTranche,
  openFeeReceivables,
  settleTrancheToClientAccount,
  trancheSettlement,
  transitFee,
} from '../src/index';
import { attestDealParties } from './support/deal-parties';
import { uncheckedEntry } from './support/unchecked-entry';

const buyer = clientKey('c1');
const seller = clientKey('c2');
const dealA = { dealId: 'A', trancheId: 't1' };
const feeIncome = { kind: 'fee_income' } as const;
const serviceIncome = { kind: 'service_income' } as const;

function at(id: string, minute = 0): { id: string; occurredAt: string } {
  return { id, occurredAt: `2026-09-04T10:${String(minute).padStart(2, '0')}:00Z` };
}

function expectCode(run: () => unknown, code: LedgerErrorCodeType): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
  }
}

/**
 * Там, где один код закрывает несколько разных дверей, утверждается ещё и
 * пояснение: иначе снятие одной проверки прячется за срабатыванием соседней.
 */
function expectCodeAndDetails(
  run: () => unknown,
  code: LedgerErrorCodeType,
  details: Readonly<Record<string, string>>,
): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
    expect((error as LedgerError).details).toEqual(details);
  }
}

/** Полностью обеспеченный транш: деньги пришли и заперты под сделку A. */
function lockedUnderA(amount: bigint) {
  return appendEntries(emptyJournal, [
    clientTopUp(at('f1'), buyer, money('GEL', amount)),
    lockForTranche(at('f2', 5), buyer, dealA, money('GEL', amount)),
  ]);
}

function settles(ceiling = DEFAULT_FEE_CEILING) {
  return trancheSettlement(
    dealA,
    buyer,
    seller,
    attestDealParties(dealA, buyer, seller),
    ceiling,
  );
}

/**
 * Потолок удержания на **настоящем** пути (эпик E16).
 *
 * До этого батча предел жил в `@sdelka/domain` (`tariff.ts`) и не запрещал
 * ничего: домен клал его в намерение расчёта полем `maxWithholding`,
 * `packages/app` (`projectSettlementIntent`) поле не читал, а `accrueFee` и
 * `settleTrancheToClientAccount` о пределе не знали. Проба ниже — та самая:
 * 99 000 из 100 000 собирались, сходились повалютно и не поднимали ни одного
 * инварианта.
 */
describe('потолок удержания стоит на пути, которым комиссия удерживается', () => {
  it('отвергает удержание сверх потолка на конструкторе расчёта', () => {
    const accrual = accrueFee(at('a1'), dealA, money('GEL', 99_000n), 'plan-1');
    expectCode(
      () =>
        settleTrancheToClientAccount(at('a2', 10), settles(), money('GEL', 100_000n), accrual),
      LedgerErrorCode.entryFeeExceedsCeiling,
    );
  });

  it('задокументированный тариф проходит и доходит до журнала', () => {
    // §3.3, поток P1: 0,4998 %. Правило обязано пропускать живой продукт,
    // иначе оно останавливает деньги вместо того, чтобы ловить опечатку.
    const accrual = accrueFee(at('b1'), dealA, money('GEL', 500n), 'plan-1');
    const journal = appendEntries(lockedUnderA(100_000n), [
      accrual,
      settleTrancheToClientAccount(at('b2', 10), settles(), money('GEL', 100_000n), accrual),
    ]);
    expect(accountBalance(journal, clientFreeAccount(seller), 'GEL').minor).toBe(99_500n);
    expect(accountBalance(journal, transitFee, 'GEL').minor).toBe(500n);
  });

  it('граница включительна: ровно потолок проходит, потолок плюс единица — нет', () => {
    const exact = accrueFee(at('c1'), dealA, money('GEL', 2_000n), 'plan-1');
    expect(() =>
      settleTrancheToClientAccount(at('c2', 10), settles(), money('GEL', 100_000n), exact),
    ).not.toThrow();
    const overByOne = accrueFee(at('c3'), dealA, money('GEL', 2_001n), 'plan-1');
    expectCode(
      () =>
        settleTrancheToClientAccount(at('c4', 10), settles(), money('GEL', 100_000n), overByOne),
      LedgerErrorCode.entryFeeExceedsCeiling,
    );
  });

  it('не обходится сменой счёта назначения', () => {
    // Правило считает удержание вычитанием — брутто с запертой части минус то,
    // что дошло до получателя, — поэтому имя счёта, на который ушла разница,
    // ему безразлично. Перечень счетов вместо вычитания пропустил бы эту
    // запись: `fee:receivable` она не трогает вовсе.
    expectCode(
      () =>
        createJournalEntry({
          ...at('d1'),
          kind: 'settlement',
          memoKey: 'ledger.entry.tranche_settled',
          settles: settles(),
          postings: [
            debit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
            credit(clientFreeAccount(seller), money('GEL', 1_000n), { clientKey: seller }),
            credit(serviceIncome, money('GEL', 99_000n), dealA),
            credit(bankNominal('GEL'), money('GEL', 100_000n), dealA),
            debit(bankNominal('GEL'), money('GEL', 1_000n), { clientKey: seller }),
            debit(bankOperating('GEL'), money('GEL', 99_000n)),
          ],
        }),
      LedgerErrorCode.entryFeeExceedsCeiling,
    );
  });

  it('не обходится добавлением строки', () => {
    // Три удержания по полтора процента — три законные строки и четыре с
    // половиной процента суммы клиента. Потолок стоит на сумме удержаний.
    expectCode(
      () =>
        createJournalEntry({
          ...at('e1'),
          kind: 'settlement',
          memoKey: 'ledger.entry.tranche_settled',
          settles: settles(),
          postings: [
            debit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
            credit(clientFreeAccount(seller), money('GEL', 95_500n), { clientKey: seller }),
            credit(feeReceivable, money('GEL', 1_500n), dealA),
            credit(serviceIncome, money('GEL', 1_500n), dealA),
            credit({ kind: 'fx_income' } as const, money('GEL', 1_500n), dealA),
            credit(bankNominal('GEL'), money('GEL', 100_000n), dealA),
            debit(bankNominal('GEL'), money('GEL', 95_500n), { clientKey: seller }),
            debit(transitFee, money('GEL', 1_500n), dealA),
            debit(bankOperating('GEL'), money('GEL', 3_000n)),
          ],
        }),
      LedgerErrorCode.entryFeeExceedsCeiling,
    );
  });

  it('не обходится вторым расчётом под видом исправления', () => {
    // Освобождение по типу записи открыло бы дверь: у `correction` нет
    // послаблений на направление, поэтому исправление, двигающее деньги вперёд,
    // — это второй расчёт. Правило смотрит на знак разности, а не на тип.
    const accrual = accrueFee(at('m1'), dealA, money('GEL', 500n), 'plan-1');
    const journal = appendEntries(lockedUnderA(200_000n), [
      accrual,
      settleTrancheToClientAccount(at('m2', 10), settles(), money('GEL', 100_000n), accrual),
    ]);
    expectCode(
      () =>
        appendEntry(
          journal,
          createJournalEntry({
            ...at('m3', 20),
            kind: 'correction',
            correctsEntryId: 'm2',
            memoKey: 'ledger.entry.tranche_settled',
            settles: settles(),
            postings: [
              debit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
              credit(clientFreeAccount(seller), money('GEL', 1_000n), { clientKey: seller }),
              credit(serviceIncome, money('GEL', 99_000n), dealA),
              credit(bankNominal('GEL'), money('GEL', 100_000n), dealA),
              debit(bankNominal('GEL'), money('GEL', 1_000n), { clientKey: seller }),
              debit(bankOperating('GEL'), money('GEL', 99_000n)),
            ],
          }),
        ),
      LedgerErrorCode.entryFeeExceedsCeiling,
    );
  });

  it('обратное исправление расчёта потолком не меряется', () => {
    // У реверса разность отрицательна: запертая часть кредитуется обратно.
    // Пропускается по знаку, а не по типу записи, — иначе законное исправление
    // стало бы несобираемым.
    expect(() =>
      createJournalEntry({
        ...at('n1', 20),
        kind: 'correction',
        correctsEntryId: 'n0',
        memoKey: 'ledger.entry.tranche_settled',
        settles: settles(),
        postings: [
          credit(clientLockedAccount(buyer, dealA.dealId, dealA.trancheId), money('GEL', 100_000n), dealA),
          debit(clientFreeAccount(seller), money('GEL', 99_500n), { clientKey: seller }),
          debit(feeReceivable, money('GEL', 500n), dealA),
          debit(bankNominal('GEL'), money('GEL', 100_000n), dealA),
          credit(bankNominal('GEL'), money('GEL', 99_500n), { clientKey: seller }),
          credit(transitFee, money('GEL', 500n), dealA),
        ],
      }),
    ).not.toThrow();
  });

  it('объявленный потолок только сужает предел, но не расширяет его', () => {
    // `feeCeiling(1/1)` — законная величина, и без правила «строжайший из двух»
    // запись приносила бы себе право удержать всё.
    const wide = settles(feeCeiling(rational(1n, 1n)));
    expect(wide.ceiling).toEqual(DEFAULT_FEE_CEILING);
    const accrual = accrueFee(at('g1'), dealA, money('GEL', 99_000n), 'plan-1');
    expectCode(
      () => settleTrancheToClientAccount(at('g2', 10), wide, money('GEL', 100_000n), accrual),
      LedgerErrorCode.entryFeeExceedsCeiling,
    );
  });

  it('политика транша строже умолчания — действует она', () => {
    // `CORE.md` Ф11: решение хранит политику, действовавшую в момент принятия.
    const strict = settles(feeCeiling(rational(1n, 1_000n)));
    const accrual = accrueFee(at('h1'), dealA, money('GEL', 500n), 'plan-1');
    expectCode(
      () => settleTrancheToClientAccount(at('h2', 10), strict, money('GEL', 100_000n), accrual),
      LedgerErrorCode.entryFeeExceedsCeiling,
    );
    const within = accrueFee(at('h3'), dealA, money('GEL', 100n), 'plan-1');
    expect(() =>
      settleTrancheToClientAccount(at('h4', 10), strict, money('GEL', 100_000n), within),
    ).not.toThrow();
  });
});

/**
 * Начисление комиссии без отнесения к траншу — ошибка учёта.
 *
 * `journalFeeAccruedTwice` ловит второе начисление по траншу, но требование по
 * комиссии связывается со сделкой **только** отнесением: в коде `fee:receivable`
 * файла нет. Начисление без отнесения не попадало ни в `openFeeReceivables`, ни
 * в `feePositions`, ни в проверку идемпотентности — и следом законно проходило
 * второе, уже отнесённое.
 */
describe('начисление комиссии без отнесения к траншу', () => {
  it('не собирается низкоуровневой дверью', () => {
    expectCode(
      () =>
        createJournalEntry({
          ...at('i1'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fee_accrued',
          postings: [
            debit(feeReceivable, money('GEL', 500n)),
            credit(feeIncome, money('GEL', 500n)),
          ],
        }),
      LedgerErrorCode.postingFeeWithoutTrancheAttribution,
    );
  });

  it('не собирается и с отнесением к файлу клиента', () => {
    // Файл клиента для требования по комиссии — не файл: все три отчёта
    // ключуются парой «сделка, транш», и клиентское отнесение для них
    // неотличимо от отсутствующего.
    expectCode(
      () =>
        createJournalEntry({
          ...at('i2'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fee_accrued',
          postings: [
            debit(feeReceivable, money('GEL', 500n), { clientKey: buyer }),
            credit(feeIncome, money('GEL', 500n), { clientKey: buyer }),
          ],
        }),
      LedgerErrorCode.postingFeeWithoutTrancheAttribution,
    );
  });

  it('доходная нога начисления обязана назвать тот же файл', () => {
    // Иначе `feePositions` показала бы «не удержано 500» при «начислено 0».
    expectCode(
      () =>
        createJournalEntry({
          ...at('i3'),
          kind: 'settlement',
          memoKey: 'ledger.entry.fee_accrued',
          postings: [
            debit(feeReceivable, money('GEL', 500n), dealA),
            credit(feeIncome, money('GEL', 500n)),
          ],
        }),
      LedgerErrorCode.postingFeeWithoutTrancheAttribution,
    );
  });

  it('доход помимо тарифного начисления по-прежнему законен', () => {
    // Правило стоит на требовании, а не на всяком доходе: `fee:income` —
    // обычный счёт дохода, и признание без требования сделкой не ключуется.
    const entry = createJournalEntry({
      ...at('i4'),
      kind: 'settlement',
      memoKey: 'ledger.entry.fee_received',
      postings: [debit(bankOperating('GEL'), money('GEL', 500n)), credit(feeIncome, money('GEL', 500n))],
    });
    expect(entry.postings).toHaveLength(2);
  });

  it('вот чем было опасно начисление без отнесения', () => {
    // Запись, собранная в обход конструктора (журнал приезжает из базы, в том
    // числе с записями старше проверки): требование на балансе есть, в отчётах
    // его нет, и идемпотентность его не видит — второе начисление по тому же
    // траншу проходит.
    const stranded: JournalEntry = uncheckedEntry({
      ...at('j1'),
      kind: 'settlement',
      memoKey: 'ledger.entry.fee_accrued',
      postings: [debit(feeReceivable, money('GEL', 500n)), credit(feeIncome, money('GEL', 500n))],
    });
    let journal = appendEntry(emptyJournal, stranded);
    expect(accountBalance(journal, feeReceivable, 'GEL').minor).toBe(500n);
    expect(openFeeReceivables(journal)).toEqual([]);
    expect(feePositions(journal)).toEqual([]);

    journal = appendEntry(journal, accrueFee(at('j2', 1), dealA, money('GEL', 500n), 'plan-1'));
    expect(accountBalance(journal, feeReceivable, 'GEL').minor).toBe(1_000n);
    // Начислено дважды, а `openFeeReceivables` знает про одно: вторая половина
    // требования не связана ни с какой сделкой. Именно поэтому такую запись
    // конструктор больше не собирает.
    expect(openFeeReceivables(journal)).toHaveLength(1);
  });
});

/**
 * Негодное значение отвечает названной ошибкой с ключом, а не `TypeError`.
 *
 * Журнал приезжает из базы и из сериализации, где `undefined` на месте поля —
 * обычное дело. `TypeError: Cannot read properties of undefined` не несёт ни
 * кода, ни поля, ни ключа локализации: его нечем показать и нечем разобрать.
 */
describe('негодное значение — ошибка учёта, а не TypeError', () => {
  it('идентификатор без значения отвергается кодом счёта', () => {
    const call = assertAccountIdentifier as unknown as (value: unknown, field: string) => string;
    expectCode(() => call(undefined, 'dealId'), LedgerErrorCode.accountInvalidIdentifier);
    expectCode(() => call(null, 'trancheId'), LedgerErrorCode.accountInvalidIdentifier);
    expectCode(() => call(42, 'clientKey'), LedgerErrorCode.accountInvalidIdentifier);
  });

  it('запись без поля объявления довнесения отвергается журналом', () => {
    const malformed = {
      ...at('k1'),
      kind: 'settlement',
      postings: [],
      memoKey: 'ledger.entry.fee_accrued',
      correctsEntryId: null,
      settles: null,
      converts: null,
      accrues: null,
    } as unknown as JournalEntry;
    expectCode(
      () => appendEntry(emptyJournal, malformed),
      LedgerErrorCode.journalEntryMalformed,
    );
  });

  it('запись без ссылки исправления не выдаётся за исправление с пропавшей целью', () => {
    // `undefined !== null` заводило её в ветку исправления, и журнал отвечал
    // «цель исправления не найдена» — то есть называл не ту причину.
    const malformed = {
      ...at('k2'),
      kind: 'settlement',
      postings: [],
      memoKey: 'ledger.entry.fee_accrued',
      settles: null,
      converts: null,
      accrues: null,
      funds: null,
    } as unknown as JournalEntry;
    expectCode(
      () => appendEntry(emptyJournal, malformed),
      LedgerErrorCode.journalEntryMalformed,
    );
  });
});

/**
 * Две проверки, у которых до этого батча не было падающего теста.
 *
 * Найдены тем же вопросом, что и дыра в `@sdelka/money`: «каким изменением
 * исходника этот тест обязан упасть?». Ни один прогон не подавал в `accrueFee`
 * неположительную комиссию и ни один не строил негодный потолок — коды
 * `entryNonPositiveFee` и `feeCeilingInvalid` не встречались в тестах учёта ни
 * разу, хотя оба стоят на денежном пути.
 */
describe('начисление и потолок: негодная величина отвергается названной причиной', () => {
  it('нулевая и отрицательная комиссия не становятся начислением', () => {
    // Код обязателен, а не класс ошибки: без проверки нулевая комиссия уходит
    // в конструктор и отвергается уже проводкой (`postingNonPositiveAmount`) —
    // тем же классом `LedgerError`, но по другой причине. «Ноль — это
    // отсутствие комиссии, а не проводка на ноль» держится вот этим кодом.
    expectCodeAndDetails(
      () => accrueFee(at('p1'), dealA, money('GEL', 0n), 'plan-1'),
      LedgerErrorCode.entryNonPositiveFee,
      { amount: '0' },
    );
    expectCodeAndDetails(
      () => accrueFee(at('p2'), dealA, money('GEL', -500n), 'plan-1'),
      LedgerErrorCode.entryNonPositiveFee,
      { amount: '-500' },
    );
    // Положительная — собирается: правило отсекает негодную величину, а не
    // начисление как таковое.
    expect(accrueFee(at('p3'), dealA, money('GEL', 1n), 'plan-1').postings).toHaveLength(2);
  });

  it('потолок как величина: доля не бывает отрицательной и не бывает больше единицы', () => {
    // Отрицательная доля дала бы отрицательный предел, при котором законным
    // остаётся только отрицательное удержание, — то есть выплата получателю
    // сверх брутто. Доля больше единицы — величина, которой не существует.
    expectCodeAndDetails(
      () => feeCeiling(rational(-1n, 100n)),
      LedgerErrorCode.feeCeilingInvalid,
      { reason: 'negative' },
    );
    expectCodeAndDetails(
      () => feeCeiling(rational(101n, 100n)),
      LedgerErrorCode.feeCeilingInvalid,
      { reason: 'above_one' },
    );
    // Границы включительны с обеих сторон: ноль — это «удерживать нельзя
    // ничего», единица — законная величина, которую сужает `strictestFeeCeiling`.
    expect(feeCeiling(rational(0n, 1n)).maxShare).toEqual(rational(0n, 1n));
    expect(feeCeiling(rational(1n, 1n)).maxShare).toEqual(rational(1n, 1n));
  });

  it('предел не считается от отрицательного брутто', () => {
    // Брутто ниже нуля — не «маленькая сумма»: доля от него отрицательна, и
    // сравнение «удержание не больше предела» начинает пропускать всё подряд.
    expectCodeAndDetails(
      () => feeCeilingCap(money('GEL', -1n)),
      LedgerErrorCode.feeCeilingInvalid,
      { reason: 'negative_gross', amount: '-1' },
    );
    expect(feeCeilingCap(money('GEL', 100_000n)).minor).toBe(2_000n);
    expect(feeCeilingCap(money('GEL', 0n)).minor).toBe(0n);
  });
});
