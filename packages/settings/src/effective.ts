import type { Instant, Result } from '@sdelka/domain';
import { failure, ok } from '@sdelka/domain';
import { SETTINGS_REFUSAL_KEYS, type SettingsRefusalKey } from './keys';
import type { SettingsVersion } from './version';

/**
 * Резолвер действующей версии. **Внутренний**: наружу его нет.
 *
 * Причина не в чистоте слоёв, а в третьем требовании спеки: момент, на который
 * спрашивают, обязан быть назван. Функция, принимающая голый `Instant`, — это
 * ровно та дверь, через которую «на сейчас» попадает туда, где положено «на
 * момент прилипания». Публичные входы (`resolve.ts`, `ratchet.ts`) требуют
 * момент, который сам себя называет; из `index.ts` этот модуль не выведен.
 *
 * Правило одно и то же на все величины — Ф2.1 `SETTINGS.md` §2: действует
 * версия с наибольшим `effectiveFrom ≤ момент`. Та же конструкция, что у
 * наблюдений курса (`FX.md` §1 Р4), а не вторая её редакция.
 */
export function effectiveVersionAt<T>(
  versions: readonly SettingsVersion<T>[],
  at: Instant,
): Result<SettingsVersion<T> | null, SettingsRefusalKey> {
  let chosen: SettingsVersion<T> | null = null;
  let ambiguous = false;
  for (const candidate of versions) {
    // Момент раньше версии — версии ещё нет. Ни «первой попавшейся», ни
    // умолчания: «действующей версии нет» — это ответ, а не пустое место.
    if (candidate.effectiveFrom > at) continue;
    if (chosen === null || candidate.effectiveFrom > chosen.effectiveFrom) {
      chosen = candidate;
      ambiguous = false;
      continue;
    }
    const sameMoment = candidate.effectiveFrom === chosen.effectiveFrom;
    if (sameMoment && candidate.versionId !== chosen.versionId) {
      // Две версии на один момент. Выбрать по идентификатору можно, но это
      // выбор молча: журнал не сказал, какая из двух действует, и подставлять
      // ответ за него значит решать за владельца.
      ambiguous = true;
    }
  }
  if (ambiguous) {
    return failure(SETTINGS_REFUSAL_KEYS.effectiveMomentAmbiguous);
  }
  return ok(chosen);
}
