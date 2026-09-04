import type { CurrencyCode } from '@sdelka/money';
import { accountType, clientAccountOwner } from './accounts';
import {
  coverage,
  coverageByFundsSource,
  coverageByTranche,
  negativeBankBalances,
  negativeClientBalances,
  negativePlatformAssetBalances,
  openFxPositions,
  openTransitPositions,
  unclaimedCoverage,
} from './balance';
import { balanceByCurrency, clientFileGains, isClientRef } from './entry';
import type { Journal } from './journal';

/**
 * Инварианты учёта, проверяемые в коде.
 *
 * В целевой архитектуре их держит база: триггер на нулевую сумму журнала,
 * ограничение на неотрицательный остаток, частичный уникальный индекс на
 * выплату. Пока базы нет, те же правила проверяются здесь — и остаются здесь
 * после, как второй контур для регулярной проверки и для отчёта дежурному.
 */
export const InvariantCode = {
  entryUnbalanced: 'ledger.invariant.entry_unbalanced',
  negativeClientBalance: 'ledger.invariant.negative_client_balance',
  /**
   * Банковский счёт платформы в минусе: журнал утверждает перевод, которого
   * банк не исполнил бы. Клиентские счета — включая номинальный — держит
   * `negativeClientBalance`; здесь остаётся операционный, до которого тот не
   * достаёт, потому что деньги на нём наши.
   *
   * Прямой случай — довнесение недостачи (§3.1, случай А, момент 2) с пустого
   * операционного счёта: дыра в клиентских средствах закрыта обещанием, за
   * которым ничего нет.
   */
  negativeBankBalance: 'ledger.invariant.negative_bank_balance',
  coverageBelowOne: 'ledger.invariant.coverage_below_one',
  trancheUncovered: 'ledger.invariant.tranche_uncovered',
  // Второй вид файла (FUNCTIONAL.md §3.1): свободная часть счёта клиента.
  // Обязательство перед клиентом вне сделки без денег на номинальном счёте —
  // такое же расхождение, как необеспеченный транш, и точно так же должно
  // останавливать приём новых сделок.
  clientAccountUncovered: 'ledger.invariant.client_account_uncovered',
  /**
   * Средства на номинальном счёте, отнесённые к файлу, но никому по этому файлу
   * не должные.
   *
   * Профицит по файлу — не запас прочности, а одно из двух нарушений, и оба
   * красные. Либо на счёте клиентских средств лежат деньги платформы
   * (комиссия, которую забыли вывести, — красная линия №2), либо обязательство
   * из файла увели, а деньги оставили: дебет обязательства без встречного
   * движения кастодиана уносит транш в профицит, и до появления этой проверки
   * такую двухзаписную «отмывку» через `suspense` не ловило вообще ничто —
   * пофайловое покрытие считает профицит покрытием (`custody >= obligations`),
   * а у непознанного поступления файла нет вовсе.
   */
  custodySurplus: 'ledger.invariant.custody_surplus',
  /**
   * Невостребованные средства без обеспечения — вторая проверка покрытия,
   * которую требует §3.1: деньги, признанные чужими, ушли с номинального счёта,
   * и если операционного остатка вместе с транзитом на них не хватает, за ними
   * не стоит уже ничего.
   *
   * Приём новых сделок этим не останавливается: красная линия №3 говорит про
   * покрытие клиентских средств на номинальном счёте, а порядок обращения с
   * невостребованными помечен в §3.1 как **[открыто]**. Расхождение обязано
   * быть видимым — решение о стоп-кране принимает владелец вместе с ответом
   * юриста.
   */
  unclaimedUncovered: 'ledger.invariant.unclaimed_uncovered',
  /**
   * Отрицательный остаток прочего актива платформы — требования или транзита.
   *
   * Отдельно от `negativeBankBalance` намеренно: код инварианта читает дежурный,
   * и «банковский счёт в минусе» на требовании по начисленной комиссии —
   * ложное сообщение. Прямой случай — удержание комиссии, которая не
   * начислялась: `fee:receivable` уходит в минус.
   */
  platformAssetNegative: 'ledger.invariant.platform_asset_negative',
  /**
   * Открытая позиция по обмену старше окна: исходная валюта отдана
   * контрагенту, встречная не поставлена (FUNCTIONAL.md §3.3).
   *
   * Это **единственное**, чем ловится состояние «встречная валюта не
   * поставлена». Отрицательным остатком оно не выражается — остаток
   * положительный; покрытием тоже — счёт расчётов с контрагентом объявлен
   * клиентским активом, и портфельное отношение в целевой валюте после
   * переоформления обязательства снова сходится в единицу. Осталось только
   * время: позиция обязана схлопнуться, и если она не схлопнулась, это
   * расхождение.
   *
   * Приём новых сделок этим **не** останавливается. Красная линия №3 говорит о
   * покрытии, а покрытие здесь не нарушено: деньги у контрагента — всё ещё
   * деньги клиента. Расхождение обязано быть видимым и, по И7.1, блокировать
   * выплаты через сутки; стоп-кран на приём — решение владельца, по образцу
   * `unclaimedUncovered`.
   */
  fxPositionOpen: 'ledger.invariant.fx_position_open',
  /**
   * Остаток на транзитном счёте старше окна.
   *
   * §3.1 обещает это про `transit:writeoff` дословно — «остаток на нём старше
   * двух банковских дней — расхождение для сверки, а не норма», — а в коде
   * такого инварианта не было вовсе: обещание документа не было подкреплено
   * ничем. С `transit:fee` то же обещание появляется у комиссии (Ф16:
   * «удержана, но перевод не прошёл» — видимое состояние), и оба счёта
   * закрываются одним механизмом.
   */
  transitStale: 'ledger.invariant.transit_stale',
  /**
   * В файл клиента внесено денег платформы больше, чем по нему признано
   * недостачи (FUNCTIONAL.md §3.1, случай А).
   *
   * Второй контур `fundShortfall`. Первый — токен признания: конструктор
   * словаря берёт владельца и сумму из записи признания, поэтому «доложить
   * кому угодно сколько угодно» там невыразимо. Но `createJournalEntry`
   * остаётся низкоуровневой дверью, и через неё форма собирается: прирост
   * клиентского файла, подпёртый кредитом операционного счёта, законен по
   * построению — это и есть довнесение. Отличить довнесение от подарка можно
   * только по признанию, а признание — это история, а не одна запись.
   */
  shortfallOverfunded: 'ledger.invariant.shortfall_overfunded',
} as const;

export type InvariantCode = (typeof InvariantCode)[keyof typeof InvariantCode];

export interface InvariantViolation {
  readonly code: InvariantCode;
  readonly currency: CurrencyCode | null;
  readonly subject: string;
  readonly amountMinor: bigint;
}

/**
 * Настройки проверок, которым нужен возраст: позиция обмена и транзит.
 *
 * Аргумент **необязателен** намеренно. Инварианты вызываются из сквозных
 * сценариев, из приложения и из тестов десятками мест; обязательный аргумент
 * сломал бы их все ради двух проверок, у которых есть разумное умолчание.
 *
 * `asOf` по умолчанию — самая поздняя `occurredAt` в журнале: «сейчас» для
 * журнала это момент последнего известного факта, а не системные часы. Так
 * проверка остаётся чистой функцией от журнала и воспроизводится через год.
 *
 * ⚠ `staleAfterMs` — календарные часы, а не банковские дни. §3.1 говорит о
 * двух банковских днях; банковский календарь (выходные, праздники Грузии) в
 * учёте не живёт и жить не должен, поэтому умолчание — 48 часов, а настоящее
 * окно передаёт тот, у кого календарь есть.
 */
export interface InvariantOptions {
  readonly asOf?: string;
  readonly staleAfterMs?: number;
}

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Возраст в миллисекундах или `null`, если хотя бы одна из меток не разбирается.
 * Неразбираемая метка — это не «свежо»: проверка молчит и говорит об этом
 * `null`, а не подставляет ноль.
 */
function ageMs(since: string, asOf: string): number | null {
  const from = Date.parse(since);
  const to = Date.parse(asOf);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return to - from;
}

function latestOccurredAt(journal: Journal): string | null {
  let latest: string | null = null;
  for (const entry of journal.entries) {
    const parsed = Date.parse(entry.occurredAt);
    if (Number.isNaN(parsed)) continue;
    if (latest === null || parsed > Date.parse(latest)) latest = entry.occurredAt;
  }
  return latest;
}

export function checkLedgerInvariants(
  journal: Journal,
  options: InvariantOptions = {},
): readonly InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const asOf = options.asOf ?? latestOccurredAt(journal);
  const staleAfterMs = options.staleAfterMs ?? TWO_DAYS_MS;

  for (const entry of journal.entries) {
    for (const [currency, total] of balanceByCurrency(entry.postings)) {
      if (total !== 0n) {
        violations.push({
          code: InvariantCode.entryUnbalanced,
          currency,
          subject: entry.id,
          amountMinor: total,
        });
      }
    }
  }

  for (const item of negativeClientBalances(journal)) {
    violations.push({
      code: InvariantCode.negativeClientBalance,
      currency: item.currency,
      subject: item.accountCode,
      amountMinor: item.balance.minor,
    });
  }

  for (const item of negativeBankBalances(journal)) {
    violations.push({
      code: InvariantCode.negativeBankBalance,
      currency: item.currency,
      subject: item.accountCode,
      amountMinor: item.balance.minor,
    });
  }

  for (const item of coverage(journal)) {
    if (!item.covered) {
      violations.push({
        code: InvariantCode.coverageBelowOne,
        currency: item.currency,
        subject: 'portfolio',
        amountMinor: item.difference.minor,
      });
    }
  }

  for (const item of unclaimedCoverage(journal)) {
    if (!item.covered) {
      violations.push({
        code: InvariantCode.unclaimedUncovered,
        currency: item.currency,
        subject: 'unclaimed',
        amountMinor: item.difference.minor,
      });
    }
  }

  for (const item of coverageByTranche(journal)) {
    if (!item.covered) {
      violations.push({
        code: InvariantCode.trancheUncovered,
        currency: item.currency,
        subject: `${item.deal.dealId}:${item.deal.trancheId}`,
        amountMinor: item.difference.minor,
      });
    }
  }

  for (const item of negativePlatformAssetBalances(journal)) {
    violations.push({
      code: InvariantCode.platformAssetNegative,
      currency: item.currency,
      subject: item.accountCode,
      amountMinor: item.balance.minor,
    });
  }

  if (asOf !== null) {
    for (const position of openFxPositions(journal)) {
      const age = ageMs(position.openedAt, asOf);
      if (age === null || age <= staleAfterMs) continue;
      for (const balance of position.balances) {
        violations.push({
          code: InvariantCode.fxPositionOpen,
          currency: balance.currency,
          subject: position.conversionId,
          amountMinor: balance.amount.minor,
        });
      }
    }

    for (const position of openTransitPositions(journal)) {
      const age = ageMs(position.openedAt, asOf);
      if (age === null || age <= staleAfterMs) continue;
      violations.push({
        code: InvariantCode.transitStale,
        currency: position.currency,
        subject: position.accountCode,
        amountMinor: position.amount.minor,
      });
    }
  }

  for (const item of overfundedShortfalls(journal)) {
    violations.push(item);
  }

  for (const item of coverageByFundsSource(journal)) {
    const subject =
      item.source.kind === 'client'
        ? item.source.clientKey
        : `${item.source.deal.dealId}:${item.source.deal.trancheId}`;
    // Транши уже посчитаны выше своим отношением: недостача по файлу клиента
    // добавляется здесь, иначе одно и то же расхождение попадало бы в отчёт
    // дважды.
    if (item.source.kind === 'client' && !item.covered) {
      violations.push({
        code: InvariantCode.clientAccountUncovered,
        currency: item.currency,
        subject,
        amountMinor: item.difference.minor,
      });
    }
    // Профицит считается по обоим видам файла: деньги платформы на номинальном
    // счёте (красная линия №2) и опустошённый файл (красная линия №1) выглядят
    // одинаково — средств больше, чем обязательств, — и оба обязаны быть
    // расхождением, а не запасом.
    if (item.difference.minor > 0n) {
      violations.push({
        code: InvariantCode.custodySurplus,
        currency: item.currency,
        subject,
        amountMinor: item.difference.minor,
      });
    }
  }

  return violations;
}

/**
 * Довнесённое сверх признанного, по каждой паре «клиент, валюта».
 *
 * Признание считается по проводкам `shortfall:expense` с отнесением к клиенту:
 * счёт не клиентских средств, поэтому отнесение на нём инертно для
 * конструктора записи и стоит ровно ради этой сверки. Довнесённое — это сумма
 * приростов файла этого клиента по всем записям; больше нуля прирост бывает
 * только там, где платформа положила в файл собственные деньги (это держит
 * `assertNoUnfundedClientFileGain`), поэтому отдельного признака «это
 * довнесение» не требуется — и хорошо, что не требуется: признак ставит тот
 * же, кто строит запись.
 */
function overfundedShortfalls(journal: Journal): readonly InvariantViolation[] {
  const recognised = new Map<string, bigint>();
  const funded = new Map<string, bigint>();
  const bump = (target: Map<string, bigint>, key: string, value: bigint): void => {
    target.set(key, (target.get(key) ?? 0n) + value);
  };

  for (const entry of journal.entries) {
    for (const posting of entry.postings) {
      if (posting.account.kind !== 'shortfall_expense') continue;
      const attribution = posting.attribution;
      if (attribution === null || !isClientRef(attribution)) continue;
      bump(
        recognised,
        `${attribution.clientKey}|${posting.amount.currency}`,
        posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor,
      );
    }
    for (const gain of clientFileGains(entry.postings)) {
      if (gain.minor <= 0n) continue;
      const source = gain.source;
      if (source === null || !isClientRef(source)) continue;
      bump(funded, `${source.clientKey}|${gain.currency}`, gain.minor);
    }
  }

  const violations: InvariantViolation[] = [];
  for (const [key, total] of [...funded.entries()].sort((left, right) =>
    left[0] < right[0] ? -1 : 1,
  )) {
    const excess = total - (recognised.get(key) ?? 0n);
    if (excess <= 0n) continue;
    const separator = key.lastIndexOf('|');
    violations.push({
      code: InvariantCode.shortfallOverfunded,
      currency: key.slice(separator + 1) as CurrencyCode,
      subject: key.slice(0, separator),
      amountMinor: excess,
    });
  }
  return violations;
}

/**
 * Нарушение покрытия останавливает приём новых сделок автоматически
 * (красная линия №3, CORE.md Ф10). Решение принимает приложение — здесь
 * только признак, вычисленный из журнала.
 */
export function shouldStopAcceptingDeals(
  journal: Journal,
  options: InvariantOptions = {},
): boolean {
  return checkLedgerInvariants(journal, options).some(
    (violation) =>
      violation.code === InvariantCode.coverageBelowOne ||
      violation.code === InvariantCode.trancheUncovered ||
      violation.code === InvariantCode.clientAccountUncovered ||
      // Профицит — тоже отклонение покрытия от единицы, только в другую
      // сторону, и останавливает приём ровно так же: пока на счёте клиентских
      // средств лежит чужое этому счёту, новые деньги туда принимать нельзя.
      violation.code === InvariantCode.custodySurplus ||
      violation.code === InvariantCode.negativeClientBalance,
  );
}
