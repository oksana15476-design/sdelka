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
  clientKey,
  clientLockedAccount,
  createJournalEntry,
  credit,
  debit,
  settleTrancheToClientAccount,
  trancheSettlement,
  transitWriteoff,
  unclaimedLiability,
  unlockToClientAccount,
  refundToSourceAccount,
  writeOffTransitArrived,
  writeOffUnclaimed,
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

/**
 * Всё, чего нет в намерении.
 *
 * ⚠ Здесь больше нет ни плательщика, ни получателя, и это главное изменение
 * слоя. Раньше оба приезжали сюда параметрами приложения: намерение несло
 * только сумму, а кому именно кредитуется расчёт, решал вызывающий — то есть
 * связи «получатель ↔ сделка» не существовало вовсе, и деньги покупателя
 * законно оседали у произвольного лица (красная линия №1). Сегодня стороны
 * приходят в самом намерении: плательщик — в `clientKey`, а получатель — в
 * отдельном намерении расчёта вместе с подтверждением домена, которого
 * приложению нечем подделать.
 *
 * Осталось ровно то, чего домен не знает: сколько удерживает платформа (§4.3,
 * считает `@sdelka/money`) и куда деньги уже попали к моменту события.
 */
export interface ProjectionContext {
  readonly meta: EntryMeta;
  /** Удержания платформы. В намерении их нет — считаются здесь, из `@sdelka/money`. */
  readonly deductions: readonly Deduction[];
  readonly route: CreditRoute;
  /**
   * Сколько сейчас заперто в файле транша — читается из журнала приложением.
   *
   * Нужно ровно одному шаблону: отвязке при возврате. Запирание средств под
   * транш — шаг приложения, у автомата намерения на него нет (отчёт,
   * расхождение 2), поэтому и обратный шаг автомат порождает вслепую: он не
   * знает, запирались ли деньги вообще. Транш, у которого деньги так и остались
   * в свободной части счёта покупателя, отвязывать нечем — и такая отвязка
   * увела бы запертую часть в минус.
   */
  readonly lockedForTranche: Money<CurrencyCode>;
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
 * Проекция намерения `post_journal_entry`.
 *
 * Плательщик приезжает **в самом намерении** (`clientKey`), а не параметром
 * приложения: домен адресует счёт клиента владельцем, и подставить сюда чужой
 * ключ приложению больше нечем. Расчёт здесь не разбирается вовсе — у него
 * отдельное намерение и отдельная проекция ниже.
 */
export function projectLedgerIntent(
  intent: Extract<Intent, { type: 'post_journal_entry' }>,
  context: ProjectionContext,
): ProjectedIntent {
  const amount = intent.amount;
  const owner = clientKey(intent.clientKey);
  const deal: TrancheRef = { dealId: intent.dealId, trancheId: intent.trancheId };
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
      return { kind: 'entry', entry: creditIncomingPayment(context.meta, owner, amount) };
    /**
     * Возврат, момент 1: отвязка от транша. Деньги никуда не уходили — они на
     * номинальном счёте и снова отзывные (красная линия №7). Конструктор берётся
     * из словаря учёта: у отвязки он есть, и второй реализации той же записи в
     * приложении быть не должно.
     *
     * Пустой файл транша — не ошибка, а второй законный случай: деньги дошли до
     * возврата, ни разу не покинув свободную часть счёта покупателя (возврат из
     * `collecting`, из `collected` до резерва, после отката резерва). Отвязывать
     * тогда нечего, и подавленное намерение видно тесту в `world.suppressed`, а
     * не проваливается молча.
     *
     * Нулём проверяется именно ноль, а не «меньше суммы»: частичный остаток в
     * файле — это расхождение, и его обязана поймать запись, а не спрятать
     * проекция.
     */
    case 'refund_unlock':
      if (context.lockedForTranche.minor === 0n) {
        return {
          kind: 'no_entry',
          template: intent.template,
          reasonKey: 'e2e.ledger.tranche_file_empty',
        };
      }
      return {
        kind: 'entry',
        entry: unlockToClientAccount(context.meta, owner, deal, amount),
      };
    /** Возврат, момент 2: уход с номинального счёта на счёт-источник (И12.2). */
    case 'refund_external':
      return { kind: 'entry', entry: refundToSourceAccount(context.meta, owner, amount) };
    /**
     * Списание такой поблажки не получает намеренно: невостребованными могут
     * стать только деньги, которые в файле транша есть. Транш, до которого
     * деньги не дошли, намерения не порождает вовсе — суммы у него нет
     * (`moneyForTemplate` вернёт `null`), — поэтому пустой файл здесь означает
     * расхождение, и оно обязано упасть записью, а не быть подавленным.
     */
    case 'write_off':
      return { kind: 'entry', entry: writeOffUnclaimed(context.meta, owner, deal, amount) };
  }
}

/**
 * Проекция намерения `post_settlement_entry`.
 *
 * ⚠ Изготавливать здесь нечего, и в этом весь смысл. Подтверждение сторон
 * приходит **внутри намерения**: его выдал автомат транша в момент расчёта, для
 * той пары, которую записал акт об условии, со ссылкой на пакет доказательств.
 * Приложение может только передать его дальше — построить своё оно не может
 * (у `DealPartiesAttestation` ambient-ключ, значения которого не существует),
 * а подставить другого получателя не может, потому что учёт сверит его с
 * подтверждением и ответит `settlementAttestationMismatch`.
 *
 * Отсюда и следствие: собрать проводку расчёта, не пройдя через автомат
 * транша, приложению нечем. «Просто выплатить» не существует как операция
 * (красная линия №5) — не потому, что запрещено, а потому, что нечем.
 */
export function projectSettlementIntent(
  intent: Extract<Intent, { type: 'post_settlement_entry' }>,
  context: ProjectionContext,
): ProjectedIntent {
  const amount = intent.amount;
  const fee = feeOf(amount, context.deductions);
  // Расчёт — одна запись, включающая вывод комиссии на операционный счёт:
  // отдельного шага вывода больше нет, и «забыть» его невозможно
  // (красная линия №2, `ledger/src/entry.ts`,
  // `assertPlatformIncomeSweptToOperating`).
  return {
    kind: 'entry',
    entry: settleTrancheToClientAccount(
      context.meta,
      trancheSettlement(
        { dealId: intent.dealId, trancheId: intent.trancheId },
        clientKey(intent.payerClientKey),
        clientKey(intent.recipientClientKey),
        intent.attestation,
      ),
      amount,
      fee,
    ),
  };
}

/** Ноль в валюте: удобство для сборки фикстур, а не бизнес-правило. */
export function zeroOf(currency: CurrencyCode): Money<CurrencyCode> {
  return money(currency, 0n);
}
