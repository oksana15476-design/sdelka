import type { CurrencyCode } from '@sdelka/money';
import { accountCode, conversionOfAccount } from './accounts';
import { type FxExecution, type JournalEntry, type Posting, isClientRef } from './entry';
import { LedgerError, LedgerErrorCode } from './errors';

/**
 * Журнал только дополняется. Изменяющих операций нет ни одной — ни в типе, ни в
 * модуле: `appendEntry` возвращает новый журнал (красная линия №11).
 */
export interface Journal {
  readonly entries: readonly JournalEntry[];
}

export const emptyJournal: Journal = Object.freeze({ entries: Object.freeze([]) });

/**
 * Транши, по которым запись **начисляет** комиссию.
 *
 * Признак структурный, а не по объявлению `accrues`: объявление необязательно
 * (см. `assertFeeAccrualDeclared`), поэтому начисление, собранное низкоуровневой
 * дверью без объявления, мимо признака по объявлению прошло бы молча. Начисление
 * — это чистый **дебет** требования по комиссии, отнесённый к траншу; расчёт и
 * реверс требование кредитуют и сюда не попадают.
 *
 * Валюта в ключ не входит намеренно: комиссия по траншу — величина одна, и
 * второе начисление «в другой валюте» не второй тариф, а расхождение.
 */
function feeAccrualTranches(entry: JournalEntry): ReadonlySet<string> {
  const net = new Map<string, bigint>();
  for (const posting of entry.postings) {
    if (posting.account.kind !== 'fee_receivable') continue;
    const attribution = posting.attribution;
    if (attribution === null || isClientRef(attribution)) continue;
    // Идентификаторы не содержат `|` (`assertAccountIdentifier`), поэтому ключ
    // разбирается однозначно и две разные пары не сливаются в одну.
    const key = `${attribution.dealId}|${attribution.trancheId}`;
    net.set(
      key,
      (net.get(key) ?? 0n) +
        (posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor),
    );
  }
  const accrued = new Set<string>();
  for (const [key, total] of net) {
    if (total > 0n) accrued.add(key);
  }
  return accrued;
}

/**
 * Идемпотентность начисления комиссии: **одно начисление на транш**.
 *
 * Проба, которую это закрывает: два `accrueFee` по одному траншу давали
 * `fee:receivable` вдвое больше, доход признавался дважды, а
 * `checkLedgerInvariants` возвращала пустой список — `transitStale` покрывает
 * только транзиты, и «начислено и никогда не удержано» не выражалось ничем.
 *
 * Проверка стоит здесь, а не в конструкторе записи, по той же причине, что и
 * проверка ссылки исправления: «уже начисляли» — свойство журнала, а
 * конструктор журнала не видит.
 *
 * **Повтор запрещён и после реверса.** §4.4: уход в возвратную ветвь снимает
 * начисление исправлением, и начислять по этому траншу снова означало бы, что
 * транш вернулся в `release_pending` после отмены. Такого перехода автомат не
 * знает; если он появится, послабление обязано быть именным и объявленным — как
 * исключение для дохода против требования, — а не тихим следствием того, что
 * счётчик обнулился. Цена строгости названа в отчёте по батчу.
 */
function assertFeeAccruedOnce(journal: Journal, entry: JournalEntry): void {
  const accruing = feeAccrualTranches(entry);
  if (accruing.size === 0) return;
  for (const existing of journal.entries) {
    for (const key of feeAccrualTranches(existing)) {
      if (!accruing.has(key)) continue;
      const separator = key.indexOf('|');
      throw new LedgerError(LedgerErrorCode.journalFeeAccruedTwice, {
        id: entry.id,
        accruedBy: existing.id,
        dealId: key.slice(0, separator),
        trancheId: key.slice(separator + 1),
      });
    }
  }
}

/** Счета расчётов с валютным контрагентом, которых касается запись. */
function conversionAccounts(entry: JournalEntry): ReadonlySet<string> {
  const codes = new Set<string>();
  for (const posting of entry.postings) {
    if (conversionOfAccount(posting.account) === null) continue;
    codes.add(accountCode(posting.account));
  }
  return codes;
}

/**
 * Ключ конверсии называет **один** обмен и тратится один раз.
 *
 * «Уникальность идентификатора конверсии не проверяется нигде» — это было верно
 * буквально: `fxExecution` проверяет объявление на непротиворечивость самому
 * себе, `assertConversionDeclared` — что проводки записи совпали с объявлением,
 * и ни одна из двух не могла заметить, что тем же ключом уже назван другой
 * обмен. Второй обмен под тем же ключом открывал позицию поверх старой, и
 * «сколько нам не поставили по этой конверсии» снова переставало быть величиной.
 *
 * Разных клиентов развёл владелец в коде счёта (`accounts.ts`): сверка идёт по
 * коду счёта, а не по ключу, поэтому одинаково названные обмены двух клиентов —
 * это два разных счёта и два разных ключа проверки.
 *
 * Правил два, и второе — уступка, сделанная сознательно:
 *
 * 1. **Схлопнувшийся ключ потрачен.** Позиция стала плоской — обмен закрыт, и
 *    новое объявление под тем же ключом это уже другой обмен. Ему нужен свой
 *    ключ, иначе два обмена неразличимы в журнале навсегда.
 * 2. **Пока позиция открыта, объявление обязано оставаться тем же обменом:** та
 *    же пара валют и ноги не больше первоначальных.
 *
 * ⚠ Почему второе правило именно такое, а не «объявление совпадает целиком».
 * **Недопоставка.** Контрагент поставил меньше обещанного и объявил это честно —
 * по тому же курсу, но на меньшую сумму (`packages/e2e`,
 * `conversion-coverage.test.ts`). Другого способа записать недопоставку сегодня
 * нет: `assertConversionDeclared` требует, чтобы сумма проводки была **ровно**
 * одной из объявленных ног, поэтому «то же объявление, меньшая проводка» не
 * собирается. Требование полного совпадения сделало бы реальное событие
 * незаписываемым, а незаписываемое событие уходит в низкоуровневую дверь.
 *
 * Что при этом остаётся незакрытым, названо прямо: **пока позиция открыта**,
 * под тем же ключом принимается меньший обмен той же пары. Отличить его от
 * недопоставки журналу нечем — для этого нужно подтверждение контрагента о том,
 * что поставка окончательная, а такого факта в системе нет. Развилка — в отчёте
 * по батчу.
 */
function assertConversionKeyNotReused(journal: Journal, entry: JournalEntry): void {
  const declaration = entry.converts;
  if (declaration === null) return;
  for (const code of conversionAccounts(entry)) {
    let opener: FxExecution | null = null;
    let touched = false;
    // Естественный знак актива: дебет — требование к контрагенту выросло.
    const balances = new Map<CurrencyCode, bigint>();
    for (const existing of journal.entries) {
      let touchesThis = false;
      for (const posting of existing.postings) {
        if (conversionOfAccount(posting.account) === null) continue;
        if (accountCode(posting.account) !== code) continue;
        touchesThis = true;
        const currency = posting.amount.currency;
        balances.set(
          currency,
          (balances.get(currency) ?? 0n) +
            (posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor),
        );
      }
      if (!touchesThis) continue;
      touched = true;
      if (opener === null) opener = existing.converts;
    }
    if (!touched) continue;
    const fail = (reason: string): never => {
      throw new LedgerError(LedgerErrorCode.journalConversionKeyReused, {
        id: entry.id,
        account: code,
        reason,
      });
    };
    if ([...balances.values()].every((total) => total === 0n)) {
      fail('position_already_closed');
    }
    if (opener === null) continue;
    const legs = opener.converted;
    const declared = declaration.converted;
    if (
      declared.source.currency !== legs.source.currency ||
      declared.target.currency !== legs.target.currency
    ) {
      fail('currency_pair');
    }
    if (declared.source.minor > legs.source.minor || declared.target.minor > legs.target.minor) {
      fail('legs_exceed_opening');
    }
  }
}

/**
 * Признанная этой записью недостача по клиенту и валюте.
 *
 * Читается по проводкам `shortfall:expense` с отнесением к клиенту — тем же
 * способом, которым её складывает инвариант `shortfallOverfunded`. Второй
 * модели проводок здесь не заводится: расхождение двух моделей в этом проекте
 * уже случалось.
 */
function recognisedShortfallOf(postings: readonly Posting[], currency: CurrencyCode): bigint {
  let total = 0n;
  for (const posting of postings) {
    if (posting.account.kind !== 'shortfall_expense') continue;
    if (posting.amount.currency !== currency) continue;
    const attribution = posting.attribution;
    if (attribution === null || !isClientRef(attribution)) continue;
    total += posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor;
  }
  return total;
}

/**
 * Довнесение закрывает **существующее и ещё не закрытое** признание.
 *
 * Токен `RecognisedShortfall` защищает словарь: собрать «положить деньги
 * платформы в файл произвольного клиента на произвольную сумму» в `entries.ts`
 * нельзя. Но токен — значение, и его никто не гасит: одна и та же признанная
 * недостача довносилась столько раз, сколько раз позвали `fundShortfall`, а
 * само признание могло вообще не попасть в журнал (`absorbShortfall` возвращает
 * запись, положить её в журнал — отдельное действие). Оба случая ловил только
 * инвариант `shortfallOverfunded` и только постфактум.
 *
 * Теперь ссылка обязана указывать на запись журнала, эта запись обязана
 * признавать ровно ту недостачу того же клиента в той же валюте, и закрыть её
 * можно один раз.
 */
function assertShortfallFundingResolves(journal: Journal, entry: JournalEntry): void {
  const funds = entry.funds;
  if (funds === null) return;
  const recognition = journal.entries.find((item) => item.id === funds.recognisedEntryId);
  if (recognition === undefined) {
    throw new LedgerError(LedgerErrorCode.journalShortfallRecognitionMissing, {
      id: entry.id,
      recognisedEntryId: funds.recognisedEntryId,
      reason: 'not_in_journal',
    });
  }
  const recognisedForOwner = recognisedShortfallOf(
    recognition.postings.filter((posting) => {
      const attribution = posting.attribution;
      return (
        attribution !== null && isClientRef(attribution) && attribution.clientKey === funds.owner
      );
    }),
    funds.amount.currency,
  );
  // Равенство, а не «не больше»: `fundShortfall` довносит признанное целиком,
  // и частичное довнесение — это другая операция, у которой нет ни момента в
  // §3.1, ни способа отличить «довнесли часть» от «довнесли не то».
  if (recognisedForOwner !== funds.amount.minor) {
    throw new LedgerError(LedgerErrorCode.journalShortfallRecognitionMissing, {
      id: entry.id,
      recognisedEntryId: funds.recognisedEntryId,
      recognised: recognisedForOwner.toString(),
      declared: funds.amount.minor.toString(),
    });
  }
  const funded = journal.entries.find(
    (item) => item.funds !== null && item.funds.recognisedEntryId === funds.recognisedEntryId,
  );
  if (funded !== undefined) {
    throw new LedgerError(LedgerErrorCode.journalShortfallFundedTwice, {
      id: entry.id,
      recognisedEntryId: funds.recognisedEntryId,
      fundedBy: funded.id,
    });
  }
}

/**
 * Запись обязана быть записью целиком, а не «почти записью».
 *
 * Проба, ради которой проверка появилась: объект, у которого нет поля `funds`
 * (запись, собранная до появления объявления довнесения, либо приехавшая из
 * сериализации), доходил до `assertShortfallFundingResolves` и падал там
 * `TypeError: Cannot read properties of undefined (reading 'recognisedEntryId')`
 * — без кода, без ключа локализации и без единого слова о том, какая запись
 * виновата. То же самое ждало `correctsEntryId`: `undefined !== null` заводило
 * запись в ветку исправления и отвечало «цель исправления не найдена», то есть
 * называло не ту причину.
 *
 * Необязательные по смыслу поля объявлены `T | null`, а не `T | undefined`,
 * именно затем, чтобы «поля нет» и «поле пусто» были разными состояниями.
 * Здесь это различение и защищается: `null` — законное значение, `undefined` —
 * негодная запись.
 */
function assertEntryWellFormed(entry: JournalEntry): void {
  const fail = (field: string): never => {
    throw new LedgerError(LedgerErrorCode.journalEntryMalformed, {
      id: typeof entry.id === 'string' ? entry.id : '',
      field,
    });
  };
  if (typeof entry.id !== 'string' || entry.id.length === 0) fail('id');
  if (typeof entry.occurredAt !== 'string') fail('occurredAt');
  if (entry.kind !== 'settlement' && entry.kind !== 'correction') fail('kind');
  if (!Array.isArray(entry.postings)) fail('postings');
  if (typeof entry.memoKey !== 'string') fail('memoKey');
  for (const field of ['correctsEntryId', 'settles', 'converts', 'accrues', 'funds'] as const) {
    if (entry[field] === undefined) fail(field);
  }
}

export function appendEntry(journal: Journal, entry: JournalEntry): Journal {
  assertEntryWellFormed(entry);
  if (journal.entries.some((existing) => existing.id === entry.id)) {
    throw new LedgerError(LedgerErrorCode.journalDuplicateEntryId, { id: entry.id });
  }
  // Красная линия №11: исправление — новая запись **со ссылкой на предыдущую**.
  // Ссылка на запись, которой в журнале нет, ссылкой не является: она снимает
  // с исправления все ограничения обычной записи, не давая взамен ни следа, ни
  // возможности сверить одно с другим. Конструктор записи журнала не видит —
  // проверка стоит здесь, где журнал есть.
  if (entry.correctsEntryId !== null) {
    if (!journal.entries.some((existing) => existing.id === entry.correctsEntryId)) {
      throw new LedgerError(LedgerErrorCode.journalCorrectionTargetMissing, {
        id: entry.id,
        correctsEntryId: entry.correctsEntryId,
      });
    }
  }
  // Ниже — три правила, которым нужна история, а не одна запись. Все они стоят
  // здесь по одной причине: конструктор записи журнала не видит.
  assertFeeAccruedOnce(journal, entry);
  assertConversionKeyNotReused(journal, entry);
  assertShortfallFundingResolves(journal, entry);
  return Object.freeze({ entries: Object.freeze([...journal.entries, entry]) });
}

export function appendEntries(journal: Journal, entries: readonly JournalEntry[]): Journal {
  return entries.reduce(appendEntry, journal);
}
