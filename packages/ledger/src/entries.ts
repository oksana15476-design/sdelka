import {
  type ConvertedAmount,
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
  bankNominal,
  bankOperating,
  clientFreeAccount,
  clientLockedAccount,
  fxSettlement,
  shortfallExpense,
  transitWriteoff,
  unclaimedLiability,
} from './accounts';
import {
  type ClientRef,
  type JournalEntry,
  type TrancheRef,
  type TrancheSettlement,
  createJournalEntry,
  credit,
  debit,
} from './entry';
import { LedgerError, LedgerErrorCode } from './errors';

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
 * **Одна запись, включающая вывод комиссии на операционный счёт.** Красная
 * линия №2 требует буквально этого: «выводится на операционный в момент
 * расчёта, в том же журнале». Прежняя редакция признавала комиссию доходом, но
 * денег с номинального счёта не двигала, оставляя в файле транша ровно
 * комиссию, — то есть средства платформы на счёте клиентских средств. Вывод жил
 * отдельной функцией в приложении, забыть его ничего не мешало, и пофайловая
 * сверка этого не ловила: профицит по файлу считается покрытием.
 *
 * Теперь вывод — часть расчёта, а не следующий шаг:
 *
 * ```
 * Дт client:{плательщик}:tranche:{сделка}:{транш}   брутто   файл транша
 *     Кт client:{получатель}:free                     нетто   файл получателя
 *     Кт fee:income                                 комиссия
 * Кт bank:nominal                                    брутто   файл транша
 * Дт bank:nominal                                     нетто   файл получателя
 * Дт bank:operating                                комиссия
 * ```
 *
 * Файл транша после записи пуст с обеих сторон, файл получателя обеспечен
 * ровно на нетто, комиссия на номинальном счёте не остаётся ни на минуту.
 * Второй контур — `assertPlatformIncomeSweptToOperating` в `createJournalEntry`:
 * даже собранная в обход словаря запись не признает доход, не выведя его.
 *
 * Плательщик, получатель и сделка приходят **одним значением** (`settles`), и
 * оно же остаётся в записи: получатель расчёта связан со сделкой в самой
 * записи, а не в намерении вызывающего (красная линия №1, см. `entry.ts`).
 * Само `settles` собирается только из подтверждения домена
 * (`DealPartiesAttestation`), которого учёту нечем подделать, — иначе связь
 * была бы самосертификацией вызывающего.
 */
export function settleTrancheToClientAccount(
  meta: EntryMeta,
  settles: TrancheSettlement,
  gross: Money<CurrencyCode>,
  fee: Money<CurrencyCode> | null = null,
): JournalEntry {
  const deal = settles.deal;
  const tranche = trancheRef(deal.dealId, deal.trancheId);
  const recipientRef = clientRef(settles.recipient);
  const custody = custodyOf(gross);
  if (fee !== null) {
    // Комиссия — часть той же суммы, а не отдельный платёж: валюты обязаны
    // совпасть до вычитания, иначе `subtract` вернул бы бессмысленное нетто.
    assertSameCurrency(gross, fee);
  }
  // Нулевая комиссия — это отсутствие комиссии, а не проводка на ноль: ноль
  // конструктор записи отвергает, и прятать его в расчёте нельзя.
  const withheld = fee !== null && isPositive(fee) ? fee : null;
  const net = withheld === null ? gross : subtract(gross, withheld);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.tranche_settled',
    settles,
    postings: [
      debit(clientLockedAccount(settles.payer, deal.dealId, deal.trancheId), gross, tranche),
      credit(clientFreeAccount(settles.recipient), net, recipientRef),
      ...(withheld === null ? [] : [credit({ kind: 'fee_income' } as const, withheld)]),
      // Кастодиан уходит из файла транша целиком: нетто переезжает в файл
      // получателя, комиссия — на операционный счёт. Остатка в файле транша не
      // остаётся, поэтому и забывать нечего.
      credit(custody, gross, tranche),
      debit(custody, net, recipientRef),
      ...(withheld === null ? [] : [debit(bankOperating(withheld.currency), withheld)]),
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
 * Дт fx:settlement              сумма   файл клиента
 * ```
 *
 * **Исправленный дефект, второй по тяжести в батче.** Конвертация собиралась
 * одной записью в приложении: целевая валюта дебетовалась на номинальный счёт
 * без единого внешнего источника. Проба: номинальный в долларах был ноль и стал
 * 500 000 — счёт в валюте, которой платформа не держала, создан одной записью.
 *
 * Следствие тяжелее самого факта. Обязательство перед клиентом в новой валюте и
 * покрытие под него создавала **одна и та же запись**, поэтому отношение
 * покрытия после конвертации тождественно равнялось единице: красная линия №3
 * переставала быть утверждением о деньгах и не проверяла больше ничего.
 *
 * Конвертация — операция с внешним контрагентом: валюта уходит с одного счёта и
 * приходит на другой **через него**, а не появляется. Поэтому моментов два, как
 * и у списания невостребованного (§3.1, «два момента, а не один»): между ними
 * деньги клиента лежат на `fx:settlement` — они всё ещё его, всё ещё покрывают
 * его обязательство, но уже не на нашем счёте. Обязательство перед клиентом
 * здесь не трогается вовсе: пока встречная валюта не пришла, он должен получить
 * ровно то, что отдал.
 *
 * Что это закрывает: получить встречную валюту, не отдав исходную, больше
 * нельзя. Момент 2 обязан закрыть требование к контрагенту, а закрытие
 * несуществующего требования уводит `fx:settlement` в минус — отрицательный
 * остаток клиентского счёта, инвариант и стоп-кран.
 *
 * Конвертация запертой части здесь невыразима намеренно: сменить валюту
 * обязательства под живым траншем — решение домена о сумме сделки, а не
 * проводка (сумма транша деноминирована), и ни один сегодняшний поток этого не
 * требует. Появится потребность — появится своё объявление, по образцу
 * `TrancheSettlement`.
 */
export function sendForConversion(
  meta: EntryMeta,
  owner: ClientKey,
  source: Money<CurrencyCode>,
): JournalEntry {
  const ref = clientRef(owner);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.fx_sent_for_conversion',
    postings: [
      credit(custodyOf(source), source, ref),
      debit(fxSettlement, source, ref),
    ],
  });
}

/**
 * Конвертация, **момент 2**: контрагент отдал встречную валюту.
 *
 * ```
 * Дт client:{c}:free      80 000 USD   файл клиента   (старое обязательство)
 *     Кт fx:settlement        80 000 USD   файл клиента   (требование закрыто)
 * Дт bank:nominal:gel    213 495 GEL   файл клиента
 * Дт bank:operating:gel    1 505 GEL                  (наш спред)
 *     Кт client:{c}:free     213 495 GEL   файл клиента   (новое обязательство)
 *     Кт fx:income             1 505 GEL
 * ```
 *
 * Запись балансируется **в каждой валюте отдельно** (`assertBalanced`): по
 * доллару требование к контрагенту гасится обязательством, по лари пришедшее
 * от контрагента расходится между клиентом и нашим спредом. От контрагента
 * приходит вся сумма по эталонному курсу; клиенту зачисляется по клиентскому,
 * разница признаётся доходом и **в этой же записи** уходит на операционный
 * счёт: красная линия №2 и `assertPlatformIncomeSweptToOperating`. На
 * номинальном счёте наш спред не оседает ни на минуту.
 *
 * Суммы приходят готовыми из `@sdelka/money` (`ConvertedAmount`, `PlatformSpread`):
 * учёт не считает деньги, а курс с недавних пор несёт свою пару валют, поэтому
 * «умножить вместо разделить» здесь уже невыразимо.
 */
export function receiveConversion(
  meta: EntryMeta,
  owner: ClientKey,
  converted: ConvertedAmount<CurrencyCode, CurrencyCode>,
  spread: PlatformSpread<CurrencyCode>,
): JournalEntry {
  const ref = clientRef(owner);
  const source = converted.source;
  const target = converted.target;
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
    memoKey: 'ledger.entry.fx_converted',
    postings: [
      debit(clientFreeAccount(owner), source, ref),
      credit(fxSettlement, source, ref),
      debit(custodyOf(target), target, ref),
      credit(clientFreeAccount(owner), target, ref),
      ...(earned === null
        ? []
        : [debit(bankOperating(earned.currency), earned), credit({ kind: 'fx_income' } as const, earned)]),
    ],
  });
}

/**
 * Недостача, покрытая платформой, **момент 1** (FUNCTIONAL.md §3.1, случай А):
 * корреспондент снял с суммы при проходе, пришло меньше обещанного.
 *
 * ```
 * Дт bank:nominal          99 900   файл клиента
 * Дт shortfall:expense        100
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
): JournalEntry {
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
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.shortfall_absorbed',
    postings: [
      debit(custodyOf(received), received, ref),
      debit(shortfallExpense, shortfall),
      credit(clientFreeAccount(owner), add(received, shortfall), ref),
    ],
  });
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
 * Отнесение — файл клиента, а не транша: недостача признана на счёте клиента, и
 * если деньги успели запереться под транш, дыра осталась в файле клиента —
 * `lockForTranche` перенесла в файл транша полную сумму, которой на номинальном
 * счёте не было.
 */
export function fundShortfall(
  meta: EntryMeta,
  owner: ClientKey,
  amount: Money<CurrencyCode>,
): JournalEntry {
  const ref = clientRef(owner);
  return createJournalEntry({
    ...meta,
    kind: 'settlement',
    memoKey: 'ledger.entry.shortfall_funded',
    postings: [
      debit(custodyOf(amount), amount, ref),
      credit(bankOperating(amount.currency), amount),
    ],
  });
}
