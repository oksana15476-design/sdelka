import {
  type CurrencyCode,
  type Money,
  type PlatformSpread,
  add,
  assertSameCurrency,
  isNegative,
  isPositive,
  subtract,
} from '@sdelka/money';
import {
  type Account,
  type ClientKey,
  assertAccountIdentifier,
  bankNominal,
  bankOperating,
  clientFreeAccount,
  clientLockedAccount,
  feeReceivable,
  fxSettlement,
  shortfallExpense,
  transitFee,
  transitWriteoff,
  unclaimedLiability,
} from './accounts';
import {
  type ClientRef,
  type FeeAccrualDeclaration,
  type FxExecution,
  type JournalEntry,
  type TrancheRef,
  type TrancheSettlement,
  createJournalEntry,
  credit,
  debit,
} from './entry';
import { LedgerError, LedgerErrorCode } from './errors';
import { type Journal, appendEntry } from './journal';

/**
 * Словарь записей — FUNCTIONAL.md §3.1.
 *
 * Здесь красная линия №1 держится **структурой, а не проверкой**: ни у одной
 * функции на входе нет двух траншей, поэтому «перенести деньги со сделки А на
 * сделку Б» в этом словаре невыразимо — не запрещено, а именно невыразимо.
 * Законный путь всегда в два шага: отвязка в свободную часть (событие автомата
 * сделки А) и отдельная привязка к сделке Б.
 *
 * `createJournalEntry` остаётся низкоуровневой дверью и держит второй контур
 * для записей, собранных помимо словаря: `assertNoLockedToLocked`,
 * `assertClientOwnerMoveOnlySettles`, направление пулов и — общее правило,
 * которое не знает ни одного имени счёта, — `assertNoUnfundedClientFileGain`.
 *
 * Ни одна функция не считает суммы: расщепление и округление — забота
 * `@sdelka/money` (§4.3), учёт только записывает результат.
 */
export interface EntryMeta {
  readonly id: string;
  readonly occurredAt: string;
}

function clientRef(owner: ClientKey): ClientRef {
  return { clientKey: owner };
}

function trancheRef(dealId: string, trancheId: string): TrancheRef {
  return { dealId, trancheId };
}

function custodyOf(amount: Money<CurrencyCode>): Account {
  return bankNominal(amount.currency);
}

/**
 * Запись плюс скрытые поля — носитель токена (`RecognisedShortfall`,
 * `FeeAccrual`).
 *
 * Поля **неперечислимые** намеренно. Токен нужен типам, а не журналу: запись,
 * попавшая в журнал, обязана остаться ровно `JournalEntry` — с той же формой
 * при сериализации, при сравнении в тестах и в выгрузке для бухгалтерии.
 * Перечислимое поле изменило бы значение записи ради удобства конструктора.
 */
function withToken<E extends Record<string, unknown>>(
  entry: JournalEntry,
  extra: E,
): JournalEntry & E {
  const copy: Record<string, unknown> = { ...entry };
  const descriptors: PropertyDescriptorMap = {};
  for (const [key, value] of Object.entries(extra)) {
    descriptors[key] = { value, enumerable: false, writable: false, configurable: false };
  }
  return Object.freeze(Object.defineProperties(copy, descriptors)) as JournalEntry & E;
}

/**
 * Зачисление на счёт клиента: деньги пришли, плательщик опознан, сделка ещё не
 * выбрана. Отдельное событие от привязки к сделке (И12.1), сумма записи — ноль.
 *
 * Сюда же ведут правила §4.3.2: недоплата сверх допуска и дробные платежи
 * накапливаются на счёте клиента, а не на транше.
 */
export function clientTopUp(
  meta: EntryMeta,
  owner: ClientKey,
  amount: Money<CurrencyCode>,
): JournalEntry {
  const ref = clientRef(owner);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.client_top_up',
    postings: [
      debit(custodyOf(amount), amount, ref),
      credit(clientFreeAccount(owner), amount, ref),
    ],
  });
}

/**
 * Непознанное поступление опознано: обязательство переезжает с
 * `suspense:unidentified` на свободную часть счёта клиента, а вместе с ним —
 * отнесение денег на номинальном счёте.
 *
 * Две проводки по номинальному счёту гасят друг друга в сумме и существуют
 * ровно ради переноса файла: без них деньги остались бы обезличенными, а
 * обязательство перед клиентом — необеспеченным.
 */
export function identifySuspense(
  meta: EntryMeta,
  owner: ClientKey,
  amount: Money<CurrencyCode>,
): JournalEntry {
  const ref = clientRef(owner);
  const custody = custodyOf(amount);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.suspense_identified',
    postings: [
      debit({ kind: 'suspense_unidentified' }, amount),
      credit(clientFreeAccount(owner), amount, ref),
      credit(custody, amount),
      debit(custody, amount, ref),
    ],
  });
}

/**
 * Привязка к сделке: свободные деньги клиента запираются под транш.
 *
 * Четыре проводки (FUNCTIONAL.md §3.1). Две последние переносят отнесение
 * кастодиана из файла клиента в файл транша: без них обязательство по траншу
 * появляется, а деньги остаются в файле клиента, и транш немедленно становится
 * необеспеченным, хотя ни одна купюра никуда не двигалась.
 *
 * «Хватает ли свободного остатка» здесь не проверяется: конструктор записи не
 * видит журнала и видеть не должен. Предпроверка — `freeBalance`, второй контур
 * — инвариант отрицательного остатка клиентского счёта и стоп-кран.
 */
export function lockForTranche(
  meta: EntryMeta,
  owner: ClientKey,
  deal: TrancheRef,
  amount: Money<CurrencyCode>,
): JournalEntry {
  const client = clientRef(owner);
  const tranche = trancheRef(deal.dealId, deal.trancheId);
  const custody = custodyOf(amount);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.locked_for_tranche',
    postings: [
      debit(clientFreeAccount(owner), amount, client),
      credit(clientLockedAccount(owner, deal.dealId, deal.trancheId), amount, tranche),
      credit(custody, amount, client),
      debit(custody, amount, tranche),
    ],
  });
}

/**
 * Отвязка: резерв снят (отзыв покупателем, истечение резерва, отмена сделки) —
 * деньги возвращаются в свободную часть счёта **того же** клиента.
 *
 * Владелец один и тот же по построению: другого аргумента-владельца у функции
 * нет. Красная линия №7 — состояние по умолчанию при бездействии есть возврат,
 * и возвращать его некуда, кроме собственного счёта клиента.
 */
export function unlockToClientAccount(
  meta: EntryMeta,
  owner: ClientKey,
  deal: TrancheRef,
  amount: Money<CurrencyCode>,
): JournalEntry {
  const client = clientRef(owner);
  const tranche = trancheRef(deal.dealId, deal.trancheId);
  const custody = custodyOf(amount);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.unlocked_to_client',
    postings: [
      debit(clientLockedAccount(owner, deal.dealId, deal.trancheId), amount, tranche),
      credit(clientFreeAccount(owner), amount, client),
      credit(custody, amount, tranche),
      debit(custody, amount, client),
    ],
  });
}

/**
 * Переплата (FUNCTIONAL.md §4.3.2): транш зачисляется ровно на требуемую сумму,
 * излишек — в свободную часть счёта клиента **сразу**, а не после закрытия
 * сделки. Деньги, не попавшие под условие расчёта, обязаны остаться отзывными
 * (красная линия №7); удержание излишка до закрытия — удержание чужих денег без
 * основания.
 *
 * Одна запись, а не две: пришёл один платёж, и разделение на «под условие» и
 * «сверх условия» — свойство этого платежа, а не два независимых события.
 */
export function overpaymentToClientAccount(
  meta: EntryMeta,
  owner: ClientKey,
  deal: TrancheRef,
  required: Money<CurrencyCode>,
  excess: Money<CurrencyCode>,
): JournalEntry {
  if (!isPositive(excess)) {
    // Переплата без излишка — это обычное поступление, и записывать её этой
    // формой значит прятать ноль в проводке. Ноль отвергается конструктором
    // записи, но с невнятным кодом, поэтому отказ явный.
    throw new LedgerError(LedgerErrorCode.entryNonPositiveExcess, {
      amount: excess.minor.toString(),
    });
  }
  // Переплата — свойство одного платежа, поэтому обе части в одной валюте.
  // Платёж в другой валюте — это другое поступление, а не излишек по этому.
  assertSameCurrency(required, excess);
  const client = clientRef(owner);
  const tranche = trancheRef(deal.dealId, deal.trancheId);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.overpayment',
    postings: [
      debit(custodyOf(required), required, tranche),
      credit(clientLockedAccount(owner, deal.dealId, deal.trancheId), required, tranche),
      debit(custodyOf(excess), excess, client),
      credit(clientFreeAccount(owner), excess, client),
    ],
  });
}

/**
 * Расчёт по траншу в пользу получателя (И12.1, четвёртый критерий приёмки):
 * деньги от продажи попадают в **свободную** часть счёта получателя — того же
 * счёта, что и всё остальное, а не в отдельный «счёт продавца». Вывод наружу —
 * отдельное событие (И12.2).
 *
 * ```
 * Дт client:{плательщик}:tranche:{сделка}:{транш}   брутто   файл транша
 *     Кт client:{получатель}:free                     нетто   файл получателя
 *     Кт fee:receivable                             комиссия   файл транша
 * Кт bank:nominal                                    брутто   файл транша
 * Дт bank:nominal                                     нетто   файл получателя
 * Дт transit:fee                                   комиссия   файл транша
 * ```
 *
 * **[исправляет предыдущее] Комиссия здесь больше не признаётся доходом и не
 * ложится на операционный счёт.** Прежняя редакция кредитовала `fee:income` и
 * дебетовала `bank:operating` внутри записи расчёта — то есть утверждала, что
 * межбанковский перевод уже дошёл, в тот же миг, когда он только начинается.
 * Ровно этот зазор описан в §3.1 для списания невостребованного («два момента,
 * а не один») и ровно его требует видеть Ф10: **начислено, удержано и получено
 * — три разные величины**. Пока их было две, «удержано, но не переведено» было
 * невыразимо.
 *
 * Теперь расчёт делает ровно одно: **удерживает** уже начисленную комиссию.
 * Требование гасится (`Кт fee:receivable`), деньги уходят в транзит
 * (`Дт transit:fee`) и доходят до операционного счёта третьей записью
 * (`receiveFee`).
 *
 * Красная линия №2 держится по-прежнему и в той же силе: комиссия уходит с
 * номинального счёта **в этой записи**, в файле транша не остаётся ни копейки,
 * и держится это теперь не проверкой, а балансом — без дебета `transit:fee`
 * запись просто не сходится повалютно. Формулировка красной линии при этом
 * уточняется: «не хранится на номинальном счёте» — а не «в тот же миг лежит на
 * операционном»; между банками деньги идут день-два, и `transit:fee` делает
 * этот промежуток видимым вместо того, чтобы врать о нём.
 *
 * **Комиссия приходит токеном начисления, а не суммой.** Удержать то, что не
 * начислено, теперь нельзя по типам: `FeeAccrual` собирается только
 * `accrueFee`. Второй контур — баланс: удержание без начисления уводит
 * `fee:receivable` в минус, и это ловит `platformAssetNegative`.
 *
 * Плательщик, получатель и сделка приходят **одним значением** (`settles`), и
 * оно же остаётся в записи (красная линия №1, см. `entry.ts`).
 */
export function settleTrancheToClientAccount(
  meta: EntryMeta,
  settles: TrancheSettlement,
  gross: Money<CurrencyCode>,
  withheld: FeeAccrual | null = null,
): JournalEntry {
  const deal = settles.deal;
  const tranche = trancheRef(deal.dealId, deal.trancheId);
  const recipientRef = clientRef(settles.recipient);
  const custody = custodyOf(gross);
  let fee: Money<CurrencyCode> | null = null;
  if (withheld !== null) {
    // Начисление по другой сделке к этому расчёту не подходит — та же логика,
    // что у подтверждения сторон: значение, выданное на одну сделку, не
    // открывает удержание по другой.
    if (
      withheld.accruedFor.dealId !== deal.dealId ||
      withheld.accruedFor.trancheId !== deal.trancheId
    ) {
      throw new LedgerError(LedgerErrorCode.entryFeeAccrualMismatch, {
        dealId: deal.dealId,
        trancheId: deal.trancheId,
        accruedDealId: withheld.accruedFor.dealId,
        accruedTrancheId: withheld.accruedFor.trancheId,
      });
    }
    // Комиссия — часть той же суммы, а не отдельный платёж: валюты обязаны
    // совпасть до вычитания, иначе `subtract` вернул бы бессмысленное нетто.
    assertSameCurrency(gross, withheld.accruedFee);
    fee = withheld.accruedFee;
  }
  const net = fee === null ? gross : subtract(gross, fee);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.tranche_settled',
    settles,
    postings: [
      debit(clientLockedAccount(settles.payer, deal.dealId, deal.trancheId), gross, tranche),
      credit(clientFreeAccount(settles.recipient), net, recipientRef),
      ...(fee === null ? [] : [credit(feeReceivable, fee, tranche)]),
      // Кастодиан уходит из файла транша целиком: нетто переезжает в файл
      // получателя, комиссия — в транзит на операционный счёт. Остатка в файле
      // транша не остаётся, поэтому и забывать нечего.
      credit(custody, gross, tranche),
      debit(custody, net, recipientRef),
      ...(fee === null ? [] : [debit(transitFee, fee, tranche)]),
    ],
  });
}

/**
 * Возврат, момент 2 (И12.2, красная линия №9): деньги уходят с номинального
 * счёта на счёт-источник, на имя плательщика. Обязательство перед клиентом
 * дебетуется, кастодиан кредитуется — обе проводки в файле клиента, потому что
 * транша у этих денег больше нет: его закрыл момент 1 (`unlockToClientAccount`).
 *
 * Куда именно ушли деньги, запись не утверждает и утверждать не может:
 * реквизиты счёта-источника живут в комплаенсе, а домен пропускает возврат
 * только через `g_source_account_known`.
 *
 * Конструктор жил в двух местах — в проекции домена и в приложении, — и это
 * ровно тот механизм, из-за которого модели проводок однажды разошлись:
 * повторённая от руки форма расходится молча, а вызванная из словаря — не
 * может.
 */
export function refundToSourceAccount(
  meta: EntryMeta,
  owner: ClientKey,
  amount: Money<CurrencyCode>,
): JournalEntry {
  const ref: ClientRef = { clientKey: owner };
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
 * Списание невостребованных средств, **момент 1** (FUNCTIONAL.md §3.1, случай
 * Б): обязательство по траншу закрывается, деньги уходят с номинального счёта в
 * транзит и превращаются не в доход, а в другой долг — `unclaimed:liability`.
 *
 * Признать невостребованное доходом было бы удобно и, возможно, незаконно:
 * порядок обращения с такими средствами помечен открытым. До ответа юриста это
 * долг.
 *
 * **Через транзит, а не сразу на операционный счёт.** Счета в разных банках,
 * автоматических переводов между ними нет (§3.2, красная линия №1): в жизни это
 * межбанковский перевод на день-два. Запись прямо на операционный счёт
 * утверждала бы, что перевод уже дошёл.
 */
export function writeOffUnclaimed(
  meta: EntryMeta,
  owner: ClientKey,
  deal: TrancheRef,
  amount: Money<CurrencyCode>,
): JournalEntry {
  const tranche = trancheRef(deal.dealId, deal.trancheId);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.unclaimed',
    postings: [
      debit(clientLockedAccount(owner, deal.dealId, deal.trancheId), amount, tranche),
      credit(bankNominal(amount.currency), amount, tranche),
      debit(transitWriteoff, amount),
      credit(unclaimedLiability, amount),
    ],
  });
}

/**
 * Списание невостребованных, **момент 2**: межбанковский перевод дошёл.
 *
 * Это факт банковской выписки, а не переход транша, — поэтому автомату сказать
 * о нём нечего, и запись порождает сверка. Остаток на транзитном счёте старше
 * двух банковских дней — расхождение, а не норма.
 */
export function writeOffTransitArrived(
  meta: EntryMeta,
  amount: Money<CurrencyCode>,
): JournalEntry {
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.write_off_transit_arrived',
    postings: [
      debit(bankOperating(amount.currency), amount),
      credit(transitWriteoff, amount),
    ],
  });
}

/**
 * Конвертация, **момент 1**: исходная валюта ушла валютному контрагенту.
 *
 * ```
 * Кт bank:nominal:{исходная}    сумма   файл клиента
 * Дт fx:settlement:{c}:{k}      сумма   файл клиента
 * ```
 *
 * **Исправленный дефект, доставшийся от прошлого батча.** Разделение
 * конвертации на два момента вылечило только ногу исходной валюты. Нога
 * встречной валюты повторяла прежнюю форму целиком: `bank:nominal:{целевая}`
 * дебетовался, `client:{c}:free` кредитовался — актив и обязательство под него
 * создавала одна и та же запись, внешнего источника не было. Проба: конвертация
 * в лари при нулевом номинальном счёте в лари давала 21 349 500 ₾ на счёте,
 * покрытие 1/1 и пустой список нарушений (см. `conversion-second-leg.test.ts`).
 *
 * **Теперь моментов три, и это следствие повалютного баланса, а не вкуса.**
 * FUNCTIONAL.md §3.3 требовал одновременно двух несовместимых вещей:
 * «обязательство перед клиентом в момент 1 не трогается» и «встречная валюта
 * приходит через контрагента, а не появляется». В записи, балансируемой в
 * каждой валюте отдельно, обязательство в лари неизбежно возникает в той же
 * записи, что и лари на счёте, — если этих записей всего две. Развести их
 * можно только третьей:
 *
 * ```
 * M1 sendForConversion     исходная валюта отдана контрагенту
 * M2 executeConversion     обмен исполнен, обязательство переоформлено
 * M3 receiveConversion     встречная валюта поставлена
 * ```
 *
 * Что это закрывает: лари попадают на номинальный счёт **единственной** записью
 * M3, и у неё нет ноги, создающей обязательство. Нарисовать покрытие в целевой
 * валюте, не поставив денег, больше нельзя.
 *
 * Чего это не закрывает, честно: после M2 и до M3 позиция в целевой валюте
 * лежит на `fx:settlement:{c}:{k}` — клиентском активе, — поэтому портфельное
 * покрытие в этот промежуток по-прежнему сходится в единицу. Это состояние
 * «встречная валюта не поставлена», и ловит его только инвариант
 * `fxPositionOpen` по возрасту позиции (`invariants.ts`), потому что ни
 * отрицательным остатком, ни покрытием оно не выражается.
 *
 * Конвертация запертой части здесь невыразима намеренно: сменить валюту
 * обязательства под живым траншем — решение домена о сумме сделки, а не
 * проводка.
 */
export function sendForConversion(
  meta: EntryMeta,
  owner: ClientKey,
  execution: FxExecution,
): JournalEntry {
  const ref = clientRef(owner);
  const source = execution.converted.source;
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.fx_sent_for_conversion',
    converts: execution,
    postings: [
      credit(custodyOf(source), source, ref),
      debit(fxSettlement(owner, execution.conversionId), source, ref),
    ],
  });
}

/**
 * Конвертация, **момент 2**: обмен исполнен у контрагента, обязательство перед
 * клиентом переоформлено в целевую валюту.
 *
 * ```
 * Дт client:{c}:free      80 000 USD   файл клиента   (старое обязательство закрыто)
 *     Кт fx:settlement:{c}:{k} 80 000 USD   файл клиента   (требование в исходной закрыто)
 * Дт fx:settlement:{c}:{k} 213 495 GEL   файл клиента   (требование во встречной)
 *     Кт client:{c}:free     213 495 GEL   файл клиента   (новое обязательство)
 * ```
 *
 * Запись балансируется в каждой валюте отдельно и не двигает ни одного счёта в
 * банке: это учётный факт исполнения сделки обмена, а не платёж. Прирост
 * клиентского файла в ней нулевой в обеих валютах, поэтому
 * `assertNoUnfundedClientFileGain` её пропускает по существу, а не по
 * недосмотру.
 *
 * **Гарантия «получить ровно то, что отдал» переезжает из учёта в домен.**
 * Прежняя редакция §3.3 держала её проводкой: обязательство до прихода
 * встречной валюты оставалось в исходной. Держать её так и одновременно
 * требовать внешнего источника встречной валюты нельзя (см. `sendForConversion`).
 * До M3 обмен разворачивается у контрагента, а дефолт контрагента — это
 * недостача платформы (§3.1, случай А), а не убыток клиента.
 *
 * M2 без M1 уводит `fx:settlement:{c}:{k}` в минус по исходной валюте —
 * отрицательный остаток клиентского счёта, инвариант и стоп-кран.
 */
export function executeConversion(
  meta: EntryMeta,
  owner: ClientKey,
  execution: FxExecution,
): JournalEntry {
  const ref = clientRef(owner);
  const source = execution.converted.source;
  const target = execution.converted.target;
  const account = fxSettlement(owner, execution.conversionId);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.fx_executed',
    converts: execution,
    postings: [
      debit(clientFreeAccount(owner), source, ref),
      credit(account, source, ref),
      debit(account, target, ref),
      credit(clientFreeAccount(owner), target, ref),
    ],
  });
}

/**
 * Конвертация, **момент 3**: контрагент поставил встречную валюту.
 *
 * ```
 * Дт bank:nominal:gel    213 495 GEL   файл клиента
 *     Кт fx:settlement:{c}:{k} 213 495 GEL   файл клиента   (требование закрыто)
 * Дт bank:operating:gel    1 505 GEL                     (наш спред)
 *     Кт fx:income             1 505 GEL
 * ```
 *
 * Обязательства перед клиентом эта запись не касается вовсе — оно уже
 * переоформлено в M2. Единственное, что она делает, — переносит деньги из «у
 * контрагента» в «на нашем счёте», и именно поэтому покрытие в целевой валюте
 * перестало быть тождеством: ноги «создать обязательство» здесь нет.
 *
 * От контрагента приходит вся сумма по эталонному курсу: `target` закрывает
 * требование клиента, разница уходит на операционный счёт и признаётся доходом
 * **в этой же записи** (красная линия №2,
 * `assertPlatformIncomeSweptToOperating`). На номинальном счёте наш спред не
 * оседает ни на минуту.
 *
 * M3 без M2 уводит `fx:settlement:{c}:{k}` в минус по встречной валюте: закрытие
 * несуществующего требования — отрицательный остаток клиентского счёта,
 * инвариант и стоп-кран.
 */
export function receiveConversion(
  meta: EntryMeta,
  owner: ClientKey,
  execution: FxExecution,
  spread: PlatformSpread<CurrencyCode>,
): JournalEntry {
  const ref = clientRef(owner);
  const target = execution.converted.target;
  assertSameCurrency(target, spread.amount);
  if (isNegative(spread.amount)) {
    // Клиентский курс лучше эталонного — это убыток платформы, и проводка у
    // него другая: расход, а не доход, и встречного вывода на операционный
    // счёт у него нет. Молча вывернуть направление значило бы записать убыток
    // доходом, поэтому форма отвергается, а не собирается «как получится».
    throw new LedgerError(LedgerErrorCode.entryNegativeSpread, {
      amount: spread.amount.minor.toString(),
      currency: spread.amount.currency,
    });
  }
  // Нулевой спред — отсутствие спреда, а не проводка на ноль (та же логика, что
  // у комиссии в расчёте).
  const earned = isPositive(spread.amount) ? spread.amount : null;
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.fx_received',
    converts: execution,
    postings: [
      debit(custodyOf(target), target, ref),
      credit(fxSettlement(owner, execution.conversionId), target, ref),
      ...(earned === null
        ? []
        : [
            debit(bankOperating(earned.currency), earned),
            credit({ kind: 'fx_income' } as const, earned),
          ]),
    ],
  });
}

/**
 * Признанная недостача — единственное основание довнести деньги платформы в
 * файл клиента.
 *
 * Ambient-символ, как у `DealPartiesAttestation`: значения этого типа нет ни в
 * рантайме, ни в типах, поэтому объект с этим ключом построить нельзя нигде,
 * кроме `absorbShortfall`. Токен **является записью признания** — не ссылкой на
 * неё и не отдельным объектом: доказательством того, что недостача признана,
 * может быть только сама запись признания.
 */
declare const recognisedByLedger: unique symbol;

export interface RecognisedShortfall extends JournalEntry {
  /** Клиент, чьё обязательство доведено до полной суммы за наш счёт. */
  readonly recognisedOwner: ClientKey;
  /** Сумма признанного расхода: потолок довнесения. */
  readonly recognisedShortfall: Money<CurrencyCode>;
  readonly [recognisedByLedger]: true;
}

/**
 * Недостача, покрытая платформой, **момент 1** (FUNCTIONAL.md §3.1, случай А):
 * корреспондент снял с суммы при проходе, пришло меньше обещанного.
 *
 * ```
 * Дт bank:nominal          99 900   файл клиента
 * Дт shortfall:expense        100   файл клиента
 *     Кт client:{c}:free      100 000   файл клиента
 * ```
 *
 * Убыток признаётся **в момент поступления**, а не потом. Обязательство перед
 * клиентом доводится до полной суммы за наш счёт — направление «дебет расхода,
 * кредит обязательства» для этого случая верно, и именно оно отличает случай А
 * от случая Б, где обязательство, наоборот, дебетуется.
 *
 * Форма документа кредитует запертую часть транша; здесь кредитуется свободная
 * часть счёта клиента, и это то же самое одним шагом раньше: §3.1 развёл
 * зачисление и привязку к сделке на два события, а разнесение поступления
 * (`@sdelka/intake`, §4.3.2) выдаёт план на счёт клиента, из которого транш
 * запирается обычной `lockForTranche`.
 *
 * **Отнесение на проводке расхода.** Счёт не клиентских средств, поэтому для
 * конструктора записи отнесение здесь инертно (`assertAttribution` его не
 * смотрит). Оно стоит ради второго контура: инвариант `shortfallOverfunded`
 * складывает признанное по каждой паре «клиент, валюта» и сравнивает с
 * довнесённым. Без отнесения признание нельзя было бы сопоставить с клиентом
 * вовсе.
 *
 * ⚠ **Одной этой записи мало, и это не недосмотр.** Признание расхода — не
 * перевод денег: на номинальном счёте по-прежнему 99 900 против обязательства
 * в 100 000, файл клиента недообеспечен, красная линия №3 сработала, приём
 * новых сделок остановлен. Так и должно быть до второй записи — `fundShortfall`.
 * Недостача, о которой никто не знает, опаснее недостачи, которая горит на
 * дежурном дашборде.
 */
export function absorbShortfall(
  meta: EntryMeta,
  owner: ClientKey,
  received: Money<CurrencyCode>,
  shortfall: Money<CurrencyCode>,
): RecognisedShortfall {
  if (!isPositive(shortfall)) {
    // Недостача без недостачи — обычное зачисление (`clientTopUp`). Записывать
    // её этой формой значит прятать ноль в проводке и признавать расход,
    // которого не было.
    throw new LedgerError(LedgerErrorCode.entryNonPositiveShortfall, {
      amount: shortfall.minor.toString(),
    });
  }
  // Недостача — свойство одного поступления: срез корреспондента в другой
  // валюте недостачей по этому платежу не является.
  assertSameCurrency(received, shortfall);
  const ref = clientRef(owner);
  const entry = createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.shortfall_absorbed',
    postings: [
      debit(custodyOf(received), received, ref),
      debit(shortfallExpense, shortfall, ref),
      credit(clientFreeAccount(owner), add(received, shortfall), ref),
    ],
  });
  return withToken(entry, {
    recognisedOwner: owner,
    recognisedShortfall: shortfall,
  }) as unknown as RecognisedShortfall;
}

/**
 * Недостача, **момент 2**: довнесение с операционного счёта на номинальный.
 *
 * ```
 * Дт bank:nominal    100   файл клиента
 *     Кт bank:operating  100
 * ```
 *
 * Инициирует человек, и это межбанковский перевод: номинальный счёт в одном
 * банке, операционный в другом, автоматических переводов между ними нет (§3.2).
 * До этой записи файл клиента недообеспечен, и это видно как расхождение, а не
 * как норма.
 *
 * Прирост обеспечения клиентского файла без встречного обязательства — ровно та
 * форма, которую `assertNoUnfundedClientFileGain` запрещает всем остальным:
 * законный источник у такого прироста один — собственные деньги платформы,
 * ушедшие с её собственного счёта **в этой же записи**. Здесь он и стоит.
 *
 * **Исправленный дефект: это был единственный конструктор без проверки входа.**
 * Прежняя подпись `fundShortfall(meta, owner, amount)` — универсальный примитив
 * «положить деньги платформы в файл произвольного клиента на произвольную
 * сумму», и `assertNoUnfundedClientFileGain` пропускал его **по построению**:
 * такое финансирование законно. То есть у формы не было ни одного контура
 * защиты: ни в словаре, ни в конструкторе записи.
 *
 * Теперь контуров два, и они закрывают разные двери:
 *
 * 1. **Токен.** Владелец, валюта и сумма берутся из записи признания, а не из
 *    аргументов. Форма «доложить кому угодно сколько угодно» исчезла из
 *    словаря — она невыразима, а не запрещена проверкой.
 * 2. **Инвариант** `shortfallOverfunded`: по каждой паре «клиент, валюта»
 *    довнесённое не превышает признанного. Он закрывает низкоуровневую дверь
 *    `createJournalEntry`, которой токен не указ.
 *
 * Отнесение — файл клиента, а не транша: недостача признана на счёте клиента, и
 * если деньги успели запереться под транш, дыра осталась в файле клиента —
 * `lockForTranche` перенесла в файл транша полную сумму, которой на номинальном
 * счёте не было.
 */
export function fundShortfall(meta: EntryMeta, recognised: RecognisedShortfall): JournalEntry {
  const owner = recognised.recognisedOwner;
  const amount = recognised.recognisedShortfall;
  const ref = clientRef(owner);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.shortfall_funded',
    // Третий контур, и он закрывает то, чего не закрывали первые два. Токен —
    // защита словаря, инвариант — сложение постфактум; ни тот ни другой не
    // мешал довнести **одно и то же** признание дважды и не требовал, чтобы
    // признание вообще лежало в журнале. Ссылка делает довнесение адресным:
    // `appendEntry` находит признание, сверяет владельца, валюту и сумму и
    // отказывает во втором довнесении по нему.
    funds: {
      recognisedEntryId: recognised.id,
      owner,
      amount,
    },
    postings: [
      debit(custodyOf(amount), amount, ref),
      credit(bankOperating(amount.currency), amount),
    ],
  });
}

/**
 * Комиссия **начислена**: доход признан против требования платформы
 * (FUNCTIONAL.md §4.6, CORE.md Ф16, история И14.3).
 *
 * ```
 * Дт fee:receivable   комиссия   отнесение: сделка d, транш t
 *     Кт fee:income       комиссия   отнесение: сделка d, транш t
 * ```
 *
 * **Зачем отдельная запись, если раньше комиссия признавалась прямо в расчёте.**
 * §4.1 и Ф16: удержание оформляется **двумя встречными фактами**, а не
 * «уменьшенным платежом», и от этого зависит, признаётся ли налоговой базой
 * наше вознаграждение или весь оборот через номинальный счёт. Начисление —
 * первый из двух фактов. Пока его нет, «начислено» и «удержано» —
 * одна величина, а Ф10 требует трёх раздельных.
 *
 * Денег эта запись не двигает вовсе, поэтому вывода на операционный счёт у неё
 * нет. Именно ради неё в `assertPlatformIncomeSweptToOperating` появилось
 * единственное именное исключение — доход против требования платформы.
 *
 * Отнесение к траншу стоит на обеих проводках. Для конструктора записи оно
 * инертно (счета не клиентских средств), а `feePositions` без него не смогла бы
 * ответить, по какой сделке комиссия начислена.
 *
 * `tariffVersionId` остаётся в токене и уходит в документ: И14.3 требует, чтобы
 * на сделке хранился идентификатор версии плана и пересчёт задним числом был
 * невозможен. Здесь он ещё не факт журнала — версия плана живёт на сделке, в
 * домене; ledger хранит её ровно на время сборки записи расчёта.
 */
declare const accruedByLedger: unique symbol;

export interface FeeAccrual extends JournalEntry {
  readonly accruedFee: Money<CurrencyCode>;
  readonly accruedFor: TrancheRef;
  readonly tariffVersionId: string;
  readonly [accruedByLedger]: true;
}

export function accrueFee(
  meta: EntryMeta,
  deal: TrancheRef,
  fee: Money<CurrencyCode>,
  tariffVersionId: string,
): FeeAccrual {
  if (!isPositive(fee)) {
    // Нулевая комиссия — это отсутствие комиссии, а не проводка на ноль. План,
    // который не берёт ничего, начисления не порождает вовсе.
    throw new LedgerError(LedgerErrorCode.entryNonPositiveFee, {
      amount: fee.minor.toString(),
    });
  }
  assertAccountIdentifier(tariffVersionId, 'tariffVersionId');
  const tranche = trancheRef(deal.dealId, deal.trancheId);
  const entry = createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.fee_accrued',
    accrues: { deal: tranche, fee, tariffVersionId },
    postings: [
      debit(feeReceivable, fee, tranche),
      credit({ kind: 'fee_income' } as const, fee, tranche),
    ],
  });
  return withToken(entry, {
    accruedFee: fee,
    accruedFor: tranche,
    tariffVersionId,
  }) as unknown as FeeAccrual;
}

/**
 * Начисление по траншу, уже лежащее в журнале, — или `null`, если его там нет.
 *
 * Токен воссоздаётся из записи, а не выдаётся конструктором, и это не
 * послабление, а усиление: конструктор выдаёт токен на запись, которую в журнал
 * ещё никто не положил, а здесь основание — запись, **лежащая в журнале** и
 * прошедшая `assertFeeAccrualDeclared`, то есть признавшая ровно эту сумму по
 * ровно этому траншу.
 *
 * Снятое исправлением начисление не возвращается: §4.4 сняло его как раз
 * потому, что комиссия за расчёт не начисляется, и удержание по снятому
 * начислению увело бы `fee:receivable` в минус.
 *
 * Начисление без объявления (собранное низкоуровневой дверью) сюда не попадает:
 * восстановить из проводок версию тарифного плана нельзя, а токен без неё —
 * половина токена. Второе начисление по такому траншу всё равно не пройдёт:
 * `appendEntry` считает начисления по проводкам, а не по объявлению.
 */
export function feeAccrualFor(journal: Journal, deal: TrancheRef): FeeAccrual | null {
  const reversed = new Set<string>();
  for (const entry of journal.entries) {
    if (entry.kind === 'correction' && entry.correctsEntryId !== null) {
      reversed.add(entry.correctsEntryId);
    }
  }
  for (const entry of journal.entries) {
    const accrues = entry.accrues;
    if (accrues === null || entry.kind !== 'settlement') continue;
    if (accrues.deal.dealId !== deal.dealId || accrues.deal.trancheId !== deal.trancheId) continue;
    if (reversed.has(entry.id)) continue;
    return withToken(entry, {
      accruedFee: accrues.fee,
      accruedFor: accrues.deal,
      tariffVersionId: accrues.tariffVersionId,
    }) as unknown as FeeAccrual;
  }
  return null;
}

/**
 * Начислить комиссию **один раз**: повтор возвращает то же начисление и не
 * добавляет в журнал ничего.
 *
 * Это и есть идемпотентность, которой у начисления не было. `accrueFee` —
 * чистый конструктор, журнала он не видит и видеть не должен, поэтому «уже
 * начисляли?» отвечается там, где журнал есть. Пока такой формы не было, любой
 * повторный вход в `release_pending`, любой ретрай обработчика и любая
 * перезапись события давали **второе** начисление: `fee:receivable` вдвое,
 * доход признан дважды, и ни один инвариант этого не видел.
 *
 * Повтор с другой суммой или другой версией плана — не повтор, а расхождение:
 * §4.2 запрещает пересчёт задним числом, и молча вернуть старое начисление
 * значило бы скрыть, что тариф разошёлся. Такой вызов отвергается.
 *
 * Журнал возвращается вместе с начислением намеренно: у идемпотентной операции
 * два исхода — «добавили запись» и «записи не добавили», — и оба обязаны быть
 * видны вызывающему одним значением, иначе он попытается положить возвращённое
 * начисление в журнал сам и получит отказ по совпадению идентификаторов.
 */
export interface FeeAccrualOutcome {
  readonly journal: Journal;
  readonly accrual: FeeAccrual;
  /** `false` — начисление уже было, второй записи не появилось. */
  readonly appended: boolean;
}

export function accrueFeeOnce(
  journal: Journal,
  meta: EntryMeta,
  deal: TrancheRef,
  fee: Money<CurrencyCode>,
  tariffVersionId: string,
): FeeAccrualOutcome {
  const existing = feeAccrualFor(journal, deal);
  if (existing !== null) {
    if (
      existing.accruedFee.currency !== fee.currency ||
      existing.accruedFee.minor !== fee.minor ||
      existing.tariffVersionId !== tariffVersionId
    ) {
      throw new LedgerError(LedgerErrorCode.entryFeeAccrualMismatch, {
        dealId: deal.dealId,
        trancheId: deal.trancheId,
        accrued: `${existing.accruedFee.currency} ${existing.accruedFee.minor} ${existing.tariffVersionId}`,
        requested: `${fee.currency} ${fee.minor} ${tariffVersionId}`,
      });
    }
    return { journal, accrual: existing, appended: false };
  }
  const accrual = accrueFee(meta, deal, fee, tariffVersionId);
  return { journal: appendEntry(journal, accrual), accrual, appended: true };
}

/**
 * Реверс начисления: сделка ушла в возвратную ветвь, комиссия за расчёт не
 * начисляется (FUNCTIONAL.md §4.4, строки «отмена до конвертации» и «отмена
 * после конвертации»).
 *
 * Запись типа `correction` со ссылкой на начисление — красная линия №11:
 * журнал не редактируется, исправление только новой записью со ссылкой на
 * предыдущую. Спред на конвертации этим не отменяется: услуга оказана, и
 * §4.4 говорит об этом отдельной строкой.
 */
export function reverseFeeAccrual(meta: EntryMeta, accrual: FeeAccrual): JournalEntry {
  return createJournalEntry({
    ...meta,
    kind: 'correction',
    correctsEntryId: accrual.id,
    memoKey: 'ledger.entry.fee_accrual_reversed',
    accrues: {
      deal: accrual.accruedFor,
      fee: accrual.accruedFee,
      tariffVersionId: accrual.tariffVersionId,
    },
    postings: [
      debit({ kind: 'fee_income' } as const, accrual.accruedFee, accrual.accruedFor),
      credit(feeReceivable, accrual.accruedFee, accrual.accruedFor),
    ],
  });
}

/**
 * Комиссия **получена**: межбанковский перевод удержанной комиссии дошёл до
 * операционного счёта.
 *
 * ```
 * Дт bank:operating   комиссия   отнесение: сделка d, транш t
 *     Кт transit:fee      комиссия   отнесение: сделка d, транш t
 * ```
 *
 * Это факт банковской выписки, а не переход транша: автомату сказать о нём
 * нечего, запись порождает сверка — ровно как у `writeOffTransitArrived`.
 * Остаток `transit:fee` старше двух банковских дней — расхождение
 * (`InvariantCode.transitStale`), а не норма.
 *
 * Отнесение к траншу обязательно: три величины Ф16 считаются по сделке, а
 * перевод одной суммой за десять сделок разбирается на проводки по каждой —
 * иначе «получено» перестаёт быть величиной сделки и становится величиной дня.
 */
export function receiveFee(
  meta: EntryMeta,
  deal: TrancheRef,
  amount: Money<CurrencyCode>,
): JournalEntry {
  const tranche = trancheRef(deal.dealId, deal.trancheId);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.fee_received',
    postings: [
      debit(bankOperating(amount.currency), amount, tranche),
      credit(transitFee, amount, tranche),
    ],
  });
}
