import { type CurrencyCode, type Money, compare } from '@sdelka/money';
import { type ClientAccountFacts, evaluateWithdrawalGuard } from './client-account';
import { type Rejection, type Result, RejectionCode, failure, ok, rejection } from './result';

/**
 * Внутреннее движение: свободные деньги клиента идут на его собственную сделку
 * — `ROADMAP.md` И12.4, `CORE.md` Ф14.
 *
 * **Почему это отдельный модуль, а не функция рядом с выводом.** Вывод уводит
 * деньги наружу и ведёт их своей машиной; здесь наружу не уходит ничего —
 * движение целиком внутри счёта клиента, и его исполняет **машина транша**
 * получающей сделки. Модуль отвечает ровно за одно: за право такое движение
 * совершить.
 *
 * **Чего здесь не было и в чём был дефект.** Проверка свободного остатка стояла
 * (`planAllocationToDeal` существовала с E12-3), но не стояла ни на одной
 * дороге: `packages/app` её не звал, единственным вызывающим был отрицательный
 * случай в сквозном тесте. Приложение при этом внутреннее движение исполняло —
 * событием `funds_received` с маршрутом зачисления `already_on_client_account`,
 * — и на этой дороге свободный остаток не проверялся **вовсе**: транш принимал
 * сумму, которой у клиента свободной могло не быть, а списывал её потом
 * `lock_funds` на входе в `reserved`. Механизм был построен, дороги к нему не
 * было, а движение шло мимо.
 */

/** Запрос на движение: куда и сколько. */
export interface AllocationRequest {
  readonly dealId: string;
  readonly trancheId: string;
  readonly amount: Money<CurrencyCode>;
}

/**
 * Ambient-символ по образцу `DealPartiesAttestation` (`@sdelka/ledger`):
 * значения у него нет ни в рантайме, ни в типах, поэтому объект с этим ключом
 * **невозможно построить кодом** нигде, кроме единственного приведения ниже.
 */
declare const authorizedByClientAccount: unique symbol;

/**
 * Разрешение счёта клиента на внутреннее движение.
 *
 * Смысл значения: «свободного остатка **этого** клиента хватало на **эту**
 * сумму, и он направляет её на **этот** транш». Выдаётся только
 * `planAllocationToDeal`, то есть только после проверки остатка. Подделать его
 * приложение не может — построить объект с ambient-ключом нечем, — а значит
 * внутреннее движение невыразимо в обход проверки.
 *
 * Привязка тройная (клиент, транш, сумма) по той же причине, по которой
 * подтверждение сторон в учёте привязано к сделке и лицам: одно выданное
 * разрешение не должно открывать движение по чему угодно.
 */
export interface AllocationAuthorization {
  /** Владелец свободного остатка, который проверили. */
  readonly clientKey: string;
  readonly dealId: string;
  readonly trancheId: string;
  readonly amount: Money<CurrencyCode>;
  readonly [authorizedByClientAccount]: true;
}

/**
 * Направить свободные деньги на свою сделку — И12.4.
 *
 * Функция смотрит **только** на свободную часть. Запертая под сделку А часть на
 * сделку Б не пойдёт не потому, что здесь стоит проверка, а потому, что она
 * лежит на другом счёте и в это сравнение не входит: красная линия №1 говорит
 * про обязательства, а не про людей, и свой собственный резерв на свою вторую
 * сделку не идёт — сделка А может откатиться, и деньги обязаны вернуться.
 *
 * Отказ при недостатке свободного остатка обязателен именно **на момент
 * применения**: И12.2 задаёт порядок «резерв выигрывает, вывод создаётся на
 * остаток после резерва», и между запросом и применением свободная часть могла
 * уменьшиться. Поэтому разрешение и не хранится: его выдают на один вызов
 * автомата транша по свежим фактам счёта.
 */
export function planAllocationToDeal(
  facts: ClientAccountFacts,
  request: AllocationRequest,
): Result<AllocationAuthorization, Rejection> {
  if (facts.requestedAmount.currency !== request.amount.currency) {
    return failure(
      rejection(RejectionCode.guardFailed, ['g_free_balance_sufficient'], {
        reason: 'currency_mismatch',
      }),
    );
  }
  if (compare(facts.requestedAmount, request.amount) !== 0) {
    // Запрос и факты обязаны говорить об одной сумме: иначе проверка остатка
    // относилась бы к одному числу, а движение — к другому.
    return failure(
      rejection(RejectionCode.guardFailed, ['g_free_balance_sufficient'], {
        reason: 'amount_mismatch',
      }),
    );
  }
  if (!evaluateWithdrawalGuard('g_free_balance_sufficient', facts)) {
    return failure(
      rejection(RejectionCode.guardFailed, ['g_free_balance_sufficient'], {
        dealId: request.dealId,
        trancheId: request.trancheId,
      }),
    );
  }
  const clientKey = facts.clientKey;
  if (clientKey === undefined || clientKey.length === 0) {
    // Остаток без владельца проверять бессмысленно: разрешение, не называющее
    // клиента, транш применил бы к тому плательщику, которого назвал сам
    // вызывающий, — то есть подтверждало бы само себя.
    return failure(
      rejection(RejectionCode.allocationOwnerUnknown, [], {
        dealId: request.dealId,
        trancheId: request.trancheId,
      }),
    );
  }
  return ok(
    Object.freeze({
      clientKey,
      dealId: request.dealId,
      trancheId: request.trancheId,
      amount: request.amount,
    }) as unknown as AllocationAuthorization,
  );
}

/**
 * Совпадает ли разрешение с тем движением, которое собираются совершить.
 *
 * Живёт здесь, а не в автомате транша, чтобы правило «разрешение годится
 * только для своего транша, своего плательщика и своей суммы» имело одно место.
 * Автомат зовёт эту функцию и отказывает `allocationNotAuthorized`.
 */
export function allocationMatches(
  authorization: AllocationAuthorization,
  movement: {
    readonly clientKey: string;
    readonly dealId: string;
    readonly trancheId: string;
    readonly amount: Money<CurrencyCode>;
  },
): boolean {
  return (
    authorization.clientKey === movement.clientKey &&
    authorization.dealId === movement.dealId &&
    authorization.trancheId === movement.trancheId &&
    authorization.amount.currency === movement.amount.currency &&
    authorization.amount.minor === movement.amount.minor
  );
}
