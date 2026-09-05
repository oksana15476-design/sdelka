import type { Result } from '@sdelka/domain';
import { failure, ok } from '@sdelka/domain';
import type { Attachment } from './attachment';
import { SETTINGS_REFUSAL_KEYS, type SettingsRefusalKey } from './keys';
import {
  type SettingsDomainKey,
  type SettingsVersion,
  type SettingsVersionId,
  compareVersionIds,
  settingsDomainKey,
  settingsVersionDomain,
} from './version';

/**
 * Журнал версий одной величины.
 *
 * Не «текущее значение с историей рядом», а история, из которой действующее
 * значение **выводится** (`resolve.ts`). Порядок в журнале — порядок записи:
 * версии дописываются в конец и не редактируются (красная линия №11).
 *
 * `attachment` живёт на журнале, а не на версии: момент прилипания — свойство
 * величины, а не отдельного её значения. Версия не может прилипнуть к другому
 * событию, чем предыдущая, — иначе половина сделок жила бы по одной модели,
 * половина по другой.
 */
export interface SettingsSeries<T, A extends Attachment> {
  readonly domain: SettingsDomainKey;
  readonly attachment: A;
  /** По возрастанию `recordedAt`, `effectiveFrom` и идентификатора — все три сразу. */
  readonly versions: readonly SettingsVersion<T>[];
}

export function settingsSeries<T, A extends Attachment>(
  domain: string,
  attachment: A,
): SettingsSeries<T, A> {
  return Object.freeze({
    domain: settingsDomainKey(domain),
    attachment,
    versions: Object.freeze([] as readonly SettingsVersion<T>[]),
  });
}

export function findSettingsVersion<T, A extends Attachment>(
  series: SettingsSeries<T, A>,
  versionId: SettingsVersionId,
): SettingsVersion<T> | null {
  return series.versions.find((candidate) => candidate.versionId === versionId) ?? null;
}

/**
 * Дописать версию в журнал. Возвращает **новый** журнал: старый не меняется.
 *
 * Девять отказов, и каждый закрывает свой способ получить две правды о том,
 * что действовало:
 *
 * 1. Чужой домен.
 * 2. Идентификатор уже был. Повтор по двойному нажатию `SETTINGS.md` §7.3
 *    называет «той же версией», но узнать «та же» можно только сравнив
 *    значение, а значение здесь неизвестно по устройству пакета (величин нет).
 *    Поэтому повтор — отказ с названной причиной, а не молчаливое согласие;
 *    вызывающий проверяет `findSettingsVersion` до записи. **[открыто]**:
 *    детерминированный ключ по содержимому потребует канонизации значения —
 *    она появится вместе с первой величиной.
 * 3. Идентификатор не возрастает: журнал перестал бы сортироваться собственным
 *    ключом, а на нём держится восстановление «что действовало 14 марта».
 * 4. Момент записи раньше предыдущего.
 * 5. Момент вступления в силу совпал с предыдущим (§7.3, двойное сохранение).
 * 6. Момент вступления в силу раньше предыдущего. Предыдущая версия при этом
 *    заведомо **отложенная**: версия, действующая раньше уже действующей,
 *    невозможна по построению — она была бы задним числом, а такую не соберёт
 *    `settingsVersion` (см. запрет там же). Отказ здесь строже спеки: §7.3
 *    считает правку отложенного изменения законной, но не отвечает, какая из
 *    двух действует после наступления более поздней — Ф2.1 («наибольший
 *    `effectiveFrom` из наступивших») и §7.3 («действовать будет вторая»)
 *    расходятся ровно в этом случае. **Цена строгости названа вслух:** пока
 *    владелец не ответил, отложенное изменение нельзя ускорить — его можно
 *    только отодвинуть; отмена отложенного (§4 п.3) остаётся отдельным
 *    механизмом и в этом пакете не выражена. **[открыто]**
 * 7. Первая версия сослалась на предыдущую: журнал пуст, ссылаться не на что.
 * 8. Версия легла в непустой журнал без ссылки — разрыв цепочки.
 * 9. Ссылка ведёт не на последнюю запись журнала. `SETTINGS.md` §2 называет
 *    `supersedes` «предыдущей действующей», а §9 п.5 требует лишь
 *    «существующую версию того же домена» — два разных правила, и расходятся
 *    они ровно тогда, когда в журнале лежит **отложенная** версия: последняя
 *    запись и действующая в этот момент — разные. Взят строжайший выразимый
 *    вариант: ссылка на **последнюю запись**, то есть цепочка без ветвлений и
 *    без дыр. **Цена строгости:** сослаться «через голову» отложенной версии на
 *    действующую нельзя, даже если владелец имел в виду именно её. **[открыто]**
 *    — какое из двух прочтений верно, решает владелец; проверка «версия
 *    существует» слабее и её одной для восстановления прошлого не хватает.
 */
export function appendSettingsVersion<T, A extends Attachment>(
  series: SettingsSeries<T, A>,
  version: SettingsVersion<T>,
): Result<SettingsSeries<T, A>, SettingsRefusalKey> {
  if (settingsVersionDomain(version.versionId) !== series.domain) {
    return failure(SETTINGS_REFUSAL_KEYS.versionDomainMismatch);
  }
  const last = series.versions.at(-1);
  if (last === undefined) {
    if (version.supersedes !== null) {
      return failure(SETTINGS_REFUSAL_KEYS.versionSupersedesUnexpected);
    }
  } else {
    // Порядок проверок не произволен: тождество версии разбирается до цепочки.
    // Повтор по двойному нажатию (§7.3) обязан назваться повтором, а не разрывом
    // ссылки, — иначе на экране владельца двойное сохранение выглядит поломкой
    // журнала.
    if (findSettingsVersion(series, version.versionId) !== null) {
      return failure(SETTINGS_REFUSAL_KEYS.versionIdReused);
    }
    if (compareVersionIds(version.versionId, last.versionId) !== 1) {
      return failure(SETTINGS_REFUSAL_KEYS.versionIdOutOfOrder);
    }
    if (version.recordedAt < last.recordedAt) {
      return failure(SETTINGS_REFUSAL_KEYS.versionRecordedOutOfOrder);
    }
    if (version.effectiveFrom === last.effectiveFrom) {
      return failure(SETTINGS_REFUSAL_KEYS.versionEffectiveMomentCollides);
    }
    if (version.effectiveFrom < last.effectiveFrom) {
      return failure(SETTINGS_REFUSAL_KEYS.versionEffectiveBeforeDeferred);
    }
    if (version.supersedes === null) {
      return failure(SETTINGS_REFUSAL_KEYS.versionSupersedesMissing);
    }
    if (version.supersedes !== last.versionId) {
      return failure(SETTINGS_REFUSAL_KEYS.versionSupersedesNotPrevious);
    }
  }
  return ok(
    Object.freeze({
      domain: series.domain,
      attachment: series.attachment,
      versions: Object.freeze([...series.versions, version]),
    }),
  );
}

/**
 * Журнал, поднятый из хранилища.
 *
 * Не «доверенный список», а тот же журнал, собранный теми же шестью правилами:
 * типы не переживают границу процесса, и порядок, гарантированный записью,
 * из базы приходит утверждением, а не фактом
 * (`packages/auth/src/approval.ts` — о том же).
 */
export function settingsSeriesFromStore<T, A extends Attachment>(
  domain: string,
  attachment: A,
  versions: readonly SettingsVersion<T>[],
): Result<SettingsSeries<T, A>, SettingsRefusalKey> {
  let built = settingsSeries<T, A>(domain, attachment);
  for (const version of versions) {
    const appended = appendSettingsVersion(built, version);
    if (!appended.ok) return appended;
    built = appended.value;
  }
  return ok(built);
}
