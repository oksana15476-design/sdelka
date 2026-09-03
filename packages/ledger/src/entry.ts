import type { CurrencyCode, Money } from '@sdelka/money';
import {
  type Account,
  type ClientKey,
  accountCode,
  assertAccountIdentifier,
  bankOperating,
  clientAccountOwner,
  clientFreeAccount,
  clientLockedAccount,
  isClientCustodyAccount,
  isClientFundsAccount,
  isClientObligationAccount,
  isPlatformIncomeAccount,
} from './accounts';
import { LedgerError, LedgerErrorCode } from './errors';

export type Direction = 'debit' | 'credit';

/** Отнесение проводки к сделке и траншу — основание пофайловой сверки. */
export interface TrancheRef {
  readonly dealId: string;
  readonly trancheId: string;
}

/** Отнесение проводки к клиенту вне сделки — второй вид файла (FUNCTIONAL.md §3.1). */
export interface ClientRef {
  readonly clientKey: ClientKey;
}

/**
 * Источник средств: транш или клиент. Union структурный, без тега, — чтобы
 * `debit(acc, m, { dealId, trancheId })` оставался тем же вызовом, что и до
 * появления счёта клиента: различение по наличию поля владельца.
 */
export type FundsRef = TrancheRef | ClientRef;

export function isClientRef(ref: FundsRef): ref is ClientRef {
  return 'clientKey' in ref;
}

export interface Posting {
  readonly account: Account;
  readonly direction: Direction;
  readonly amount: Money<CurrencyCode>;
  /** `null` допустим только там, где сделка ещё не известна: непознанное поступление. */
  readonly attribution: FundsRef | null;
}

/**
 * `correction` — единственный способ исправления (красная линия №11: журнал не
 * редактируется, исправление только новой записью со ссылкой на предыдущую).
 */
export type JournalEntryKind = 'settlement' | 'correction';

/**
 * Объявление расчёта по траншу: кто платит, кто получает, по какой сделке.
 *
 * Красная линия №1 — архитектурный запрет, а не дисциплина. Обязательство
 * плательщика заперто структурой: код счёта `client:{плательщик}:tranche:{сделка}:{транш}`
 * содержит и владельца, и транш. **У получателя такой опоры не было вовсе**:
 * расчёт кредитовал свободную часть произвольного клиента, и запись «деньги
 * сделки А ушли лицу, к сделке А отношения не имеющему» строилась молча — после
 * чего это лицо законно запирало их под свою сделку Б.
 *
 * Ledger не знает и не может знать состав участников сделки: участники живут в
 * домене. Поэтому проверяемое здесь — не «Y действительно продавец по А» (этого
 * из журнала не следует), а то, что **утверждение об этом присутствует в самой
 * записи и постройка ему соответствует**:
 *
 * 1. движение обязательства между разными владельцами вообще невозможно без
 *    этого объявления (`assertClientOwnerMoveOnlySettles`);
 * 2. объявление называет сделку, транш, плательщика и получателя одним
 *    значением, и каждая проводка записи сверяется с ним: в расчёте не может
 *    участвовать ни один посторонний счёт клиента;
 * 3. объявление остаётся в журнале (`JournalEntry.settles`) — то есть претензия
 *    «Y получатель по сделке A» становится проверяемым фактом записи для аудита
 *    и сверки, а не молчаливым следствием формы проводок.
 *
 * Значение брендированное: структурный литерал на его место подставить нельзя,
 * идентификаторы валидируются теми же правилами, что и код счёта.
 */
export interface TrancheSettlement {
  readonly deal: TrancheRef;
  /** Владелец запертой части: она же источник денег расчёта. */
  readonly payer: ClientKey;
  /** Получатель расчёта. Свободную часть его счёта — и ничью больше — кредитует запись. */
  readonly recipient: ClientKey;
  readonly __trancheSettlement: unique symbol;
}

export function trancheSettlement(
  deal: TrancheRef,
  payer: ClientKey,
  recipient: ClientKey,
): TrancheSettlement {
  assertAccountIdentifier(deal.dealId, 'dealId');
  assertAccountIdentifier(deal.trancheId, 'trancheId');
  assertAccountIdentifier(payer, 'payer');
  assertAccountIdentifier(recipient, 'recipient');
  if (payer === recipient) {
    // FUNCTIONAL.md §2.1, «Что запрещено жёстко»: одна и та же личность на обеих
    // сторонах одной сделки — отказ, а не предупреждение. Возврат самому себе
    // расчётом не является: у него своя запись (`unlockToClientAccount`).
    throw new LedgerError(LedgerErrorCode.settlementSelfDealing, {
      dealId: deal.dealId,
      trancheId: deal.trancheId,
      clientKey: payer,
    });
  }
  return Object.freeze({
    deal: Object.freeze({ dealId: deal.dealId, trancheId: deal.trancheId }),
    payer,
    recipient,
  }) as unknown as TrancheSettlement;
}

export interface JournalEntryInput {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: JournalEntryKind;
  readonly postings: readonly Posting[];
  /** Ключ локализации/тип операции, не текст для клиента. */
  readonly memoKey: string;
  readonly correctsEntryId?: string;
  /**
   * Объявление расчёта. Обязательно ровно там, где обязательство переходит от
   * одного клиента к другому, и запрещено там, где такого перехода нет.
   */
  readonly settles?: TrancheSettlement;
}

export interface JournalEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: JournalEntryKind;
  readonly postings: readonly Posting[];
  readonly memoKey: string;
  readonly correctsEntryId: string | null;
  readonly settles: TrancheSettlement | null;
}

function signedMinor(posting: Posting): bigint {
  return posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor;
}

/** Дт минус Кт по каждой валюте отдельно. */
export function balanceByCurrency(postings: readonly Posting[]): ReadonlyMap<CurrencyCode, bigint> {
  const totals = new Map<CurrencyCode, bigint>();
  for (const posting of postings) {
    const currency = posting.amount.currency;
    totals.set(currency, (totals.get(currency) ?? 0n) + signedMinor(posting));
  }
  return totals;
}

function assertBalanced(postings: readonly Posting[]): void {
  // Мультивалютная запись балансируется в каждой валюте, а не в пересчёте:
  // пересчёт зависит от курса, а курс — это отдельная проводка (FUNCTIONAL.md §3.3).
  for (const [currency, total] of balanceByCurrency(postings)) {
    if (total !== 0n) {
      throw new LedgerError(LedgerErrorCode.entryUnbalanced, {
        currency,
        difference: total.toString(),
      });
    }
  }
}

function assertAttribution(postings: readonly Posting[]): void {
  // Непознанное поступление не может быть отнесено к сделке — на то оно и
  // непознанное (FUNCTIONAL.md §3.3, шаг 1). Во всех остальных записях проводка
  // по номинальному счёту обязана нести отнесение, иначе пофайловая сверка
  // (CORE.md Ф10) не построится — теперь по любому из двух файлов: транш или
  // клиент.
  const hasSuspense = postings.some((posting) => posting.account.kind === 'suspense_unidentified');
  for (const posting of postings) {
    const account = posting.account;
    const attribution = posting.attribution;
    if (account.kind === 'client_locked') {
      if (attribution === null) continue;
      if (isClientRef(attribution)) {
        // Запертые деньги живут в файле транша, а не в файле владельца: иначе
        // обеспечение транша считалось бы по чужому файлу и красная линия №1
        // перестала бы иметь опору в отнесении.
        throw new LedgerError(LedgerErrorCode.postingClientAttributionMismatch, {
          account: accountCode(account),
          clientKey: attribution.clientKey,
        });
      }
      if (
        attribution.dealId !== account.dealId ||
        attribution.trancheId !== account.trancheId
      ) {
        throw new LedgerError(LedgerErrorCode.postingAttributionMismatch, {
          account: accountCode(account),
          dealId: attribution.dealId,
          trancheId: attribution.trancheId,
        });
      }
      continue;
    }
    if (account.kind === 'client_free') {
      if (attribution === null) continue;
      // Свободная часть — файл владельца. Отнесение к траншу здесь означало бы,
      // что деньги одновременно свободны и заперты.
      if (!isClientRef(attribution) || attribution.clientKey !== account.clientKey) {
        throw new LedgerError(LedgerErrorCode.postingClientAttributionMismatch, {
          account: accountCode(account),
          attribution: isClientRef(attribution)
            ? attribution.clientKey
            : `${attribution.dealId}:${attribution.trancheId}`,
        });
      }
      continue;
    }
    if (isClientCustodyAccount(account) && attribution === null && !hasSuspense) {
      throw new LedgerError(LedgerErrorCode.postingCustodyWithoutAttribution, {
        account: accountCode(account),
      });
    }
  }
}

function assertFeeNeverLandsOnClientFunds(
  kind: JournalEntryKind,
  postings: readonly Posting[],
): void {
  // Красная линия №2: комиссия платформы не может иметь конечным счётом
  // клиентские средства. Признак — доход платформы по дебету (уходит с дохода)
  // и клиентские средства по кредиту (приходят на них) в одной записи.
  // Обратная проводка при исправлении — законный случай: возврат ошибочно
  // удержанной комиссии клиенту. Поэтому он разрешён только записью типа
  // `correction`, у которой обязана быть ссылка на исправляемую запись.
  if (kind === 'correction') {
    return;
  }
  const debitsIncome = postings.some(
    (posting) => posting.direction === 'debit' && isPlatformIncomeAccount(posting.account),
  );
  if (!debitsIncome) {
    return;
  }
  const creditsClientFunds = postings.find(
    (posting) => posting.direction === 'credit' && isClientFundsAccount(posting.account),
  );
  if (creditsClientFunds !== undefined) {
    throw new LedgerError(LedgerErrorCode.entryFeeIntoClientFunds, {
      account: accountCode(creditsClientFunds.account),
    });
  }
}

/**
 * Ключ источника средств: транш, клиент вне сделки, а для непознанного
 * поступления — сам факт того, что сделки нет. Валюта входит в ключ:
 * обязательство в долларах не гасится долями лари, пересчёт — это отдельная
 * проводка.
 */
function fundsSourceKey(currency: CurrencyCode, ref: FundsRef | null): string {
  if (ref === null) return `${currency}|suspense`;
  // Префикс обязателен: без него сделка с идентификатором `client` попадала бы
  // в файл клиента с тем же именем. Идентификаторы не могут содержать `|`
  // (`assertIdentifier`), поэтому разбор ключа однозначен.
  return isClientRef(ref)
    ? `${currency}|client|${ref.clientKey}`
    : `${currency}|tranche|${ref.dealId}|${ref.trancheId}`;
}

function assertNoClientCrossSubsidy(postings: readonly Posting[]): void {
  // Красная линия №1 и FUNCTIONAL.md §3.1: «проводка „дебет клиентского
  // обязательства, кредит номинального счёта“ без встречной выплаты этому же
  // клиенту отвергается при построении записи». Дыру по одной сделке нельзя
  // закрывать деньгами другой, и это архитектурный запрет, а не дисциплина.
  //
  // Отличить выплату от списания за чужой счёт можно ровно по отнесению: в
  // выплате деньги уходят с номинального счёта, отнесённые к тому же траншу,
  // чьё обязательство гасится. Любое другое отнесение — и любое отсутствие
  // отнесения — означает, что уходят средства, собранные под другую сделку.
  //
  // Проверка применяется и к исправлениям: у обратной проводки (дебет
  // номинального, кредит обязательства) эта форма не возникает, поэтому
  // законному исправлению исключение не нужно.
  const settledObligations = new Set<string>();
  for (const posting of postings) {
    if (posting.direction === 'debit' && isClientObligationAccount(posting.account)) {
      const account = posting.account;
      const ref: FundsRef | null =
        account.kind === 'client_locked'
          ? { dealId: account.dealId, trancheId: account.trancheId }
          : account.kind === 'client_free'
            ? { clientKey: account.clientKey }
            : null;
      settledObligations.add(fundsSourceKey(posting.amount.currency, ref));
    }
  }
  if (settledObligations.size === 0) {
    return;
  }
  for (const posting of postings) {
    if (posting.direction !== 'credit' || !isClientCustodyAccount(posting.account)) {
      continue;
    }
    if (!settledObligations.has(fundsSourceKey(posting.amount.currency, posting.attribution))) {
      throw new LedgerError(LedgerErrorCode.entryClientFundsCrossSubsidy, {
        account: accountCode(posting.account),
        currency: posting.amount.currency,
        attribution:
          posting.attribution === null
            ? ''
            : isClientRef(posting.attribution)
              ? posting.attribution.clientKey
              : `${posting.attribution.dealId}:${posting.attribution.trancheId}`,
      });
    }
  }
}

/**
 * Второй контур красной линии №1 для счёта клиента: перенос из запертой части
 * одной сделки в запертую часть другой одной записью.
 *
 * Первый контур — словарь записей (`entries.ts`): у него просто нет
 * конструктора, принимающего два транша, поэтому такой перенос там невыразим.
 * Но `createJournalEntry` остаётся низкоуровневой дверью, и через неё форму
 * собрать можно, поэтому запрет стоит и здесь.
 *
 * Запрет действует и при совпадении владельца. FUNCTIONAL.md §2.1, «Граница,
 * которая здесь проходит»: причина не в личности владельца — сделка А может
 * откатиться, и тогда деньги обязаны вернуться. Законный путь один и он в два
 * шага: отвязка в свободную часть (событие автомата сделки А) и только потом
 * привязка к сделке Б.
 */
function assertNoLockedToLocked(postings: readonly Posting[]): void {
  const debited = postings.filter(
    (posting) => posting.direction === 'debit' && posting.account.kind === 'client_locked',
  );
  const credited = postings.filter(
    (posting) => posting.direction === 'credit' && posting.account.kind === 'client_locked',
  );
  for (const from of debited) {
    for (const to of credited) {
      const fromCode = accountCode(from.account);
      const toCode = accountCode(to.account);
      if (fromCode !== toCode) {
        throw new LedgerError(LedgerErrorCode.entryLockedToLocked, { from: fromCode, to: toCode });
      }
    }
  }
}

/**
 * Обязательство перед одним клиентом не превращается в обязательство перед
 * другим иначе как объявленным расчётом по траншу.
 *
 * FUNCTIONAL.md §2.1: одно лицо в двух ролях — законный случай, но это одно
 * лицо. Любое движение «дебет обязательства перед X, кредит обязательства перед
 * Y» — это перевод между людьми, и деньгами X финансировалось бы обязательство
 * перед Y (красная линия №1).
 *
 * **Исправленный дефект.** Прежняя редакция запрещала только одну из двух форм —
 * дебет **свободной** части X, — а обратную (дебет **запертой** части X, кредит
 * свободной части Y) намеренно пропускала как «расчёт по сделке, условие
 * которого проверяет автомат». Пропускала при этом для любого Y: расчёт по
 * сделке А принимался в пользу лица, к сделке А отношения не имеющего, после
 * чего `lockForTranche(Y, сделка Б)` законно запирал эти деньги под чужую
 * сделку. Ни покрытие, ни пофайловая сверка нарушения не видели, потому что по
 * форме проводок его и не было.
 *
 * Теперь исключение существует, но оно **именное**: расчёт разрешён ровно тогда,
 * когда запись несёт объявление (`settles`), и только между счетами, которые это
 * объявление называет. Ledger не проверяет, что Y действительно получатель по
 * сделке А — этого знания у журнала нет; он делает утверждение об этом
 * обязательным, единственным и записанным.
 */
function assertClientOwnerMoveOnlySettles(
  kind: JournalEntryKind,
  postings: readonly Posting[],
  settles: TrancheSettlement | undefined,
): void {
  const debitedOwners = new Set<ClientKey>();
  const creditedOwners = new Set<ClientKey>();
  for (const posting of postings) {
    if (!isClientObligationAccount(posting.account)) continue;
    const owner = clientAccountOwner(posting.account);
    // У непознанного поступления владельца нет — это его определение, а не
    // лазейка: обязательство без владельца никому не переходит.
    if (owner === null) continue;
    (posting.direction === 'debit' ? debitedOwners : creditedOwners).add(owner);
  }
  let crossesOwners = false;
  for (const from of debitedOwners) {
    for (const to of creditedOwners) {
      if (from !== to) crossesOwners = true;
    }
  }

  if (settles === undefined) {
    if (crossesOwners) {
      throw new LedgerError(LedgerErrorCode.entryClientOwnerMismatch, {
        debited: [...debitedOwners].sort().join(','),
        credited: [...creditedOwners].sort().join(','),
      });
    }
    return;
  }

  assertSettlementShape(kind, postings, settles);
}

/**
 * Постройка расчёта сверяется с объявлением — иначе объявление было бы
 * украшением, а не опорой.
 *
 * Правила ровно три, и каждое закрывает свой способ увести деньги транша:
 *
 * 1. **Ни одного постороннего счёта клиента.** Обязательства в записи — только
 *    запертая часть плательщика по объявленному траншу и свободная часть
 *    получателя. Иначе расчёт по сделке А заодно гасил бы обязательство по Б.
 * 2. **Объявление обязано быть применено.** Запись, в которой запертая часть
 *    плательщика по объявленному траншу не участвует вовсе, расчётом не
 *    является, и объявление на ней — попытка получить право на
 *    межвладельческое движение задаром.
 * 3. **Направление задано.** В расчёте деньги идут от плательщика получателю.
 *    Обратное движение — деньги получателя запираются под сделку плательщика —
 *    это финансирование чужой сделки, и оно допустимо только исправлением
 *    (красная линия №11), у которого есть ссылка на исправляемую запись.
 *
 * Отнесение проводок кастодиана тоже сверяется: деньги расчёта переезжают из
 * файла объявленного транша в файл объявленного получателя и никуда больше.
 */
function assertSettlementShape(
  kind: JournalEntryKind,
  postings: readonly Posting[],
  settles: TrancheSettlement,
): void {
  const lockedCode = accountCode(
    clientLockedAccount(settles.payer, settles.deal.dealId, settles.deal.trancheId),
  );
  const freeCode = accountCode(clientFreeAccount(settles.recipient));
  const fail = (details: Readonly<Record<string, string>>): never => {
    throw new LedgerError(LedgerErrorCode.entrySettlementShapeMismatch, {
      dealId: settles.deal.dealId,
      trancheId: settles.deal.trancheId,
      ...details,
    });
  };

  // Применено — значит запертая часть плательщика в записи участвует. У расчёта
  // она дебетуется, у исправления кредитуется обратно; направление задаёт
  // отдельное правило ниже, здесь важен сам факт участия.
  let touchesLocked = false;
  for (const posting of postings) {
    const account = posting.account;
    if (isClientObligationAccount(account)) {
      const code = accountCode(account);
      if (code !== lockedCode && code !== freeCode) {
        fail({ account: code });
      }
      if (code === lockedCode) {
        touchesLocked = true;
        if (posting.direction === 'credit' && kind !== 'correction') {
          fail({ account: code, direction: posting.direction });
        }
      }
      if (code === freeCode && posting.direction === 'debit' && kind !== 'correction') {
        fail({ account: code, direction: posting.direction });
      }
      continue;
    }
    if (isClientCustodyAccount(account) && posting.attribution !== null) {
      const attribution = posting.attribution;
      const matchesFile = isClientRef(attribution)
        ? attribution.clientKey === settles.recipient
        : attribution.dealId === settles.deal.dealId &&
          attribution.trancheId === settles.deal.trancheId;
      if (!matchesFile) {
        fail({
          account: accountCode(account),
          attribution: isClientRef(attribution)
            ? attribution.clientKey
            : `${attribution.dealId}:${attribution.trancheId}`,
        });
      }
    }
  }
  if (!touchesLocked) {
    fail({ account: lockedCode, reason: 'not_applied' });
  }
}

/**
 * Признанный доход платформы уходит на операционный счёт **в той же записи**.
 *
 * Красная линия №2 буквально: «комиссия платформы не хранится на номинальном
 * счёте — выводится на операционный в момент расчёта, в том же журнале».
 * FUNCTIONAL.md §3.3 шаг 5 описывает вывод отдельным движением, и ровно этим
 * зазором дефект и жил: расчёт признавал комиссию доходом, денег с номинального
 * счёта не двигал, а конструктора вывода в словаре не было вовсе — он был
 * написан вручную в приложении. Забыть вывод не запрещалось ничем: в файле
 * транша оставался профицит, а профицит покрытием не считается.
 *
 * Поэтому вывод перестал быть отдельным шагом. Признание дохода без встречного
 * дебета операционного счёта в той же валюте и на ту же сумму — не запись.
 * Забыть его теперь нельзя: запись просто не собирается.
 *
 * ⚠ Ограничение осознанное: начисленный, но не удержанный доход
 * (FUNCTIONAL.md §4.6, «начислено против удержано») этой записью выразить
 * нельзя. Счёта требований в плане нет; когда он появится, у правила появится
 * ровно одно исключение — доход против требования, а не против клиентских
 * средств.
 */
function assertPlatformIncomeSweptToOperating(postings: readonly Posting[]): void {
  const income = new Map<CurrencyCode, bigint>();
  const swept = new Map<CurrencyCode, bigint>();
  for (const posting of postings) {
    const currency = posting.amount.currency;
    if (posting.direction === 'credit' && isPlatformIncomeAccount(posting.account)) {
      income.set(currency, (income.get(currency) ?? 0n) + posting.amount.minor);
    }
    if (posting.direction === 'debit' && posting.account.kind === 'bank_operating') {
      swept.set(currency, (swept.get(currency) ?? 0n) + posting.amount.minor);
    }
  }
  for (const [currency, recognised] of income) {
    const moved = swept.get(currency) ?? 0n;
    if (moved < recognised) {
      throw new LedgerError(LedgerErrorCode.entryPlatformIncomeNotSwept, {
        account: accountCode(bankOperating(currency)),
        currency,
        recognised: recognised.toString(),
        swept: moved.toString(),
      });
    }
  }
}

/**
 * Обязательство перед клиентом не уходит обратно в непознанные.
 *
 * `suspense:unidentified` — вход в учёт, а не выход из него: у поступления ещё
 * нет владельца (FUNCTIONAL.md §3.3, шаг 1), и опознание одностороннее
 * (`identifySuspense`). Обратное движение — «дебет обязательства перед
 * клиентом, кредит непознанных» — переводит деньги в пул без владельца и без
 * файла, и это ровно первый шаг двухзаписной отмывки: обязательство по траншу
 * А гасится в непознанные, а вторая запись опознаёт их на постороннее лицо.
 *
 * Ни портфельное покрытие, ни пофайловое такую пару не видели: у непознанных
 * файла нет вовсе, а опустевший файл транша оказывался в профиците, который до
 * `InvariantCode.custodySurplus` считался покрытием.
 *
 * Исправление ошибочного опознания — законный случай (не тот плательщик), и оно
 * остаётся возможным записью типа `correction`: у неё есть ссылка на
 * исправляемую запись, то есть след (красная линия №11).
 *
 * Проверка стоит последней: формы, которые ловят красные линии №1 и №2, обязаны
 * называться своими кодами, а не этим.
 */
function assertNoObligationIntoSuspense(
  kind: JournalEntryKind,
  postings: readonly Posting[],
): void {
  if (kind === 'correction') {
    return;
  }
  const intoSuspense = postings.some(
    (posting) =>
      posting.direction === 'credit' && posting.account.kind === 'suspense_unidentified',
  );
  if (!intoSuspense) {
    return;
  }
  const drained = postings.find(
    (posting) =>
      posting.direction === 'debit' &&
      isClientObligationAccount(posting.account) &&
      clientAccountOwner(posting.account) !== null,
  );
  if (drained !== undefined) {
    throw new LedgerError(LedgerErrorCode.entryObligationIntoSuspense, {
      account: accountCode(drained.account),
    });
  }
}

export function createJournalEntry(input: JournalEntryInput): JournalEntry {
  if (input.postings.length < 2) {
    throw new LedgerError(LedgerErrorCode.entryTooFewPostings, {
      postings: String(input.postings.length),
    });
  }
  for (const posting of input.postings) {
    if (posting.amount.minor <= 0n) {
      // Знак несёт направление (Дт/Кт), а не сумма: иначе одна и та же операция
      // записывается двумя способами и сверка перестаёт быть однозначной.
      throw new LedgerError(LedgerErrorCode.postingNonPositiveAmount, {
        account: accountCode(posting.account),
        amount: posting.amount.minor.toString(),
      });
    }
  }
  assertBalanced(input.postings);
  assertAttribution(input.postings);
  assertNoLockedToLocked(input.postings);
  assertClientOwnerMoveOnlySettles(input.kind, input.postings, input.settles);
  assertFeeNeverLandsOnClientFunds(input.kind, input.postings);
  assertPlatformIncomeSweptToOperating(input.postings);
  assertNoClientCrossSubsidy(input.postings);
  assertNoObligationIntoSuspense(input.kind, input.postings);
  if (input.kind === 'correction' && input.correctsEntryId === undefined) {
    throw new LedgerError(LedgerErrorCode.entryCorrectionWithoutReference, { id: input.id });
  }
  if (input.kind === 'settlement' && input.correctsEntryId !== undefined) {
    throw new LedgerError(LedgerErrorCode.entrySettlementWithReference, { id: input.id });
  }
  return Object.freeze({
    id: input.id,
    occurredAt: input.occurredAt,
    kind: input.kind,
    postings: Object.freeze([...input.postings]),
    memoKey: input.memoKey,
    correctsEntryId: input.correctsEntryId ?? null,
    // Объявление расчёта остаётся в записи: без него утверждение «получатель Y
    // связан со сделкой A» нечем предъявить ни аудиту, ни сверке.
    settles: input.settles ?? null,
  });
}

export function debit(
  account: Account,
  amount: Money<CurrencyCode>,
  attribution: FundsRef | null = null,
): Posting {
  return Object.freeze({ account, direction: 'debit', amount, attribution });
}

export function credit(
  account: Account,
  amount: Money<CurrencyCode>,
  attribution: FundsRef | null = null,
): Posting {
  return Object.freeze({ account, direction: 'credit', amount, attribution });
}
