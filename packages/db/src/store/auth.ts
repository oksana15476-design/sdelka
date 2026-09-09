import {
  type AccountDirectoryPort,
  type AccountRecord,
  type AuthEvent,
  type AuthJournalPort,
  type AuthStore,
  type AuthTransaction,
  type ChallengeId,
  type Fingerprint,
  type IdentityChallenge,
  type IdentityChallengeStorePort,
  type PersonId,
  type RoleId,
  type SecondFactorAssertion,
  type SecondFactorKind,
  type Session,
  type SessionId,
  type SessionStorePort,
  type PrimaryMethod,
  accountId as toAccountId,
  challengeId as toChallengeId,
  fingerprint as toFingerprint,
  personId as toPersonId,
  sessionId as toSessionId,
} from '@sdelka/auth';
import { type Instant, instant } from '@sdelka/domain';
import { DbError, DbErrorCode } from '../errors.ts';
import type { Pool, PoolClient } from '../pool.ts';
import { APP_ROLE, SCHEMA_NAME } from '../roles.ts';
import { translating } from './errors.ts';

/**
 * Хранилище входа на Postgres: учётные записи, вызовы личности, сессии и журнал
 * входов.
 *
 * ## Зачем модуль появился
 *
 * `SessionStorePort` был объявлен в `packages/auth` и **не реализован ни разу**:
 * сессии жили в памяти процесса (`World.sessions`), то есть перезапуск
 * разлогинивал всех, а вторая реплика не видела сессий первой. Таблица
 * `sdelka.auth_session` при этом стояла в схеме с `0010` со всеми своими
 * триггерами — и была пуста, потому что писать в неё было некому.
 *
 * ## Правил здесь нет
 *
 * Ровно как в `pg-store.ts`: правила живут в трёх местах — в `packages/auth`
 * (над значением), в схеме (ограничения, триггеры, гранты) и в переводе отказов
 * (`errors.ts`). Этот файл только связывает их и держит транзакцию. Ни одного
 * условия вида «если сессия истекла» здесь нет: это решение, а решения
 * принимает не хранилище.
 *
 * ## Чего здесь нет
 *
 * **Кода.** Ни в открытом виде, ни в отпечатке: его нет и в схеме (`0024`), а
 * выводится он ключом из окружения (`auth/src/code.ts`, красная линия №12).
 * Хранилище видит вызов — идентификатор, срок, счётчик — и не видит кода.
 *
 * **Удаления.** Ни сессия, ни вызов, ни событие журнала не удаляются: у роли
 * приложения нет ни `DELETE`, ни `TRUNCATE` на этих таблицах, и метода тоже
 * нет — красная линия №11 держится грантами и отсутствием двери, а не
 * дисциплиной вызывающего.
 */

/* ------------------------------------------------------------------------- */
/* Время                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Момент в базу и обратно. `timestamptz` ↔ миллисекунды эпохи: драйвер отдаёт
 * `Date`, из него берётся то же число, которое туда положили (`audit.ts`
 * делает так же). Через `to_timestamp` не идём — он принимает число с
 * плавающей точкой, а его разбор в этом дереве запрещён (`pool.ts`).
 */
function stamp(at: Instant): string {
  return new Date(at).toISOString();
}

function momentOf(value: Date): Instant {
  return instant(value.getTime());
}

function optionalMoment(value: Date | null): Instant | null {
  return value === null ? null : momentOf(value);
}

function optionalFingerprint(value: string | null): Fingerprint | null {
  return value === null ? null : toFingerprint(value);
}

/* ------------------------------------------------------------------------- */
/* Учётные записи                                                            */
/* ------------------------------------------------------------------------- */

interface AccountRow {
  readonly account_id: string;
  readonly person_id: string;
  readonly role_id: string;
}

const SELECT_ACCOUNT = `
  SELECT account_id, person_id, role_id
    FROM ${SCHEMA_NAME}.auth_account
   WHERE account_id = $1`;

/**
 * Поиск по ключу учётной записи.
 *
 * Ключ приходит из формы входа, то есть от кого угодно. Форма проверяется
 * конструктором `accountId` **после** запроса, а не до: до запроса он бросил бы
 * на строке неверной формы, и «неверная форма» отличалась бы от «нет такой
 * записи» — то есть форма входа отвечала бы по-разному. Здесь оба случая дают
 * `null`, потому что параметр запроса неверной формы просто ничего не находит.
 */
export async function findAccount(
  client: PoolClient,
  accountKey: string,
): Promise<AccountRecord | null> {
  const found = await client.query<AccountRow>(SELECT_ACCOUNT, [accountKey]);
  const row = found.rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    accountId: toAccountId(row.account_id),
    personId: toPersonId(row.person_id),
    roleId: row.role_id as RoleId,
  });
}

/* ------------------------------------------------------------------------- */
/* Вызов личности                                                            */
/* ------------------------------------------------------------------------- */

interface ChallengeRow {
  readonly challenge_id: string;
  readonly account_id: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly attempts_used: number;
  readonly max_attempts: number;
  readonly consumed_at: Date | null;
  readonly delivered_at: Date | null;
}

const CHALLENGE_COLUMNS = `challenge_id, account_id, issued_at, expires_at,
         attempts_used, max_attempts, consumed_at, delivered_at`;

const SELECT_CHALLENGE = `
  SELECT ${CHALLENGE_COLUMNS}
    FROM ${SCHEMA_NAME}.identity_challenge
   WHERE challenge_id = $1`;

/**
 * Самый свежий вызов учётной записи.
 *
 * Состояние не отбирается: закрытый вызов нужен ради своей отметки об
 * отправке (`auth/src/code-request.ts`), а «живой ли он» — решение, и его
 * принимает не хранилище. Порядок разрешается до конца
 * (`challenge_id` вторым ключом): два вызова в одну миллисекунду иначе
 * поднимались бы через раз разными, и правило зависело бы от плана запроса.
 * Обратный проход идёт по `identity_challenge_account (account_id, issued_at)`
 * из `0024` — второго индекса под это не заводится (`0025`).
 */
const SELECT_LATEST_CHALLENGE = `
  SELECT ${CHALLENGE_COLUMNS}
    FROM ${SCHEMA_NAME}.identity_challenge
   WHERE account_id = $1
   ORDER BY issued_at DESC, challenge_id DESC
   LIMIT 1`;

const INSERT_CHALLENGE = `
  INSERT INTO ${SCHEMA_NAME}.identity_challenge
    (challenge_id, account_id, issued_at, expires_at, attempts_used, max_attempts,
     consumed_at, delivered_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (challenge_id) DO NOTHING`;

/**
 * Обновление вызова сверкой с предыдущим состоянием — та же замена колонки
 * версии, что и у состояния сделки (`state.ts`): два параллельных ответа на
 * один вызов иначе молча затирают друг друга, и последний записавший выигрывает.
 * Здесь это не абстрактная гонка: два ответа на один код — ровно то, чем
 * пользуется подбор.
 */
const UPDATE_CHALLENGE = `
  UPDATE ${SCHEMA_NAME}.identity_challenge
     SET attempts_used = $2, consumed_at = $3
   WHERE challenge_id = $1
     AND attempts_used = $4
     AND consumed_at IS NULL`;

/**
 * Отметка об отправке — на каждую отправку, включая повторную (`0025`).
 *
 * Условие сравнения оставлено, но развёрнуто: отметка не двигается назад.
 * Триггер такой `UPDATE` и так отвергнет, но отвергнет **исключением**, то есть
 * оборванной транзакцией входа; здесь то же самое — просто ноль строк. Разница
 * важна для часов, переведённых назад: вход не обязан падать от этого.
 */
const MARK_DELIVERED = `
  UPDATE ${SCHEMA_NAME}.identity_challenge
     SET delivered_at = $2
   WHERE challenge_id = $1
     AND (delivered_at IS NULL OR delivered_at <= $2)`;

function challengeOfRow(row: ChallengeRow): IdentityChallenge {
  return Object.freeze({
    challengeId: toChallengeId(row.challenge_id),
    accountId: toAccountId(row.account_id),
    issuedAt: momentOf(row.issued_at),
    expiresAt: momentOf(row.expires_at),
    attemptsUsed: row.attempts_used,
    maxAttempts: row.max_attempts,
    consumedAt: optionalMoment(row.consumed_at),
    deliveredAt: optionalMoment(row.delivered_at),
  });
}

export async function loadChallenge(
  client: PoolClient,
  id: ChallengeId,
): Promise<IdentityChallenge | null> {
  const found = await client.query<ChallengeRow>(SELECT_CHALLENGE, [id]);
  const row = found.rows[0];
  return row === undefined ? null : challengeOfRow(row);
}

export async function latestChallengeFor(
  client: PoolClient,
  account: string,
): Promise<IdentityChallenge | null> {
  const found = await client.query<ChallengeRow>(SELECT_LATEST_CHALLENGE, [account]);
  const row = found.rows[0];
  return row === undefined ? null : challengeOfRow(row);
}

export async function saveChallenge(
  client: PoolClient,
  challenge: IdentityChallenge,
): Promise<void> {
  if (challenge.attemptsUsed === 0 && challenge.consumedAt === null) {
    const inserted = await client.query(INSERT_CHALLENGE, [
      challenge.challengeId,
      challenge.accountId,
      stamp(challenge.issuedAt),
      stamp(challenge.expiresAt),
      challenge.attemptsUsed,
      challenge.maxAttempts,
      null,
      // Отметка об отправке кладётся вместе со строкой: выданный вызов её не
      // имеет, но вызов и его отметка обязаны класться и подниматься одним
      // значением — иначе «поднимается целым» перестаёт быть правдой.
      challenge.deliveredAt === undefined || challenge.deliveredAt === null
        ? null
        : stamp(challenge.deliveredAt),
    ]);
    if (inserted.rowCount === 0) {
      // Место занято другим вызовом под тем же идентификатором. Повтором это
      // быть не может: идентификатор выдаётся случайным на каждый запрос.
      throw new DbError(DbErrorCode.stepConflict, {
        relation: 'identity_challenge',
        challengeId: challenge.challengeId,
      });
    }
    return;
  }
  const updated = await client.query(UPDATE_CHALLENGE, [
    challenge.challengeId,
    challenge.attemptsUsed,
    challenge.consumedAt === null ? null : stamp(challenge.consumedAt),
    challenge.attemptsUsed - 1,
  ]);
  if (updated.rowCount === 0) {
    // Либо вызов уже закрыт, либо счётчик в базе не тот, из которого шаг
    // уходил: второй ответ на тот же код. Оба случая — конфликт, а не повтор.
    throw new DbError(DbErrorCode.stepStateConflict, {
      relation: 'identity_challenge',
      challengeId: challenge.challengeId,
    });
  }
}

export async function markChallengeDelivered(
  client: PoolClient,
  id: ChallengeId,
  at: Instant,
): Promise<void> {
  await client.query(MARK_DELIVERED, [id, stamp(at)]);
}

/* ------------------------------------------------------------------------- */
/* Сессия                                                                    */
/* ------------------------------------------------------------------------- */

interface SessionRow {
  readonly session_id: string;
  readonly account_id: string;
  readonly person_id: string;
  readonly role_id: string;
  readonly on_duty: boolean;
  readonly primary_method: string;
  readonly primary_at: Date;
  readonly device_fingerprint: string | null;
  readonly network_fingerprint: string | null;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly last_seen_at: Date;
  readonly revoked_at: Date | null;
}

interface FactorRow {
  readonly challenge_id: string;
  readonly kind: string;
  readonly verified_at: Date;
  readonly device_fingerprint: string | null;
}

const SELECT_SESSION = `
  SELECT session_id, account_id, person_id, role_id, on_duty,
         primary_method, primary_at, device_fingerprint, network_fingerprint,
         issued_at, expires_at, last_seen_at, revoked_at
    FROM ${SCHEMA_NAME}.auth_session
   WHERE session_id = $1`;

const SELECT_FACTORS = `
  SELECT challenge_id, kind, verified_at, device_fingerprint
    FROM ${SCHEMA_NAME}.session_factor
   WHERE session_id = $1
   ORDER BY verified_at`;

const INSERT_SESSION = `
  INSERT INTO ${SCHEMA_NAME}.auth_session
    (session_id, account_id, person_id, role_id, on_duty,
     primary_method, primary_at, device_fingerprint, network_fingerprint,
     issued_at, expires_at, last_seen_at, revoked_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  ON CONFLICT (session_id) DO NOTHING`;

/**
 * Обновление сессии — только то, что схема вообще разрешает двигать: отметка
 * активности и отзыв (`0010`, `assert_auth_session_update`). Абсолютный срок в
 * списке колонок отсутствует, поэтому продлить его нечем даже по ошибке.
 */
const UPDATE_SESSION = `
  UPDATE ${SCHEMA_NAME}.auth_session
     SET last_seen_at = $2, revoked_at = $3
   WHERE session_id = $1`;

const INSERT_FACTOR = `
  INSERT INTO ${SCHEMA_NAME}.session_factor
    (challenge_id, session_id, kind, verified_at, device_fingerprint)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (challenge_id) DO NOTHING`;

const REVOKE_ALL_FOR_ACCOUNT = `
  UPDATE ${SCHEMA_NAME}.auth_session
     SET revoked_at = $2
   WHERE account_id = $1
     AND revoked_at IS NULL`;

function assertionOfRow(row: FactorRow): SecondFactorAssertion {
  return Object.freeze({
    kind: row.kind as SecondFactorKind,
    challengeId: toChallengeId(row.challenge_id),
    verifiedAt: momentOf(row.verified_at),
    device: optionalFingerprint(row.device_fingerprint),
  });
}

function sessionOfRow(row: SessionRow, factors: readonly SecondFactorAssertion[]): Session {
  return Object.freeze({
    sessionId: toSessionId(row.session_id),
    accountId: toAccountId(row.account_id),
    personId: toPersonId(row.person_id),
    roleId: row.role_id as RoleId,
    onDuty: row.on_duty,
    primary: Object.freeze({
      method: row.primary_method as PrimaryMethod,
      at: momentOf(row.primary_at),
      device: optionalFingerprint(row.device_fingerprint),
      network: optionalFingerprint(row.network_fingerprint),
    }),
    factors: Object.freeze([...factors]),
    issuedAt: momentOf(row.issued_at),
    expiresAt: momentOf(row.expires_at),
    lastSeenAt: momentOf(row.last_seen_at),
    revokedAt: optionalMoment(row.revoked_at),
  });
}

export async function loadSession(client: PoolClient, id: SessionId): Promise<Session | null> {
  const found = await client.query<SessionRow>(SELECT_SESSION, [id]);
  const row = found.rows[0];
  if (row === undefined) return null;
  const factors = await client.query<FactorRow>(SELECT_FACTORS, [id]);
  return sessionOfRow(row, factors.rows.map(assertionOfRow));
}

/**
 * Запись сессии.
 *
 * **Обновление пробуется первым, вставка вторым**, и порядок здесь не вкусовой.
 * `assert_auth_session` — триггер `BEFORE INSERT`, и он срабатывает **до**
 * разбора `ON CONFLICT`: вставка-сначала означала бы, что каждая отметка
 * активности заново проходит проверку выдачи сессии, а отметка по сессии,
 * выданной по прежней политике, падала бы с `auth.session.ttl_too_long` —
 * то есть смена политики выкидывала бы всех действующих не при истечении
 * срока, а на ближайшем движении.
 *
 * Вставка идёт вместе с подтверждениями фактора: проверка «второй фактор на
 * входе» отложена до конца транзакции (`0010`), поэтому фактор обязан лечь в ту
 * же транзакцию, а не следующей операцией.
 *
 * Что именно можно двигать, решает не этот файл: схема разрешает отметку
 * активности и отзыв, и попытка сдвинуть что-то ещё приезжает сюда отказом
 * `db.auth.session_immutable`. Абсолютного срока в списке колонок обновления
 * нет вовсе — продлить его нечем даже по ошибке.
 */
export async function saveSession(client: PoolClient, session: Session): Promise<void> {
  const updated = await client.query(UPDATE_SESSION, [
    session.sessionId,
    stamp(session.lastSeenAt),
    session.revokedAt === null ? null : stamp(session.revokedAt),
  ]);
  if (updated.rowCount === 0) {
    await client.query(INSERT_SESSION, [
      session.sessionId,
      session.accountId,
      session.personId,
      session.roleId,
      session.onDuty,
      session.primary.method,
      stamp(session.primary.at),
      session.primary.device,
      session.primary.network,
      stamp(session.issuedAt),
      stamp(session.expiresAt),
      stamp(session.lastSeenAt),
      session.revokedAt === null ? null : stamp(session.revokedAt),
    ]);
  }
  for (const assertion of session.factors) {
    await client.query(INSERT_FACTOR, [
      assertion.challengeId,
      session.sessionId,
      assertion.kind,
      stamp(assertion.verifiedAt),
      assertion.device,
    ]);
  }
}

export async function revokeAllSessionsForAccount(
  client: PoolClient,
  account: string,
  at: Instant,
): Promise<number> {
  const updated = await client.query(REVOKE_ALL_FOR_ACCOUNT, [account, stamp(at)]);
  return updated.rowCount ?? 0;
}

/* ------------------------------------------------------------------------- */
/* Журнал входов                                                             */
/* ------------------------------------------------------------------------- */

const INSERT_EVENT = `
  INSERT INTO ${SCHEMA_NAME}.auth_event
    (kind, occurred_at, account_id, person_id, role_id, on_duty, session_id,
     device_fingerprint, network_fingerprint, primary_method, second_factor,
     expires_at, capability, reason, ordered_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`;

/**
 * Событие входа в вечный журнал.
 *
 * Разбора союза `AuthEvent` здесь **нет**: форму каждого вида проверяет
 * ограничение `auth_event_shape` (`0010`), и вторая реализация тех же правил на
 * стороне клиента разошлась бы с первой молча. Поля читаются через `in`, потому
 * что у разных видов их набор разный, а не подставляются `null` наугад: `null`
 * там, где вид требует значения, ограничение и отвергнет.
 *
 * Кода одноразового доступа среди полей нет ни одного, и его отпечатка тоже:
 * журнал не редактируется (красная линия №11), поэтому состав проверяется на
 * входе — дописать или убрать потом нельзя.
 */
export async function appendAuthEvent(client: PoolClient, event: AuthEvent): Promise<void> {
  const has = <K extends string>(key: K): unknown =>
    key in event ? (event as unknown as Record<string, unknown>)[key] : null;
  const expiresAt = has('expiresAt');
  await client.query(INSERT_EVENT, [
    event.kind,
    stamp(event.at),
    event.actor.accountId,
    event.actor.personId,
    event.actor.roleId,
    event.actor.onDuty,
    event.sessionId,
    event.device,
    event.network,
    has('primaryMethod'),
    has('secondFactor') ?? has('factor'),
    typeof expiresAt === 'number' ? stamp(expiresAt as Instant) : null,
    has('capability'),
    has('reason'),
    has('orderedBy'),
  ]);
}

/* ------------------------------------------------------------------------- */
/* Сборка                                                                    */
/* ------------------------------------------------------------------------- */

function transactionOf(client: PoolClient): AuthTransaction {
  const accounts: AccountDirectoryPort = {
    find: (accountKey) => findAccount(client, accountKey),
  };
  const challenges: IdentityChallengeStorePort = {
    load: (id) => loadChallenge(client, id),
    latestFor: (account) => latestChallengeFor(client, account),
    save: (challenge) => saveChallenge(client, challenge),
    markDelivered: (id, at) => markChallengeDelivered(client, id, at),
  };
  const sessions: SessionStorePort = {
    load: (id) => loadSession(client, id),
    save: (session) => saveSession(client, session),
    revokeAllForAccount: (account, at) => revokeAllSessionsForAccount(client, account, at),
  };
  const journal: AuthJournalPort = {
    append: (event) => appendAuthEvent(client, event),
  };
  return Object.freeze({ accounts, challenges, sessions, journal });
}

/** Транзакция над **уже открытым** соединением: границу держит тот, кто её открыл. */
export function pgAuthTransaction(client: PoolClient): AuthTransaction {
  return transactionOf(client);
}

export interface PgAuthStoreOptions {
  /**
   * Роль, под которой идёт шаг. Умолчание — роль приложения, и это не
   * украшение: append-only журнала входов держится **грантами** (`0010`), а
   * гранты действуют на роль. Шаг от имени владельца схемы обходит их целиком.
   */
  readonly role?: string;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]*$/u;

function assertRoleName(role: string): string {
  if (!ROLE_NAME.test(role)) {
    throw new DbError(DbErrorCode.roleMissing, { role });
  }
  return role;
}

/**
 * Хранилище входа поверх пула.
 *
 * Транзакция открывается на **каждый** шаг входа: попытка, счётчик, сессия и
 * запись в журнале ложатся вместе либо не ложатся вовсе. Отложенная проверка
 * второго фактора (`assert_session_second_factor`, `0010`) срабатывает на
 * `COMMIT`, поэтому `COMMIT` тоже завёрнут в перевод отказов — иначе «второго
 * фактора нет» приехало бы безымянной ошибкой драйвера.
 */
export function pgAuthStore(pool: Pool, options: PgAuthStoreOptions = {}): AuthStore {
  const role = assertRoleName(options.role ?? APP_ROLE);
  return {
    async transact<T>(body: (tx: AuthTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${role}`);
        const result = await translating(() => body(transactionOf(client)));
        await translating(async () => {
          await client.query('COMMIT');
        });
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
