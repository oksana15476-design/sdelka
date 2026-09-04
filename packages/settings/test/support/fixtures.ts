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
  });
}
