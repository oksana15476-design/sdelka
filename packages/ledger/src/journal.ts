import type { CurrencyCode } from '@sdelka/money';
import { accountCode, conversionOfAccount } from './accounts';
import {
  type FxExecution,
  type JournalEntry,
  type Posting,
  fundsRefText,
  isClientRef,
  postingFile,
  postingMovementKey,
} from './entry';
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
 * Чистое движение требования по комиссии, отнесённого к траншу. Дебет — плюс.
 *
 * Валюта в ключ не входит намеренно: комиссия по траншу — величина одна, и
 * второе начисление «в другой валюте» не второй тариф, а расхождение.
 */
function feeReceivableNet(entry: JournalEntry): ReadonlyMap<string, bigint> {
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
  return net;
}

/**
 * Сколько требования по комиссии эта запись-исправление вправе **вернуть** по
 * каждому траншу.
 *
 * Возврат — не начисление, и в этом вся правка. Расчёт требование гасит
 * (`Кт fee:receivable`), поэтому его реверс требование дебетует — структурно
 * это ровно то же движение, что у начисления. Различает их только цель
 * исправления: вернуть можно столько, сколько **эта самая цель** сняла, за
 * вычетом того, что по ней уже вернули прежние исправления. Отсюда свойство,
 * из-за которого послабление не разворачивается в дверь: чтобы получить право
 * на дебет требования, нужна лежащая в журнале запись, это требование
 * уменьшившая, и каждое уменьшение отдаётся один раз.
 *
 * Отсутствия цели в журнале здесь не разбирается: его ловит
 * `journalCorrectionTargetMissing` — своей ошибкой и своим именем.
 */
function feeRestorableBy(
  prior: readonly JournalEntry[],
  entry: JournalEntry,
): ReadonlyMap<string, bigint> {
  if (entry.kind !== 'correction' || entry.correctsEntryId === null) return new Map();
  const target = prior.find((existing) => existing.id === entry.correctsEntryId);
  if (target === undefined) return new Map();
  const restorable = new Map<string, bigint>();
  for (const [key, net] of feeReceivableNet(target)) {
    // Цель требование увеличила — возвращать по ней нечего.
    if (net < 0n) restorable.set(key, -net);
  }
  for (const existing of prior) {
    if (existing.kind !== 'correction' || existing.correctsEntryId !== target.id) continue;
    for (const [key, net] of feeReceivableNet(existing)) {
      if (net <= 0n) continue;
      restorable.set(key, (restorable.get(key) ?? 0n) - net);
    }
  }
  return restorable;
}

/**
 * Транши, по которым запись **начисляет** комиссию.
 *
 * Признак структурный, а не по объявлению `accrues`: объявление необязательно
 * (см. `assertFeeAccrualDeclared`), поэтому начисление, собранное низкоуровневой
 * дверью без объявления, мимо признака по объявлению прошло бы молча. Начисление
 * — это чистый **дебет** требования по комиссии, отнесённый к траншу; расчёт
 * требование кредитует и сюда не попадает.
 *
 * **[исправляет предыдущее] Возврат снятого требования начислением не
 * считается.** Прежняя редакция читала дебет требования как начисление всегда,
 * и законная операция — реверс расчёта целиком — оказывалась **невыразимой**:
 * `appendEntry` отвечал на неё `journalFeeAccruedTwice`, то есть запрещал не
 * то, что собирался (проба и её вывод — в `test/settlement-reversal.test.ts`).
 * Теперь из дебета вычитается то, что исправление вправе вернуть по своей цели
 * (`feeRestorableBy`), и начислением считается только остаток. Идемпотентность
 * от этого не слабеет: без цели, снявшей требование, вычитать нечего, а каждое
 * снятие отдаётся один раз.
 */
function feeAccrualTranches(
  prior: readonly JournalEntry[],
  entry: JournalEntry,
): ReadonlySet<string> {
  const restorable = feeRestorableBy(prior, entry);
  const accrued = new Set<string>();
  for (const [key, total] of feeReceivableNet(entry)) {
    const allowed = restorable.get(key) ?? 0n;
    if (total > (allowed > 0n ? allowed : 0n)) accrued.add(key);
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
  const accruing = feeAccrualTranches(journal.entries, entry);
  if (accruing.size === 0) return;
  for (const [index, existing] of journal.entries.entries()) {
    // Каждая лежащая запись читается тем же способом и в том положении, в
    // каком она в журнал попала: что она вернула, а что начислила, зависит от
    // записей **до** неё, а не от журнала целиком.
    for (const key of feeAccrualTranches(journal.entries.slice(0, index), existing)) {
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

/**
 * Расчёт отматывается назад **один раз**.
 *
 * Правило появилось вместе с самой возможностью отматывать
 * (`entries.ts`, `reverseTrancheSettlement`) и закрывает дверь, которую эта
 * возможность открывает. Первый реверс возвращает деньги плательщику целиком;
 * второй увёл бы файл получателя в минус и открыл требование по комиссии,
 * которого никто не начислял. У расчёта с комиссией второй реверс уткнулся бы
 * в идемпотентность начисления — но с невнятным ответом «начислено дважды», а
 * у расчёта **без** комиссии не уткнулся бы ни во что: `negativeClientBalance`
 * — проверка постфактум, приём записи она не останавливает.
 *
 * Признак — объявление расчёта на исправлении, а не имя ключа памятки:
 * движение обязательства между владельцами без `settles` невозможно
 * (`assertClientOwnerMoveOnlySettles`), поэтому под правило попадает любой
 * реверс расчёта, кем бы он ни был собран — словарём или низкоуровневой
 * дверью.
 *
 * Что правило намеренно **не** запрещает: исправление той же цели, не
 * двигающее клиентское обязательство (например, возврат одной лишь комиссии в
 * транзит). Такое исправление ограничено своим пределом — вернуть больше, чем
 * цель сняла, нельзя (`feeRestorableBy`).
 */
function assertSettlementReversedOnce(journal: Journal, entry: JournalEntry): void {
  if (entry.kind !== 'correction' || entry.settles === null) return;
  const target = entry.correctsEntryId;
  if (target === null) return;
  const reversal = journal.entries.find(
    (existing) =>
      existing.kind === 'correction' &&
      existing.settles !== null &&
      existing.correctsEntryId === target,
  );
  if (reversal === undefined) return;
  throw new LedgerError(LedgerErrorCode.journalSettlementReversedTwice, {
    id: entry.id,
    correctsEntryId: target,
    reversedBy: reversal.id,
    dealId: entry.settles.deal.dealId,
    trancheId: entry.settles.deal.trancheId,
  });
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
 * Чистое движение записи по одному счёту в одном файле. Дебет — плюс.
 *
 * `account` и `file` хранятся рядом с суммой только ради сообщения об ошибке:
 * ключ (`postingMovementKey`) разбирается однозначно, но дежурному его читать
 * незачем.
 */
interface Movement {
  readonly account: string;
  readonly file: string;
  readonly currency: CurrencyCode;
  readonly minor: bigint;
}

function netMovements(entry: JournalEntry): ReadonlyMap<string, Movement> {
  const net = new Map<string, Movement>();
  for (const posting of entry.postings) {
    const key = postingMovementKey(posting);
    const signed = posting.direction === 'debit' ? posting.amount.minor : -posting.amount.minor;
    net.set(key, {
      account: accountCode(posting.account),
      file: fundsRefText(postingFile(posting)),
      currency: posting.amount.currency,
      minor: (net.get(key)?.minor ?? 0n) + signed,
    });
  }
  return net;
}

/**
 * **Исправление — зеркало своей цели, а не свободная запись со ссылкой.**
 *
 * Красная линия №11 обещает не ссылку, а след: «журнал не редактируется,
 * исправление — только новой записью со ссылкой на предыдущую». Пока ссылка
 * проверялась на одно лишь существование цели, обещание было пустым, и вот чем
 * это кончалось (проба — `test/correction-mirror.test.ts`):
 *
 * ```
 * clientTopUp(X) → lockForTranche(X, A/t1) → writeOffUnclaimed(X, A/t1)   — всё законно
 * correction correctsEntryId: <любая лежащая запись>
 *   Дт unclaimed:liability      100 000     Кт client:Z:free   100 000  {Z}
 *   Кт transit:writeoff         100 000     Дт bank:nominal    100 000  {Z}
 * ```
 *
 * Четыре проводки, где кастодиан едет вместе с обязательством: прирост каждого
 * файла ровно нулевой — молчит `assertNoUnfundedClientFileGain`; ключ пула у
 * дебета и кредита один — молчит `assertNoClientCrossSubsidy`; у пула нет
 * владельца — молчит `assertClientOwnerMoveOnlySettles`; вид записи
 * `correction` — молчит `assertNoPayoutFromTerminalPool`. Итог прогона:
 * невостребованные средства транша стали свободным остатком постороннего лица,
 * покрытие 1/1, `checkLedgerInvariants()` пуст, стоп-кран не сработал.
 *
 * **Почему правило стоит здесь, а не на виде записи.** Затыкать `correction` в
 * `assertNoPayoutFromTerminalPool` бесполезно: та же форма собирается через
 * любой другой пул и любую другую пару счетов, а законное исправление ошибочного
 * списания стало бы невыразимым. Причина не в том, что исправление трогает пул,
 * а в том, что исправление **ничем не связано со своей целью**. Связь выразима,
 * и вот она: движение исправления по каждому счёту и файлу обязано быть
 * обратным движению цели по тому же счёту и файлу и не больше его — с учётом
 * того, что прежние исправления той же цели уже отмотали. Цель у `appendEntry`
 * под рукой, у конструктора записи её нет — поэтому правило journal-уровня.
 *
 * Что из этого следует буквально:
 *
 * 1. **Ни одного счёта и ни одного файла мимо цели.** `client:Z:free` в цели не
 *    участвовал — исправление его не трогает. Этим атака и ломается.
 * 2. **Только назад.** Движение в ту же сторону, что и у цели, — это не
 *    исправление, а второй такой же расчёт под видом отмены.
 * 3. **Не больше, чем было.** Сумма всех исправлений одной цели по каждому
 *    ключу не превышает того, что цель двинула: цель отдаётся один раз, и
 *    «отмотать вдвое» — способ создать деньги из ссылки.
 *
 * Оба законных исправления продукта — образец зеркальности и проходят по
 * построению: `reverseTrancheSettlement` строится зеркалом самой записи расчёта,
 * `reverseFeeAccrual` — обратной парой к начислению. Частичное исправление тоже
 * остаётся возможным (возврат одной лишь комиссии в транзит, см.
 * `feeRestorableBy`): «не больше цели» — неравенство, а не равенство.
 *
 * ⚠ **[открыто]** Правило требует, чтобы исправление отматывало **тем же
 * счётом**. Исправление, которому пришлось бы вернуть деньги другим маршрутом
 * (счёт-источник закрыт, валюта поменялась), этой формой не выражается. Такой
 * операции сегодня нет ни в словаре, ни в приложении; появится — ей нужно своё
 * объявление, по образцу `DealPartiesAttestation`, а не послабление здесь.
 */
function assertCorrectionMirrorsTarget(journal: Journal, entry: JournalEntry): void {
  if (entry.correctsEntryId === null) return;
  const target = journal.entries.find((existing) => existing.id === entry.correctsEntryId);
  // Отсутствия цели здесь не разбирается: его ловит
  // `journalCorrectionTargetMissing` — своей ошибкой и своим именем.
  if (target === undefined) return;
  const targetNet = netMovements(target);
  const unwound = new Map<string, bigint>();
  for (const existing of journal.entries) {
    if (existing.correctsEntryId !== target.id) continue;
    for (const [key, movement] of netMovements(existing)) {
      unwound.set(key, (unwound.get(key) ?? 0n) + movement.minor);
    }
  }
  for (const [key, movement] of netMovements(entry)) {
    // Ноль — не движение: счёт, дебетованный и тут же кредитованный в одном
    // файле на ту же сумму, ничего не двинул. Переезд между файлами нулём не
    // выглядит никогда: файл входит в ключ.
    if (movement.minor === 0n) continue;
    const moved = targetNet.get(key)?.minor ?? 0n;
    const fail = (reason: string): never => {
      throw new LedgerError(LedgerErrorCode.journalCorrectionNotMirror, {
        id: entry.id,
        correctsEntryId: target.id,
        account: movement.account,
        file: movement.file,
        currency: movement.currency,
        reason,
        moved: movement.minor.toString(),
        target: moved.toString(),
      });
    };
    if (moved === 0n) fail('account_not_in_target');
    if (moved > 0n === movement.minor > 0n) fail('same_direction');
    const total = (unwound.get(key) ?? 0n) + movement.minor;
    // Отмотано в сумме не больше, чем цель двинула. Знак у `total` тот же, что
    // у `movement.minor`: прежние исправления прошли это же правило.
    if (moved > 0n ? total < -moved : total > -moved) fail('exceeds_target');
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
  // Ниже — правила, которым нужна история, а не одна запись. Все они стоят
  // здесь по одной причине: конструктор записи журнала не видит.
  //
  // Порядок значим ровно в одном месте: «расчёт отматывается один раз» стоит
  // **до** идемпотентности начисления. Иначе второй реверс расчёта с комиссией
  // отвергался бы как «начислено дважды» — то есть снова не тем правилом, к
  // которому относится.
  assertSettlementReversedOnce(journal, entry);
  assertFeeAccruedOnce(journal, entry);
  // Зеркальность стоит **после** двух правил выше, и это тот же довод о
  // порядке: второй реверс расчёта и возврат требования сверх снятого она тоже
  // отвергает, но своим общим именем, а у обоих случаев имя уже есть. Общее
  // правило отвечает там, где именного нет.
  assertCorrectionMirrorsTarget(journal, entry);
  assertConversionKeyNotReused(journal, entry);
  assertShortfallFundingResolves(journal, entry);
  return Object.freeze({ entries: Object.freeze([...journal.entries, entry]) });
}

export function appendEntries(journal: Journal, entries: readonly JournalEntry[]): Journal {
  return entries.reduce(appendEntry, journal);
}
