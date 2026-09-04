import type { Instant, Result } from '@sdelka/domain';
import { failure, ok } from '@sdelka/domain';
import type { StickingMoment, StickingPoint } from './attachment';
import { effectiveVersionAt } from './effective';
import { SettingsError, SettingsErrorCode } from './errors';
import {
  SETTINGS_OUTCOME_KEYS,
  SETTINGS_REFUSAL_KEYS,
  type SettingsOutcomeKey,
  type SettingsRefusalKey,
} from './keys';
import type { SettingsResolution } from './resolve';
import type { SettingsSeries } from './series';
import type { SettingsVersion } from './version';

/**
 * ⚠ **ХРАПОВИК — ИСКЛЮЧЕНИЕ ИЗ ПРИЛИПАНИЯ, И ЕДИНСТВЕННОЕ.**
 *
 * Отдельный модуль и отдельная стратегия, а не ветка внутри резолвера, — по
 * причине, которая важнее опрятности: ветка в общем резолвере означала бы, что
 * исключение может достаться любой величине незаметно. Здесь его нельзя
 * получить случайно — храповик требует того, чего у обычного разрешения нет
 * вовсе: **порядка строгости значений** и ссылки на документ, объясняющей,
 * почему у этой величины исключение есть.
 *
 * Почему исключение вообще есть (`SETTINGS.md` §В4, §7.1). Пороги утверждения —
 * не цена и не обещание стороне, а контрольная мера. Чистое прилипание даёт
 * странность: ужесточение, принятое из-за инцидента, не действует ни на одну
 * живую сделку — то есть ровно на те, из-за которых принято. Обратное — «всегда
 * текущая версия» — означает, что **смягчение** действует задним числом: сделка,
 * заведённая под две подписи, выплачивается по одной. Это ослабление контроля
 * над чужими деньгами нашей же настройкой.
 *
 * Храповик пропускает только ужесточение: **ни одна выплата не становится
 * легче**. Оговорка, без которой он опасен, — ниже, у `isUnreachable`.
 *
 * Что здесь **не** решено: применять ли храповик к порогам утверждения — вопрос
 * владельца §10 В4.1, и ответа на него в коде нет. Пакет даёт стратегию;
 * какая величина ею разрешается, решает владелец, а подключает следующий батч.
 */

/**
 * Порядок строгости значений величины.
 *
 * Пакет о величинах не знает ничего, поэтому «строже» приносит с собой тот, чья
 * это величина. Ссылка на документ обязательна той же логикой, по которой
 * обязательна у порога детектора (`JustifiedThreshold`,
 * `packages/compliance/src/policy.ts`): исключение без письменного основания —
 * находка на аудите, а не настройка.
 */
export interface StrictnessOrder<T> {
  /**
   * Где объяснено, почему у этой величины есть храповик. Не текст для клиента —
   * ссылка на документ проекта.
   */
  readonly docRef: string;
  /**
   * `1` — левое строже правого, `-1` — мягче, `0` — равны по строгости.
   * Сравниваются **значения**, а не версии: версия старше — не значит строже.
   */
  compareStrictness(left: T, right: T): -1 | 0 | 1;
  /**
   * Делает ли значение действие **недостижимым** вовсе.
   *
   * Это не «очень строго», а «нельзя никак»: `null` в ступени утверждения
   * означает «утверждений не набрать» (`packages/domain/src/guards.ts`).
   * Применить такое к живому траншу, где деньги уже заперты, значит сделать
   * выплату невозможной при живом обязательстве — а состоянием по умолчанию при
   * бездействии является возврат покупателю (красная линия №7). Понижение
   * потолка закрывает вход, а не запирает выход.
   *
   * Величина, у которой недостижимого значения не бывает, отвечает `false`
   * всегда — и отвечает явно: молчания здесь нет.
   */
  isUnreachable(value: T): boolean;
}

export function strictnessOrder<T>(order: StrictnessOrder<T>): StrictnessOrder<T> {
  if (order.docRef.trim() === '') {
    throw new SettingsError(SettingsErrorCode.strictnessOrderUnjustified);
  }
  return Object.freeze({
    docRef: order.docRef,
    compareStrictness: order.compareStrictness,
    isUnreachable: order.isUnreachable,
  });
}

/**
 * Момент «сейчас» для храповика — со своим типом.
 *
 * Не `ObservationMoment`: тот принадлежит величинам, которые не прилипают, и
 * значит «версии на сейчас» законно. Здесь величина прилипает, и вопрос «а что
 * сейчас» — это и есть исключение. Отдельный конструктор нужен, чтобы
 * исключение нельзя было сделать, не назвав его по имени.
 */
export interface TighteningMoment {
  readonly point: 'tightening_ratchet_now';
  readonly at: Instant;
}

export function tighteningMoment(at: Instant): TighteningMoment {
  return Object.freeze({ point: 'tightening_ratchet_now' as const, at });
}

function resolution<T>(
  applied: SettingsVersion<T> | null,
  reasonKey: SettingsOutcomeKey,
): SettingsResolution<T> {
  return Object.freeze({ strategy: 'tightening_ratchet' as const, applied, reasonKey });
}

/**
 * Действующая версия по храповику: строжайшее из прилипшей и текущей.
 *
 * Разбор по случаям, каждый со своим ключом исхода — потому что «применена
 * текущая» и «текущая была мягче и не применена» обязаны различаться в очереди
 * утверждения, иначе изменение выглядит отказом без причины (`SETTINGS.md`
 * §В4 критерии приёмки).
 */
export function resolveWithTighteningRatchet<T, P extends StickingPoint>(
  series: SettingsSeries<T, P>,
  stuckAt: StickingMoment<NoInfer<P>>,
  now: TighteningMoment,
  order: StrictnessOrder<T>,
): Result<SettingsResolution<T>, SettingsRefusalKey> {
  if (stuckAt.point !== series.attachment) {
    return failure(SETTINGS_REFUSAL_KEYS.attachmentMismatch);
  }
  if (now.at < stuckAt.at) {
    // «Сейчас» раньше прилипания — это не порядок событий, а ошибка вызова:
    // храповик сравнил бы будущее с прошлым и назвал бы результат ужесточением.
    return failure(SETTINGS_REFUSAL_KEYS.momentsOutOfOrder);
  }
  const stuck = effectiveVersionAt(series.versions, stuckAt.at);
  if (!stuck.ok) return stuck;
  const current = effectiveVersionAt(series.versions, now.at);
  if (!current.ok) return current;

  if (stuck.value === null) {
    // В момент прилипания версии не было. Единственный кандидат — текущая:
    // «ничего» контрольной мерой не является.
    return ok(resolution(current.value, SETTINGS_OUTCOME_KEYS.ratchetNoStuckVersion));
  }
  if (current.value === null) {
    return ok(resolution(stuck.value, SETTINGS_OUTCOME_KEYS.ratchetNoCurrentVersion));
  }
  if (current.value.versionId === stuck.value.versionId) {
    return ok(resolution(stuck.value, SETTINGS_OUTCOME_KEYS.ratchetUnchanged));
  }
  if (order.isUnreachable(current.value.value) && !order.isUnreachable(stuck.value.value)) {
    return ok(resolution(stuck.value, SETTINGS_OUTCOME_KEYS.ratchetUnreachableNotApplied));
  }
  if (order.compareStrictness(current.value.value, stuck.value.value) === 1) {
    return ok(resolution(current.value, SETTINGS_OUTCOME_KEYS.ratchetTightened));
  }
  return ok(resolution(stuck.value, SETTINGS_OUTCOME_KEYS.ratchetSofteningNotApplied));
}
