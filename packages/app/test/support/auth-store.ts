import {
  type AccountRecord,
  type AuthEvent,
  type AuthStore,
  type AuthTransaction,
  type ChallengeId,
  type CodeDeliveryPort,
  type CodeDeliveryRequest,
  type IdentityChallenge,
  type Session,
  type SessionId,
} from '@sdelka/auth';
import type { Instant } from '@sdelka/domain';

/**
 * Хранилище входа в памяти — **не мок, а вторая реализация порта**.
 *
 * Ожиданий, проверок вызовов и заданного поведения здесь нет ни одного: это
 * карта строк, ведущая себя как таблица. Именно поэтому «перезапуск процесса»
 * выражается честно — состояние живёт **снаружи** хранилища (`AuthTables`), и
 * второе хранилище над теми же таблицами это и есть поднявшийся заново процесс.
 *
 * Правила базы здесь повторены ровно те, на которых стоят проверки: счётчик
 * попыток идёт вперёд, принятый вызов не оживает, журнал только дополняется.
 * Повторять остальное незачем — это делает `packages/db` на живой базе
 * (`test/int/auth-store.int.test.ts`).
 */
export interface AuthTables {
  readonly accounts: Map<string, AccountRecord>;
  readonly challenges: Map<string, IdentityChallenge>;
  readonly delivered: Map<string, Instant>;
  readonly sessions: Map<string, Session>;
  readonly journal: AuthEvent[];
}

export function tables(accounts: readonly AccountRecord[] = []): AuthTables {
  return {
    accounts: new Map(accounts.map((account) => [account.accountId, account])),
    challenges: new Map(),
    delivered: new Map(),
    sessions: new Map(),
    journal: [],
  };
}

class ImmutableViolation extends Error {}

function transactionOf(data: AuthTables): AuthTransaction {
  return {
    accounts: {
      find: (accountKey: string): Promise<AccountRecord | null> =>
        Promise.resolve(data.accounts.get(accountKey) ?? null),
    },
    challenges: {
      load: (id: ChallengeId): Promise<IdentityChallenge | null> =>
        Promise.resolve(data.challenges.get(id) ?? null),
      save: (challenge: IdentityChallenge): Promise<void> => {
        const stored = data.challenges.get(challenge.challengeId);
        if (stored !== undefined) {
          if (stored.consumedAt !== null) {
            throw new ImmutableViolation('auth.identity.challenge_consumed');
          }
          if (challenge.attemptsUsed < stored.attemptsUsed) {
            throw new ImmutableViolation('db.auth.challenge_attempts_regression');
          }
          if (challenge.expiresAt !== stored.expiresAt || challenge.issuedAt !== stored.issuedAt) {
            throw new ImmutableViolation('db.auth.challenge_immutable');
          }
        }
        data.challenges.set(challenge.challengeId, challenge);
        return Promise.resolve();
      },
      markDelivered: (id: ChallengeId, at: Instant): Promise<void> => {
        if (!data.delivered.has(id)) data.delivered.set(id, at);
        return Promise.resolve();
      },
    },
    sessions: {
      load: (id: SessionId): Promise<Session | null> =>
        Promise.resolve(data.sessions.get(id) ?? null),
      save: (session: Session): Promise<void> => {
        const stored = data.sessions.get(session.sessionId);
        if (stored !== undefined && stored.revokedAt !== null) {
          throw new ImmutableViolation('db.auth.session_revived');
        }
        if (stored !== undefined && stored.expiresAt !== session.expiresAt) {
          throw new ImmutableViolation('db.auth.session_immutable');
        }
        data.sessions.set(session.sessionId, session);
        return Promise.resolve();
      },
      revokeAllForAccount: (account: string, at: Instant): Promise<number> => {
        let count = 0;
        for (const [id, session] of data.sessions) {
          if (session.accountId !== account || session.revokedAt !== null) continue;
          data.sessions.set(id, Object.freeze({ ...session, revokedAt: at }));
          count += 1;
        }
        return Promise.resolve(count);
      },
    },
    journal: {
      append: (event: AuthEvent): Promise<void> => {
        data.journal.push(event);
        return Promise.resolve();
      },
    },
  };
}

/**
 * Хранилище над таблицами. Транзакции здесь нет по-настоящему — карты не
 * откатываются, — и это названо: проверять откат на подделке значило бы
 * проверять подделку. Откат проверяется на живой базе.
 */
export function memoryAuthStore(data: AuthTables): AuthStore {
  return {
    transact: <T>(body: (tx: AuthTransaction) => Promise<T>): Promise<T> =>
      body(transactionOf(data)),
  };
}

export interface Channel {
  readonly port: CodeDeliveryPort;
  readonly sent: CodeDeliveryRequest[];
}

export function channel(failing = false): Channel {
  const sent: CodeDeliveryRequest[] = [];
  return {
    sent,
    port: {
      deliver: (request: CodeDeliveryRequest): Promise<void> => {
        if (failing) return Promise.reject(new Error('channel.down'));
        sent.push(request);
        return Promise.resolve();
      },
    },
  };
}
