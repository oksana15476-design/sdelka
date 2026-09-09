import {
  type IdentityChallenge,
  type Session,
  AUTH_REASON_KEYS,
  accountId,
  challengeId,
  issueChallenge,
  personId,
  revoke,
  sessionDenied,
  sessionEstablished,
  sessionId,
  sessionRevoked,
  sessionStatus,
} from '@sdelka/auth';
import { type Instant, instant } from '@sdelka/domain';
import { expect, it } from 'vitest';
import { DbError, DbErrorCode } from '../../src/errors.ts';
import type { PoolClient } from '../../src/pool.ts';
import { pgAuthTransaction } from '../../src/store/auth.ts';
import { dbSuite, errorKey, sqlState, withRollback } from './support/pg.ts';

/**
 * Хранилище входа на живой базе — `0010` плюс `0024`.
 *
 * Проверяется не «функция вернула значение», а то, ради чего адаптер написан:
 * **сессия и вызов личности лежат в базе, а не в памяти процесса**. Значение,
 * поднятое обратно, сверяется полем в поле — сессия, потерявшая срок или
 * подтверждение фактора при разборе строки, выглядит рабочей ровно до первого
 * решения о полномочии.
 *
 * ⚠ **Границу коммита набор не переходит, и это названо.** Каждый случай идёт в
 * транзакции, которая всегда откатывается (`withRollback`): журнал входов
 * дополняется и не чистится ни грантами, ни триггером (`0010`), поэтому
 * записавший тест оставил бы след навсегда. Что данные переживают **сам
 * процесс**, показывает `packages/app` (`test/sign-in.test.ts`, «сессия
 * переживает перезапуск»): там состояние живёт снаружи хранилища, и второе
 * хранилище над теми же таблицами видит ту же сессию. Здесь показывается
 * другое и не менее нужное: значение уходит на сервер и возвращается оттуда
 * целым — запрос идёт в Postgres, а не в карту в памяти.
 */
const suite = await dbSuite('вход: учётная запись, вызов, сессия, журнал');

const NOW: Instant = instant(Date.UTC(2026, 8, 9, 10, 0, 0));

function at(offsetMs: number): Instant {
  return instant(NOW + offsetMs);
}

const ACCOUNT = accountId('acc-int-party');
const PERSON = personId('per-int-party');
const DEVICE = 'b'.repeat(64);

async function seedAccount(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO sdelka.auth_account (account_id, person_id, role_id, role_assigned_at)
     VALUES ($1, $2, 'party', $3)`,
    [ACCOUNT, PERSON, new Date(NOW - 60_000).toISOString()],
  );
}

/**
 * Шаг идёт от имени роли приложения, а не владельца схемы.
 *
 * Инвариант 21 держится грантами, а гранты действуют на роль: адаптер,
 * проверенный от имени владельца, не доказывает ничего — владелец обходит
 * гранты целиком.
 */
async function asApp(client: PoolClient): Promise<void> {
  await client.query('SET LOCAL ROLE sdelka_app');
}

function freshChallenge(): IdentityChallenge {
  return issueChallenge({
    challengeId: challengeId('ch-int-1'),
    accountId: ACCOUNT,
    issuedAt: NOW,
  });
}

function freshSession(): Session {
  return Object.freeze({
    sessionId: sessionId('s-int-1'),
    accountId: ACCOUNT,
    personId: PERSON,
    roleId: 'party' as const,
    onDuty: false,
    primary: Object.freeze({
      method: 'magic_link' as const,
      at: NOW,
      device: DEVICE as never,
      network: null,
    }),
    factors: Object.freeze([]),
    issuedAt: NOW,
    expiresAt: at(24 * 60 * 60 * 1000),
    lastSeenAt: NOW,
    revokedAt: null,
  });
}

/**
 * Запрещённая попытка внутри точки сохранения.
 *
 * Без неё вторая попытка подряд не проверяет ничего: первая ошибка обрывает
 * транзакцию целиком, и следующий запрос падает с «current transaction is
 * aborted» — то есть с ошибкой, к запрету отношения не имеющей. Тест, принявший
 * её за отказ, остался бы зелёным, даже если бы запрета не было вовсе.
 */
async function refused(client: PoolClient, sql: string): Promise<unknown> {
  await client.query('SAVEPOINT forbidden');
  try {
    await client.query(sql);
    throw new Error(`ожидался отказ, а запрос прошёл: ${sql}`);
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT forbidden');
    return error;
  }
}

suite.run(suite.title, () => {
  const pool = suite.pool;
  if (pool === null) return;

  it('учётная запись находится по ключу, а неизвестный ключ даёт null', async () => {
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const tx = pgAuthTransaction(client);
      const found = await tx.accounts.find(ACCOUNT);
      expect(found).toEqual({ accountId: ACCOUNT, personId: PERSON, roleId: 'party' });
      expect(await tx.accounts.find('acc-not-here')).toBeNull();
      // Строка неверной формы — тот же ответ, а не исключение: иначе «неверная
      // форма» отличалась бы от «нет такой записи» и на экране, и по времени.
      expect(await tx.accounts.find('это не ключ')).toBeNull();
    });
  });

  it('вызов личности кладётся и поднимается целым — и кода в нём нет', async () => {
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const tx = pgAuthTransaction(client);
      const challenge = freshChallenge();
      await tx.challenges.save(challenge);
      const loaded = await tx.challenges.load(challenge.challengeId);
      expect(loaded).toEqual(challenge);

      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'sdelka' AND table_name = 'identity_challenge'`,
      );
      const names = columns.rows.map((row) => row.column_name).sort();
      // Красная линия №12 в применении к схеме: колонки под код нет ни под
      // каким именем — ни открытой, ни «хешированной».
      expect(names).toEqual([
        'account_id',
        'attempts_used',
        'challenge_id',
        'consumed_at',
        'delivered_at',
        'expires_at',
        'issued_at',
        'max_attempts',
      ]);
    });
  });

  it('самый свежий вызов записи поднимается в любом состоянии, а чужой — не поднимается', async () => {
    // По нему считается ограничение потока запросов «пришлите код»
    // (`auth/src/code-request.ts`): живой возвращается тому, кто попросил
    // повторно, а закрытый нужен ради своей отметки об отправке.
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const tx = pgAuthTransaction(client);
      expect(await tx.challenges.latestFor(ACCOUNT)).toBeNull();

      const first = freshChallenge();
      await tx.challenges.save(first);
      expect((await tx.challenges.latestFor(ACCOUNT))?.challengeId).toBe(first.challengeId);

      // Закрытый вызов остаётся самым свежим, пока не выдан следующий: иначе
      // пять неверных ответов открывали бы канал заново.
      await tx.challenges.save(Object.freeze({ ...first, attemptsUsed: 1, consumedAt: at(1000) }));
      expect((await tx.challenges.latestFor(ACCOUNT))?.consumedAt).toBe(at(1000));

      const second = issueChallenge({
        challengeId: challengeId('ch-int-2'),
        accountId: ACCOUNT,
        issuedAt: at(60_000),
      });
      await tx.challenges.save(second);
      expect((await tx.challenges.latestFor(ACCOUNT))?.challengeId).toBe(second.challengeId);

      // Чужая запись своего вызова не получает ни при каком состоянии нашего.
      expect(await tx.challenges.latestFor(accountId('acc-int-someone-else'))).toBeNull();
    });
  });

  it('отметка об отправке двигается вперёд — окно считается от последней отправки', async () => {
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const tx = pgAuthTransaction(client);
      const challenge = freshChallenge();
      await tx.challenges.save(challenge);
      expect((await tx.challenges.load(challenge.challengeId))?.deliveredAt).toBeNull();

      await tx.challenges.markDelivered(challenge.challengeId, NOW);
      expect((await tx.challenges.load(challenge.challengeId))?.deliveredAt).toBe(NOW);

      // Повторная отправка того же кода двигает отметку. Неподвижная сделала бы
      // окно повторной отправки бесконечным (`0025`).
      await tx.challenges.markDelivered(challenge.challengeId, at(60_000));
      expect((await tx.challenges.load(challenge.challengeId))?.deliveredAt).toBe(at(60_000));

      // Назад отметка не идёт: это была бы ложь о том, когда человеку
      // сообщили, — и заодно способ открыть окно чужими часами. Адаптер это
      // не пишет вовсе, поэтому строка просто не меняется.
      await tx.challenges.markDelivered(challenge.challengeId, at(30_000));
      expect((await tx.challenges.load(challenge.challengeId))?.deliveredAt).toBe(at(60_000));
    });
  });

  it('отметку об отправке не стереть и не отмотать даже напрямую', async () => {
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const tx = pgAuthTransaction(client);
      const challenge = freshChallenge();
      await tx.challenges.save(challenge);
      await tx.challenges.markDelivered(challenge.challengeId, at(60_000));

      for (const value of ['NULL', `'${new Date(NOW).toISOString()}'`]) {
        const error = await refused(
          client,
          `UPDATE sdelka.identity_challenge SET delivered_at = ${value}
            WHERE challenge_id = '${challenge.challengeId}'`,
        );
        expect(errorKey(error)).toBe(DbErrorCode.authChallengeImmutable);
      }
    });
  });

  it('счётчик попыток идёт вперёд, и назад его не сдвинуть даже напрямую', async () => {
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const tx = pgAuthTransaction(client);
      const challenge = freshChallenge();
      await tx.challenges.save(challenge);
      const attempted = Object.freeze({ ...challenge, attemptsUsed: 1 });
      await tx.challenges.save(attempted);
      expect((await tx.challenges.load(challenge.challengeId))?.attemptsUsed).toBe(1);

      await expect(
        client.query(
          `UPDATE sdelka.identity_challenge SET attempts_used = 0 WHERE challenge_id = $1`,
          [challenge.challengeId],
        ),
      ).rejects.toSatisfy(
        (error: unknown) => errorKey(error) === DbErrorCode.authChallengeAttemptsRegression,
      );
    });
  });

  it('принятый вызов не оживает: второй ответ на тот же код не проходит', async () => {
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const tx = pgAuthTransaction(client);
      const challenge = freshChallenge();
      await tx.challenges.save(challenge);
      const consumed = Object.freeze({ ...challenge, attemptsUsed: 1, consumedAt: at(1000) });
      await tx.challenges.save(consumed);
      expect((await tx.challenges.load(challenge.challengeId))?.consumedAt).toBe(at(1000));

      // Повторный ответ приходит вторым состоянием того же вызова — и хранилище
      // называет это конфликтом, а не молча перезаписывает.
      const again = Object.freeze({ ...challenge, attemptsUsed: 2, consumedAt: at(2000) });
      await expect(tx.challenges.save(again)).rejects.toSatisfy(
        (error: unknown) => error instanceof DbError && error.code === DbErrorCode.stepStateConflict,
      );
    });
  });

  it('срок вызова продлению не подлежит', async () => {
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const tx = pgAuthTransaction(client);
      const challenge = freshChallenge();
      await tx.challenges.save(challenge);
      await expect(
        client.query(
          `UPDATE sdelka.identity_challenge SET expires_at = expires_at + interval '1 hour'
            WHERE challenge_id = $1`,
          [challenge.challengeId],
        ),
      ).rejects.toSatisfy(
        (error: unknown) => errorKey(error) === DbErrorCode.authChallengeImmutable,
      );
    });
  });

  it('сессия уходит в базу и возвращается оттуда полем в поле', async () => {
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const written = pgAuthTransaction(client);
      const session = freshSession();
      await written.sessions.save(session);

      // Второе обращение к порту: значение поднимается запросом к серверу, а не
      // достаётся из объекта, который его записал.
      const read = pgAuthTransaction(client);
      const loaded = await read.sessions.load(session.sessionId);
      expect(loaded).toEqual(session);
      expect(sessionStatus(loaded as Session, at(60_000))).toBe('active');
    });
  });

  it('отзыв закрывает доступ немедленно и остаётся в строке', async () => {
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const tx = pgAuthTransaction(client);
      const session = freshSession();
      await tx.sessions.save(session);
      await tx.sessions.save(revoke(session, at(60_000)));

      const loaded = await tx.sessions.load(session.sessionId);
      expect(loaded?.revokedAt).toBe(at(60_000));
      expect(sessionStatus(loaded as Session, at(60_000))).toBe('revoked');

      // Отозванная сессия не оживает: строка после отзыва не меняется вовсе.
      await expect(
        tx.sessions.save(Object.freeze({ ...session, lastSeenAt: at(120_000) })),
      ).rejects.toSatisfy((error: unknown) => errorKey(error) === DbErrorCode.authSessionRevived);
    });
  });

  it('абсолютный срок сессии через порт не двигается', async () => {
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const tx = pgAuthTransaction(client);
      const session = freshSession();
      await tx.sessions.save(session);
      // Порт принимает значение целиком, а схема разрешает двигать только
      // отметку активности и отзыв: подложенный срок просто не доезжает.
      await tx.sessions.save(Object.freeze({ ...session, expiresAt: at(90 * 24 * 60 * 60 * 1000) }));
      expect((await tx.sessions.load(session.sessionId))?.expiresAt).toBe(session.expiresAt);
    });
  });

  it('вход и отказ во входе ложатся в журнал, а изменить их роль приложения не может', async () => {
    await withRollback(pool, async (client) => {
      await seedAccount(client);
      await asApp(client);
      const tx = pgAuthTransaction(client);
      const session = freshSession();
      await tx.sessions.save(session);
      await tx.journal.append(sessionEstablished(session, null));
      await tx.journal.append(
        sessionDenied(
          { accountId: ACCOUNT, personId: PERSON, roleId: null, onDuty: false },
          'magic_link',
          AUTH_REASON_KEYS.identityCodeMismatch,
          at(1000),
          null,
          null,
        ),
      );
      await tx.journal.append(
        sessionRevoked(session, AUTH_REASON_KEYS.sessionRevoked, at(2000)),
      );

      const rows = await client.query<{ kind: string; reason: string | null }>(
        `SELECT kind, reason::text AS reason FROM sdelka.auth_event
          WHERE account_id = $1 ORDER BY event_seq`,
        [ACCOUNT],
      );
      expect(rows.rows.map((row) => row.kind)).toEqual([
        'session_established',
        'session_denied',
        'session_revoked',
      ]);
      expect(rows.rows[1]?.reason).toBe(AUTH_REASON_KEYS.identityCodeMismatch);

      // Красная линия №11: исправление — только новой записью. Ни изменить, ни
      // удалить роль приложения не может, и это проверяется живой попыткой, а
      // не списком грантов.
      //
      // Останавливает попытку **первый** контур — сам грант (`42501`,
      // «permission denied»), и до триггера `forbid_auth_event_mutation` дело не
      // доходит. Так и задумано (`0010`): триггер — второй контур, для
      // владельца схемы, которого гранты не ограничивают. Поэтому годится любой
      // из двух отказов, но не отсутствие отказа.
      const stopped = (error: unknown): boolean =>
        sqlState(error) === '42501' || errorKey(error) === DbErrorCode.authAppendOnly;
      expect(stopped(await refused(client, 'UPDATE sdelka.auth_event SET reason = NULL'))).toBe(
        true,
      );
      expect(stopped(await refused(client, 'DELETE FROM sdelka.auth_event'))).toBe(true);
    });
  });

  it('одноразового кода в журнале входов нет ни в одном поле', async () => {
    await withRollback(pool, async (client) => {
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'sdelka' AND table_name = 'auth_event'`,
      );
      const suspicious = columns.rows
        .map((row) => row.column_name)
        .filter((name) => /code|secret|otp|token|digest|hash/u.test(name));
      expect(suspicious).toEqual([]);
    });
  });
});
