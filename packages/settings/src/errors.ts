/**
 * Технические ключи ошибок для разработчика. Не пользовательский текст.
 *
 * Бросают здесь ровно те же случаи, что и в соседних пакетах: **испорченная
 * настройка**, по которой продолжать нельзя (идентификатор не той формы, версия
 * задним числом, полномочия нет). Отказ в конкретной операции — не исключение, а
 * значение: см. `Result` и `SETTINGS_REFUSAL_KEYS` в `keys.ts`.
 */
export const SettingsErrorCode = {
  domainKeyInvalid: 'settings.domain_key.invalid',
  versionIdInvalid: 'settings.version_id.invalid',
  /** Дата в идентификаторе не существует в календаре: `2026-02-30`, `2026-13-01`. */
  versionIdDateInvalid: 'settings.version_id.date_invalid',
  reasonKeyInvalid: 'settings.reason_key.invalid',
  /**
   * Версия вводится задним числом: момент вступления в силу раньше момента
   * записи. Красная линия №11 — журнал не редактируется; версия, действующая
   * раньше, чем она записана, и есть правка прошлого, только другим способом.
   */
  versionBackdated: 'settings.version.backdated',
  /**
   * Настройку двигает роль, у которой нет `manage_settings`
   * (`packages/auth/src/capabilities.ts`). Не отказ в операции, а испорченный
   * вызов: полномочие проверяется до того, как версия вообще появится.
   */
  capabilityNotGranted: 'settings.capability.not_granted',
  /** Порядок строгости заведён без ссылки на документ, объясняющий исключение. */
  strictnessOrderUnjustified: 'settings.strictness_order.unjustified',
  /**
   * Версия ссылается сама на себя как на предыдущую. Не цепочка, а петля: по
   * такой ссылке «что действовало до» не восстанавливается никогда.
   */
  supersedesSelfReference: 'settings.version.supersedes_self',
  /**
   * Предыдущая версия — из другого домена (`SETTINGS.md` §9 п.5). Тариф не
   * сменяет наценку: это две разные истории, и склеивать их ссылкой значит
   * получить журнал, в котором ни одна из двух не читается.
   */
  supersedesDomainMismatch: 'settings.version.supersedes_domain_mismatch',
  /**
   * Предыдущая версия не старше текущей по идентификатору. Ссылка вперёд ломает
   * тот же порядок, на котором держится восстановление «что действовало 14 марта».
   */
  supersedesNotOlder: 'settings.version.supersedes_not_older',
} as const;

export type SettingsErrorCode = (typeof SettingsErrorCode)[keyof typeof SettingsErrorCode];

export class SettingsError extends Error {
  readonly code: SettingsErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: SettingsErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'SettingsError';
    this.code = code;
    this.details = details;
  }
}
