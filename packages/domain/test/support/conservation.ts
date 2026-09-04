import {
  type Account,
  type Journal,
  accountBalances,
  accountCode,
  bankNominal,
  bankOperating,
  clientFreeAccount,
  clientKey,
  clientLockedAccount,
  transitWriteoff,
  unclaimedLiability,
} from '@sdelka/ledger';
import { type CurrencyCode, type Money, type Rational, split } from '@sdelka/money';
import type { Intent } from '../../src/index';

/**
 * Модель остатков, посчитанная **из намерений автомата, а не из журнала**.
 *
 * Зачем нужна отдельная модель, если есть `checkLedgerInvariants`. Все проверки
 * учёта смотрят на журнал изнутри: сумма записи ноль, покрытие по файлу,
 * отрицательный остаток. Такая проверка по построению не видит расхождения,
 * симметричного с обеих сторон, — а именно таким и оказалось **исчезновение
 * обязательства**: если расчёт дебетует запертую часть плательщика и кредитует
 * номинальный счёт, не порождая обязательства перед получателем, то у файла
 * транша исчезают сразу и деньги, и долг. Запись сходится в ноль, покрытие
 * равно единице, профицита нет, отрицательных остатков нет,
 * `checkLedgerInvariants` возвращает пустой список — а деньги ушли в никуда.
 * Именно это верификатор проверил мутацией и назвал «заявка о профиците и
 * недостаче верна только для двух форм, которые есть в тестах».
 *
 * Поймать такое можно только сравнением с внешним счётом: сколько денег
 * автомат **велел** двигать и куда. Здесь этот счёт и ведётся — по потоку
 * намерений, ничего не зная о форме записей. Модель предсказывает остаток
 * каждого счёта до минорной единицы, поэтому ловит не только исчезновение
 * обязательства, но и любое движение денег не туда, куда велено.
 *
 * Ставка комиссии считается тем же `split`, что и в проекции (§4.3: остаток от
 * округления у получателя). Это не круговая ссылка: сверяются не формулы, а
 * остатки счетов — модель говорит, **у кого** должны оказаться деньги, а
 * проекция строит проводки, и совпасть они могут только если обе правы.
 */
export interface ExpectedBalances {
  readonly totals: ReadonlyMap<string, bigint>;
}

const feeIncome: Account = Object.freeze({ kind: 'fee_income' });

function keyOf(account: Account, currency: CurrencyCode): string {
  return `${accountCode(account)}|${currency}`;
}

class Totals {
  private readonly totals = new Map<string, bigint>();

  add(account: Account, amount: Money<CurrencyCode>): void {
    const key = keyOf(account, amount.currency);
    this.totals.set(key, (this.totals.get(key) ?? 0n) + amount.minor);
  }

  subtract(account: Account, amount: Money<CurrencyCode>): void {
    const key = keyOf(account, amount.currency);
    this.totals.set(key, (this.totals.get(key) ?? 0n) - amount.minor);
  }

  /** Нулевые остатки выбрасываются: счёт, сведённый в ноль, — это отсутствие остатка. */
  frozen(): ReadonlyMap<string, bigint> {
    const result = new Map<string, bigint>();
    for (const [key, value] of this.totals) {
      if (value !== 0n) result.set(key, value);
    }
    return result;
  }
}

/**
 * Ожидаемые остатки после потока намерений — в естественном знаке счёта, том
 * же, в котором их считает `accountBalances`.
 *
 * Каждая ветка — одно предложение о деньгах, а не форма записи:
 *
 * - поступление: на номинальном счёте стало больше, у клиента появился долг в
 *   свободной части (транша он ещё не касается);
 * - запирание: долг переехал из свободной части в файл транша;
 * - расфиксация: тот же долг переехал обратно;
 * - расчёт: долг транша погашен, у получателя в свободной части появилось
 *   нетто, комиссия признана доходом и **ушла с номинального счёта** на
 *   операционный (красная линия №2);
 * - возврат, момент 1: долг транша погашен, столько же должны покупателю в
 *   свободной части; деньги на номинальном счёте не двигались;
 * - возврат, момент 2: долг перед покупателем погашен, деньги ушли с
 *   номинального счёта;
 * - списание: долг транша погашен, деньги ушли с номинального счёта в транзит
 *   и стали долгом невостребованных.
 */
export function expectedBalances(
  intents: readonly Intent[],
  feeRate: Rational,
): ExpectedBalances {
  const totals = new Totals();
  for (const intent of intents) {
    if (intent.type === 'post_settlement_entry') {
      const payer = clientKey(intent.payerClientKey);
      const recipient = clientKey(intent.recipientClientKey);
      const parts = split(intent.amount, [{ key: 'fee:income', rate: feeRate }]);
      const fee = parts.deductions[0]?.amount ?? null;
      const net = parts.recipient;
      totals.subtract(
        clientLockedAccount(payer, intent.dealId, intent.trancheId),
        intent.amount,
      );
      totals.add(clientFreeAccount(recipient), net);
      if (fee !== null && fee.minor > 0n) {
        totals.add(feeIncome, fee);
        totals.add(bankOperating(fee.currency), fee);
        totals.subtract(bankNominal(fee.currency), fee);
      }
      continue;
    }
    if (intent.type !== 'post_journal_entry') continue;
    const owner = clientKey(intent.clientKey);
    const locked = clientLockedAccount(owner, intent.dealId, intent.trancheId);
    const free = clientFreeAccount(owner);
    const nominal = bankNominal(intent.amount.currency);
    switch (intent.template) {
      // Зачисление и привязка к сделке разведены и в модели: раньше
      // `funds_received` был записан здесь как «на номинальном стало больше, у
      // транша появился долг», то есть модель была склеена ровно так же, как
      // проекция, и расхождение между ними было невыразимо.
      case 'funds_received':
        totals.add(nominal, intent.amount);
        totals.add(free, intent.amount);
        break;
      case 'lock_funds':
        totals.subtract(free, intent.amount);
        totals.add(locked, intent.amount);
        break;
      case 'unlock_funds':
        totals.subtract(locked, intent.amount);
        totals.add(free, intent.amount);
        break;
      case 'refund_unlock':
        totals.subtract(locked, intent.amount);
        totals.add(free, intent.amount);
        break;
      case 'refund_external':
        totals.subtract(free, intent.amount);
        totals.subtract(nominal, intent.amount);
        break;
      case 'write_off':
        totals.subtract(locked, intent.amount);
        totals.subtract(nominal, intent.amount);
        totals.add(transitWriteoff, intent.amount);
        totals.add(unclaimedLiability, intent.amount);
        break;
    }
  }
  return { totals: totals.frozen() };
}

export function mergeExpected(
  left: ExpectedBalances,
  right: ExpectedBalances,
): ExpectedBalances {
  const totals = new Map<string, bigint>(left.totals);
  for (const [key, value] of right.totals) {
    const next = (totals.get(key) ?? 0n) + value;
    if (next === 0n) totals.delete(key);
    else totals.set(key, next);
  }
  return { totals };
}

export interface BalanceBreak {
  readonly account: string;
  readonly expectedMinor: bigint;
  readonly actualMinor: bigint;
}

/**
 * Расхождения между тем, что автомат велел, и тем, что записал журнал.
 *
 * Сравниваются **все** счета в обе стороны: и те, где остаток не тот, и те,
 * которых в журнале нет, и те, которых не должно было быть вовсе. Деньги,
 * ушедшие на счёт, о котором намерения не говорили, — такое же расхождение,
 * как деньги, не дошедшие до названного.
 */
export function balanceBreaks(
  journal: Journal,
  expected: ExpectedBalances,
): readonly BalanceBreak[] {
  const actual = new Map<string, bigint>();
  for (const item of accountBalances(journal)) {
    if (item.balance.minor === 0n) continue;
    actual.set(`${item.accountCode}|${item.currency}`, item.balance.minor);
  }
  const breaks: BalanceBreak[] = [];
  for (const key of new Set([...expected.totals.keys(), ...actual.keys()])) {
    const expectedMinor = expected.totals.get(key) ?? 0n;
    const actualMinor = actual.get(key) ?? 0n;
    if (expectedMinor !== actualMinor) {
      breaks.push({ account: key, expectedMinor, actualMinor });
    }
  }
  return breaks.sort((left, right) => (left.account < right.account ? -1 : 1));
}
