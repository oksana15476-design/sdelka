import { type ActorRef, type RoleId, accountId, actorRef, personId } from '@sdelka/auth';
import { type Instant, instant } from '@sdelka/domain';
import {
  type SettingsVersion,
  settingsReasonKey,
  settingsVersion,
  settingsVersionId,
} from '../../src/index';

/**
 * Величины в фикстурах нет и здесь: значение — непрозрачная метка `Tier`,
 * по которой видно только «строже» и «недостижимо». Пакет о содержимом не знает
 * ничего, и тесты не должны знать больше него.
 */
export type Tier = 'soft' | 'strict' | 'unreachable';

export const OWNER: ActorRef = actorRef(accountId('acc-principal'), personId('person-principal'));
export const OWNER_ROLE: RoleId = 'principal';
/** Роль без `manage_settings` — оператор консоли. */
export const OPERATOR_ROLE: RoleId = 'operator';

export const REASON = settingsReasonKey('settings.reason.owner_decision');

export const T0 = instant(Date.UTC(2026, 8, 4, 9, 0, 0));

export function at(hours: number): Instant {
  return instant(T0 + hours * 60 * 60 * 1000);
}

export interface VersionSpec {
  readonly id: string;
  readonly value?: Tier;
  readonly recordedAt: Instant;
  readonly effectiveFrom: Instant;
  readonly role?: RoleId;
  /**
   * Ссылка на предыдущую версию. В фикстуре умолчания нет намеренно: `null`
   * пишется руками, иначе «первая в журнале» и «забыли сослаться» стали бы одним
   * и тем же и в тестах тоже.
   */
  readonly supersedes: string | null;
}

export function version(spec: VersionSpec): SettingsVersion<Tier> {
  return settingsVersion<Tier>({
    versionId: settingsVersionId(spec.id),
    value: spec.value ?? 'soft',
    introducedBy: OWNER,
    introducedByRole: spec.role ?? OWNER_ROLE,
    reasonKey: REASON,
    recordedAt: spec.recordedAt,
    effectiveFrom: spec.effectiveFrom,
    supersedes: spec.supersedes === null ? null : settingsVersionId(spec.supersedes),
  });
}

/** Звено цепочки без ссылки: её проставит `chain`. */
export type ChainSpec = Omit<VersionSpec, 'supersedes'>;

/**
 * Готовая цепочка версий: каждая ссылается на предыдущую, первая — ни на что.
 *
 * Нужна там, где проверяется **не** цепочка (разрешение, храповик), а журнал
 * обязан собраться. Сама ссылка проверяется отдельно и вручную —
 * `series.test.ts`, `version.test.ts`; здесь она не должна занимать место.
 */
export function chain(specs: readonly ChainSpec[]): readonly SettingsVersion<Tier>[] {
  return specs.map((spec, index) =>
    version({ ...spec, supersedes: index === 0 ? null : (specs[index - 1]?.id ?? null) }),
  );
}
