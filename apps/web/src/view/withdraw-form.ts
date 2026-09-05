import {
  type ClientAccountFacts,
  type WithdrawalGuardId,
  type WithdrawalStatus,
  WITHDRAWAL_REQUIRED_APPROVALS,
  evaluateWithdrawalGuard,
  isTerminalWithdrawalStatus,
} from '@sdelka/domain';
import {
  type CurrencyCode,
  type Money,
  MoneyError,
  MoneyErrorCode,
  fromDecimalString,
  isCurrencyCode,
  isPositive,
  minorUnitExponent,
  toDecimalString,
} from '@sdelka/money';

/**
 * Заявка на вывод: разбор ввода и решение о том, что показать.
 *
 * ## Почему это отдельный модуль, а не код внутри экрана
 *
 * Здесь единственное место в клиентском интерфейсе, где **клиент распоряжается
 * деньгами**: он называет сумму, и из этой суммы получается поручение банку.
 * Ошибка разбора строки здесь стоит ровно столько, сколько стоит разница между
 * тем, что человек напечатал, и тем, что ушло. Такое проверяется перебором в
 * тесте, а не снимком экрана, — поэтому логика вынесена из компонента целиком
 * (`withdraw-form.test.ts`).
 *
 * ## Что здесь решается, а что нет
 *
 * Решается: разобралась ли строка в сумму, и что об этой сумме говорят guard'ы
 * машины вывода (`packages/domain/src/client-account.ts`). Guard'ы **не
 * переписываются** — они вызываются: правило «свободного остатка хватает» живёт
 * в домене, и второй его копии в интерфейсе быть не должно, иначе они разойдутся
 * и разойдутся молча.
 *
 * Не решается: утверждение. Два утверждения набирают разные учётные записи, и
 * ни одна из них не готовила заявку (`g_withdrawal_approvers_distinct`); с
 * экрана клиента этих guard'ов не видно и проверять их здесь нечего. Экран
 * показывает **число** набранных подписей, а не судит о нём.
 */

/* ------------------------------------------------------------------- шаги */

/**
 * Три шага и ни одного лишнего: заполнение, сверка того, что уйдёт, и уже
 * созданная заявка. Сверка отдельным шагом стоит одного нажатия и снимает самый
 * дорогой промах — «не ту сумму на не тот счёт»: после отправки поручение
 * отменяется только пока заявка не утверждена, а после утверждения перехода в
 * «отменено» в автомате нет вовсе.
 */
export const WITHDRAW_STEPS = ['form', 'review', 'submitted'] as const;

export type WithdrawStep = (typeof WITHDRAW_STEPS)[number];

export function withdrawStepOf(value: string | undefined): WithdrawStep {
  return WITHDRAW_STEPS.find((item) => item === value) ?? 'form';
}

/* ---------------------------------------------------------- счёт-источник */

/**
 * Счёт-источник для экрана: ключ реквизитов и **имя владельца** — из домена
 * (`SourceAccountRef`), маска и банк — для показа.
 *
 * Красная линия №9: возврат только на счёт-источник, на имя плательщика.
 * Поэтому счёт здесь — не поле выбора, а факт движения: он показывается и не
 * редактируется, а если его нет или он не на имя плательщика, заявка не
 * создаётся вовсе и уходит человеку с названной причиной.
 */
export interface WithdrawSource {
  readonly accountRef: string;
  readonly holderIsPayer: boolean;
  readonly masked: string;
  readonly bank: string;
}

/* ------------------------------------------------------------------ ошибки */

export type WithdrawFieldName = 'amount' | 'currency' | 'source';

export interface WithdrawFieldError {
  readonly field: WithdrawFieldName;
  readonly messageKey: string;
  readonly params: Readonly<Record<string, string>> | null;
  /**
   * Guard домена, отказавший в этом месте, либо `null` — если строка вообще не
   * стала суммой и до guard'ов дело не дошло.
   *
   * Поле существует не для показа, а для проверки: тест требует, чтобы каждый
   * отказ, кроме разбора строки, был именем из `WITHDRAWAL_GUARD_IDS`. Так
   * «правило, придуманное на экране» становится невыразимым.
   */
  readonly guard: WithdrawalGuardId | null;
}

/* -------------------------------------------------------------- ввод формы */

export interface WithdrawInput {
  /** Ровно то, что напечатал человек: при ошибке поле показывается как есть. */
  readonly amountText: string;
  readonly currency: string;
  readonly step: WithdrawStep;
  /** Нажата «всё свободное»: сумма берётся из остатка, а не из поля. */
  readonly fillMax: boolean;
}

function single(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  return '';
}

export function readWithdrawInput(
  query: Readonly<Record<string, string | string[] | undefined>>,
): WithdrawInput {
  return {
    amountText: single(query.amount),
    currency: single(query.currency),
    step: withdrawStepOf(single(query.step) === '' ? undefined : single(query.step)),
    fillMax: single(query.fill) === 'max',
  };
}

/* ------------------------------------------------------------ разбор суммы */

/**
 * Строка человека → сумма в минорных единицах.
 *
 * Своего разбора десятичной записи здесь нет: строка нормализуется и уходит в
 * `fromDecimalString` из `@sdelka/money`, где всё считается на `BigInt`. Числа
 * с плавающей точкой не появляются ни на одном шаге — красная линия №4.
 *
 * Нормализация — это про клавиатуру, а не про правила денег:
 *
 * · запятая как разделитель дробной части. На русской и грузинской раскладках
 *   печатают именно запятую, и `Intl` в обеих локалях её же и рисует. Отвергать
 *   ввод, совпадающий с тем, что мы сами показали, — дефект, а не строгость;
 * · пробелы внутри числа, включая неразрывный и узкий неразрывный: `Intl`
 *   группирует ими разряды, и они приезжают вместе со вставкой из буфера;
 * · знак валюты и код, приехавшие тем же копированием.
 *
 * Всё остальное — отказ. «Примерно понятного» ввода на экране денег не бывает.
 */
/* Пробелы кодовыми точками, а не литералами: неразрывный и узкий неразрывный
   в исходнике неотличимы от обычного, и правка теряет их молча. */
const SPACES = /[\s\u00a0\u202f\u2009]/gu;
const CURRENCY_MARKS = /[₾$€]|GEL|USD|EUR/giu;

export function normalizeAmountInput(text: string): string {
  return text.replace(CURRENCY_MARKS, '').replace(SPACES, '').replace(/,/gu, '.').trim();
}

export interface ParsedAmount {
  readonly amount: Money<CurrencyCode> | null;
  readonly error: WithdrawFieldError | null;
}

export function parseAmount(currency: CurrencyCode, text: string): ParsedAmount {
  const normalized = normalizeAmountInput(text);
  if (normalized === '') {
    return {
      amount: null,
      error: { field: 'amount', messageKey: 'withdraw.form.error.amount.required', params: null, guard: null },
    };
  }
  try {
    return { amount: fromDecimalString(currency, normalized), error: null };
  } catch (error) {
    if (error instanceof MoneyError && error.code === MoneyErrorCode.parseTooManyFractionDigits) {
      return {
        amount: null,
        error: {
          field: 'amount',
          messageKey: 'withdraw.form.error.amount.fraction',
          // Число знаков — свойство валюты, а не константа 100: у GEL, USD и
          // EUR их два, и это читается из `@sdelka/money`, а не пишется в текст.
          params: { digits: String(minorUnitExponent(currency)) },
          guard: null,
        },
      };
    }
    return {
      amount: null,
      error: { field: 'amount', messageKey: 'withdraw.form.error.amount.number', params: null, guard: null },
    };
  }
}

/* ---------------------------------------------------------------- сборка */

export interface CurrencyOption {
  readonly currency: CurrencyCode;
  readonly free: Money<CurrencyCode>;
}

export interface WithdrawFormOptions {
  /** Валюты со свободным остатком. Пустой список — выводить нечего. */
  readonly options: readonly CurrencyOption[];
  readonly source: WithdrawSource | null;
  /** Заявка, которая уже идёт, либо `null`. */
  readonly activeStatus: WithdrawalStatus | null;
}

export interface WithdrawFormView {
  readonly step: WithdrawStep;
  readonly options: readonly CurrencyOption[];
  readonly currency: CurrencyCode | null;
  readonly free: Money<CurrencyCode> | null;
  /** Что стоит в поле: ввод человека либо остаток после «всё свободное». */
  readonly amountText: string;
  readonly amount: Money<CurrencyCode> | null;
  readonly errors: readonly WithdrawFieldError[];
  readonly source: WithdrawSource | null;
  readonly approvalsRequired: number;
  /**
   * Форма показывается вовсе. `false` — либо выводить нечего, либо заявка уже
   * идёт: в обоих случаях на её месте стоит названная причина, а не пустое
   * место и не отключённая кнопка.
   */
  readonly formAvailable: boolean;
  /** Заявка, из-за которой форма закрыта. */
  readonly activeStatus: WithdrawalStatus | null;
  readonly canSubmit: boolean;
}

export function errorOf(
  errors: readonly WithdrawFieldError[],
  field: WithdrawFieldName,
): WithdrawFieldError | null {
  return errors.find((item) => item.field === field) ?? null;
}

/**
 * Собрать состояние экрана из ввода и фактов счёта.
 *
 * Порядок проверок задан ценой ошибки, а не удобством: сначала есть ли вообще
 * что выводить и куда, потом валюта, потом сумма. Сумма, разобранная в валюте,
 * которой у клиента нет, — это ответ на несуществующий вопрос.
 */
export function buildWithdrawForm(
  input: WithdrawInput,
  facts: WithdrawFormOptions,
): WithdrawFormView {
  const errors: WithdrawFieldError[] = [];
  const active = facts.activeStatus !== null && !isTerminalWithdrawalStatus(facts.activeStatus);
  const nothingToWithdraw = facts.options.length === 0;

  // Счёт-источник — не поле, а условие. Оба отказа закрытые и разные: счёта нет
  // вовсе либо счёт не на имя плательщика (инвариант 20). Второе не смягчается
  // до первого: «мы не знаем счёт» и «счёт чужой» — разные новости.
  if (facts.source === null) {
    errors.push({
      field: 'source',
      messageKey: 'withdraw.form.error.source.unknown',
      params: null,
      guard: 'g_source_account_known',
    });
  } else if (!facts.source.holderIsPayer) {
    errors.push({
      field: 'source',
      messageKey: 'withdraw.form.error.source.holder',
      params: null,
      guard: 'g_source_account_known',
    });
  }
  if (active) {
    errors.push({
      field: 'amount',
      messageKey: 'withdraw.form.error.active',
      params: null,
      guard: 'g_no_active_withdrawal',
    });
  }

  const requested = input.currency;
  const chosen =
    requested !== '' && isCurrencyCode(requested)
      ? facts.options.find((item) => item.currency === requested) ?? null
      : null;
  if (requested !== '' && chosen === null) {
    errors.push({
      field: 'currency',
      messageKey: 'withdraw.form.error.currency.free',
      params: null,
      guard: 'g_free_balance_sufficient',
    });
  }
  const option = chosen ?? facts.options[0] ?? null;
  const currency = option?.currency ?? null;
  const free = option?.free ?? null;

  // «Всё свободное» — не подсказка, а подстановка: поле получает ровно тот
  // остаток, который стоит рядом, и дальше идёт по общему пути разбора. Иначе
  // кнопка и поле начинают говорить о разных числах.
  const amountText = input.fillMax && free !== null ? toDecimalString(free) : input.amountText;

  let amount: Money<CurrencyCode> | null = null;
  // Нажатие на «продолжить» — это тоже обращение к полю: пустая форма после
  // отправки обязана сказать «сумма не названа», а не молча перерисоваться.
  const touched = amountText.trim() !== '' || input.step !== 'form';
  if (option !== null && free !== null && touched) {
    const parsed = parseAmount(option.currency, amountText);
    amount = parsed.amount;
    if (parsed.error !== null) errors.push(parsed.error);
    if (amount !== null) {
      const clientFacts: ClientAccountFacts = {
        free,
        locked: [],
        requestedAmount: amount,
        sourceAccount:
          facts.source === null
            ? null
            : { accountRef: facts.source.accountRef, holderIsPayer: facts.source.holderIsPayer },
        preparedBy: null,
        approvals: [],
        activeWithdrawals: active ? 1 : 0,
      };
      // Отказ по остатку приходит из домена, но названы два разных случая:
      // ноль и минус — это «сумма не названа», а не «денег не хватает».
      if (!evaluateWithdrawalGuard('g_free_balance_sufficient', clientFacts)) {
        errors.push(
          isPositive(amount)
            ? {
                field: 'amount',
                messageKey: 'withdraw.form.error.amount.free',
                // Свободный остаток в текст ошибки подставляет **экран**: сумма
                // форматируется `Intl` по локали, а локали в этом слое нет и
                // быть не должно. Своих форматтеров денег в проекте ноль
                // (`CLAUDE.md`, «Три языка»), и `toDecimalString` здесь дал бы
                // клиенту «1016231.00» вместо «1 016 231,00 ₾».
                params: null,
                guard: 'g_free_balance_sufficient',
              }
            : {
                field: 'amount',
                messageKey: 'withdraw.form.error.amount.positive',
                params: null,
                guard: 'g_free_balance_sufficient',
              },
        );
      }
    }
  }

  const formAvailable = !nothingToWithdraw && !active;
  const canSubmit = formAvailable && amount !== null && errors.length === 0;
  // Шаг не может быть дальше, чем позволяет проверка: адрес со `step=submitted`
  // и негодной суммой обязан вернуть форму с ошибкой, а не «созданную заявку».
  // Иначе состояние экрана задаёт адресная строка, а не факты.
  const step: WithdrawStep = canSubmit ? input.step : 'form';

  return {
    step,
    options: facts.options,
    currency,
    free,
    amountText,
    amount,
    errors,
    source: facts.source,
    approvalsRequired: WITHDRAWAL_REQUIRED_APPROVALS,
    formAvailable,
    activeStatus: facts.activeStatus,
    canSubmit,
  };
}
