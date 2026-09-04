import { type DurationMs, type Instant, duration, instant } from '@sdelka/domain';
import {
  type ActorRef,
  type PrimaryAuthentication,
  type RoleId,
  type RoleSession,
  type SecondFactorAssertion,
  type SecondFactorKind,
  type Session,
  accountId,
  actorRef,
  challengeId,
  personId,
  sessionId,
} from '../src/index';

export const NOW: Instant = instant(Date.UTC(2026, 8, 4, 12, 0, 0));

export function at(offsetMs: number): Instant {
  return instant(NOW + offsetMs);
}

export const MINUTE: DurationMs = duration(60 * 1000);

export function actor(name: string, person: string = name): ActorRef {
  return actorRef(accountId(name), personId(person));
}

export function factor(
  kind: SecondFactorKind = 'webauthn',
  verifiedAt: Instant = NOW,
): SecondFactorAssertion {
  return { kind, challengeId: challengeId('ch-1'), verifiedAt, device: null };
}

const PRIMARY: PrimaryAuthentication = {
  method: 'passkey',
  at: NOW,
  device: null,
  network: null,
};

export interface SessionOverrides {
  readonly onDuty?: boolean;
  readonly factors?: readonly SecondFactorAssertion[];
  readonly issuedAt?: Instant;
  readonly lastSeenAt?: Instant;
  readonly expiresAt?: Instant;
  readonly revokedAt?: Instant | null;
  readonly primary?: PrimaryAuthentication;
  readonly person?: string;
}

/** Готовая живая сессия. Тесты, которым важна выдача, зовут `establishSession`. */
export function sessionFor<R extends RoleId>(
  roleId: R,
  account: string,
  overrides: SessionOverrides = {},
): RoleSession<R> {
  const base: Session = {
    sessionId: sessionId(`s-${account}`),
    accountId: accountId(account),
    personId: personId(overrides.person ?? account),
    roleId,
    onDuty: overrides.onDuty ?? false,
    primary: overrides.primary ?? PRIMARY,
    factors: overrides.factors ?? [factor()],
    issuedAt: overrides.issuedAt ?? NOW,
    expiresAt: overrides.expiresAt ?? at(4 * 60 * 60 * 1000),
    lastSeenAt: overrides.lastSeenAt ?? NOW,
    revokedAt: overrides.revokedAt ?? null,
  };
  return base as RoleSession<R>;
}
