import {
  type AuditActor,
  type AuditAmount,
  type AuditRef,
  type AuditSettingValue,
  type SettingChangedBody,
  auditActor,
  auditAmount,
  auditInstant,
  auditRef,
  auditToken,
  policyRef,
} from '@sdelka/audit';
import { auditRoleFor } from '@sdelka/auth';
import { type Result, failure, ok } from '@sdelka/domain';
import type { Money } from '@sdelka/money';
import { type SettingsVersion, settingsVersionDomain } from '@sdelka/settings';
import type { DealCurrencyList } from './currencies';
import { LIMITS_REFUSAL_KEYS, type LimitsRefusalKey } from './keys';
import type { AmountTolerance, MaterialityThreshold, QueueAgeBands } from './thresholds';

/**
 * Изменение настройки в журнале аудита (E16-12).
 *
 * Почему это вообще P0, а не обвязка: **настройка, поменянная без следа, — это
 * способ переписать историю денег** (`BACKLOG.md` E16-12). Запись строится
 * **из самой версии**, а не собирается рядом с ней: кто ввёл, в какой роли, на
 * каком основании, с какого момента действует и какую версию сменяет — всё это
 * уже поля `SettingsVersion`, и второго их источника здесь нет. Разойтись
 * «что записано в журнал» и «что лежит в журнале версий» нечему.
 *
 * ## Значение пишется целиком, а не дельтой
 *
 * `previous` и `next` несут перечень и порог **полностью**. Дельта («добавлен
 * USD») читается только вместе с состоянием, которое было до неё, а состояние
 * до неё восстанавливается пересчётом всей цепочки — то есть ровно тем, чего
 * запись должна избавлять. `SETTINGS.md` §4 п.1 требует «оба перечня до и
 * после», и это то же самое требование.
 *
 * ## Чего в записи нет
 *
 * Ссылки на документ-обоснование (`rationaleDocRef`): в теле записи разрешены
 * только строки формы `AUDIT_TOKEN` — без пробелов, без `#`, без кириллицы, — и
 * якорь вида `SETTINGS.md#в8-допуск` в него не проходит по построению. Основание
 * при этом в записи есть: `reasonKey` версии, ключ, а не свободный текст.
 */

/* ------------------------------------------------------------------------- */
/* Субъект                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Субъект записи — сама настройка, областью `setting`.
 *
 * Идентификатор равен домену версии (`deal_currencies`, `amount_tolerance`, …):
 * одно имя на журнал версий, на субъект записи и на левую часть идентификатора
 * версии. Цепочка это и проверяет — запись, поданная под чужим субъектом, в неё
 * не ложится (`packages/audit/src/chain.ts`, `settingSubjectMismatch`).
 */
export function settingSubject<T>(version: SettingsVersion<T>): AuditRef {
  return auditRef('setting', settingsVersionDomain(version.versionId));
}

/* ------------------------------------------------------------------------- */
/* Актор                                                                     */
/* ------------------------------------------------------------------------- */

const MANAGE_SETTINGS = 'manage_settings';

/**
 * Актор записи — тот, кто ввёл версию, в той роли, в которой ввёл.
 *
 * ⚠ **Сегодня это отказ на обычном пути, а не на крайнем случае.**
 * `manage_settings` есть ровно у `principal`, а `principal` в `AUDIT_ROLES` не
 * переезжает никуда: пробел назван поимённо в `packages/auth/src/journal.ts` и
 * в `ACTORS.md` §13, и закрывается он миграцией `sdelka.audit_role` вместе с
 * `packages/audit`, `packages/compliance` и `packages/db` — то есть не отсюда.
 *
 * Подставить похожую роль нельзя: `principal`, записанный как `operator`,
 * останется в вечном журнале ложью о том, кто двигал деньги (красная линия
 * №11). Поэтому здесь отказ, который вызывающий обязан разобрать, а не молчание
 * и не «ближайшая по смыслу» роль.
 */
function actorOf<T>(version: SettingsVersion<T>): Result<AuditActor, LimitsRefusalKey> {
  const role = auditRoleFor(version.introducedByRole);
  if (role === null) {
    return failure(LIMITS_REFUSAL_KEYS.auditRoleUnrepresentable);
  }
  return ok(auditActor(version.introducedBy.accountId, role, MANAGE_SETTINGS));
}

/* ------------------------------------------------------------------------- */
/* Тело записи                                                               */
/* ------------------------------------------------------------------------- */

export interface SettingChangeInput<T> {
  /** Версия, которая вводится. */
  readonly version: SettingsVersion<T>;
  /**
   * Версия, которую она сменяет; `null` — настройка вводится впервые.
   *
   * Обязательное и необнуляемое по умолчанию поле, как `supersedes` у самой
   * версии: «прежнего значения нет» и «прежнее значение не заполнили» — разные
   * вещи, и второе получается молчанием. В теле записи они разведены ветвями
   * `introduced` и `updated` (`packages/audit/src/values.ts`).
   */
  readonly previous: SettingsVersion<T> | null;
  /** Как величина выглядит в журнале. Канонизация — дело того, чья величина. */
  readonly render: (value: T) => AuditSettingValue;
}

/**
 * Тело записи `setting_changed` по версии настройки.
 *
 * Три отказа:
 *
 * 1. Роли нет соответствия в журнале — см. `actorOf`.
 * 2. Подана прежняя версия, которую эта не сменяет (`previous.versionId !==
 *    version.supersedes`): запись утверждала бы не то, что говорит журнал
 *    версий, а восстанавливать прошлое будут по ней.
 * 3. Первая версия подана с прежней (или наоборот). Тот же разрыв цепочки, что
 *    ловит журнал версий, — здесь он ловится второй раз, потому что тело записи
 *    собирается и из того, что пришло из хранилища.
 */
export function settingChangedBody<T>(
  input: SettingChangeInput<T>,
): Result<SettingChangedBody, LimitsRefusalKey> {
  const { version, previous } = input;
  const expected = version.supersedes;
  if (previous === null ? expected !== null : previous.versionId !== expected) {
    return failure(LIMITS_REFUSAL_KEYS.auditPreviousVersionMismatch);
  }
  const actor = actorOf(version);
  if (!actor.ok) return actor;

  const common = {
    kind: 'setting_changed' as const,
    setting: auditToken(settingsVersionDomain(version.versionId)),
    next: input.render(version.value),
    orderedBy: actor.value,
    reasonKey: version.reasonKey,
    policy: policyRef(version.versionId),
    effectiveFrom: auditInstant(version.effectiveFrom),
  };
  if (previous === null) {
    return ok(Object.freeze({ ...common, change: 'introduced' as const }));
  }
  return ok(
    Object.freeze({
      ...common,
      change: 'updated' as const,
      previous: input.render(previous.value),
    }),
  );
}

/* ------------------------------------------------------------------------- */
/* Как выглядят величины в журнале                                           */
/* ------------------------------------------------------------------------- */

function amounts(values: readonly Money[]): readonly AuditAmount[] {
  return values.map((item) => auditAmount(item.currency, item.minor));
}

/**
 * Перечень валют — массив кодов.
 *
 * Порядок канонизирован конструктором перечня (`dealCurrencyList` сортирует), и
 * это существенно: два одинаковых перечня, различающиеся порядком, дали бы в
 * журнале две разные записи об одном и том же состоянии.
 */
export function renderDealCurrencies(value: DealCurrencyList): AuditSettingValue {
  return Object.freeze([...value.codes]);
}

/** Допуск: доля целым и абсолют суммами — `bigint`, а не строкой (красная линия №4). */
export function renderAmountTolerance(value: AmountTolerance): AuditSettingValue {
  return Object.freeze({
    shareBp: value.shareBp,
    absolute: Object.freeze(amounts(value.absolute)),
  });
}

/** Границы очереди: миллисекунды целыми, валюта ранжирования кодом. */
export function renderQueueAgeBands(value: QueueAgeBands): AuditSettingValue {
  return Object.freeze({
    escalationAfterMs: Object.freeze([...value.escalationAfter].map((item) => item as number)),
    rankCurrency: value.rankCurrency,
  });
}

/** Порог значимости: норма суммой, доля предупреждения целым. */
export function renderMaterialityThreshold(value: MaterialityThreshold): AuditSettingValue {
  return Object.freeze({
    monthlyTurnover: auditAmount(
      value.monthlyTurnover.currency,
      value.monthlyTurnover.minor,
    ),
    warnAtBp: value.warnAtBp,
  });
}
