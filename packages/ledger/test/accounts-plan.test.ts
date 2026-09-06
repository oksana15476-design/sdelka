import { describe, expect, it } from 'vitest';
import {
  type Account,
  type AccountKind,
  type AccountNature,
  LedgerError,
  LedgerErrorCode,
  accountCode,
  accountNature,
  accountsEqual,
  assertAccountIdentifier,
  bankNominal,
  bankOperating,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  feeReceivable,
  fxAccountingDiff,
  fxSettlement,
  shortfallExpense,
  transitFee,
  transitWriteoff,
  unclaimedLiability,
} from '../src/index';

/**
 * План счетов как **таблица значений**, а не как набор косвенных проверок.
 *
 * Зачем такой тест нужен отдельно. Природа счёта (`ACCOUNT_NATURE`) — это то,
 * из чего выводятся красные линии №1 и №2: «клиентские это деньги или наши»,
 * «актив или обязательство», «файл в коде счёта, в отнесении или его нет».
 * Проверялась она до сих пор только через поведение записей, и мутационный
 * прогон это показал буквально: подмена `role: 'result'` на `role: 'bank'` у
 * `fee:income`, `fx:income`, `service:income`, `psp:fee:expense`,
 * `oracle:cost:expense` и `fx:accounting:diff` — то есть объявление счёта
 * дохода **банковским счётом платформы** — не роняла ни одного из двухсот
 * тестов. Последствие такой подмены не косметическое: `isPlatformBankAccount`
 * решает, что считать «настоящими деньгами платформы», а от этого зависят
 * `platformFunding` (чем законно довносить недостачу в файл клиента) и
 * обеспечение невостребованных средств.
 *
 * Ровно так же не роняла ничего подмена `case 'fee_income'` на `case 'fx_income'`
 * в `accountCode`: два счёта получали один код, а третий — `undefined`, и
 * сверка по коду счёта переставала различать их.
 *
 * Поэтому здесь утверждаются **конкретные значения**: код счёта и его природа
 * по каждому виду. Таблица типизирована `Record<AccountKind, …>`: вид счёта,
 * добавленный в план и забытый здесь, не компилируется.
 */

const owner = clientKey('c1');

interface Expectation {
  readonly account: Account;
  readonly code: string;
  readonly nature: AccountNature;
}

const PLAN: Record<AccountKind, Expectation> = {
  bank_nominal: {
    account: bankNominal('GEL'),
    code: 'bank:nominal:gel',
    nature: { type: 'asset', funds: 'client', file: 'in_attribution' },
  },
  bank_operating: {
    account: bankOperating('GEL'),
    code: 'bank:operating:gel',
    nature: { type: 'asset', funds: 'platform', role: 'bank' },
  },
  client_free: {
    account: clientFreeAccount(owner),
    code: 'client:c1:free',
    nature: { type: 'liability', funds: 'client', file: 'owner_in_code' },
  },
  client_locked: {
    account: clientLockedAccount(owner, 'd1', 't1'),
    code: 'client:c1:tranche:d1:t1',
    nature: { type: 'liability', funds: 'client', file: 'owner_in_code' },
  },
  suspense_unidentified: {
    account: { kind: 'suspense_unidentified' },
    code: 'suspense:unidentified',
    nature: { type: 'liability', funds: 'client', file: 'pooled', pool: 'intake' },
  },
  fee_income: {
    account: { kind: 'fee_income' },
    code: 'fee:income',
    nature: { type: 'income', funds: 'platform', role: 'result' },
  },
  fx_income: {
    account: { kind: 'fx_income' },
    code: 'fx:income',
    nature: { type: 'income', funds: 'platform', role: 'result' },
  },
  service_income: {
    account: { kind: 'service_income' },
    code: 'service:income',
    nature: { type: 'income', funds: 'platform', role: 'result' },
  },
  psp_fee_expense: {
    account: { kind: 'psp_fee_expense' },
    code: 'psp:fee:expense',
    nature: { type: 'expense', funds: 'platform', role: 'result' },
  },
  oracle_cost_expense: {
    account: { kind: 'oracle_cost_expense' },
    code: 'oracle:cost:expense',
    nature: { type: 'expense', funds: 'platform', role: 'result' },
  },
  shortfall_expense: {
    account: shortfallExpense,
    code: 'shortfall:expense',
    nature: { type: 'expense', funds: 'platform', role: 'result' },
  },
  unclaimed_liability: {
    account: unclaimedLiability,
    code: 'unclaimed:liability',
    nature: { type: 'liability', funds: 'client', file: 'pooled', pool: 'terminal' },
  },
  transit_writeoff: {
    account: transitWriteoff,
    code: 'transit:writeoff',
    nature: { type: 'asset', funds: 'client', file: 'pooled', pool: 'terminal' },
  },
  fx_settlement: {
    account: fxSettlement(owner, 'x1'),
    code: 'fx:settlement:c1:x1',
    nature: { type: 'asset', funds: 'client', file: 'owner_in_code' },
  },
  fee_receivable: {
    account: feeReceivable,
    code: 'fee:receivable',
    nature: { type: 'asset', funds: 'platform', role: 'receivable' },
  },
  transit_fee: {
    account: transitFee,
    code: 'transit:fee',
    nature: { type: 'asset', funds: 'platform', role: 'transit' },
  },
  fx_accounting_diff: {
    account: fxAccountingDiff,
    code: 'fx:accounting:diff',
    nature: { type: 'expense', funds: 'platform', role: 'result' },
  },
};

describe('план счетов: код и природа каждого вида', () => {
  for (const [kind, expectation] of Object.entries(PLAN)) {
    it(`declares ${kind} with its own code and nature`, () => {
      expect(expectation.account.kind).toBe(kind);
      expect(accountCode(expectation.account)).toBe(expectation.code);
      expect(accountNature(expectation.account)).toEqual(expectation.nature);
    });
  }

  it('gives every account its own code', () => {
    const codes = Object.values(PLAN).map((item) => item.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('сравнение счетов идёт по коду', () => {
  it('holds for two independently built values of the same account', () => {
    expect(
      accountsEqual(clientLockedAccount(owner, 'd1', 't1'), clientLockedAccount(owner, 'd1', 't1')),
    ).toBe(true);
  });

  it('separates the same client under two different tranches', () => {
    expect(
      accountsEqual(clientLockedAccount(owner, 'd1', 't1'), clientLockedAccount(owner, 'd1', 't2')),
    ).toBe(false);
  });

  it('separates the free part from the locked one', () => {
    expect(accountsEqual(clientFreeAccount(owner), clientLockedAccount(owner, 'd1', 't1'))).toBe(
      false,
    );
  });
});

describe('идентификатор кода счёта', () => {
  /**
   * Разбор ключа счёта однозначен только потому, что двоеточие и вертикальная
   * черта в идентификаторы не пропускаются. Ошибка называет и **поле**, и код:
   * без поля дежурному не видно, какой из трёх идентификаторов расчёта негоден.
   */
  it('rejects a separator inside an identifier by its own code', () => {
    try {
      assertAccountIdentifier('d:1', 'dealId');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe(LedgerErrorCode.accountInvalidIdentifier);
      expect((error as LedgerError).details).toEqual({ field: 'dealId', value: 'd:1' });
    }
  });

  it('rejects the funds-source separator too', () => {
    try {
      assertAccountIdentifier('d|1', 'dealId');
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).details).toEqual({ field: 'dealId', value: 'd|1' });
    }
  });

  it('rejects an empty identifier', () => {
    try {
      assertAccountIdentifier('', 'trancheId');
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).details).toEqual({ field: 'trancheId', value: '' });
    }
  });

  /**
   * Журнал приезжает из базы и из сериализации, где `undefined` на месте
   * `dealId` — обычное дело. Ответ на него — названная ошибка с типом
   * значения, а не `TypeError` без кода. `null` называется отдельно от
   * `object`: `typeof null === 'object'` не сказал бы дежурному ничего.
   */
  it('names the type of a value that is not a string at all', () => {
    for (const [value, type] of [
      [null, 'null'],
      [undefined, 'undefined'],
      [42, 'number'],
    ] as const) {
      try {
        assertAccountIdentifier(value as unknown as string, 'clientKey');
        expect.unreachable();
      } catch (error) {
        expect((error as LedgerError).code).toBe(LedgerErrorCode.accountInvalidIdentifier);
        expect((error as LedgerError).details).toEqual({ field: 'clientKey', type });
      }
    }
  });

  it('returns the identifier unchanged when it is sound', () => {
    expect(assertAccountIdentifier('d1', 'dealId')).toBe('d1');
  });
});
