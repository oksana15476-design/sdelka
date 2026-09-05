/**
 * Ключи пакета. Ни одной пользовательской строки: наружу уходит ключ, текст
 * живёт в словарях трёх языков (`CLAUDE.md` → «Три языка»).
 */

/* ------------------------------------------------------------------------- */
/* Отказы                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Отказы — **значения**, а не исключения: каждый приходится на живое действие
 * (владелец включает валюту, сделка заводится, изменение уходит в журнал), и
 * вызывающий обязан его разобрать. Та же граница, что у
 * `SETTINGS_REFUSAL_KEYS`.
 */
export const LIMITS_REFUSAL_KEYS = {
  /* --- Включение валюты: пять предпосылок `SETTINGS.md` §В3 --- */
  /**
   * Нет счёта номинального держания в этой валюте. Покрытие считается **по
   * каждой валюте отдельно** (`packages/ledger`, `coverage`), и валюта без
   * счёта даёт покрытие ниже единицы в тот же день — красная линия №3.
   */
  nominalAccountMissing: 'limits.currency.nominal_account_missing',
  /** Нет построчной сверки по этому счёту (`FUNCTIONAL.md` §3.1). */
  reconciliationMissing: 'limits.currency.reconciliation_missing',
  /**
   * Нет наблюдения официального курса пары «валюта → лари». Без него
   * утверждений по траншу не набрать вовсе: `requiredApprovals` возвращает
   * `null` (`packages/domain/src/guards.ts`), то есть деньги придут, а выплатить
   * их будет нельзя.
   */
  officialRateMissing: 'limits.currency.official_rate_missing',
  /** Не объявлен абсолютный допуск в этой валюте: допуск был бы нулём молча. */
  toleranceNotDeclared: 'limits.currency.tolerance_not_declared',
  /** Не объявлена наценка по паре: котировка не выпускается. */
  markupNotDeclared: 'limits.currency.markup_not_declared',
  /** Валюта уже включена: повторное включение — не изменение, а шум в журнале. */
  currencyAlreadyAdmitted: 'limits.currency.already_admitted',

  /* --- Выключение валюты --- */
  /** Валюты нет в перечне: выключать нечего. */
  currencyNotAdmitted: 'limits.currency.not_admitted',
  /**
   * По валюте есть открытые позиции. «Открытые позиции» шире, чем «незакрытые
   * сделки»: сюда же входят непогашенная позиция по обмену и остаток на
   * транзитных счетах (`SETTINGS.md` §В3 п.6). Считаются **по журналу**, а не по
   * списку сделок, и число приходит сюда снаружи: журнал этому пакету не
   * принадлежит.
   */
  currencyHasOpenPositions: 'limits.currency.has_open_positions',
  /** Лари из перечня валют сделки не выключается (`SETTINGS.md` §9 п.15). */
  settlementCurrencyLocked: 'limits.currency.settlement_currency_locked',

  /* --- Применение перечня --- */
  /**
   * Валюта не входила в перечень, действовавший на момент создания сделки.
   *
   * Именно **на момент создания**, а не сейчас: перечень прилипает к созданию
   * сделки, и выключение валюты действует только на новые сделки. Старая сделка
   * получает этот отказ тогда и только тогда, когда её валюты не было в перечне
   * уже в момент её создания.
   */
  currencyNotAdmittedAtDealCreation: 'limits.currency.not_admitted_at_deal_creation',

  /* --- Журнал аудита --- */
  /**
   * Роли, в которой владелец ввёл версию, нет соответствия в перечне ролей
   * журнала (`AUDIT_ROLES`).
   *
   * ⚠ Сегодня это **не крайний случай, а обычный путь**: `manage_settings` есть
   * ровно у `principal` (`packages/auth/src/roles.ts`), а `principal` в
   * `AUDIT_ROLES` не переезжает никуда — пробел назван поимённо в
   * `packages/auth/src/journal.ts` («изменение настройки владельцем сегодня
   * записать нечем») и в `ACTORS.md` §13. Отказ, а не подстановка похожей роли:
   * `principal`, записанный как `operator`, останется ложью в вечном журнале
   * (красная линия №11).
   */
  auditRoleUnrepresentable: 'limits.audit.role_unrepresentable',
  /**
   * Прежняя версия, поданная в запись, — не та, которую эта версия сменяет.
   * Запись утверждала бы не то, что говорит журнал версий, а восстанавливать
   * прошлое будут по ней.
   */
  auditPreviousVersionMismatch: 'limits.audit.previous_version_mismatch',
} as const;

export type LimitsRefusalKey = (typeof LIMITS_REFUSAL_KEYS)[keyof typeof LIMITS_REFUSAL_KEYS];
