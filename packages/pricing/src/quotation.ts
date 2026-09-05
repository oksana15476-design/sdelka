import { type Result, failure, ok } from '@sdelka/domain';
import { feeCeilingCap } from '@sdelka/ledger';
import {
  type CurrencyCode,
  type Deduction,
  type Money,
  applyRational,
  money,
} from '@sdelka/money';
import type { SettingsResolution, SettingsVersionId } from '@sdelka/settings';
import { PLATFORM_FEE_DEDUCTION_KEY, PRICING_REFUSAL_KEYS, type PricingRefusalKey } from './keys';
import { PricingError, PricingErrorCode } from './errors';
import { shareOf } from './rate';
import type { TariffPlan } from './tariff';

/**
 * Тарификация: сколько обязан перевести покупатель, сколько получит продавец и
 * сколько из этого наша комиссия — **по названной версии плана**.
 *
 * ### Одно правило, из которого следует всё остальное
 *
 * **База ставки — сумма сделки** (`principal`), то есть то, о чём договорились
 * стороны. Не «сумма к переводу» и не «сумма к получению»: это одно и то же
 * число только тогда, когда комиссию несёт получатель, а плательщик — величина
 * управляемая, и база, зависящая от неё, означала бы, что смена плательщика
 * молча меняет нашу выручку.
 *
 * Отсюда свойство, ради которого база выбрана так: **комиссия одна и та же при
 * любом плательщике**, различаются только брутто и нетто.
 *
 * | Плательщик | Брутто (переводит покупатель) | Нетто (получает продавец) |
 * |---|---|---|
 * | `recipient` | `principal` | `principal − комиссия` |
 * | `payer` | `principal + комиссия` | `principal` |
 * | `split` | `principal + доля покупателя` | `principal − доля получателя` |
 *
 * Во всех трёх строках `брутто − нетто = комиссия` — тождество, а не совпадение,
 * и именно на нём держится красная линия №2: запись расчёта дебетует брутто с
 * запертой части, кредитует нетто получателю и дебетует разницу в `transit:fee`;
 * если бы тождество нарушилось, запись не сошлась бы повалютно и не собралась
 * вовсе (`@sdelka/ledger`, `assertBalanced`).
 *
 * ### Почему грубого «поделить на (1 − ставка)» здесь нет
 *
 * Вариант «база = брутто, брутто решается уравнением» выглядит естественнее
 * («ставка от суммы к распределению», `split`), но требует целочисленного
 * деления с остатком, у которого нет правильной стороны округления: остаток
 * достаётся либо клиенту, либо нам, и решать это молча нельзя. При базе
 * `principal` деления нет вовсе — только умножение с усечением, а усечение уже
 * имеет объявленное направление: в пользу клиента.
 *
 * ### Округление
 *
 * Комиссия усекается один раз (`trunc` от неотрицательной величины) — остаток
 * достаётся клиенту (`FUNCTIONAL.md` §4.3 п.5). У сплита усекается **доля
 * получателя**, а покупателю достаётся остаток: получатель — та сторона, чьи
 * деньги мы уменьшаем, и спорная минорная единица остаётся у него.
 */
export interface TariffQuotation<C extends CurrencyCode = CurrencyCode> {
  /**
   * Версия плана, по которой посчитано. **Не строка рядом, а часть результата:**
   * сумма и версия выходят из одного значения, поэтому «посчитали по одной
   * версии, записали другую» невыразимо. Это же значение уходит в запись
   * начисления (`accrues.tariffVersionId`, `@sdelka/ledger`).
   */
  readonly versionId: SettingsVersionId;
  /** Сам план — чтобы выписка по сделке восстанавливалась без похода в журнал версий. */
  readonly plan: TariffPlan;
  /** Сумма сделки: о чём договорились стороны. База ставки. */
  readonly principal: Money<C>;
  /** Комиссия платформы. Не зависит от плательщика. */
  readonly fee: Money<C>;
  /** Доля комиссии, которую несёт покупатель. */
  readonly payerShare: Money<C>;
  /** Доля комиссии, которую несёт получатель. */
  readonly recipientShare: Money<C>;
  /** Брутто: сколько обязан перевести покупатель. */
  readonly required: Money<C>;
  /** Нетто: сколько получит продавец. */
  readonly net: Money<C>;
  /**
   * Строка удержания для расщепления (`@sdelka/money`, `split`).
   *
   * Приходит **фиксированной суммой**, а не ставкой, и это не мелочь: база
   * ставки — `principal`, а `split` считает от того, что ему передали, то есть
   * от брутто. Передай мы сюда ставку — при плательщике-покупателе расщепление
   * посчитало бы её от большей суммы и разошлось бы с уже раскрытой клиенту
   * комиссией. Одно вычисление комиссии на пакет, а не два.
   */
  readonly deductions: readonly Deduction[];
}

function feeForPlan(plan: TariffPlan, principalMinor: bigint): bigint {
  let amount = applyRational(principalMinor, shareOf(plan.rateBp), 'trunc') + plan.fixed;
  if (plan.minimum !== null && amount < plan.minimum) {
    amount = plan.minimum;
  }
  if (plan.maximum !== null && amount > plan.maximum) {
    amount = plan.maximum;
  }
  return amount;
}

function sharesOf(plan: TariffPlan, fee: bigint): { payer: bigint; recipient: bigint } {
  switch (plan.bearing.payer) {
    case 'recipient':
      return { payer: 0n, recipient: fee };
    case 'payer':
      return { payer: fee, recipient: 0n };
    case 'split': {
      // Усекается доля **получателя**, остаток достаётся покупателю: спорная
      // минорная единица остаётся у той стороны, чьи деньги мы уменьшаем.
      const recipient = applyRational(fee, shareOf(plan.bearing.recipientShareBp), 'trunc');
      return { payer: fee - recipient, recipient };
    }
  }
}

/**
 * Тарифицировать сумму по уже разрешённой версии плана.
 *
 * Вход — `SettingsResolution`, а не голый план: версия и значение приходят одним
 * значением из резолвера настройки, и подсунуть сюда «план из прошлого с
 * версией из настоящего» нечем.
 */
export function quoteTariff<C extends CurrencyCode>(
  resolution: SettingsResolution<TariffPlan>,
  principal: Money<C>,
): Result<TariffQuotation<C>, PricingRefusalKey> {
  const plan = resolution.applied.value;
  if (principal.minor < 0n) {
    // Отрицательная сумма сделки — не «маленькая сделка», а испорченный вызов:
    // тарифицировать нечего.
    throw new PricingError(PricingErrorCode.principalNegative, {
      amount: principal.minor.toString(),
    });
  }
  if ((principal.currency as CurrencyCode) !== plan.currency) {
    return failure(PRICING_REFUSAL_KEYS.planCurrencyNotDeclared);
  }
  const feeMinor = feeForPlan(plan, principal.minor);
  const shares = sharesOf(plan, feeMinor);
  if (shares.recipient > principal.minor) {
    // Комиссия съедает сумму получателя целиком. Отказ, а не усечение: усечение
    // оставило бы продавцу ноль и выглядело бы законным расчётом.
    return failure(PRICING_REFUSAL_KEYS.feeExceedsPrincipal);
  }
  const requiredMinor = principal.minor + shares.payer;
  const required = money(principal.currency, requiredMinor);
  if (feeMinor > feeCeilingCap(required, plan.ceiling).minor) {
    // Тот же предел, который считает запись расчёта из самих проводок, только
    // померенный до того, как деньги позваны. Оба рубежа мерят одно и то же
    // отношение — удержание к брутто, — поэтому разойтись им нечем.
    return failure(PRICING_REFUSAL_KEYS.feeAboveCeiling);
  }
  return ok(
    Object.freeze({
      versionId: resolution.applied.versionId,
      plan,
      principal,
      fee: money(principal.currency, feeMinor),
      payerShare: money(principal.currency, shares.payer),
      recipientShare: money(principal.currency, shares.recipient),
      required,
      net: money(principal.currency, principal.minor - shares.recipient),
      deductions: Object.freeze([
        Object.freeze({ key: PLATFORM_FEE_DEDUCTION_KEY, fixed: feeMinor }),
      ] as readonly Deduction[]),
    }),
  );
}
