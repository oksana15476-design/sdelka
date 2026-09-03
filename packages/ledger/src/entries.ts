import {
  type CurrencyCode,
  type Money,
  assertSameCurrency,
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
