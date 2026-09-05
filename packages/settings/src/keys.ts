import { SettingsError, SettingsErrorCode } from './errors';

/**
 * Ключи пакета настроек.
 *
 * Ни одной пользовательской строки: пакет возвращает ключи, текст живёт в
 * словарях трёх языков (`CLAUDE.md` → «Три языка»). Ключи собраны в объекты и
 * выведены в типы, поэтому опечатка не собирается, а полнота словаря
 * проверяется перебором значений, а не поиском по коду.
 */

/* ------------------------------------------------------------------------- */
/* Основание изменения                                                       */
/* ------------------------------------------------------------------------- */

declare const reasonKeyBrand: unique symbol;

/**
 * Основание, по которому владелец ввёл версию, — **ключ, а не текст**.
 *
 * `SETTINGS.md` §2 Ф2.4 требует обязательного обоснования и называет его
 * свободным текстом; журнал аудита уже реализован иначе — `SettingChangedBody`
 * несёт `reasonKey` (`packages/audit/src/record.ts`), и свободного текста в
 * записи нет по построению: `AUDIT_TOKEN` не пропускает строку с пробелами.
 * Здесь выбран ключ — по трём причинам, и все три проверяемы:
 *
 * 1. Значение уходит в журнал аудита как `reasonKey`; двух форм основания
 *    (текст здесь, ключ там) быть не должно — вторая форма это второе место,
 *    где основание теряется.
 * 2. Свободный текст локализации не имеет, а язык интерфейса у нас три.
 * 3. Свободный текст — это канал, по которому в журнал попадают персональные
 *    данные, и он же не проверяется никаким тестом на полноту.
 *
 * Развилка **[открыто]**: закрытый перечень оснований (как `REASON_KEYS` в
 * комплаенсе) назначить нельзя — из чего он состоит, знает владелец. До ответа
 * ключ проверяется только формой: `settings.reason.<снейк_кейс>`.
 */
export type SettingsReasonKey = string & { readonly [reasonKeyBrand]: 'settings_reason' };

const REASON_KEY = /^settings\.reason\.[a-z][a-z0-9_]*$/u;

export function settingsReasonKey(value: string): SettingsReasonKey {
  if (!REASON_KEY.test(value)) {
    throw new SettingsError(SettingsErrorCode.reasonKeyInvalid, { value });
  }
  return value as SettingsReasonKey;
}

/* ------------------------------------------------------------------------- */
/* Отказы                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Отказы журнала версий и разрешения действующей версии.
 *
 * Это **значения**, а не исключения: отказ приходится на живую сделку, и
 * вызывающий обязан его разобрать — как разбирает отказ в кворуме
 * (`packages/auth/src/approval.ts`). Исключениями остаются только испорченные
 * данные (`errors.ts`).
 */
export const SETTINGS_REFUSAL_KEYS = {
  /** Версия чужого домена: `tariff/...` в журнале другого домена. */
  versionDomainMismatch: 'settings.version.domain_mismatch',
  /** Идентификатор уже встречался в журнале. */
  versionIdReused: 'settings.version.id_reused',
  /** Идентификатор не возрастает: журнал перестал сортироваться собственным ключом. */
  versionIdOutOfOrder: 'settings.version.id_out_of_order',
  /** Момент записи раньше предыдущего: журнал дописывается только в конец. */
  versionRecordedOutOfOrder: 'settings.version.recorded_out_of_order',
  /**
   * Момент вступления в силу совпал с предыдущим. Ровно та «правка, сохранённая
   * дважды», о которой `SETTINGS.md` §7.3: двух действующих версий на один
   * момент не бывает, и выбирать между ними по идентификатору значит выбирать
   * молча.
   */
  versionEffectiveMomentCollides: 'settings.version.effective_moment_collides',
  /**
   * Версия действует раньше уже записанной **отложенной**. Отказ, а не разбор
   * порядка: см. `series.ts`, там же названа цена строгости.
   */
  versionEffectiveBeforeDeferred: 'settings.version.effective_before_deferred',
  /**
   * Первая версия журнала сослалась на предыдущую, которой не было: журнал пуст.
   */
  versionSupersedesUnexpected: 'settings.version.supersedes_unexpected',
  /**
   * Версия легла в непустой журнал, не сославшись на предыдущую. Разрыв цепочки:
   * `SETTINGS.md` §2 требует ссылку, §9 п.5 — чтобы она указывала на
   * существующую версию того же домена.
   */
  versionSupersedesMissing: 'settings.version.supersedes_missing',
  /**
   * Ссылка ведёт не на последнюю запись журнала. Отказ строже спеки, и цена
   * названа в `series.ts`.
   */
  versionSupersedesNotPrevious: 'settings.version.supersedes_not_previous',
  /**
   * В журнале две версии на один момент вступления в силу. Второй рубеж после
   * журнала: список приходит из хранилища, а типы не переживают границу
   * процесса (`packages/auth/src/approval.ts`).
   */
  effectiveMomentAmbiguous: 'settings.resolve.effective_moment_ambiguous',
  /**
   * **Действующей версии нет — и это отказ, а не значение.**
   *
   * Пустая история (или момент раньше первой версии) не даёт «умолчания»:
   * умолчание, подставленное молча, и есть та ошибка, из-за которой в продукте
   * сегодня три разных тарифа — 0,5% в экономике, 0,4998% в примере проводок,
   * 1,2% в коде (`SETTINGS.md` §10 В1.1). Отказ здесь возвращается вместо
   * `applied: null` намеренно: `null` в успешном ответе читается вызывающим как
   * «ограничения нет» и молча схлопывается в `?? DEFAULT`, а отказ обязан быть
   * разобран.
   */
  noVersionInEffect: 'settings.resolve.no_version_in_effect',
  /** Момент прилипания не тот, к которому привязана величина. */
  attachmentMismatch: 'settings.resolve.attachment_mismatch',
  /** «Сейчас» раньше момента прилипания: у храповика это не порядок, а ошибка вызова. */
  momentsOutOfOrder: 'settings.resolve.moments_out_of_order',
} as const;

export type SettingsRefusalKey =
  (typeof SETTINGS_REFUSAL_KEYS)[keyof typeof SETTINGS_REFUSAL_KEYS];

/* ------------------------------------------------------------------------- */
/* Исходы разрешения                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Почему применена именно эта версия. Исход всегда назван ключом: «эта сумма
 * посчитана по версии транша» и «эта сумма посчитана по текущей версии» —
 * разные утверждения, и через два года их различает только запись.
 *
 * Исхода «версии нет» здесь нет: отсутствие действующей версии — не исход, а
 * отказ, и живёт он в `SETTINGS_REFUSAL_KEYS.noVersionInEffect`.
 */
export const SETTINGS_OUTCOME_KEYS = {
  /** Версия, действовавшая в момент прилипания. */
  stickyVersionApplied: 'settings.resolution.sticky_version_applied',
  /** Версия, действующая сейчас, — у величин, которые не прилипают. */
  immediateVersionApplied: 'settings.resolution.immediate_version_applied',
  /** Храповик: текущая версия строже прилипшей и потому применена. */
  ratchetTightened: 'settings.resolution.ratchet_tightened',
  /** Храповик: текущая версия мягче прилипшей и потому не применена. */
  ratchetSofteningNotApplied: 'settings.resolution.ratchet_softening_not_applied',
  /**
   * Храповик: текущая версия делает величину недостижимой, и к прилипшей она не
   * применяется. Оговорка `SETTINGS.md` §В4 и красная линия №7.
   */
  ratchetUnreachableNotApplied: 'settings.resolution.ratchet_unreachable_not_applied',
  /** Храповик: в момент прилипания версии не было, применена текущая. */
  ratchetNoStuckVersion: 'settings.resolution.ratchet_no_stuck_version',
  /** Храповик: текущей версии нет, осталась прилипшая. */
  ratchetNoCurrentVersion: 'settings.resolution.ratchet_no_current_version',
  /** Храповик: версия не менялась. */
  ratchetUnchanged: 'settings.resolution.ratchet_unchanged',
} as const;

export type SettingsOutcomeKey =
  (typeof SETTINGS_OUTCOME_KEYS)[keyof typeof SETTINGS_OUTCOME_KEYS];
