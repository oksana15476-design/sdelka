import type { ActorRef, RoleId } from '@sdelka/auth';
import { roleHasCapability } from '@sdelka/auth';
import type { Instant } from '@sdelka/domain';
import { SettingsError, SettingsErrorCode } from './errors';
import type { SettingsReasonKey } from './keys';

/**
 * Общая форма настройки: **версия, а не поле** (`SETTINGS.md` §2).
 *
 * Форма одна на все величины и не зависит ни от одного ответа владельца из §10:
 * она одинакова при любом числе и при любом варианте кворума. Ни одной величины
 * в пакете нет намеренно — ни ставки, ни наценки, ни валют: значение живёт в
 * параметре `T` и приходит из пакета, которому эта величина принадлежит.
 */

/* ------------------------------------------------------------------------- */
/* Домен и идентификатор                                                     */
/* ------------------------------------------------------------------------- */

declare const domainKeyBrand: unique symbol;
declare const versionIdBrand: unique symbol;
declare const versionBrand: unique symbol;

/** Домен настройки — левая часть идентификатора. Перечень доменов задаёт не этот пакет. */
export type SettingsDomainKey = string & { readonly [domainKeyBrand]: 'settings_domain' };

/**
 * Идентификатор версии: `<домен>/<ГГГГ-ММ-ДД>.<n>`.
 *
 * Формат взят у уже существующих: `PolicyVersionId`
 * (`packages/compliance/src/decision.ts`), `IntakePolicyVersionId`
 * (`packages/intake/src/policy.ts`) и `PolicyRef` (`packages/audit`). Последний
 * принимает любой домен, поэтому значение отсюда ложится в журнал аудита без
 * преобразования.
 */
export type SettingsVersionId = string & { readonly [versionIdBrand]: 'settings_version_id' };

const DOMAIN_KEY = /^[a-z][a-z0-9_]*$/u;
const VERSION_ID = /^([a-z][a-z0-9_]*)\/(\d{4})-(\d{2})-(\d{2})\.([1-9]\d*)$/u;

export function settingsDomainKey(value: string): SettingsDomainKey {
  if (!DOMAIN_KEY.test(value)) {
    throw new SettingsError(SettingsErrorCode.domainKeyInvalid, { value });
  }
  return value as SettingsDomainKey;
}

interface ParsedVersionId {
  readonly domain: SettingsDomainKey;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly ordinal: number;
}

function parse(value: string): ParsedVersionId {
  const matched = VERSION_ID.exec(value);
  if (matched === null) {
    throw new SettingsError(SettingsErrorCode.versionIdInvalid, { value });
  }
  const [, domain, year, month, day, ordinal] = matched;
  if (
    domain === undefined ||
    year === undefined ||
    month === undefined ||
    day === undefined ||
    ordinal === undefined
  ) {
    // Недостижимо: пять групп обязательны в выражении. Проверка стоит ради типа
    // (`noUncheckedIndexedAccess`), а не вместо чтения выражения.
    throw new SettingsError(SettingsErrorCode.versionIdInvalid, { value });
  }
  const parsed = {
    domain: domain as SettingsDomainKey,
    year: Number(year),
    month: Number(month),
    day: Number(day),
    ordinal: Number(ordinal),
  };
  const asDate = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  const roundTrips =
    asDate.getUTCFullYear() === parsed.year &&
    asDate.getUTCMonth() === parsed.month - 1 &&
    asDate.getUTCDate() === parsed.day;
  if (!roundTrips) {
    throw new SettingsError(SettingsErrorCode.versionIdDateInvalid, { value });
  }
  return parsed;
}

export function settingsVersionId(value: string): SettingsVersionId {
  parse(value);
  return value as SettingsVersionId;
}

export function settingsVersionDomain(id: SettingsVersionId): SettingsDomainKey {
  return parse(id).domain;
}

/**
 * Сравнение идентификаторов: сначала дата, потом **числовой** порядковый.
 *
 * ⚠ `SETTINGS.md` §2 обещает, что версии «сортируются лексикографически». Это
 * неверно ровно с десятой версии за день: `…\.10` лексикографически меньше
 * `…\.2`. Порядковый разбирается числом, а не строкой, и ведущий ноль в нём
 * отвергнут формой (`[1-9]\d*`), иначе `.01` и `.1` были бы двумя ключами
 * одной версии — то самое двойное сохранение из §7.3.
 */
export function compareVersionIds(left: SettingsVersionId, right: SettingsVersionId): -1 | 0 | 1 {
  const a = parse(left);
  const b = parse(right);
  const byField: readonly (readonly [number, number])[] = [
    [a.year, b.year],
    [a.month, b.month],
    [a.day, b.day],
    [a.ordinal, b.ordinal],
  ];
  for (const [x, y] of byField) {
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/* ------------------------------------------------------------------------- */
/* Версия                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Версия значения настройки.
 *
 * Марка `versionBrand` — не украшение: собрать версию литералом нельзя, вход
 * ровно один — `settingsVersion`. Иначе запрет «задним числом» держался бы на
 * дисциплине вызывающего, а он и есть то, ради чего этот тип существует.
 *
 * Поля `recordedAt` и `effectiveFrom` разные намеренно (`SETTINGS.md` §2 Ф2.3):
 * ответ регулятора по сроку предуведомления меняет значение поля, а не код.
 */
export interface SettingsVersion<T> {
  readonly versionId: SettingsVersionId;
  /** Само значение. Пакет о нём не знает ничего — и не должен. */
  readonly value: T;
  /** Кто ввёл: учётная запись и человек за ней. */
  readonly introducedBy: ActorRef;
  /**
   * В какой роли. Хранится рядом с лицом, а не выводится при чтении: роль лица
   * меняется, а запись о том, кто и по какому праву двигал настройку, — нет.
   */
  readonly introducedByRole: RoleId;
  /** На каком основании — ключ, не текст (см. `SettingsReasonKey`). */
  readonly reasonKey: SettingsReasonKey;
  /** Момент записи. */
  readonly recordedAt: Instant;
  /** Момент, с которого версия действует. Никогда не раньше `recordedAt`. */
  readonly effectiveFrom: Instant;
  readonly [versionBrand]: 'settings_version';
}

export interface SettingsVersionInput<T> {
  readonly versionId: SettingsVersionId;
  readonly value: T;
  readonly introducedBy: ActorRef;
  readonly introducedByRole: RoleId;
  readonly reasonKey: SettingsReasonKey;
  readonly recordedAt: Instant;
  readonly effectiveFrom: Instant;
}

/**
 * Полномочие на изменение настроек. **[установлено]** заведено ровно одно и
 * выдано ровно одной роли (`packages/auth/src/capabilities.ts`,
 * `packages/auth/src/roles.ts`). Кто утверждает изменение вторым — вопрос
 * владельца §10 В0, и здесь его нет: утверждения лягут рядом с версией, когда
 * ответ появится, а подставлять кворум от своего имени нельзя.
 */
const MANAGE_SETTINGS = 'manage_settings';

/**
 * Единственный вход. Бросает — потому что каждый из трёх случаев означает не
 * отказ конкретной операции, а испорченную настройку:
 *
 * 1. **Задним числом.** `effectiveFrom < recordedAt` — версия, действовавшая
 *    раньше, чем она записана. Красная линия №11 запрещает править журнал, и
 *    ровно этот запрет здесь повторён вторым местом, чтобы он не держался на
 *    журнале аудита в одиночку. Следствие, на которое опирается `series.ts`:
 *    версия, действующая раньше **уже действующей**, невозможна по построению,
 *    а не запрещена правилом (`SETTINGS.md` §9 п.2).
 * 2. **Роль без полномочия.** Настройку двигает тот, кому это дано.
 * 3. Форма идентификатора и ключа основания — их конструкторами.
 */
export function settingsVersion<T>(input: SettingsVersionInput<T>): SettingsVersion<T> {
  if (!roleHasCapability(input.introducedByRole, MANAGE_SETTINGS)) {
    throw new SettingsError(SettingsErrorCode.capabilityNotGranted, {
      roleId: input.introducedByRole,
      capability: MANAGE_SETTINGS,
    });
  }
  if (input.effectiveFrom < input.recordedAt) {
    throw new SettingsError(SettingsErrorCode.versionBackdated, {
      versionId: input.versionId,
      recordedAt: String(input.recordedAt),
      effectiveFrom: String(input.effectiveFrom),
    });
  }
  return Object.freeze({
    versionId: input.versionId,
    value: input.value,
    introducedBy: input.introducedBy,
    introducedByRole: input.introducedByRole,
    reasonKey: input.reasonKey,
    recordedAt: input.recordedAt,
    effectiveFrom: input.effectiveFrom,
  }) as SettingsVersion<T>;
}
