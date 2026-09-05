import {
  DEFAULT_FEE_CEILING,
  type FeeCeiling,
  strictestFeeCeiling,
} from '@sdelka/ledger';
import { type CurrencyCode, assertCurrencyCode, compareRational } from '@sdelka/money';
import { PricingError, PricingErrorCode } from './errors';
import { type FeeBearing, bornByRecipient, feeBearingFromStore } from './payer';
import { assertBasisPoints, shareOf } from './rate';

/**
 * Тарифный план — значение одной версии настройки (`SETTINGS.md` §В1).
 *
 * Не константа модуля и не поле сделки, а **значение, которое кладётся в
 * `SettingsVersion<TariffPlan>`** и оттуда разрешается на момент создания транша
 * (`series.ts`). Состав взят из `FUNCTIONAL.md` §4.2: процент от суммы,
 * фиксированная часть, минимум, максимум, любая часть может быть нулевой, плюс
 * плательщик комиссии.
 *
 * **Потолок удержания входит в план и едет той же версией.** Развилка F2
 * `DECISIONS-REVIEW.md` («откуда транш берёт свой потолок») здесь не решается
 * от своего имени: выбран единственный вариант, не создающий второй правды о
 * пределе, — источник тот же, что у ставки. Если владелец назовёт другой
 * источник, меняется поле, а не устройство: потолок остаётся значением, а не
 * константой.
 */
export interface TariffPlan {
  /** Ставка от суммы сделки, целым числом базисных пунктов (`rate.ts`). */
  readonly rateBp: number;
  /**
   * Валюта фиксированной части, минимума и максимума.
   *
   * Обязательна, а не «валюта сделки»: комиссия «1,00» без валюты — это три
   * разные комиссии на трёх валютах приёма. Тариф в чужой валюте к сделке не
   * применяется вовсе (отказ, а не пересчёт по курсу: курс — внешний факт, и
   * объявленная величина не может ездить вместе с рынком между инструкцией и
   * платежом — то же правило, что у допуска, `INTAKE.md` §3.2).
   */
  readonly currency: CurrencyCode;
  /** Фиксированная часть в целых минорных единицах. Ноль — законное значение. */
  readonly fixed: bigint;
  /** Нижняя граница комиссии; `null` — границы нет (не «ноль»). */
  readonly minimum: bigint | null;
  /** Верхняя граница комиссии; `null` — границы нет. */
  readonly maximum: bigint | null;
  /** Кто несёт комиссию (`payer.ts`). */
  readonly bearing: FeeBearing;
  /** Потолок удержания этой же версии плана. */
  readonly ceiling: FeeCeiling;
}

export interface TariffPlanInput {
  readonly rateBp: number;
  readonly currency: CurrencyCode;
  readonly fixed?: bigint;
  readonly minimum?: bigint | null;
  readonly maximum?: bigint | null;
  readonly bearing?: FeeBearing;
  readonly ceiling?: FeeCeiling;
}

function assertNonNegative(value: bigint | null, field: string): void {
  if (value !== null && value < 0n) {
    // Отрицательная комиссия — это доплата клиенту, и тарифом она не
    // выражается (`SETTINGS.md` §В1 п.5).
    throw new PricingError(PricingErrorCode.amountNegative, { field, value: value.toString() });
  }
}

/**
 * Единственный вход. Бросает, потому что каждый случай означает не отказ
 * конкретной сделки, а **испорченный тариф**: по такому плану нельзя посчитать
 * ни одну сделку, и продолжать не с чем.
 *
 * Границы те же, что требует `SETTINGS.md` §9 пп. 6–8, и стоят они здесь
 * **дважды с базой**, а не вместо неё: типы не переживают границу процесса,
 * план приезжает из хранилища приведением.
 */
export function tariffPlan(input: TariffPlanInput): TariffPlan {
  assertBasisPoints(input.rateBp, 'rateBp');
  const currency = assertCurrencyCode(input.currency);
  const fixed = input.fixed ?? 0n;
  const minimum = input.minimum ?? null;
  const maximum = input.maximum ?? null;
  assertNonNegative(fixed, 'fixed');
  assertNonNegative(minimum, 'minimum');
  assertNonNegative(maximum, 'maximum');
  if (minimum !== null && maximum !== null && minimum > maximum) {
    throw new PricingError(PricingErrorCode.minimumAboveMaximum, {
      minimum: minimum.toString(),
      maximum: maximum.toString(),
    });
  }
  // Потолок плана может жёсткий предел учёта только **сузить**: объявить его
  // шире значило бы поднять предел настройкой, а это отдельное решение
  // владельца и отдельная правка учёта (`@sdelka/ledger`, `DEFAULT_FEE_CEILING`).
  const ceiling = strictestFeeCeiling(input.ceiling ?? DEFAULT_FEE_CEILING, DEFAULT_FEE_CEILING);
  if (compareRational(shareOf(input.rateBp), ceiling.maxShare) > 0) {
    // Ставка выше потолка не соберётся в записи расчёта вовсе — деньги встали бы
    // задачей оператора. Отказ переносится на сохранение настройки, где его
    // разбирает владелец, а не на живой транш (`SETTINGS.md` §В1 критерии
    // приёмки).
    throw new PricingError(PricingErrorCode.rateAboveCeiling, {
      rateBp: String(input.rateBp),
      ceiling: `${ceiling.maxShare.numerator}/${ceiling.maxShare.denominator}`,
    });
  }
  return Object.freeze({
    rateBp: input.rateBp,
    currency,
    fixed,
    minimum,
    maximum,
    bearing: input.bearing ?? bornByRecipient(),
    ceiling,
  });
}

/**
 * План, поднятый из хранилища: те же правила, но вход — то, что отдала база.
 *
 * Отдельная функция, а не `tariffPlan(row as TariffPlan)`: приведение прошло бы
 * молча мимо всех проверок, а именно на этой границе величина и приходит без
 * типов.
 */
export function tariffPlanFromStore(row: {
  readonly rateBp: number;
  readonly currency: string;
  readonly fixed: bigint;
  readonly minimum: bigint | null;
  readonly maximum: bigint | null;
  readonly payer: string;
  readonly payerShareBp?: number;
  readonly recipientShareBp?: number;
  readonly ceiling?: FeeCeiling;
}): TariffPlan {
  const shares = {
    ...(row.payerShareBp === undefined ? {} : { payerShareBp: row.payerShareBp }),
    ...(row.recipientShareBp === undefined ? {} : { recipientShareBp: row.recipientShareBp }),
  };
  return tariffPlan({
    rateBp: row.rateBp,
    currency: assertCurrencyCode(row.currency),
    fixed: row.fixed,
    minimum: row.minimum,
    maximum: row.maximum,
    bearing: feeBearingFromStore(row.payer, shares),
    ...(row.ceiling === undefined ? {} : { ceiling: row.ceiling }),
  });
}

/**
 * ⚠ **ВРЕМЕННОЕ ЗНАЧЕНИЕ. НЕ НОРМА И НЕ РЕШЕНИЕ ВЛАДЕЛЬЦА.**
 *
 * Имя выбрано так, чтобы его нельзя было принять за принятое: `PROVISIONAL_`, а
 * не `DEFAULT_`. Умолчания у тарифа нет и быть не должно — резолвер настройки
 * отвечает **отказом** там, где действующей версии нет
 * (`SETTINGS_REFUSAL_KEYS.noVersionInEffect`), и подставлять сюда число молча
 * запрещено ровно тем же доводом.
 *
 * Зачем оно тогда есть: чтобы тесты и первая версия журнала имели одно
 * названное значение вместо трёх разных чисел, разложенных по коду. Сегодня в
 * продукте их именно три, и это установленный факт **[установлено,
 * `SETTINGS.md` §В1, п.1]**:
 *
 *  · 0,5 % за сервис — экономика продукта (`PRODUCT.md` §12);
 *  · 0,4998 % — пример проводок (`FUNCTIONAL.md` §3.3), где это не ставка, а
 *    результат округления комиссии 1 067 из 213 495;
 *  · **1,2 % плюс 1,00 ₾ — единственный работающий код**
 *    (`apps/web/src/fixtures/engine.ts`), то есть на экране владельца сервисная
 *    нога сегодня показана вдвое с лишним больше заложенной.
 *
 * Здесь взято 50 б.п. = 0,5 %, потому что это единственное из трёх, которое
 * названо **ставкой** в продуктовом документе; фикс — ноль, границ нет,
 * плательщик — получатель (сегодняшняя конструкция расчёта). Валюта — GEL:
 * из перечня валют сделки лари не выключается (`SETTINGS.md` §9 п.15).
 *
 * **Само число — вопрос владельца, вынесенный в `DECISIONS-REVIEW.md` §J1
 * [открыто].** До ответа это значение не должно попадать ни в одну версию
 * настройки, кроме тестовой.
 */
export const PROVISIONAL_TARIFF_PLAN: TariffPlan = tariffPlan({
  rateBp: 50,
  currency: 'GEL',
  fixed: 0n,
  minimum: null,
  maximum: null,
  bearing: bornByRecipient(),
  ceiling: DEFAULT_FEE_CEILING,
});
