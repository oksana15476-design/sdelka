import { type Result, failure, ok } from '@sdelka/domain';
import { type CurrencyCode, assertCurrencyCode } from '@sdelka/money';
import { LimitsError, LimitsErrorCode } from './errors';
import { LIMITS_REFUSAL_KEYS, type LimitsRefusalKey } from './keys';

/**
 * Перечень валют сделки — величина владельца (E16-6, `SETTINGS.md` §В3,
 * `ROADMAP.md` И16.4).
 *
 * ⚠ **[установлено, `packages/money/src/currency.ts`] Настройкой можно только
 * включать и выключать коды, которые уже существуют в коде.** `CurrencyCode` —
 * объединение четырёх литералов, и добавление пятой валюты это правка кода и
 * миграция справочника базы, а не галочка на экране. Тип здесь именно
 * `CurrencyCode`, а не строка: перечень настройки — **подмножество** известных
 * кодов, и включить в него `GBP` невозможно даже опечаткой.
 *
 * ## Что перечень делает и чего не делает
 *
 * Делает: решает, **можно ли завести новую сделку** в этой валюте.
 *
 * Не делает: ничего с уже существующими счетами и проводками. Счёт учёта несёт
 * свою валюту в самом ключе (`bank:nominal:usd`, `client:{c}:free` с валютой в
 * проводке), покрытие считается **по каждой валюте отдельно** — `coverage`
 * складывает клиентские активы и обязательства в `Map` по валюте и ни разу не
 * спрашивает, включена ли валюта. Поэтому включение валюты не переносит ни одной
 * проводки, а выключение не обнуляет ни одного остатка: обе операции меняют
 * только то, что будет заведено дальше. Проверено `test/coverage.test.ts` —
 * тестом на журнале, а не рассуждением.
 */

/**
 * Валюта расчёта, которая из перечня не выключается.
 *
 * **[установлено, `PRODUCT.md` §6; `SETTINGS.md` §9 п.15]** Расчёт по
 * недвижимости на территории Грузии возможен только в национальной валюте.
 * Это не настройка и не умолчание: перечень без лари — не «узкий продукт», а
 * продукт, которого не существует.
 */
export const SETTLEMENT_CURRENCY = 'GEL' as const satisfies CurrencyCode;

export interface DealCurrencyList {
  /** По возрастанию кода: перечень канонизирован, иначе две одинаковые версии различались бы порядком. */
  readonly codes: readonly CurrencyCode[];
}

/**
 * Перечень как величина. Отвергает на входе — до того, как он попадёт в версию
 * настройки:
 *
 * 1. **Пустой перечень** — продукта без валюты сделки не существует.
 * 2. **Повтор** — две записи об одной валюте это не «дважды включена», а два
 *    разных ответа на вопрос «включена ли»; выбирать между ними по порядку
 *    массива значило бы выбирать молча.
 * 3. **Неизвестный код** — второй рубеж после типа: перечень приходит и из
 *    хранилища, а типы границу процесса не переживают.
 * 4. **Нет лари** — см. `SETTLEMENT_CURRENCY`.
 */
export function dealCurrencyList(codes: readonly string[]): DealCurrencyList {
  if (codes.length === 0) {
    throw new LimitsError(LimitsErrorCode.currencyListEmpty);
  }
  const seen = new Set<CurrencyCode>();
  for (const raw of codes) {
    const code = assertCurrencyCode(raw);
    if (seen.has(code)) {
      throw new LimitsError(LimitsErrorCode.currencyDuplicated, { currency: code });
    }
    seen.add(code);
  }
  if (!seen.has(SETTLEMENT_CURRENCY)) {
    throw new LimitsError(LimitsErrorCode.settlementCurrencyMissing, {
      required: SETTLEMENT_CURRENCY,
    });
  }
  return Object.freeze({ codes: Object.freeze([...seen].sort()) });
}

export function admitsCurrency(list: DealCurrencyList, currency: CurrencyCode): boolean {
  return list.codes.includes(currency);
}

/* ------------------------------------------------------------------------- */
/* Включение: пять предпосылок                                               */
/* ------------------------------------------------------------------------- */

/**
 * Чек-лист включения валюты — **пять предпосылок, и каждая из кода**
 * (`SETTINGS.md` §В3 п.5).
 *
 * Все пять приходят сюда снаружи фактами, а не проверяются здесь: счёт и
 * позиции живут в учёте, курс — в наблюдениях оракула, допуск — в приёме,
 * наценка — в ценообразовании. Этот пакет владеет **перечнем**, а не всем
 * продуктом, и вычислять чужие факты у него нет ни права, ни данных. Форма
 * записи выбрана так, что пропустить предпосылку молчанием нельзя: поле
 * обязательное и булево, `undefined` не собирается.
 *
 * Почему отказ, а не предупреждение: иначе валюта включается, сделка заводится,
 * деньги приходят — и выплатить их нельзя. Это не гипотетический сценарий, он
 * воспроизводится в фикстурах владельца сегодня (`apps/web/src/fixtures/owner.ts`:
 * «сделки в валюте, отличной от лари, завершиться не могут»).
 */
export interface CurrencyReadiness {
  readonly currency: CurrencyCode;
  /** Счёт номинального держания в этой валюте открыт. */
  readonly nominalAccountOpened: boolean;
  /** По этому счёту идёт построчная сверка с выпиской. */
  readonly statementReconciliationRunning: boolean;
  /** Есть наблюдение официального курса пары «валюта → лари». */
  readonly officialRateObserved: boolean;
  /** Объявлен абсолютный допуск по сумме в этой валюте. */
  readonly toleranceDeclared: boolean;
  /** Объявлена наценка по паре. */
  readonly markupDeclared: boolean;
}

/** Порядок проверки — порядок таблицы `SETTINGS.md` §В3 п.5; первая невыполненная называется. */
const PRECONDITIONS: readonly (readonly [keyof CurrencyReadiness, LimitsRefusalKey])[] = [
  ['nominalAccountOpened', LIMITS_REFUSAL_KEYS.nominalAccountMissing],
  ['statementReconciliationRunning', LIMITS_REFUSAL_KEYS.reconciliationMissing],
  ['officialRateObserved', LIMITS_REFUSAL_KEYS.officialRateMissing],
  ['toleranceDeclared', LIMITS_REFUSAL_KEYS.toleranceNotDeclared],
  ['markupDeclared', LIMITS_REFUSAL_KEYS.markupNotDeclared],
];

/** Невыполненные предпосылки — все сразу, для экрана владельца. */
export function unmetPreconditions(readiness: CurrencyReadiness): readonly LimitsRefusalKey[] {
  return Object.freeze(
    PRECONDITIONS.filter(([field]) => readiness[field] !== true).map(([, key]) => key),
  );
}

/**
 * Включить валюту в перечень. Возвращает **новый** перечень: старый не меняется,
 * как не меняется журнал версий.
 *
 * Отказ, а не бросок: включение — действие владельца на живом экране, и причина
 * обязана дойти до него разобранной, а не исключением.
 */
export function admitDealCurrency(
  list: DealCurrencyList,
  readiness: CurrencyReadiness,
): Result<DealCurrencyList, LimitsRefusalKey> {
  const currency = assertCurrencyCode(readiness.currency);
  if (admitsCurrency(list, currency)) {
    return failure(LIMITS_REFUSAL_KEYS.currencyAlreadyAdmitted);
  }
  const unmet = unmetPreconditions(readiness);
  const first = unmet[0];
  if (first !== undefined) {
    return failure(first);
  }
  return ok(dealCurrencyList([...list.codes, currency]));
}

/* ------------------------------------------------------------------------- */
/* Выключение                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Выключить валюту. **Действует только на новые сделки** — и это свойство не
 * этой функции, а момента прилипания перечня (`series.ts`): уже заведённая
 * сделка спрашивает перечень на момент **своего создания**, и там валюта
 * по-прежнему есть. Здесь только запрет выключать валюту, под которой ещё лежат
 * деньги.
 *
 * `openPositions` — число открытых позиций по журналу, посчитанное снаружи.
 * Целое: позиций не бывает полторы, а дробное число здесь означало бы, что
 * кто-то посчитал их долей от чего-то.
 */
export function withdrawDealCurrency(
  list: DealCurrencyList,
  currency: CurrencyCode,
  openPositions: number,
): Result<DealCurrencyList, LimitsRefusalKey> {
  const code = assertCurrencyCode(currency);
  if (!Number.isInteger(openPositions) || openPositions < 0) {
    throw new LimitsError(LimitsErrorCode.openPositionsInvalid, { value: String(openPositions) });
  }
  if (!admitsCurrency(list, code)) {
    return failure(LIMITS_REFUSAL_KEYS.currencyNotAdmitted);
  }
  if (code === SETTLEMENT_CURRENCY) {
    return failure(LIMITS_REFUSAL_KEYS.settlementCurrencyLocked);
  }
  if (openPositions > 0) {
    return failure(LIMITS_REFUSAL_KEYS.currencyHasOpenPositions);
  }
  return ok(dealCurrencyList(list.codes.filter((item) => item !== code)));
}

/* ------------------------------------------------------------------------- */
/* Временное значение                                                        */
/* ------------------------------------------------------------------------- */

/**
 * ⚠ **ВРЕМЕННОЕ ЗНАЧЕНИЕ, НЕ РЕШЕНИЕ ВЛАДЕЛЬЦА.**
 *
 * Здесь ровно одна валюта, и это не предложение узкого продукта, а отказ
 * назначать перечень за владельца. Лари в перечне **[установлено]** — без него
 * перечень не собирается вовсе (`PRODUCT.md` §6). Любая вторая валюта — уже
 * решение: доллар и евро сегодня объявлены в допуске приёма
 * (`packages/intake/src/policy.ts`), но ни одна из пяти предпосылок §В3 для них
 * не подтверждена ни одним фактом, который я мог бы прочитать.
 *
 * Вопрос — `DECISIONS-REVIEW.md` §K1 **[открыто]**.
 */
export const PROVISIONAL_DEAL_CURRENCIES: DealCurrencyList = dealCurrencyList([
  SETTLEMENT_CURRENCY,
]);
