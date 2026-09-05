import { describe, expect, it } from 'vitest';
import {
  WITHDRAWAL_GUARD_IDS,
  WITHDRAWAL_REQUIRED_APPROVALS,
  WITHDRAWAL_STATUSES,
  isTerminalWithdrawalStatus,
} from '@sdelka/domain';
import { type Money, money, toDecimalString } from '@sdelka/money';
import { LOCALES } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import {
  type WithdrawFormOptions,
  type WithdrawInput,
  type WithdrawSource,
  buildWithdrawForm,
  normalizeAmountInput,
  readWithdrawInput,
} from './withdraw-form';

/**
 * Заявка на вывод — единственное место кабинета, где клиент называет **сумму
 * денег**. Всё, что здесь проверяется, проверяется перебором, а не снимком:
 * промах в разборе строки не виден ни на одном скриншоте, а стоит ровно
 * разницу между напечатанным и отправленным.
 */

const FREE: Money = money('GEL', 98_000_00n);
const SOURCE: WithdrawSource = {
  accountRef: 'source-test',
  holderIsPayer: true,
  masked: 'DE00 0000 0000 0000',
  bank: 'Test Bank',
};

function input(patch: Partial<WithdrawInput> = {}): WithdrawInput {
  return { amountText: '', currency: '', step: 'form', fillMax: false, ...patch };
}

function facts(patch: Partial<WithdrawFormOptions> = {}): WithdrawFormOptions {
  return {
    options: [{ currency: 'GEL', free: FREE }],
    source: SOURCE,
    activeStatus: null,
    ...patch,
  };
}

describe('разбор суммы', () => {
  it('принимает то, что человек видит на экране: запятую, пробелы, знак валюты', () => {
    // Ровно та запись, которую печатает `Intl` в русской и грузинской локали,
    // — вместе с узким неразрывным пробелом между разрядами.
    for (const text of ['1 234,56', '1 234,56', '1 234.56', '1234,56 ₾', 'GEL 1234.56']) {
      const view = buildWithdrawForm(input({ amountText: text }), facts());
      expect(view.amount, `не разобрано: ${text}`).not.toBeNull();
      expect(toDecimalString(view.amount!)).toBe('1234.56');
    }
  });

  it('отвергает всё остальное, а не угадывает', () => {
    for (const text of ['сто', '12e3', '1..2', '-', '12,3,4']) {
      const view = buildWithdrawForm(input({ amountText: text }), facts());
      expect(view.amount, `угадано: ${text}`).toBeNull();
      expect(view.errors.map((item) => item.messageKey)).toContain(
        'withdraw.form.error.amount.number',
      );
    }
  });

  it('лишний знак после запятой — отказ, а не округление', () => {
    const view = buildWithdrawForm(input({ amountText: '10.005' }), facts());
    expect(view.amount).toBeNull();
    const error = view.errors.find((item) => item.field === 'amount');
    expect(error?.messageKey).toBe('withdraw.form.error.amount.fraction');
    // Число знаков берётся из валюты, а не из текста ошибки.
    expect(error?.params).toEqual({ digits: '2' });
  });

  it('нормализация не трогает середину числа', () => {
    expect(normalizeAmountInput('  12 345,67 GEL ')).toBe('12345.67');
    expect(normalizeAmountInput('')).toBe('');
  });

  /**
   * Копейки не теряются на больших числах: это проверка красной линии №4 —
   * если бы где-то в разборе появился `Number`, здесь бы отвалились младшие
   * разряды.
   */
  it('десятизначная сумма разбирается без потери минорных единиц', () => {
    const view = buildWithdrawForm(
      input({ amountText: '12345678.91' }),
      facts({ options: [{ currency: 'GEL', free: money('GEL', 99_999_999_99n) }] }),
    );
    expect(view.amount?.minor).toBe(1_234_567_891n);
  });
});

describe('правила вывода приходят из домена', () => {
  it('сумма больше свободного остатка отвергается guard’ом, а не сравнением на экране', () => {
    const view = buildWithdrawForm(input({ amountText: '98000.01' }), facts());
    const error = view.errors.find((item) => item.field === 'amount');
    expect(error?.messageKey).toBe('withdraw.form.error.amount.free');
    expect(error?.guard).toBe('g_free_balance_sufficient');
    expect(view.canSubmit).toBe(false);
    // Сумма в текст ошибки не кладётся здесь: форматирует её `Intl` на экране.
    expect(error?.params).toBeNull();
  });

  it('ровно свободный остаток проходит: граница включительная', () => {
    const view = buildWithdrawForm(input({ amountText: '98000.00', step: 'review' }), facts());
    expect(view.errors).toEqual([]);
    expect(view.canSubmit).toBe(true);
    expect(view.step).toBe('review');
  });

  it('ноль и минус — не заявка', () => {
    for (const text of ['0', '0.00', '-5']) {
      const view = buildWithdrawForm(input({ amountText: text }), facts());
      expect(view.errors.map((item) => item.messageKey)).toContain(
        'withdraw.form.error.amount.positive',
      );
    }
  });

  it('«всё свободное» подставляет ровно остаток и проходит проверку', () => {
    const view = buildWithdrawForm(input({ fillMax: true }), facts());
    expect(view.amountText).toBe(toDecimalString(FREE));
    expect(view.errors).toEqual([]);
  });

  it('счёт-источник не на имя плательщика закрывает заявку', () => {
    const view = buildWithdrawForm(
      input({ amountText: '100' }),
      facts({ source: { ...SOURCE, holderIsPayer: false } }),
    );
    const error = view.errors.find((item) => item.field === 'source');
    expect(error?.messageKey).toBe('withdraw.form.error.source.holder');
    expect(error?.guard).toBe('g_source_account_known');
    expect(view.canSubmit).toBe(false);
  });

  it('неизвестный счёт-источник — свой отказ, а не оттенок чужого имени', () => {
    const view = buildWithdrawForm(input({ amountText: '100' }), facts({ source: null }));
    expect(view.errors.find((item) => item.field === 'source')?.messageKey).toBe(
      'withdraw.form.error.source.unknown',
    );
  });

  it('валюта без свободного остатка не выбирается', () => {
    const view = buildWithdrawForm(input({ currency: 'USD', amountText: '1' }), facts());
    expect(view.errors.find((item) => item.field === 'currency')?.messageKey).toBe(
      'withdraw.form.error.currency.free',
    );
  });

  /**
   * Каждая нетерминальная заявка закрывает форму. Прежде экран считал активными
   * два статуса из четырёх, то есть поверх созданной заявки разрешал завести
   * вторую — ровно то, что запрещает `g_no_active_withdrawal`.
   */
  it('форма закрыта при любой нетерминальной заявке и открыта при терминальной', () => {
    for (const status of WITHDRAWAL_STATUSES) {
      const view = buildWithdrawForm(input({ amountText: '100' }), facts({ activeStatus: status }));
      expect(view.formAvailable, status).toBe(isTerminalWithdrawalStatus(status));
      if (!isTerminalWithdrawalStatus(status)) {
        expect(view.errors.map((item) => item.guard)).toContain('g_no_active_withdrawal');
      }
    }
  });

  it('выводить нечего — формы нет вовсе', () => {
    const view = buildWithdrawForm(input(), facts({ options: [] }));
    expect(view.formAvailable).toBe(false);
    expect(view.currency).toBeNull();
  });
});

describe('шаг не обгоняет проверку', () => {
  it('адрес со «отправлено» и негодной суммой возвращает форму', () => {
    const view = buildWithdrawForm(input({ amountText: '999999', step: 'submitted' }), facts());
    expect(view.step).toBe('form');
    expect(view.canSubmit).toBe(false);
  });

  it('пустое поле после нажатия названо ошибкой, а не молчанием', () => {
    const view = buildWithdrawForm(input({ step: 'review' }), facts());
    expect(view.errors.map((item) => item.messageKey)).toContain(
      'withdraw.form.error.amount.required',
    );
    expect(view.step).toBe('form');
  });

  it('первое открытие формы не показывает ошибок', () => {
    const view = buildWithdrawForm(input(), facts());
    expect(view.errors).toEqual([]);
  });

  it('шаг читается из адреса, а неизвестный — это форма', () => {
    expect(readWithdrawInput({ step: 'review' }).step).toBe('review');
    expect(readWithdrawInput({ step: 'что-нибудь' }).step).toBe('form');
    expect(readWithdrawInput({ amount: ['1', '2'] }).amountText).toBe('');
  });
});

describe('словарь и домен', () => {
  it('каждый отказ по правилу назван именем guard’а домена', () => {
    const cases: WithdrawInput[] = [
      input({ amountText: '999999999' }),
      input({ amountText: '0' }),
      input({ currency: 'USD', amountText: '1' }),
    ];
    for (const item of cases) {
      const view = buildWithdrawForm(item, facts({ source: null, activeStatus: 'requested' }));
      for (const error of view.errors) {
        if (error.guard === null) continue;
        expect(WITHDRAWAL_GUARD_IDS).toContain(error.guard);
      }
    }
  });

  it('у каждого сообщения об ошибке есть строка на трёх языках', () => {
    const keys = new Set<string>();
    const cases: WithdrawInput[] = [
      input({ step: 'review' }),
      input({ amountText: 'сто' }),
      input({ amountText: '10.005' }),
      input({ amountText: '0' }),
      input({ amountText: '999999' }),
      input({ currency: 'USD', amountText: '1' }),
    ];
    for (const item of cases) {
      for (const error of buildWithdrawForm(item, facts()).errors) keys.add(error.messageKey);
      for (const error of buildWithdrawForm(item, facts({ source: null })).errors) {
        keys.add(error.messageKey);
      }
      for (const error of buildWithdrawForm(item, facts({ activeStatus: 'approved' })).errors) {
        keys.add(error.messageKey);
      }
      for (const error of buildWithdrawForm(item, facts({ source: { ...SOURCE, holderIsPayer: false } }))
        .errors) {
        keys.add(error.messageKey);
      }
    }
    // Перебор обязан дойти до всех девяти отказов, иначе проверка зелена от
    // того, что ничего не проверила: пусто, не число, лишний знак, ноль, выше
    // свободного, чужая валюта, счёта нет, счёт не тот, заявка уже идёт.
    expect(keys.size).toBe(9);
    for (const key of keys) {
      for (const locale of LOCALES) {
        expect(t(dictionaryOf(locale), key).startsWith('['), `${locale}: ${key}`).toBe(false);
      }
    }
  });

  it('число утверждений берётся из домена, а не из разметки', () => {
    expect(buildWithdrawForm(input(), facts()).approvalsRequired).toBe(
      WITHDRAWAL_REQUIRED_APPROVALS,
    );
    expect(WITHDRAWAL_REQUIRED_APPROVALS).toBeGreaterThan(1);
  });
});
