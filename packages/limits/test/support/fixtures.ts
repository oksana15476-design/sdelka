import { type ActorRef, type RoleId, accountId, actorRef, personId } from '@sdelka/auth';
import { type Instant, instant } from '@sdelka/domain';
import {
  type SettingsVersion,
  settingsReasonKey,
  settingsVersion,
  settingsVersionId,
} from '@sdelka/settings';

export const OWNER: ActorRef = actorRef(accountId('acc-principal'), personId('person-principal'));
/** Единственная роль с `manage_settings` (`packages/auth/src/roles.ts`). */
export const OWNER_ROLE: RoleId = 'principal';
export const REASON = settingsReasonKey('settings.reason.owner_decision');

export const T0 = instant(Date.UTC(2026, 8, 4, 9, 0, 0));

export function at(hours: number): Instant {
  return instant(T0 + hours * 60 * 60 * 1000);
}

export interface VersionSpec<T> {
  readonly id: string;
  readonly value: T;
  readonly recordedAt: Instant;
  readonly effectiveFrom: Instant;
  readonly supersedes: string | null;
}

/**
 * Версия настройки с уже проставленными автором, ролью и основанием.
 *
 * Их правила проверяет `@sdelka/settings`; повторять там же проверенное здесь
 * значило бы завести второе место, где они якобы проверяются.
 */
export function version<T>(spec: VersionSpec<T>): SettingsVersion<T> {
  return settingsVersion<T>({
    versionId: settingsVersionId(spec.id),
    value: spec.value,
    introducedBy: OWNER,
    introducedByRole: OWNER_ROLE,
    reasonKey: REASON,
    recordedAt: spec.recordedAt,
    effectiveFrom: spec.effectiveFrom,
    supersedes: spec.supersedes === null ? null : settingsVersionId(spec.supersedes),
  });
}
