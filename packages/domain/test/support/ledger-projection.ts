import {
  type EntryMeta,
  type Journal,
  type TrancheRef,
  appendEntry,
  bankNominal,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  clientTopUp,
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
  writeOffUnclaimed,
} from '@sdelka/ledger';
import { type Rational, split } from '@sdelka/money';
import type { Intent } from '../../src/index';

/**
 * Проекция намерений транша в проводки. Живёт в тестах намеренно: домен не
 * знает про учёт, а учёт не знает про автомат — их связывает приложение.
 * Здесь она нужна, чтобы проверять инварианты учёта на переходах автомата.
 *
 * **Проводки собираются словарём `@sdelka/ledger`, а не руками.** Прежняя
 * редакция собирала их `createJournalEntry` и описывала при этом другую модель
 * денег, чем словарь: `funds_received` клала деньги **сразу в запертую часть**
 * (свободной части не существовало вовсе), а `payout_with_fee` кредитовала
 * кастодиана, не порождая обязательства перед получателем, — то есть выручка
 * продавца исчезала из обязательств. Обе формы сходились в ноль и проходили
 * пофайловое обеспечение, поэтому расхождение не ловилось ничем: тест на
 * свойствах гонял инварианты по схеме проводок, которой в проде не будет.
 *
 * Вызовом словаря расхождение становится невозможным по построению: форму
 * записи знает одно место, и меняется она там же, где проверяется.
 *
 * **У проекции больше нет ни одного свободного параметра.** Получатель расчёта
 * приходил сюда отдельным полем `ProjectionOptions.recipientClientKey` — то
 * есть его называла проекция, а не сделка. Теперь получателя, плательщика и
 * подтверждение сторон несёт само намерение `post_settlement_entry`: домен
 * читает получателя из акта об условии, а подтверждение изготавливает у себя,
 * и подделать его здесь нечем. Осталась одна настройка — ставка комиссии,
 * которая к сторонам отношения не имеет.
 *
 * **Проекция не собирает проводки сама — она только зовёт словарь.**
 *
 * Раньше внешний вывод возврата и списание невостребованных были собраны здесь
 * от руки, потому что конструкторов в `entries.ts` не было, и ту же форму
 * вынуждено повторяло приложение. Повторённая от руки форма расходится молча —
 * ровно так модели проводок однажды и разошлись, и обе оставались зелёными.
 * Теперь конструкторы есть, и разойтись негде: расхождение стало ошибкой
 * компиляции, а не находкой на ревью.
 */
export interface ProjectionOptions {
  readonly feeRate: Rational;
}

let sequence = 0;

function nextMeta(occurredAt: string): EntryMeta {
  sequence += 1;
  return { id: `entry-${sequence}`, occurredAt };
}

export function projectIntents(
  journal: Journal,
  intents: readonly Intent[],
  options: ProjectionOptions,
): Journal {
  let result = journal;
  for (const intent of intents) {
    if (intent.type === 'post_settlement_entry') {
      const deal: TrancheRef = { dealId: intent.dealId, trancheId: intent.trancheId };
      const payer = clientKey(intent.payerClientKey);
      const recipient = clientKey(intent.recipientClientKey);
      // Комиссию считает `@sdelka/money` (§4.3): остаток от округления всегда
      // у получателя, поэтому она берётся вычитанием, а не умножением.
      const parts = split(intent.amount, [{ key: 'fee:income', rate: options.feeRate }]);
      const fee = parts.deductions[0]?.amount ?? null;
      // Расчёт и вывод комиссии на операционный счёт — одна запись (красная
      // линия №2): словарь иначе и не умеет. Подтверждение сторон приходит из
      // намерения — проекция его не изготавливает и изготовить не может.
      result = appendEntry(
        result,
        settleTrancheToClientAccount(
          nextMeta('2026-09-03T12:00:00Z'),
          trancheSettlement(deal, payer, recipient, intent.attestation),
          intent.amount,
          fee,
        ),
      );
      continue;
    }
    if (intent.type !== 'post_journal_entry') continue;
    const payer = clientKey(intent.clientKey);
    const deal: TrancheRef = { dealId: intent.dealId, trancheId: intent.trancheId };
    const amount = intent.amount;
    switch (intent.template) {
      case 'funds_received':
        // Зачисление, и только оно. Раньше здесь стояли **два** вызова подряд —
        // зачисление и запирание, — потому что намерения на запирание у
        // автомата не было и проекция решала за него. Приложение в `e2e`
        // решало иначе, интерфейс — в третий раз иначе, и момент запирания
        // разошёлся между тремя проекциями молча: каждая сходилась в ноль.
        result = appendEntry(result, clientTopUp(nextMeta('2026-09-03T10:00:00Z'), payer, amount));
        break;
      case 'lock_funds':
        // Привязка к сделке (FUNCTIONAL.md §3.1): вход в `reserved`. Четыре
        // проводки, две из них переносят отнесение кастодиана — без них транш
        // немедленно необеспечен, хотя ни одна купюра не двигалась.
        result = appendEntry(
          result,
          lockForTranche(nextMeta('2026-09-03T10:00:01Z'), payer, deal, amount),
        );
        break;
      case 'unlock_funds':
        // Расфиксация при снятии резерва — та же словарная запись, что и
        // отвязка при возврате, и это правильно: событие разное, движение
        // денег одно (`reserved → collected`, `CABINETS.md` §3.2 блок 6).
        result = appendEntry(
          result,
          unlockToClientAccount(nextMeta('2026-09-03T11:00:00Z'), payer, deal, amount),
        );
        break;
      case 'refund_unlock':
        // Возврат, момент 1: отвязка от транша. Деньги возвращаются в
        // **свободную** часть счёта того же покупателя, отзывными (красная
        // линия №7), и остаются на номинальном счёте — никуда они пока не
        // уходили. Это словарная запись, обратная привязке.
        result = appendEntry(
          result,
          unlockToClientAccount(nextMeta('2026-09-03T12:00:00Z'), payer, deal, amount),
        );
        break;
      case 'refund_external':
        // Возврат, момент 2 (И12.2, красная линия №9). Собран словарём:
        // конструктор `refundToSourceAccount` живёт в `@sdelka/ledger` и
        // вызывается и здесь, и приложением. Раньше форма была повторена от
        // руки в двух местах — ровно тот механизм, из-за которого модели
        // проводок однажды разошлись молча.
        result = appendEntry(
          result,
          refundToSourceAccount(nextMeta('2026-09-03T12:00:01Z'), payer, amount),
        );
        break;
      case 'write_off':
        // Списание невостребованных, момент 1 (FUNCTIONAL.md §3.1, случай Б).
        // Собран словарём: `writeOffUnclaimed`. Момент 2 сюда не попадает
        // вовсе — приход перевода это факт банковской выписки, а не переход
        // транша, и автомату сказать о нём нечего.
        result = appendEntry(
          result,
          writeOffUnclaimed(nextMeta('2026-09-04T12:00:00Z'), payer, deal, amount),
        );
        break;
    }
  }
  return result;
}
