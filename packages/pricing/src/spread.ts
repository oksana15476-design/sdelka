import { type Result, failure, ok } from '@sdelka/domain';
import {
  type CurrencyCode,
  type FxRate,
  assertCurrencyCode,
  fxRate,
  multiplyRational,
  rational,
} from '@sdelka/money';
import { PricingError, PricingErrorCode } from './errors';
import { PRICING_REFUSAL_KEYS, type PricingRefusalKey } from './keys';
import { RATE_SCALE_BP, RATE_SCALE_BP_NUMBER, assertBasisPoints } from './rate';

/**
 * Наценка к курсу — наш заработок на конвертации (E16-5, `SETTINGS.md` §В2,
 * `FX.md` §7.1).
 *
 * **По каждой паре отдельно, а не одна на все.** EUR волатильнее USD втрое, и
 * одинаковая наценка означает разную реальную маржу **[установлено, `FX.md`
 * §7.1]**. Отсюда и форма значения версии: не число, а расписание пар — версия
 * несёт его целиком, потому что `before`/`after` в журнале аудита пишутся
 * целиком, а не дельтой (`SETTINGS.md` §4 п.1).
 *
 * **Прилипает к выпуску котировки** (`series.ts`): клиент подтверждает
 * конкретную котировку по идентификатору, и согласие, данное на прежний курс, не
 * применяется к пересчитанному.
 *
 * ⚠ **[установлено, `FX.md` §12.1, §17 О1] Наценка не чинит валютную ногу.**
 * При исполнении по витринному курсу банка нога даёт −1 414 ₾ на сделке
 * $80 000: замеренная себестоимость конвертации 1,375 % против заложенных
 * 0,20 %. Пока не получен дилерский курс, любое число наценки — украшение, и
 * настройка не должна создавать впечатление, что дыра закрыта.
 */
export interface FxMarkup<
  F extends CurrencyCode = CurrencyCode,
  T extends CurrencyCode = CurrencyCode,
> {
  /** Валюта, за одну мажорную единицу которой выражен курс. */
  readonly base: F;
  /** Валюта, в мажорных единицах которой выражен курс. */
  readonly quote: T;
  /** Наценка целым числом базисных пунктов (`rate.ts`). */
  readonly markupBp: number;
}

/**
 * ⚠ **ВРЕМЕННОЕ ЗНАЧЕНИЕ, НЕ РЕШЕНИЕ ВЛАДЕЛЬЦА.** 500 базисных пунктов
 * предложены в `FX.md` §1 Р14 **как предложение**, и предложением остаются.
 *
 * Довод за то, чтобы потолок вообще был: опечатка в настройке — самый дешёвый
 * способ отдать или отобрать процент от шестизначной суммы. Довод за то, чтобы
 * его назначал владелец: при 500 б.п. проходит вариант В из `FX.md` §17 О1
 * (требует 1,875 %), а промах на разряд — нет; более тесный потолок
 * останавливает законный сценарий. Вопрос — `DECISIONS-REVIEW.md` §J3
 * **[открыто]**.
 */
export const PROVISIONAL_MARKUP_CAP_BP = 500;

/**
 * Наценка как величина. Отвергает на входе — до того, как она попадёт в версию
 * настройки и в котировку:
 *
 * 1. **Дробное значение** — плавающая точка, зашедшая через форму.
 * 2. **Отрицательная наценка** — клиентский курс лучше эталонного. Сегодня она
 *    **выразима**: `fxRates` собирает три курса без отношения порядка, а
 *    `disclosedMarkupBp` возвращает знаковую величину **[установлено, `FX.md`
 *    §7.2, §12.4]**. Здесь она перестаёт быть выразимой.
 * 3. **Выше потолка** — `SETTINGS.md` §9 п.9.
 * 4. **Сто процентов и больше** — не наценка, а обнуление курса: клиентский
 *    курс стал бы нулём или отрицательным, а такой `fxRate` не собирается вовсе.
 *    Проверяется отдельно от потолка, потому что потолок — величина владельца, а
 *    это — свойство самой конструкции.
 * 5. **Пара из одной валюты** — курса у неё не бывает.
 */
export function fxMarkup<F extends CurrencyCode, T extends CurrencyCode>(
  base: F,
  quote: T,
  markupBp: number,
  capBp: number = PROVISIONAL_MARKUP_CAP_BP,
): FxMarkup<F, T> {
  if (!Number.isInteger(markupBp)) {
    throw new PricingError(PricingErrorCode.markupNotInteger, { value: String(markupBp) });
  }
  if (!Number.isInteger(capBp) || capBp < 0 || capBp > RATE_SCALE_BP_NUMBER) {
    throw new PricingError(PricingErrorCode.markupCapOutOfRange, { value: String(capBp) });
  }
  if (markupBp < 0 || markupBp > capBp) {
    throw new PricingError(PricingErrorCode.markupOutOfRange, {
      value: String(markupBp),
      capBp: String(capBp),
    });
  }
  if (markupBp >= RATE_SCALE_BP_NUMBER) {
    throw new PricingError(PricingErrorCode.markupOutOfRange, {
      value: String(markupBp),
      reason: 'whole_rate',
    });
  }
  if ((base as CurrencyCode) === (quote as CurrencyCode)) {
    throw new PricingError(PricingErrorCode.markupPairInvalid, { base, quote });
  }
  return Object.freeze({ base, quote, markupBp });
}

/**
 * Расписание наценок — значение одной версии настройки.
 *
 * Пара объявляется один раз: две наценки на одну пару — это не «более позднее
 * побеждает», а две правды о нашем заработке, и выбирать между ними по порядку
 * массива значило бы выбирать молча (тот же довод, что у
 * `effectiveMomentAmbiguous` в настройках).
 */
export interface FxMarkupSchedule {
  readonly entries: readonly FxMarkup[];
}

export function fxMarkupSchedule(entries: readonly FxMarkup[]): FxMarkupSchedule {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.base}/${entry.quote}`;
    if (seen.has(key)) {
      throw new PricingError(PricingErrorCode.markupPairDuplicated, { pair: key });
    }
    seen.add(key);
  }
  return Object.freeze({ entries: Object.freeze([...entries]) });
}

/** Расписание, поднятое из хранилища: те же правила и те же границы. */
export function fxMarkupScheduleFromStore(
  rows: readonly { readonly base: string; readonly quote: string; readonly markupBp: number }[],
  capBp: number = PROVISIONAL_MARKUP_CAP_BP,
): FxMarkupSchedule {
  return fxMarkupSchedule(
    rows.map((row) =>
      fxMarkup(assertCurrencyCode(row.base), assertCurrencyCode(row.quote), row.markupBp, capBp),
    ),
  );
}

/**
 * Наценка по паре. Отказ — значение: пара, которой расписание не знает,
 * встречается на живой котировке, и вызывающий обязан его разобрать.
 *
 * Умолчания «ноль» здесь нет намеренно: нулевая наценка — это законное решение
 * владельца («валютная нога в ноль», `FX.md` §17 О1 вариант Г), и подставлять её
 * молча там, где владелец просто не объявил пару, значило бы принять это решение
 * за него.
 */
export function markupFor(
  schedule: FxMarkupSchedule,
  base: CurrencyCode,
  quote: CurrencyCode,
): Result<FxMarkup, PricingRefusalKey> {
  const found = schedule.entries.find((entry) => entry.base === base && entry.quote === quote);
  if (found === undefined) {
    return failure(PRICING_REFUSAL_KEYS.markupPairNotDeclared);
  }
  return ok(found);
}

/**
 * Клиентский курс из эталонного: `client = reference · (10000 − markupBp) / 10000`
 * **[установлено, `FX.md` §7.2]**.
 *
 * Целочисленно над рациональными дробями — ни одной операции с плавающей точкой
 * (красная линия №4). Инвариант `FX.md` §1 Р13 («клиентский курс не лучше
 * эталонного») держится **по построению**, а не проверкой: множитель не
 * превышает единицу, потому что наценка неотрицательна, и другого пути получить
 * клиентский курс здесь нет.
 *
 * Обратного направления функция не даёт и дать не может: перевёрнутый курс
 * отдаёт спред клиенту (`@sdelka/money`, `fx.ts`). Наценку в обратную сторону
 * объявляют отдельной строкой расписания.
 */
export function clientRateFrom<F extends CurrencyCode, T extends CurrencyCode>(
  reference: FxRate<F, T>,
  markup: FxMarkup<NoInfer<F>, NoInfer<T>>,
): FxRate<F, T> {
  if (
    (reference.base as CurrencyCode) !== (markup.base as CurrencyCode) ||
    (reference.quote as CurrencyCode) !== (markup.quote as CurrencyCode)
  ) {
    // Типы это уже говорят, но наценка приходит из хранилища, а там типов нет.
    throw new PricingError(PricingErrorCode.markupPairMismatch, {
      base: reference.base,
      quote: reference.quote,
      markupBase: markup.base,
      markupQuote: markup.quote,
    });
  }
  assertBasisPoints(markup.markupBp, 'markupBp');
  const factor = rational(RATE_SCALE_BP - BigInt(markup.markupBp), RATE_SCALE_BP);
  return fxRate(reference.base, reference.quote, multiplyRational(reference.value, factor));
}
