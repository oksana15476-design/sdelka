import type { Instant, Result } from '@sdelka/domain';
import type { CurrencyCode, Money } from '@sdelka/money';
import {
  type SettingsRefusalKey,
  type SettingsResolution,
  type SettingsSeries,
  type SettingsVersion,
  type SettingsVersionId,
  settingsSeries,
  settingsSeriesFromStore,
  stickingMoment,
  versionInEffect,
} from '@sdelka/settings';
import type { PricingRefusalKey } from './keys';
import { type TariffQuotation, quoteTariff } from './quotation';
import type { FxMarkup, FxMarkupSchedule } from './spread';
import { markupFor } from './spread';
import type { TariffPlan } from './tariff';

/**
 * Подключение величин к уже построенному механизму настроек.
 *
 * **Второго механизма здесь нет ни одного.** Версия, журнал версий, порядок
 * записи, запрет на задним числом, резолвер «действует версия с наибольшим
 * `effectiveFrom ≤ момент`» — всё это `@sdelka/settings`, и оно не повторено.
 * Здесь только два ответа, которых тот пакет дать не может по устройству: **что**
 * лежит в версии (`TariffPlan`, `FxMarkupSchedule`) и **к какому моменту** эта
 * величина прилипает.
 *
 * Момент прилипания задан **типом журнала**, а не соглашением: журнал тарифа
 * объявлен как `SettingsSeries<TariffPlan, 'tranche_created'>`, и спросить у
 * него «а какой тариф сейчас» компилятор не даёт — `versionInEffect` требует
 * `StickingMoment<'tranche_created'>`. Ровно это и есть запрет пересчёта задним
 * числом, выраженный так, что обойти его нельзя невнимательностью.
 */

/* ------------------------------------------------------------------------- */
/* Тариф                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Домен версий тарифа. Совпадает с `domain` записи аудита `setting_changed`
 * (`SETTINGS.md` §4) и с левой частью идентификатора версии
 * (`tariff/2026-09-04.1`) — одно имя на журнал версий, журнал аудита и ссылку в
 * записи начисления.
 */
export const TARIFF_DOMAIN = 'tariff';

/**
 * Тариф **прилипает к созданию транша** **[установлено, `FUNCTIONAL.md` §4.2:
 * «на каждой сделке хранится идентификатор версии плана, применённой в момент
 * создания — иначе через год нельзя воспроизвести, почему списали именно
 * столько»]**.
 *
 * Не к `release_pending`, где комиссия начисляется: между созданием транша и
 * начислением проходят часы, а при `release_blocked` — недели, и обе стороны
 * видят комиссию **до** платежа (`CABINETS.md` §3.2, §4.1). Величина,
 * прилипающая к начислению, означала бы, что показанные человеку цифры —
 * предположение, которое мы вправе поменять после того, как он на него
 * согласился.
 */
export const TARIFF_ATTACHMENT = 'tranche_created' as const;

export type TariffSeries = SettingsSeries<TariffPlan, typeof TARIFF_ATTACHMENT>;

export function tariffSeries(): TariffSeries {
  return settingsSeries<TariffPlan, typeof TARIFF_ATTACHMENT>(TARIFF_DOMAIN, TARIFF_ATTACHMENT);
}

/** Журнал тарифа, поднятый из хранилища: те же шесть правил дописывания. */
export function tariffSeriesFromStore(
  versions: readonly SettingsVersion<TariffPlan>[],
): Result<TariffSeries, SettingsRefusalKey> {
  return settingsSeriesFromStore<TariffPlan, typeof TARIFF_ATTACHMENT>(
    TARIFF_DOMAIN,
    TARIFF_ATTACHMENT,
    versions,
  );
}

/**
 * План, действовавший в момент создания транша.
 *
 * Момент обязан быть **моментом создания транша**, а не «сейчас»: тип
 * `StickingMoment<'tranche_created'>` собирается только здесь и только из этого
 * события.
 */
export function tariffAtTrancheCreation(
  series: TariffSeries,
  trancheCreatedAt: Instant,
): Result<SettingsResolution<TariffPlan>, SettingsRefusalKey> {
  return versionInEffect(series, stickingMoment(TARIFF_ATTACHMENT, trancheCreatedAt));
}

/**
 * Тарификация транша: журнал версий плюс момент создания дают сумму **и**
 * версию, по которой она посчитана.
 *
 * Единственный вход, которым эти две вещи получают вместе. Отсюда и свойство,
 * ради которого он существует: изменение тарифа не двигает уже посчитанные
 * сделки — не потому, что мы не пересчитываем, а потому, что пересчитать не по
 * чему: момент создания транша в прошлом, и резолвер на него отвечает прежней
 * версией.
 */
export function quoteTrancheTariff<C extends CurrencyCode>(
  series: TariffSeries,
  trancheCreatedAt: Instant,
  principal: Money<C>,
): Result<TariffQuotation<C>, SettingsRefusalKey | PricingRefusalKey> {
  const resolved = tariffAtTrancheCreation(series, trancheCreatedAt);
  if (!resolved.ok) return resolved;
  return quoteTariff(resolved.value, principal);
}

/**
 * Ссылка на версию тарифа в том виде, в каком её принимает журнал учёта
 * (`accrueFee(meta, deal, fee, tariffVersionId)`).
 *
 * **Находка, которую это закрывает.** Ссылка на траншe существовала и раньше —
 * `TrancheRuntime.tariffVersionId` (`packages/app/src/world.ts`) и
 * `accrues.tariffVersionId` в записи начисления, — но это была **метка, а не
 * связь**: обычная строка, проверяемая только на отсутствие `:` и `|`, никем не
 * сверяемая с журналом версий и ничем не связанная с суммой, которую называет та
 * же запись. По ней нельзя было ответить на вопрос И14.3 «почему списали
 * столько»: она утверждала, под какой версией *считали*, но ничто не мешало
 * посчитать под одной, а записать другую.
 *
 * Теперь ссылка выдаётся **только вместе с суммой** — из `TariffQuotation`,
 * которую невозможно получить иначе, чем разрешив версию на момент создания
 * транша. Формат `<домен>/<ГГГГ-ММ-ДД>.<n>` проходит `assertAccountIdentifier`
 * учёта без преобразования: `/` и `.` там законны, `:` и `|` в идентификаторе
 * версии невыразимы.
 */
export function tariffVersionRef(quotation: TariffQuotation<CurrencyCode>): string {
  return quotation.versionId;
}

/**
 * Та же ссылка от версии напрямую — для мест, где сумма уже посчитана и нужна
 * только запись (реверс начисления, выписка).
 */
export function tariffVersionRefOf(versionId: SettingsVersionId): string {
  return versionId;
}

/* ------------------------------------------------------------------------- */
/* Наценка                                                                   */
/* ------------------------------------------------------------------------- */

/** Домен версий наценки. Тот же, что `domain: 'fx_markup'` в записи аудита. */
export const FX_MARKUP_DOMAIN = 'fx_markup';

/**
 * Наценка **прилипает к выпуску котировки** (`SETTINGS.md` §8, `FX.md` §7.1).
 *
 * Не к созданию сделки и не к платежу: клиент подтверждает конкретную котировку
 * по идентификатору, и подтверждение «вообще» невыразимо намеренно
 * (`packages/intake/src/quote.ts`). Следствие, которое надо знать: живая
 * котировка доживает свой срок по прежней наценке — новая наценка действует на
 * котировки, выпущенные после `effectiveFrom`. Это предложение, а не решение
 * (`SETTINGS.md` §10 В2.1 **[открыто]**); в коде оно выражено выбором момента, и
 * другой ответ владельца меняет момент, а не устройство.
 */
export const FX_MARKUP_ATTACHMENT = 'quote_issued' as const;

export type FxMarkupSeries = SettingsSeries<FxMarkupSchedule, typeof FX_MARKUP_ATTACHMENT>;

export function fxMarkupSeries(): FxMarkupSeries {
  return settingsSeries<FxMarkupSchedule, typeof FX_MARKUP_ATTACHMENT>(
    FX_MARKUP_DOMAIN,
    FX_MARKUP_ATTACHMENT,
  );
}

export function fxMarkupSeriesFromStore(
  versions: readonly SettingsVersion<FxMarkupSchedule>[],
): Result<FxMarkupSeries, SettingsRefusalKey> {
  return settingsSeriesFromStore<FxMarkupSchedule, typeof FX_MARKUP_ATTACHMENT>(
    FX_MARKUP_DOMAIN,
    FX_MARKUP_ATTACHMENT,
    versions,
  );
}

export function markupScheduleAtQuoteIssue(
  series: FxMarkupSeries,
  quoteIssuedAt: Instant,
): Result<SettingsResolution<FxMarkupSchedule>, SettingsRefusalKey> {
  return versionInEffect(series, stickingMoment(FX_MARKUP_ATTACHMENT, quoteIssuedAt));
}

/** Наценка по паре на момент выпуска котировки — вместе с версией, её давшей. */
export interface ResolvedMarkup {
  readonly versionId: SettingsVersionId;
  readonly markup: FxMarkup;
}

export function markupAtQuoteIssue(
  series: FxMarkupSeries,
  quoteIssuedAt: Instant,
  base: CurrencyCode,
  quote: CurrencyCode,
): Result<ResolvedMarkup, SettingsRefusalKey | PricingRefusalKey> {
  const resolved = markupScheduleAtQuoteIssue(series, quoteIssuedAt);
  if (!resolved.ok) return resolved;
  const found = markupFor(resolved.value.applied.value, base, quote);
  if (!found.ok) return found;
  return {
    ok: true,
    value: Object.freeze({ versionId: resolved.value.applied.versionId, markup: found.value }),
  };
}
