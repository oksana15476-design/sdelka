import type { Result } from '@sdelka/domain';
import { failure, ok } from '@sdelka/domain';
import {
  NOT_STICKY,
  type NotSticky,
  type ObservationMoment,
  type StickingMoment,
  type StickingPoint,
} from './attachment';
import { effectiveVersionAt } from './effective';
import {
  SETTINGS_OUTCOME_KEYS,
  SETTINGS_REFUSAL_KEYS,
  type SettingsOutcomeKey,
  type SettingsRefusalKey,
} from './keys';
import type { SettingsSeries } from './series';
import type { SettingsVersion } from './version';

/**
 * Какой стратегией получен ответ. Стратегия названа в самом ответе, а не
 * известна из места вызова: «эта сумма посчитана по версии транша» и «эта сумма
 * посчитана по текущей версии» — разные утверждения, и через два года их
 * различает только запись.
 */
export const RESOLUTION_STRATEGIES = ['sticky', 'immediate', 'tightening_ratchet'] as const;
export type ResolutionStrategyKey = (typeof RESOLUTION_STRATEGIES)[number];

export interface SettingsResolution<T> {
  readonly strategy: ResolutionStrategyKey;
  /** `null` — действующей версии нет. Почему именно нет, сказано в `reasonKey`. */
  readonly applied: SettingsVersion<T> | null;
  readonly reasonKey: SettingsOutcomeKey;
}

function resolution<T>(
  strategy: ResolutionStrategyKey,
  applied: SettingsVersion<T> | null,
  reasonKey: SettingsOutcomeKey,
): SettingsResolution<T> {
  return Object.freeze({ strategy, applied, reasonKey });
}

/**
 * Версия, действовавшая **в момент прилипания величины**.
 *
 * `NoInfer` в типе момента — вся суть: параметр `P` выводится только из
 * журнала, поэтому момент чужого события (котировка там, где положен транш) не
 * соберётся. Рантайм-проверка стоит вторым рубежом по той же причине, по
 * которой она стоит у полномочий: журнал приходит из хранилища вместе со своим
 * `attachment`, и типы этой границы не переживают.
 */
export function versionInEffect<T, P extends StickingPoint>(
  series: SettingsSeries<T, P>,
  moment: StickingMoment<NoInfer<P>>,
): Result<SettingsResolution<T>, SettingsRefusalKey> {
  if (moment.point !== series.attachment) {
    return failure(SETTINGS_REFUSAL_KEYS.attachmentMismatch);
  }
  const found = effectiveVersionAt(series.versions, moment.at);
  if (!found.ok) return found;
  return ok(
    found.value === null
      ? resolution<T>('sticky', null, SETTINGS_OUTCOME_KEYS.noVersionInEffect)
      : resolution('sticky', found.value, SETTINGS_OUTCOME_KEYS.stickyVersionApplied),
  );
}

/**
 * Версия, действующая **сейчас**, — для величин, которые не прилипают вовсе
 * (`SETTINGS.md` §В6, §В7: окна наблюдения; §8, строки «не прилипает»).
 *
 * Величину с моментом прилипания сюда не передать: журнал объявляет
 * `NOT_STICKY`, и компилятор отказывает. Это и есть требование «спросить версию
 * „на сейчас“ там, где положено „на момент прилипания“, невозможно», выраженное
 * типом, а не соглашением.
 */
export function versionInEffectNow<T>(
  series: SettingsSeries<T, NotSticky>,
  now: ObservationMoment,
): Result<SettingsResolution<T>, SettingsRefusalKey> {
  if (series.attachment !== NOT_STICKY) {
    return failure(SETTINGS_REFUSAL_KEYS.attachmentMismatch);
  }
  const found = effectiveVersionAt(series.versions, now.at);
  if (!found.ok) return found;
  return ok(
    found.value === null
      ? resolution<T>('immediate', null, SETTINGS_OUTCOME_KEYS.noVersionInEffect)
      : resolution('immediate', found.value, SETTINGS_OUTCOME_KEYS.immediateVersionApplied),
  );
}
