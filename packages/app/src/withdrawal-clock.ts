import {
  type Instant,
  type Result,
  type WithdrawalClockPolicy,
  PROVISIONAL_WITHDRAWAL_CLOCK,
} from '@sdelka/domain';
import {
  NOT_STICKY,
  type NotSticky,
  type SettingsRefusalKey,
  type SettingsResolution,
  type SettingsSeries,
  type SettingsVersion,
  observationMoment,
  settingsSeries,
  settingsSeriesFromStore,
  versionInEffectNow,
} from '@sdelka/settings';

/**
 * Часы заявки на вывод как **величина владельца**, а не константа в коде.
 *
 * ## Что здесь чинится
 *
 * `DECISIONS-REVIEW.md` §H4: «у машины вывода нет ни дедлайнов, ни эскалации по
 * возрасту — заявка может стоять сколько угодно, и никто об этом не узнает. Это
 * чинит разработка, но **норматив — ваше число**». Машину чинит домен
 * (`client-account.ts`: дедлайн внутри нетерминального состояния, возраст от
 * `enteredAt`, `isWithdrawalStalled`); число не назначает никто из нас — оно
 * живёт версией настройки, как тариф и пороги очереди.
 *
 * ## Почему журнал версий, а не поле конфигурации
 *
 * Норматив попадает в задачу оператора и в объяснение «почему эту заявку подняли
 * тогда-то». Через год ответ «мы подняли её через четыре часа» обязан быть
 * восстановим: без версии он не восстановим ничем — сегодняшнее значение
 * перепишет вчерашнее молча. Механизм версий здесь не переизобретается ни
 * строкой: журнал, порядок, запрет задним числом и резолвер — `@sdelka/settings`.
 *
 * ## Почему величина не прилипает
 *
 * Норматив разбора — **операционная** величина, а не цена сделки: он говорит,
 * когда дежурный обязан увидеть застрявшую заявку. Сокращение норматива обязано
 * подействовать на **уже стоящие** заявки: они и есть те, о которых владелец
 * беспокоится. Поэтому `NOT_STICKY` и `versionInEffectNow` — спросить у этого
 * журнала «а что действовало в момент заявки» компилятор не даст (`resolve.ts`),
 * и это правильно: прилипший норматив означал бы, что заявка, заведённая до
 * правки, стоит по старому нормативу ровно тогда, когда владелец решил, что
 * старый норматив слишком длинный.
 *
 * ## Чего здесь нет
 *
 * Умолчания, подставляемого молча. Пустой журнал — **отказ**
 * (`SETTINGS_REFUSAL_KEYS.noVersionInEffect`), а не «взять
 * `PROVISIONAL_WITHDRAWAL_CLOCK` за неимением лучшего»: `?? DEFAULT`
 * компилируется, читается как забота о крайнем случае и подставляет число,
 * которого никто не выбирал. Временное значение существует ровно для того, чтобы
 * **им завели первую версию** — и тогда оно видно в журнале со своим основанием,
 * а не спрятано в коде.
 */

/** Домен версий. Он же — субъект записи `setting_changed` в журнале аудита. */
export const WITHDRAWAL_CLOCK_DOMAIN = 'withdrawal_clock';

export type WithdrawalClockSeries = SettingsSeries<WithdrawalClockPolicy, NotSticky>;

export function withdrawalClockSeries(): WithdrawalClockSeries {
  return settingsSeries<WithdrawalClockPolicy, NotSticky>(WITHDRAWAL_CLOCK_DOMAIN, NOT_STICKY);
}

export function withdrawalClockSeriesFromStore(
  versions: readonly SettingsVersion<WithdrawalClockPolicy>[],
): Result<WithdrawalClockSeries, SettingsRefusalKey> {
  return settingsSeriesFromStore<WithdrawalClockPolicy, NotSticky>(
    WITHDRAWAL_CLOCK_DOMAIN,
    NOT_STICKY,
    versions,
  );
}

/**
 * Часы, действующие сейчас. Отказ разбирает вызывающий: заявка без норматива —
 * это ровно та заявка, о которой никто не узнает, и молчаливого умолчания у неё
 * быть не должно.
 */
export function withdrawalClockInEffect(
  series: WithdrawalClockSeries,
  now: Instant,
): Result<SettingsResolution<WithdrawalClockPolicy>, SettingsRefusalKey> {
  return versionInEffectNow(series, observationMoment(now));
}

/**
 * ⚠ **Временное значение владельца, а не решение.** Реэкспорт доменного
 * `PROVISIONAL_WITHDRAWAL_CLOCK` под тем же именем: он существует, чтобы им
 * завели **первую версию** журнала, и чтобы всякий, кто его читает, видел слово
 * «временное» в том же месте, где берёт число.
 *
 * Вопрос — `DECISIONS-REVIEW.md` §H4 **[открыто]**.
 */
export const PROVISIONAL_WITHDRAWAL_CLOCK_VALUE: WithdrawalClockPolicy =
  PROVISIONAL_WITHDRAWAL_CLOCK;
