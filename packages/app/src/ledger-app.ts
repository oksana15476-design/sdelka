import {
  type CurrencyCode,
  type Deduction,
  type Money,
  isPositive,
  money,
  split,
  subtract,
} from '@sdelka/money';
import {
  type ClientKey,
  type EntryMeta,
  type FeeAccrual,
  type JournalEntry,
  type TrancheRef,
  accrueFee,
  bankNominal,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  createJournalEntry,
  credit,
  debit,
  lockForTranche,
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
   * ⚠ Поля `lockedForTranche` здесь больше нет, и это главное изменение слоя.
   *
   * Оно существовало ровно ради одного шаблона — отвязки при возврате — потому
   * что запирание средств под транш не было намерением автомата, и обратный
   * шаг автомат порождал вслепую: он не знал, запирались ли деньги вообще.
   * Транш, у которого деньги так и остались в свободной части счёта
   * покупателя, отвязывать было нечем, и проекция гасила намерение сама.
   *
   * Сегодня запертую сумму несут факты транша (`TrancheFacts.lockedAmount`,
   * читается из журнала в `contextFor`), и решение «двигать или нечего»
   * принимает автомат: при пустом файле он не порождает намерения вовсе. Защит
   * от пустого файла было три — здесь по остатку, в интерфейсе по флагу, в
   * проекции домена никакой; теперь их ноль, потому что случая нет.
   */
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
 * Конвертации здесь **больше нет**.
 *
 * Раньше её собирало приложение своим `convertClientBalance` — одной записью:
 * исходная валюта списывалась со счёта клиента, встречная дебетовалась на
 * номинальный счёт, спред уходил на операционный. Внешнего контрагента в этой
 * записи не было вовсе, то есть номинальный счёт в валюте, которой платформа
 * не держала, вырастал из нуля, а обязательство перед клиентом и покрытие под
 * него создавала одна и та же запись: отношение покрытия после конвертации
 * тождественно равнялось единице и не проверяло больше ничего.
 *
 * Сегодня конвертация — два момента словаря учёта (`sendForConversion` и
 * `receiveConversion`), и приложение только зовёт их по очереди
 * (`flow.ts`). Второй реализации той же записи здесь быть не должно: повторённая
 * от руки форма расходится молча, и ровно так модели проводок однажды и
 * разошлись.
 */

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
          reasonKey: 'app.ledger.funds_already_credited',
        };
      }
      return { kind: 'entry', entry: creditIncomingPayment(context.meta, owner, amount) };
    /**
     * Привязка к сделке — вход в `reserved` (FUNCTIONAL.md §3.1). Раньше это
     * был отдельный экспорт `lockFundsForTranche`, который тест обязан был не
     * забыть позвать; момент запирания при этом отличался от того, что делала
     * проекция домена, и от того, что делал интерфейс, — три ответа на вопрос,
     * которого автомат не задавал.
     *
     * Маршрут поступления здесь ни при чём: где бы деньги ни были зачислены,
     * запираются они одинаково.
     */
    case 'lock_funds':
      return { kind: 'entry', entry: lockForTranche(context.meta, owner, deal, amount) };
    /**
     * Расфиксация по снятию резерва — та же словарная запись, что и отвязка при
     * возврате. Её не было ни у одной проекции: при `reserve_expired` деньги в
     * учёте оставались запертыми под траншем, который в интерфейсе уже считался
     * свободным (`CABINETS.md` §3.2 блок 6, §3.4).
     */
    case 'unlock_funds':
      return { kind: 'entry', entry: unlockToClientAccount(context.meta, owner, deal, amount) };
    /**
     * Возврат, момент 1: отвязка от транша. Деньги никуда не уходили — они на
     * номинальном счёте и снова отзывные (красная линия №7). Конструктор берётся
     * из словаря учёта: у отвязки он есть, и второй реализации той же записи в
     * приложении быть не должно.
     *
     * Пустой файл транша — не ошибка, а второй законный случай: деньги дошли до
     * возврата, ни разу не покинув свободную часть счёта покупателя (возврат из
     * `collecting`, из `collected` до резерва, после отката резерва). Разбирает
     * его теперь автомат: сумма отвязки берётся из `facts.lockedAmount`, и при
     * пустом файле намерения не возникает вовсе — гасить здесь нечего.
     */
    case 'refund_unlock':
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
 * Контекст проекции расчёта: всё то же плюс две величины, которых у намерения
 * нет и быть не может.
 */
export interface SettlementProjectionContext extends ProjectionContext {
  /**
   * Отметка второй записи — начисления комиссии. Записей теперь две, значит и
   * идентификаторов два: один на две записи журнал не примет.
   */
  readonly accrualMeta: EntryMeta;
  /**
   * Версия тарифного плана, по которой посчитана комиссия (`CORE.md` Ф16,
   * И14.3). Уходит фактом в журнал вместе с начислением, чтобы пересчёт задним
   * числом был невозможен.
   *
   * ⚠ Её место — на сделке, в `packages/domain`: И14.3 требует, чтобы
   * идентификатор версии плана хранился на сделке. Пока его там нет, приложение
   * держит его при транше (`TrancheRuntime.tariffVersionId`) и приносит сюда.
   * Названо в отчёте, не спрятано.
   */
  readonly tariffVersionId: string;
}

/**
 * Расчёт — **две встречные записи, а не одна** (`CORE.md` Ф16, И14.1).
 *
 * Начислено, удержано и получено — три разные величины, и до этого батча они
 * были одним числом: расчёт кредитовал `fee:income` прямо в своей записи, и
 * различить «комиссия признана доходом» и «комиссия физически у нас» было
 * нечем. Теперь начисление — отдельная запись (`accrueFee`), а расчёт её
 * **гасит**: комиссия приходит в конструктор токеном начисления, а не суммой,
 * поэтому удержать неначисленное невозможно по типам.
 *
 * Нулевая комиссия — отсутствие комиссии, а не проводка на ноль: тариф, ничего
 * не берущий, начисления не порождает вовсе, и расчёт тогда собирается без
 * удержания (`withheld === null`).
 */
export interface ProjectedSettlement {
  /** По порядку: начисление (если есть) и сам расчёт. Порядок значим. */
  readonly entries: readonly JournalEntry[];
  /** Начисление, если оно было: нужно тому, кто потом отразит получение. */
  readonly accrual: FeeAccrual | null;
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
  context: SettlementProjectionContext,
): ProjectedSettlement {
  const amount = intent.amount;
  const fee = feeOf(amount, context.deductions);
  const deal: TrancheRef = { dealId: intent.dealId, trancheId: intent.trancheId };
  const accrual = isPositive(fee)
    ? accrueFee(context.accrualMeta, deal, fee, context.tariffVersionId)
    : null;
  // Расчёт — одна запись, включающая **вывод комиссии с номинального счёта**:
  // отдельного шага вывода больше нет, и «забыть» его невозможно
  // (красная линия №2, `ledger/src/entry.ts`,
  // `assertPlatformIncomeSweptToOperating`). Комиссия при этом уходит не сразу
  // на операционный счёт, а в транзит: межбанк идёт день-два, и утверждать
  // обратное было бы враньём в проводке (`FUNCTIONAL.md` §3.1).
  const settlement = settleTrancheToClientAccount(
    context.meta,
    trancheSettlement(
      deal,
      clientKey(intent.payerClientKey),
      clientKey(intent.recipientClientKey),
      intent.attestation,
    ),
    amount,
    accrual,
  );
  return {
    entries: accrual === null ? [settlement] : [accrual, settlement],
    accrual,
  };
}

/** Ноль в валюте: удобство для сборки фикстур, а не бизнес-правило. */
export function zeroOf(currency: CurrencyCode): Money<CurrencyCode> {
  return money(currency, 0n);
}
