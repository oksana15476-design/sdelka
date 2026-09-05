import { type DurationMs, HOUR, duration } from '@sdelka/domain';
import { type CurrencyCode, type Money, assertCurrencyCode, money } from '@sdelka/money';
import { type DealCurrencyList, SETTLEMENT_CURRENCY, admitsCurrency } from './currencies';
import { LimitsError, LimitsErrorCode } from './errors';

/**
 * Пороги как величины владельца (E16-7, `SETTINGS.md` §В8, `ROADMAP.md` И16.5).
 *
 * Три правила, общие для всех порогов этого файла:
 *
 * 1. **Ни одного числа с плавающей точкой.** Порог — либо целые минорные
 *    единицы (`Money.minor`, `bigint`), либо целое число базисных пунктов, либо
 *    целое число миллисекунд. Красная линия №4 не про суммы проводок, а про
 *    деньги вообще, и настройка — самый простой способ завести дробь в домен:
 *    поле формы, `Number('0.5')`, и порог, который не равен себе после
 *    сохранения и чтения.
 * 2. **Негодный порог отвергается на записи, а не при применении.** Каждый
 *    конструктор здесь бросает: величина, ошибочная по построению, не должна
 *    попадать в версию настройки вовсе. Проверка, отложенная до применения,
 *    доезжает до денег — к этому моменту допуск уже раскрыт стороне, а
 *    инструкция на перевод уже выдана.
 * 3. **Само число — величина владельца.** Значения `PROVISIONAL_` временные и
 *    перенесены из мест, где они лежат константами сегодня; ни одно не выбрано
 *    здесь. Вопросы — `DECISIONS-REVIEW.md` §K **[открыто]**.
 */

/** Сама сумма в базисных пунктах: доля больше неё — это доля больше единицы. */
const WHOLE_BP = 10_000;

function assertShareBp(value: number, field: string): number {
  if (!Number.isInteger(value)) {
    throw new LimitsError(LimitsErrorCode.shareNotInteger, { field, value: String(value) });
  }
  if (value < 0 || value > WHOLE_BP) {
    throw new LimitsError(LimitsErrorCode.shareOutOfRange, { field, value: String(value) });
  }
  return value;
}

function assertJustified(docRef: string): string {
  if (docRef.trim() === '') {
    throw new LimitsError(LimitsErrorCode.thresholdUnjustified);
  }
  return docRef;
}

/* ------------------------------------------------------------------------- */
/* В8. Допуск по сумме поступления                                           */
/* ------------------------------------------------------------------------- */

/**
 * Допуск по сумме: **абсолютная величина в каждой валюте и доля; действует
 * меньшее из двух** **[установлено, `FUNCTIONAL.md` §4.3.2]**.
 *
 * Форма поля в поле совпадает с `TolerancePolicy` из `@sdelka/intake`
 * намеренно: значение этой версии подставляется туда как есть, и второй
 * редакции применения допуска здесь нет ни одной. Считает допуск
 * `toleranceFor` в приёме — там же, где он раскрывается стороне и где живут
 * правила «раскрытия не было — допуск ноль» и «меньшее из раскрытого и
 * текущего» (`INTAKE.md` §3.3). Этот пакет отвечает за то, чтобы **негодная
 * величина туда не доехала**.
 *
 * Абсолют перечнем по валютам, а не одной суммой с пересчётом: курс — внешний
 * факт, а объявленная величина не может ездить вместе с рынком между
 * инструкцией и платежом. Валюта, для которой абсолют не объявлен, даёт в приёме
 * закрытый отказ `undeclared`, то есть допуск ноль, — и это ещё одна причина,
 * по которой включение валюты требует объявленного допуска (`currencies.ts`).
 */
export interface AmountTolerance {
  readonly absolute: readonly Money<CurrencyCode>[];
  /** Доля в базисных пунктах. Ноль — законное значение: строгое равенство. */
  readonly shareBp: number;
  readonly rationaleDocRef: string;
}

export interface AmountToleranceInput {
  readonly absolute: readonly Money<CurrencyCode>[];
  readonly shareBp: number;
  readonly rationaleDocRef: string;
}

/**
 * Допуск как величина. Отвергает на входе:
 *
 * 1. **Дробная доля** — плавающая точка через форму.
 * 2. **Доля вне `0…10 000` б.п.** Верхняя граница — не вкусовая: `10 000` б.п.
 *    это сама сумма, и доля выше означает допуск **больше суммы поступления**,
 *    то есть «пришло вдвое меньше — считаем, что пришло полностью».
 * 3. **Отрицательный абсолют** — допуск, который делает недоплатой ровную сумму.
 * 4. **Одна валюта дважды** — два разных допуска на одну валюту; выбирать между
 *    ними по порядку массива значило бы выбирать молча.
 * 5. **Валюта не из перечня валют сделки**, если перечень предъявлен
 *    (`SETTINGS.md` §9 п.7). Предъявлять его необязательно: перечень — своя
 *    версия со своим моментом, и требовать его здесь значило бы сцепить две
 *    настройки в одну.
 *
 * ⚠ **Верхней границы абсолюта здесь нет, и это названо вслух.** «Допуск
 * 50 000 ₾ — это не допуск, а подарок» (`SETTINGS.md` §В8 п.5), но само число
 * потолка — величина владельца, и назначать его за него нельзя.
 * `DECISIONS-REVIEW.md` §K2 **[открыто]**.
 */
export function amountTolerance(
  input: AmountToleranceInput,
  admitted: DealCurrencyList | null = null,
): AmountTolerance {
  const shareBp = assertShareBp(input.shareBp, 'shareBp');
  const rationaleDocRef = assertJustified(input.rationaleDocRef);
  const seen = new Set<CurrencyCode>();
  for (const amount of input.absolute) {
    const currency = assertCurrencyCode(amount.currency);
    if (seen.has(currency)) {
      throw new LimitsError(LimitsErrorCode.currencyDuplicated, { currency });
    }
    seen.add(currency);
    if (amount.minor < 0n) {
      throw new LimitsError(LimitsErrorCode.amountNegative, {
        currency,
        value: amount.minor.toString(),
      });
    }
    if (admitted !== null && !admitsCurrency(admitted, currency)) {
      throw new LimitsError(LimitsErrorCode.currencyNotAdmitted, { currency });
    }
  }
  return Object.freeze({
    absolute: Object.freeze([...input.absolute].sort((a, b) => a.currency.localeCompare(b.currency))),
    shareBp,
    rationaleDocRef,
  });
}

const TOLERANCE_DOC = 'docs/product/SETTINGS.md';

/**
 * ⚠ **ВРЕМЕННОЕ ЗНАЧЕНИЕ, НЕ РЕШЕНИЕ ВЛАДЕЛЬЦА.** Перенесено как есть из
 * `PROPOSED_INTAKE_POLICY` (`packages/intake/src/policy.ts`), где оно и было
 * помечено предложением: 50,00 ₾ / $20,00 / €20,00 и 50 б.п. Ни одной величины
 * допуска нет ни в одном документе проекта **[установлено, `SETTINGS.md` §В8]**.
 *
 * Доллар и евро объявлены здесь, а не в перечне валют сделки, и это не
 * противоречие: допуск объявляется **до** включения валюты — объявленный
 * допуск и есть одна из пяти предпосылок включения (`currencies.ts`).
 *
 * Вопрос — `DECISIONS-REVIEW.md` §K2 **[открыто]**.
 */
export const PROVISIONAL_AMOUNT_TOLERANCE: AmountTolerance = amountTolerance({
  absolute: [money('GEL', 5_000n), money('USD', 2_000n), money('EUR', 2_000n)],
  shareBp: 50,
  rationaleDocRef: TOLERANCE_DOC,
});

/* ------------------------------------------------------------------------- */
/* Возрастные границы очереди разбора                                        */
/* ------------------------------------------------------------------------- */

/**
 * Возрастные границы очереди разбора: после какого возраста задача поднимается
 * на следующий уровень эскалации.
 *
 * Возраст считается **от постановки задачи**, а не от дедлайна
 * (`packages/compliance/src/queue.ts`), и границы поэтому — длительности, а не
 * моменты. Форма совпадает с `QueuePolicy` комплаенса поле в поле: значение
 * версии подставляется туда как есть, а вычисление уровня эскалации остаётся
 * там, где оно уже написано. Второй его редакции здесь нет.
 */
export interface QueueAgeBands {
  /** Строго возрастающие границы возраста. Первая — норматив, дальше по уровню. */
  readonly escalationAfter: readonly DurationMs[];
  /**
   * Валюта ранжирования очереди по сумме. Одна на всю очередь: сравнивать суммы
   * в разных валютах без курса нельзя, а курс — внешний факт, которого у очереди
   * нет (`FUNCTIONAL.md` §4.3.1).
   */
  readonly rankCurrency: CurrencyCode;
  readonly rationaleDocRef: string;
}

export interface QueueAgeBandsInput {
  /** Миллисекунды целыми: единица времени, а не «часы с запятой». */
  readonly escalationAfterMs: readonly number[];
  readonly rankCurrency: CurrencyCode;
  readonly rationaleDocRef: string;
}

/**
 * Границы как величина. Отвергает на входе:
 *
 * 1. **Пустой перечень границ** — очередь без норматива (см. `ageBandsEmpty`).
 * 2. **Дробная или неположительная граница** — `duration` в домене не соберётся,
 *    но проверка стоит здесь своя, чтобы отказ назывался порогом, а не моментом
 *    времени.
 * 3. **Границы не по возрастанию** — «нижняя граница выше верхней». Равные
 *    соседние тоже отказ: две ступени, наступающие одновременно, означают
 *    уровень эскалации, выбранный порядком массива.
 * 4. **Валюта ранжирования не из перечня валют сделки**, если перечень
 *    предъявлен.
 */
export function queueAgeBands(
  input: QueueAgeBandsInput,
  admitted: DealCurrencyList | null = null,
): QueueAgeBands {
  if (input.escalationAfterMs.length === 0) {
    throw new LimitsError(LimitsErrorCode.ageBandsEmpty);
  }
  const bands: DurationMs[] = [];
  let previous = 0;
  for (const value of input.escalationAfterMs) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new LimitsError(LimitsErrorCode.ageBandNotPositiveInteger, { value: String(value) });
    }
    if (value <= previous) {
      throw new LimitsError(LimitsErrorCode.ageBandsNotAscending, {
        value: String(value),
        previous: String(previous),
      });
    }
    previous = value;
    bands.push(duration(value));
  }
  const rankCurrency = assertCurrencyCode(input.rankCurrency);
  if (admitted !== null && !admitsCurrency(admitted, rankCurrency)) {
    throw new LimitsError(LimitsErrorCode.currencyNotAdmitted, { currency: rankCurrency });
  }
  return Object.freeze({
    escalationAfter: Object.freeze(bands),
    rankCurrency,
    rationaleDocRef: assertJustified(input.rationaleDocRef),
  });
}

/**
 * ⚠ **ВРЕМЕННОЕ ЗНАЧЕНИЕ, НЕ РЕШЕНИЕ ВЛАДЕЛЬЦА.** Перенесено как есть из
 * `POLICY_2026_09_03` (`packages/compliance/src/policy.ts`): 4 часа, сутки,
 * трое суток, ранжирование в лари. Откуда взяты именно эти три числа, в
 * документах проекта не сказано **[открыто]**; цена ошибки — очередь дежурного:
 * тесные границы дают шум, широкие прячут забытую задачу.
 *
 * Вопрос — `DECISIONS-REVIEW.md` §K3 **[открыто]**.
 */
export const PROVISIONAL_QUEUE_AGE_BANDS: QueueAgeBands = queueAgeBands({
  escalationAfterMs: [4 * HOUR, 24 * HOUR, 72 * HOUR],
  rankCurrency: SETTLEMENT_CURRENCY,
  rationaleDocRef: TOLERANCE_DOC,
});

/* ------------------------------------------------------------------------- */
/* Порог значимости                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Порог значимости платёжного провайдера: среднемесячный объём, за которым
 * включаются требования к капиталу и режим значимого провайдера
 * (`ROADMAP.md` Г3, `ACTORS.md`).
 *
 * ⚠ **Здесь два разных числа, и путать их нельзя.**
 *
 * `monthlyTurnover` — **внешняя норма, а не наша величина**: её называет
 * регулятор, и `SETTINGS.md` §В9 прямо выносит её из перечня управляемых
 * величин по этой причине. Версионируется она не для того, чтобы владелец её
 * двигал, а для того, чтобы **решение, принятое в марте, осталось посчитанным по
 * той норме, которая действовала в марте**: норма меняется законом, и без версии
 * прошлая оценка «мы на 78 % порога» через год не воспроизводится.
 *
 * `warnAtBp` — **наша величина**: с какой доли порога блок перестаёт быть
 * справочным и становится предупреждением. Сегодня она лежит константой в
 * `apps/web/src/view/owner-economics.ts` (`SIGNIFICANCE_WARN_AT_BP`).
 *
 * Что порог **не** делает: не останавливает приём и ничего не считает сам.
 * Пересчёт валютного оборота в лари ради этой цифры — отдельное решение
 * владельца, и до ответа оценка считается только по лариевой ноге, то есть
 * заведомо занижена. Занижение названо на экране, а не спрятано.
 */
export interface MaterialityThreshold {
  /** Среднемесячный объём, за которым провайдер значим. Норма названа в лари. */
  readonly monthlyTurnover: Money<typeof SETTLEMENT_CURRENCY>;
  /** Доля порога в базисных пунктах, с которой блок становится предупреждением. */
  readonly warnAtBp: number;
  readonly rationaleDocRef: string;
}

export interface MaterialityThresholdInput {
  readonly monthlyTurnover: Money<CurrencyCode>;
  readonly warnAtBp: number;
  readonly rationaleDocRef: string;
}

/**
 * Порог значимости как величина. Отвергает на входе:
 *
 * 1. **Порог не в лари** — норма названа в национальной валюте, а пересчёт по
 *    курсу сделал бы её плавающей вместе с рынком.
 * 2. **Порог ≤ 0** — нулевой порог значимости означает «значимо всё», то есть
 *    предупреждение, горящее всегда; это не строгость, а выключенный сигнал.
 * 3. **Доля предупреждения вне `1…10 000` б.п.** Ноль — предупреждение,
 *    горящее при нулевом обороте; выше `10 000` — предупреждение **позже самого
 *    порога**, то есть сигнал, который не успевает предупредить. Оба — тот самый
 *    «порог, заданный неверно», и оба отвергаются здесь, а не на экране.
 */
export function materialityThreshold(input: MaterialityThresholdInput): MaterialityThreshold {
  const currency = assertCurrencyCode(input.monthlyTurnover.currency);
  if (currency !== SETTLEMENT_CURRENCY) {
    throw new LimitsError(LimitsErrorCode.currencyNotSettlement, { currency });
  }
  if (input.monthlyTurnover.minor <= 0n) {
    throw new LimitsError(LimitsErrorCode.amountNotPositive, {
      value: input.monthlyTurnover.minor.toString(),
    });
  }
  const warnAtBp = assertShareBp(input.warnAtBp, 'warnAtBp');
  if (warnAtBp === 0) {
    throw new LimitsError(LimitsErrorCode.shareOutOfRange, { field: 'warnAtBp', value: '0' });
  }
  return Object.freeze({
    monthlyTurnover: money(SETTLEMENT_CURRENCY, input.monthlyTurnover.minor),
    warnAtBp,
    rationaleDocRef: assertJustified(input.rationaleDocRef),
  });
}

/**
 * ⚠ **Норма — не наша, доля предупреждения — временная.**
 *
 * 9 000 000,00 ₾ среднемесячного объёма **[установлено, `ROADMAP.md` Г3;
 * `apps/web/src/view/owner-economics.ts`]** — внешняя норма; её меняет закон, а
 * не владелец. 7 500 б.п. (75 % порога) перенесены из
 * `SIGNIFICANCE_WARN_AT_BP` и остаются временными: с какого запаса начинать
 * готовиться к режиму значимого провайдера — вопрос владельца,
 * `DECISIONS-REVIEW.md` §K4 **[открыто]**.
 */
export const PROVISIONAL_MATERIALITY_THRESHOLD: MaterialityThreshold = materialityThreshold({
  monthlyTurnover: money(SETTLEMENT_CURRENCY, 900_000_000n),
  warnAtBp: 7_500,
  rationaleDocRef: TOLERANCE_DOC,
});
