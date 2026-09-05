import { type Instant, type Result, failure, ok } from '@sdelka/domain';
import type { CurrencyCode } from '@sdelka/money';
import {
  NOT_STICKY,
  type NotSticky,
  type SettingsRefusalKey,
  type SettingsResolution,
  type SettingsSeries,
  type SettingsVersion,
  type SettingsVersionId,
  observationMoment,
  settingsSeries,
  settingsSeriesFromStore,
  stickingMoment,
  versionInEffect,
  versionInEffectNow,
} from '@sdelka/settings';
import { type DealCurrencyList, admitsCurrency } from './currencies';
import { LIMITS_REFUSAL_KEYS, type LimitsRefusalKey } from './keys';
import type { AmountTolerance, MaterialityThreshold, QueueAgeBands } from './thresholds';

/**
 * Подключение величин периметра к уже построенному механизму настроек.
 *
 * **Второго механизма здесь нет ни одного.** Версия, журнал версий, порядок
 * записи, запрет «задним числом», резолвер «действует версия с наибольшим
 * `effectiveFrom ≤ момент`» — всё это `@sdelka/settings`, и оно не повторено.
 * Здесь только два ответа, которых тот пакет дать не может по устройству: **что**
 * лежит в версии и **к какому моменту** величина прилипает.
 *
 * Момент задан **типом журнала**, а не соглашением: журнал валют объявлен как
 * `SettingsSeries<DealCurrencyList, 'deal_created'>`, и спросить у него «а какие
 * валюты сейчас» компилятор не даёт. Ровно это и есть требование «выключение
 * валюты действует только на новые сделки», выраженное так, что обойти его
 * нельзя невнимательностью.
 */

/* ------------------------------------------------------------------------- */
/* Перечень валют сделки                                                     */
/* ------------------------------------------------------------------------- */

/** Домен версий перечня. Он же — `domain` записи аудита `setting_changed`. */
export const DEAL_CURRENCIES_DOMAIN = 'deal_currencies';

/**
 * Перечень валют сделки **прилипает к созданию сделки** (`SETTINGS.md` §8).
 *
 * Не к «сейчас» и не к платежу: валюта сделки определяет счёт обязательства и
 * все последующие проводки, а конвертация запертой части не выражается вовсе
 * **[установлено, `FUNCTIONAL.md` §3.3]**. Отсюда прямое следствие, ради
 * которого момент и выбран: **убрать валюту из перечня можно только для новых
 * сделок**. Сделка, заведённая, пока валюта была включена, спрашивает перечень
 * на момент своего создания — и получает тот перечень, в котором её валюта
 * есть, сколько бы версий ни легло сверху.
 */
export const DEAL_CURRENCIES_ATTACHMENT = 'deal_created' as const;

export type DealCurrenciesSeries = SettingsSeries<
  DealCurrencyList,
  typeof DEAL_CURRENCIES_ATTACHMENT
>;

export function dealCurrenciesSeries(): DealCurrenciesSeries {
  return settingsSeries<DealCurrencyList, typeof DEAL_CURRENCIES_ATTACHMENT>(
    DEAL_CURRENCIES_DOMAIN,
    DEAL_CURRENCIES_ATTACHMENT,
  );
}

export function dealCurrenciesSeriesFromStore(
  versions: readonly SettingsVersion<DealCurrencyList>[],
): Result<DealCurrenciesSeries, SettingsRefusalKey> {
  return settingsSeriesFromStore<DealCurrencyList, typeof DEAL_CURRENCIES_ATTACHMENT>(
    DEAL_CURRENCIES_DOMAIN,
    DEAL_CURRENCIES_ATTACHMENT,
    versions,
  );
}

export function dealCurrenciesAtDealCreation(
  series: DealCurrenciesSeries,
  dealCreatedAt: Instant,
): Result<SettingsResolution<DealCurrencyList>, SettingsRefusalKey> {
  return versionInEffect(series, stickingMoment(DEAL_CURRENCIES_ATTACHMENT, dealCreatedAt));
}

/** Валюта, допущенная к сделке, — вместе с версией перечня, которая её допустила. */
export interface AdmittedDealCurrency {
  readonly versionId: SettingsVersionId;
  readonly currency: CurrencyCode;
}

/**
 * Допущена ли валюта к сделке, созданной в этот момент.
 *
 * Единственный вход, которым ответ и версия получаются вместе. Отсюда и
 * свойство, ради которого он существует: **выключение валюты не трогает уже
 * заведённые сделки** — не потому, что мы их не пересчитываем, а потому, что
 * пересчитать не по чему: момент создания сделки в прошлом, и резолвер на него
 * отвечает прежней версией перечня.
 *
 * Тот же вызов служит и новой сделке: момент создания новой сделки — «сейчас»,
 * и перечень на «сейчас» валюту уже не содержит. Двух функций не нужно, и
 * заводить их значило бы завести место, где «для новых» и «для старых»
 * разъезжаются.
 */
export function dealCurrencyAdmittedAt(
  series: DealCurrenciesSeries,
  dealCreatedAt: Instant,
  currency: CurrencyCode,
): Result<AdmittedDealCurrency, SettingsRefusalKey | LimitsRefusalKey> {
  const resolved = dealCurrenciesAtDealCreation(series, dealCreatedAt);
  if (!resolved.ok) return resolved;
  if (!admitsCurrency(resolved.value.applied.value, currency)) {
    return failure(LIMITS_REFUSAL_KEYS.currencyNotAdmittedAtDealCreation);
  }
  return ok(
    Object.freeze({ versionId: resolved.value.applied.versionId, currency }),
  );
}

/* ------------------------------------------------------------------------- */
/* Допуск по сумме                                                           */
/* ------------------------------------------------------------------------- */

export const AMOUNT_TOLERANCE_DOMAIN = 'amount_tolerance';

/**
 * Допуск **прилипает к факту раскрытия** (`SETTINGS.md` §8, `INTAKE.md` §3.3).
 *
 * Не к созданию транша и не к поступлению: допуск обязан быть раскрыт стороне
 * **до** платежа, иначе критерий приёмки A2 недоказуем — необъявленный допуск
 * объявить задним числом нельзя. Правило «раскрыто под другую версию политики —
 * действует **меньшее** из объявленного и текущего» живёт в приёме
 * (`packages/intake/src/disclosure.ts`) и здесь не повторяется: этот момент
 * отвечает на вопрос «какая версия была объявлена», а не «какая применится».
 */
export const AMOUNT_TOLERANCE_ATTACHMENT = 'disclosure_made' as const;

export type AmountToleranceSeries = SettingsSeries<
  AmountTolerance,
  typeof AMOUNT_TOLERANCE_ATTACHMENT
>;

export function amountToleranceSeries(): AmountToleranceSeries {
  return settingsSeries<AmountTolerance, typeof AMOUNT_TOLERANCE_ATTACHMENT>(
    AMOUNT_TOLERANCE_DOMAIN,
    AMOUNT_TOLERANCE_ATTACHMENT,
  );
}

export function amountToleranceSeriesFromStore(
  versions: readonly SettingsVersion<AmountTolerance>[],
): Result<AmountToleranceSeries, SettingsRefusalKey> {
  return settingsSeriesFromStore<AmountTolerance, typeof AMOUNT_TOLERANCE_ATTACHMENT>(
    AMOUNT_TOLERANCE_DOMAIN,
    AMOUNT_TOLERANCE_ATTACHMENT,
    versions,
  );
}

/**
 * Допуск, действовавший в момент раскрытия его стороне.
 *
 * Момент обязан быть **моментом раскрытия**: `StickingMoment<'disclosure_made'>`
 * собирается только здесь и только из этого события. Спросить «а какой допуск
 * сейчас» у этого журнала нельзя — компилятор откажет, и это ровно тот запрет,
 * который держит обещание, данное стороне до платежа.
 */
export function amountToleranceAtDisclosure(
  series: AmountToleranceSeries,
  disclosedAt: Instant,
): Result<SettingsResolution<AmountTolerance>, SettingsRefusalKey> {
  return versionInEffect(series, stickingMoment(AMOUNT_TOLERANCE_ATTACHMENT, disclosedAt));
}

/* ------------------------------------------------------------------------- */
/* Возрастные границы очереди                                                */
/* ------------------------------------------------------------------------- */

export const QUEUE_AGE_DOMAIN = 'queue_age';

/**
 * Границы очереди **не прилипают** (`SETTINGS.md` §8, строки «не прилипает» —
 * окна наблюдения).
 *
 * Очередь разбора — контрольная мера дежурного, а не обещание стороне: она не
 * двигает ни одной суммы и никому не раскрывается. Ужесточение обязано
 * действовать сразу на все задачи, включая те, из-за которых оно принято, —
 * иначе после инцидента норматив меняется, а очередь живёт по прежнему.
 *
 * Что при этом **не** теряется: ответ на прошлый момент не переписывается.
 * Версия, действовавшая в момент наблюдения, остаётся действовавшей в этот
 * момент навсегда — новую версию раньше её записи не ввести
 * (`SETTINGS.md` §9 п.2), а значит ни одна будущая правка не меняет уровень
 * эскалации, назначенный вчерашней задаче вчера.
 */
export const QUEUE_AGE_ATTACHMENT: NotSticky = NOT_STICKY;

export type QueueAgeSeries = SettingsSeries<QueueAgeBands, NotSticky>;

export function queueAgeSeries(): QueueAgeSeries {
  return settingsSeries<QueueAgeBands, NotSticky>(QUEUE_AGE_DOMAIN, QUEUE_AGE_ATTACHMENT);
}

export function queueAgeSeriesFromStore(
  versions: readonly SettingsVersion<QueueAgeBands>[],
): Result<QueueAgeSeries, SettingsRefusalKey> {
  return settingsSeriesFromStore<QueueAgeBands, NotSticky>(
    QUEUE_AGE_DOMAIN,
    QUEUE_AGE_ATTACHMENT,
    versions,
  );
}

/** Границы, действующие в названный момент наблюдения. */
export function queueAgeBandsAt(
  series: QueueAgeSeries,
  observedAt: Instant,
): Result<SettingsResolution<QueueAgeBands>, SettingsRefusalKey> {
  return versionInEffectNow(series, observationMoment(observedAt));
}

/* ------------------------------------------------------------------------- */
/* Порог значимости                                                          */
/* ------------------------------------------------------------------------- */

export const MATERIALITY_DOMAIN = 'materiality';

/**
 * Порог значимости **не прилипает**: он оценивает оборот за период, а не сделку.
 *
 * Момент наблюдения при этом обязателен и назван: «мы на 78 % порога» без даты —
 * утверждение, которое через год не проверить. Версия, действовавшая на дату
 * наблюдения, остаётся при этом наблюдении навсегда: норму меняет закон, и
 * прошлая оценка обязана считаться по норме, действовавшей тогда.
 */
export const MATERIALITY_ATTACHMENT: NotSticky = NOT_STICKY;

export type MaterialitySeries = SettingsSeries<MaterialityThreshold, NotSticky>;

export function materialitySeries(): MaterialitySeries {
  return settingsSeries<MaterialityThreshold, NotSticky>(MATERIALITY_DOMAIN, MATERIALITY_ATTACHMENT);
}

export function materialitySeriesFromStore(
  versions: readonly SettingsVersion<MaterialityThreshold>[],
): Result<MaterialitySeries, SettingsRefusalKey> {
  return settingsSeriesFromStore<MaterialityThreshold, NotSticky>(
    MATERIALITY_DOMAIN,
    MATERIALITY_ATTACHMENT,
    versions,
  );
}

export function materialityThresholdAt(
  series: MaterialitySeries,
  observedAt: Instant,
): Result<SettingsResolution<MaterialityThreshold>, SettingsRefusalKey> {
  return versionInEffectNow(series, observationMoment(observedAt));
}
