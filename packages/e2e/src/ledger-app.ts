import {
  type ConvertedAmount,
  type CurrencyCode,
  type Deduction,
  type Money,
  type PlatformSpread,
  isPositive,
  money,
  split,
  subtract,
} from '@sdelka/money';
import {
  type ClientKey,
  type EntryMeta,
  type JournalEntry,
  type TrancheRef,
  bankNominal,
  bankOperating,
  clientFreeAccount,
  clientLockedAccount,
  createJournalEntry,
  credit,
  debit,
  settleTrancheToClientAccount,
  trancheSettlement,
  unclaimedLiability,
} from '@sdelka/ledger';
import type { Intent, LedgerTemplate } from '@sdelka/domain';

/**
 * Проекция намерений автомата в проводки — слой приложения.
 *
 * Домен намеренно ничего не пишет в журнал сам: он возвращает намерения
 * (`FUNCTIONAL.md` инвариант 15). Здесь эти намерения превращаются в записи
 * словаря `@sdelka/ledger`. Сквозной прогон вскрыл, что словарь и перечень
 * шаблонов домена (`LedgerTemplate`) не совпадают ни по составу, ни по объёму
 * данных — всё, что ниже собрано `createJournalEntry` вручную, отмечено
 * комментарием и вынесено в отчёт.
 */

/** Куда попали деньги к моменту события `funds_received` у транша. */
export type CreditRoute =
  /** Платёж пришёл снаружи в валюте транша: событие транша и есть зачисление. */
  | 'external_arrival'
  /**
   * Деньги уже на свободной части счёта клиента — пришли раньше и, возможно, в
   * другой валюте (конвертация — отдельное событие). Повторное зачисление
   * удвоило бы обязательство.
   */
  | 'already_on_client_account';

export interface ProjectionContext {
  readonly meta: EntryMeta;
  readonly deal: TrancheRef;
  /** Владелец обязательства по траншу: он же плательщик. */
  readonly payer: ClientKey;
  /**
   * Получатель расчёта. В намерении `post_journal_entry` его **нет**: интент
   * несёт только `clientKey` плательщика. Приложение достаёт получателя из
   * своего состояния (отчёт, расхождение 3).
   */
  readonly recipient: ClientKey;
  /** Удержания платформы. В намерении их тоже нет — считаются здесь, из `@sdelka/money`. */
  readonly deductions: readonly Deduction[];
  readonly route: CreditRoute;
}

export type ProjectedIntent =
  | { readonly kind: 'entry'; readonly entry: JournalEntry }
  /** Намерение принято, но проводки у него нет. Причина — ключ, а не текст. */
  | { readonly kind: 'no_entry'; readonly template: LedgerTemplate; readonly reasonKey: string };

/**
 * Комиссия платформы по правилам `@sdelka/money` §4.3: остаток от округления
 * всегда у получателя, поэтому комиссия считается вычитанием из общей суммы.
 */
export function feeOf(
  gross: Money<CurrencyCode>,
  deductions: readonly Deduction[],
): Money<CurrencyCode> {
  return subtract(gross, split(gross, deductions).recipient);
}

/**
 * Зачисление на счёт клиента.
 *
 * Отдельная функция, а не проекция намерения: `entries.ts` называет зачисление
 * на счёт клиента и привязку к сделке **разными событиями** (И12.1), а домен
 * порождает намерение `funds_received` только на входе в `collected`. Развести
 * их может только приложение.
 */
export function creditIncomingPayment(
  meta: EntryMeta,
  owner: ClientKey,
  amount: Money<CurrencyCode>,
): JournalEntry {
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.client_top_up',
    postings: [
      debit(bankNominal(amount.currency), amount, { clientKey: owner }),
      credit(clientFreeAccount(owner), amount, { clientKey: owner }),
    ],
  });
}

/**
 * Поступление, которое нельзя отнести на сделку: платёж третьего лица
 * (`FUNCTIONAL.md` инвариант 19, §3.3 шаг 1). Деньги физически пришли и обязаны
 * быть в учёте, но обязательство перед покупателем из них не возникает.
 *
 * ⚠ Конструктора этой формы в `entries.ts` нет: там есть только
 * `identifySuspense` — выход из непознанного, но не вход в него. Отчёт,
 * расхождение 5.
 */
export function holdUnidentifiedPayment(
  meta: EntryMeta,
  amount: Money<CurrencyCode>,
): JournalEntry {
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.suspense_received',
    postings: [
      debit(bankNominal(amount.currency), amount),
      credit({ kind: 'suspense_unidentified' }, amount),
    ],
  });
}

/** Возврат непознанного поступления отправителю. Тоже отсутствует в словаре. */
export function returnUnidentifiedPayment(
  meta: EntryMeta,
  amount: Money<CurrencyCode>,
): JournalEntry {
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.suspense_returned',
    postings: [
      debit({ kind: 'suspense_unidentified' }, amount),
      credit(bankNominal(amount.currency), amount),
    ],
  });
}

/**
 * Конвертация остатка клиента.
 *
 * Клиенту зачисляется сумма по клиентскому курсу; наш спред между эталонным и
 * клиентским курсом признаётся доходом и **сразу уходит на операционный счёт**,
 * а не оседает на номинальном. Это та же норма, что и для комиссии (красная
 * линия №2): чужой счёт не место для наших денег.
 *
 * ⚠ Конструктора конвертации в `entries.ts` нет. Отчёт, расхождение 5.
 */
export function convertClientBalance(
  meta: EntryMeta,
  owner: ClientKey,
  converted: ConvertedAmount<CurrencyCode, CurrencyCode>,
  spread: PlatformSpread<CurrencyCode>,
): JournalEntry {
  const ref = { clientKey: owner };
  const source = converted.source;
  const target = converted.target;
  if (spread.amount.minor < 0n) {
    // Отрицательный спред означает, что клиентский курс лучше эталонного. Это
    // не арифметическая мелочь, а убыток платформы, и проводка у него другая.
    // Здесь он не собирается намеренно: молча вывернуть направление значило бы
    // признать убыток доходом.
    throw new Error('e2e.fx.negative_spread');
  }
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.fx_conversion',
    postings: [
      debit(clientFreeAccount(owner), source, ref),
      credit(bankNominal(source.currency), source, ref),
      debit(bankNominal(target.currency), target, ref),
      credit(clientFreeAccount(owner), target, ref),
      ...(isPositive(spread.amount)
        ? [
            debit(bankOperating(spread.amount.currency), spread.amount),
            credit({ kind: 'fx_income' } as const, spread.amount),
          ]
        : []),
    ],
  });
}

/**
 * Возврат покупателю наружу, на счёт-источник (красная линия №9).
 *
 * Деньги уходят со свободной части счёта клиента и с номинального счёта. Что
 * счёт именно тот, с которого пришли, и на имя плательщика, проверяет
 * `assessRefundDestination` в `@sdelka/compliance` и guard
 * `g_source_account_known` в домене — журнал этого не знает и знать не может.
 *
 * ⚠ Конструктора внешнего возврата в `entries.ts` нет. Отчёт, расхождение 5.
 */
export function refundToSourceAccount(
  meta: EntryMeta,
  owner: ClientKey,
  amount: Money<CurrencyCode>,
): JournalEntry {
  const ref = { clientKey: owner };
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.refund_to_source',
    postings: [
      debit(clientFreeAccount(owner), amount, ref),
      credit(bankNominal(amount.currency), amount, ref),
    ],
  });
}

/**
 * Списание невостребованных средств (случай Б, `FUNCTIONAL.md` §3.1).
 * Обязательство остаётся долгом (`unclaimed_liability`), деньги уходят с
 * номинального счёта на операционный.
 *
 * ⚠ Конструктора списания в `entries.ts` нет. Отчёт, расхождение 5.
 */
export function writeOffUnclaimed(
  meta: EntryMeta,
  owner: ClientKey,
  deal: TrancheRef,
  amount: Money<CurrencyCode>,
): JournalEntry {
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.written_off',
    postings: [
      debit(clientLockedAccount(owner, deal.dealId, deal.trancheId), amount, deal),
      credit(unclaimedLiability, amount),
      credit(bankNominal(amount.currency), amount, deal),
      debit(bankOperating(amount.currency), amount),
    ],
  });
}

/**
 * Проекция намерения `post_journal_entry`.
 *
 * Шаблонов у домена четыре, конструкторов в словаре учёта шесть, и пересекаются
 * они на одном — расчёте по траншу. Остальное собрано выше вручную.
 */
export function projectLedgerIntent(
  intent: Extract<Intent, { type: 'post_journal_entry' }>,
  context: ProjectionContext,
): ProjectedIntent {
  const amount = intent.amount;
  switch (intent.template) {
    case 'funds_received':
      if (context.route === 'already_on_client_account') {
        // Деньги уже на счёте клиента: их зачислила отдельная запись при
        // поступлении, а событие транша только относит их на сделку. Второе
        // зачисление удвоило бы обязательство и сломало покрытие.
        return {
          kind: 'no_entry',
          template: intent.template,
          reasonKey: 'e2e.ledger.funds_already_credited',
        };
      }
      return { kind: 'entry', entry: creditIncomingPayment(context.meta, context.payer, amount) };
    case 'payout_with_fee': {
      const fee = feeOf(amount, context.deductions);
      // Расчёт — одна запись, включающая вывод комиссии на операционный счёт:
      // отдельного шага вывода больше нет, и «забыть» его невозможно
      // (красная линия №2, `ledger/src/entry.ts`,
      // `assertPlatformIncomeSweptToOperating`). Раньше приложение выводило
      // комиссию вручную вторым движением; теперь такое движение создало бы
      // недостачу по файлу транша, который расчёт уже опустошил.
      //
      // Объявление расчёта называет сделку, транш, плательщика и получателя
      // одним значением и **остаётся в записи**: претензия «получатель — по
      // этой сделке» стала фактом журнала, а не следствием формы проводок
      // (красная линия №1).
      return {
        kind: 'entry',
        entry: settleTrancheToClientAccount(
          context.meta,
          trancheSettlement(context.deal, context.payer, context.recipient),
          amount,
          fee,
        ),
      };
    }
    case 'refund':
      return { kind: 'entry', entry: refundToSourceAccount(context.meta, context.payer, amount) };
    case 'write_off':
      return {
        kind: 'entry',
        entry: writeOffUnclaimed(context.meta, context.payer, context.deal, amount),
      };
  }
}

/** Ноль в валюте: удобство для сборки фикстур, а не бизнес-правило. */
export function zeroOf(currency: CurrencyCode): Money<CurrencyCode> {
  return money(currency, 0n);
}
