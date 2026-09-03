import {
  type EntryMeta,
  type Journal,
  type TrancheRef,
  appendEntry,
  bankNominal,
  bankOperating,
  clientKey,
  clientLockedAccount,
  clientTopUp,
  createJournalEntry,
  credit,
  debit,
  lockForTranche,
  settleTrancheToClientAccount,
  trancheSettlement,
  unclaimedLiability,
  unlockToClientAccount,
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
 * Что словарь **не** покрывает и почему здесь это видно поимённо:
 *
 * - **получатель расчёта.** Намерение `post_journal_entry` несёт только
 *   плательщика (`clientKey`); кто получатель, знает приложение. Здесь его
 *   приносит `ProjectionOptions.recipientClientKey`. Это тот же разрыв, что
 *   `ProjectionContext.recipient` в `packages/e2e`, и закрывается он изменением
 *   периметра домена (получатель в намерении) — отдельное решение, отдельная
 *   спека.
 * - **внешний вывод** (возврат покупателю на счёт-источник, И12.2)
 *   и **списание невостребованных** (§3.1, случай Б): конструкторов в словаре
 *   нет. Возврат доведён до свободной части счёта покупателя и остановлен —
 *   выдумывать форму записи здесь нельзя. Списание собрано вручную ровно
 *   потому, что без него терминальное `written_off` не проверить; это
 *   единственное место с ручной сборкой, и оно помечено.
 */
export interface ProjectionOptions {
  readonly feeRate: Rational;
  /**
   * Получатель расчёта. В намерении его нет: домен знает плательщика (владельца
   * обязательства) и не знает продавца.
   */
  readonly recipientClientKey: string;
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
    if (intent.type !== 'post_journal_entry') continue;
    const payer = clientKey(intent.clientKey);
    const deal: TrancheRef = { dealId: intent.dealId, trancheId: intent.trancheId };
    const amount = intent.amount;
    switch (intent.template) {
      case 'funds_received': {
        // Словарь разводит зачисление и привязку к сделке на **два события**
        // (И12.1, FUNCTIONAL.md §3.1): деньги приходят в свободную часть счёта
        // клиента и только отдельной записью запираются под транш. Автомат
        // транша порождает одно намерение — в момент, когда деньги становятся
        // деньгами этого транша, — поэтому приложение выполняет здесь оба шага
        // подряд. `packages/e2e` разводит их по времени той же парой вызовов.
        result = appendEntry(result, clientTopUp(nextMeta('2026-09-03T10:00:00Z'), payer, amount));
        result = appendEntry(
          result,
          lockForTranche(nextMeta('2026-09-03T10:00:01Z'), payer, deal, amount),
        );
        break;
      }
      case 'payout_with_fee': {
        // Комиссию считает `@sdelka/money` (§4.3): остаток от округления всегда
        // у получателя, поэтому она берётся вычитанием, а не умножением.
        const parts = split(amount, [{ key: 'fee:income', rate: options.feeRate }]);
        const fee = parts.deductions[0]?.amount ?? null;
        // Расчёт и вывод комиссии на операционный счёт — одна запись (красная
        // линия №2): словарь иначе и не умеет.
        result = appendEntry(
          result,
          settleTrancheToClientAccount(
            nextMeta('2026-09-03T12:00:00Z'),
            trancheSettlement(deal, payer, clientKey(options.recipientClientKey)),
            amount,
            fee,
          ),
        );
        break;
      }
      case 'refund':
        // Возврат — отвязка от сделки: деньги возвращаются в **свободную** часть
        // счёта того же покупателя, отзывными (красная линия №7). Перевод их
        // наружу, на счёт-источник (красная линия №9), — отдельное событие
        // (И12.2): намерения у автомата на него нет, конструктора в словаре
        // тоже. Проекция на этом останавливается, а не придумывает запись:
        // «деньги у покупателя на его счёте, мы их держим» — утверждение
        // слабее терминального `refunded`, но верное.
        result = appendEntry(
          result,
          unlockToClientAccount(nextMeta('2026-09-03T12:00:00Z'), payer, deal, amount),
        );
        break;
      case 'write_off':
        // ⚠ Единственная запись, собранная не словарём: конструктора списания в
        // `entries.ts` нет (то же расхождение, что и в `packages/e2e`).
        //
        // Случай Б из FUNCTIONAL.md §3.1: невостребованные средства. Это и есть
        // терминальное `written_off`. Обязательство дебетуется, деньги уходят с
        // номинального счёта — на нём не остаётся остатка без признанного
        // обязательства, — и превращаются не в доход, а в другой долг:
        // `unclaimed:liability`. Форма — та, что закреплена тестами
        // `packages/ledger` (`test/write-off.test.ts`, случай Б); документ
        // требует ещё транзитного счёта на время межбанковского перевода, но
        // счёта `transit:writeoff` в плане счетов нет — расхождение учёта, не
        // домена.
        //
        // Случай А (недостача при зачислении) состоянием транша не является и
        // здесь не проецируется: он живёт в проводке поступления.
        result = appendEntry(
          result,
          createJournalEntry({
            ...nextMeta('2026-09-04T12:00:00Z'),
            kind: 'settlement',
            memoKey: 'ledger.entry.unclaimed',
            postings: [
              debit(clientLockedAccount(payer, deal.dealId, deal.trancheId), amount, deal),
              credit(bankNominal(amount.currency), amount, deal),
              debit(bankOperating(amount.currency), amount),
              credit(unclaimedLiability, amount),
            ],
          }),
        );
        break;
    }
  }
  return result;
}
