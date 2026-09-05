import { expect, it } from 'vitest';
import type { PoolClient } from '../../src/pool.ts';
import { dbSuite, errorKey, sqlState, withRollback } from './support/pg.ts';

/**
 * Учётные записи и сессии на живой базе — `0010`.
 *
 * `packages/auth` держит свои правила типами, и это работает ровно до границы
 * процесса: сессия, поднятая из хранилища, — это строка, а не значение, и роль
 * в ней приходит приведением. Здесь проверяется, что каждое правило имеет
 * второй рубеж в базе: попытка нарушить **падает**, а не проходит.
 *
 * Каждый случай сверяет **конкретный** ключ или SQLSTATE. Тест, принимающий
 * любую ошибку, остаётся зелёным от опечатки в запросе — то есть без инварианта.
 */
const suite = await dbSuite('учётные записи, сессии, гранты и журнал доступа');

const ASSIGNED = '2026-09-04T09:00:00Z';
const LOGIN = '2026-09-04T09:59:30Z';
const ISSUED = '2026-09-04T10:00:00Z';
/** Четыре часа: помещается и в консольные восемь, и в клиентские сутки. */
const EXPIRES = '2026-09-04T14:00:00Z';
const DECIDED = '2026-09-04T10:00:10Z';
const GRANT_EXPIRES = '2026-09-04T10:02:00Z';

const DEVICE = 'a'.repeat(64);

interface AccountSeed {
  readonly accountId: string;
  readonly personId: string;
  readonly roleId: string;
}

const ACCOUNTS: readonly AccountSeed[] = [
  { accountId: 'acc-fc', personId: 'per-fc', roleId: 'financial_controller' },
  { accountId: 'acc-op', personId: 'per-op', roleId: 'operator' },
  { accountId: 'acc-an', personId: 'per-an', roleId: 'compliance_analyst' },
  { accountId: 'acc-party', personId: 'per-party', roleId: 'party' },
];

async function seedAccounts(client: PoolClient): Promise<void> {
  for (const account of ACCOUNTS) {
    await client.query(
      `INSERT INTO sdelka.auth_account
         (account_id, person_id, role_id, role_assigned_at)
       VALUES ($1, $2, $3, $4)`,
      [account.accountId, account.personId, account.roleId, ASSIGNED],
    );
  }
}

interface SessionSeed {
  readonly sessionId?: string;
  readonly accountId?: string;
  readonly personId?: string;
  readonly roleId?: string;
  readonly onDuty?: boolean;
  readonly primaryMethod?: string;
  readonly issuedAt?: string;
  readonly expiresAt?: string | null;
  readonly lastSeenAt?: string;
}

async function openSession(client: PoolClient, seed: SessionSeed = {}): Promise<string> {
  const sessionId = seed.sessionId ?? 'ses-1';
  await client.query(
    `INSERT INTO sdelka.auth_session
       (session_id, account_id, person_id, role_id, on_duty, primary_method, primary_at,
        device_fingerprint, issued_at, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      sessionId,
      seed.accountId ?? 'acc-fc',
      seed.personId ?? 'per-fc',
      seed.roleId ?? 'financial_controller',
      seed.onDuty ?? false,
      seed.primaryMethod ?? 'passkey',
      LOGIN,
      DEVICE,
      seed.issuedAt ?? ISSUED,
      seed.expiresAt === undefined ? EXPIRES : seed.expiresAt,
      seed.lastSeenAt ?? ISSUED,
    ],
  );
  return sessionId;
}

async function verifyFactor(
  client: PoolClient,
  options: {
    readonly sessionId?: string;
    readonly challengeId?: string;
    readonly kind?: string;
    readonly verifiedAt?: string;
  } = {},
): Promise<void> {
  await client.query(
    `INSERT INTO sdelka.session_factor (challenge_id, session_id, kind, verified_at)
     VALUES ($1, $2, $3, $4)`,
    [
      options.challengeId ?? 'ch-1',
      options.sessionId ?? 'ses-1',
      options.kind ?? 'webauthn',
      options.verifiedAt ?? LOGIN,
    ],
  );
}

interface GrantSeed {
  readonly sessionId?: string;
  readonly accountId?: string;
  readonly personId?: string;
  readonly roleId?: string;
  readonly onDuty?: boolean;
  readonly capability?: string;
  readonly decidedAt?: string;
  readonly expiresAt?: string | null;
}

function grantStatement(): string {
  return `INSERT INTO sdelka.auth_grant
            (session_id, account_id, person_id, role_id, on_duty, capability,
             decided_at, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
}

function grantParams(seed: GrantSeed = {}): readonly unknown[] {
  return [
    seed.sessionId ?? 'ses-1',
    seed.accountId ?? 'acc-fc',
    seed.personId ?? 'per-fc',
    seed.roleId ?? 'financial_controller',
    seed.onDuty ?? false,
    seed.capability ?? 'approve_payout',
    seed.decidedAt ?? DECIDED,
    seed.expiresAt === undefined ? GRANT_EXPIRES : seed.expiresAt,
  ];
}

async function issueGrant(client: PoolClient, seed: GrantSeed = {}): Promise<void> {
  await client.query(grantStatement(), [...grantParams(seed)]);
}

/**
 * Попытка нарушить инвариант. Точка отката — точка сохранения: после отказа
 * транзакция в аварийном состоянии, и следующий запрос без отката вернул бы
 * «current transaction is aborted» вместо настоящей ошибки.
 */
async function refuses(
  client: PoolClient,
  what: string,
  statement: string,
  params: readonly unknown[],
  expected: { readonly state?: string; readonly key?: string },
): Promise<void> {
  await client.query('SAVEPOINT probe');
  let failed = false;
  try {
    await client.query(statement, [...params]);
  } catch (error) {
    failed = true;
    if (expected.state !== undefined) expect(sqlState(error), what).toBe(expected.state);
    if (expected.key !== undefined) expect(errorKey(error), what).toBe(expected.key);
  }
  await client.query('ROLLBACK TO SAVEPOINT probe');
  expect(failed, what).toBe(true);
}

suite.run(suite.title, () => {
  const pool = suite.pool;

  /* --------------------------------------------------------------------- */
  /* Сессия: срок есть, срок не двигается, отзыв необратим                  */
  /* --------------------------------------------------------------------- */

  it('сессия без срока не вставляется: SQLSTATE 23502', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      // `expiresAt` в `Session` не опционален. За границей процесса это держит
      // `NOT NULL`, и ничто другое: сессия без срока — это сессия навсегда.
      await refuses(
        client,
        'сессия без срока',
        `INSERT INTO sdelka.auth_session
           (session_id, account_id, person_id, role_id, on_duty, primary_method, primary_at,
            issued_at, expires_at, last_seen_at)
         VALUES ('ses-x', 'acc-fc', 'per-fc', 'financial_controller', false, 'passkey',
                 $1, $2, NULL, $2)`,
        [LOGIN, ISSUED],
        { state: '23502' },
      );
    });
  });

  it('срок в прошлом или в момент выдачи не вставляется', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await refuses(
        client,
        'срок равен выдаче',
        `INSERT INTO sdelka.auth_session
           (session_id, account_id, person_id, role_id, on_duty, primary_method, primary_at,
            issued_at, expires_at, last_seen_at)
         VALUES ('ses-x', 'acc-fc', 'per-fc', 'financial_controller', false, 'passkey',
                 $1, $2, $2, $2)`,
        [LOGIN, ISSUED],
        { state: '23514' },
      );
    });
  });

  it('срок дольше политики роли: auth.session.ttl_too_long', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      // Восемь часов у консоли (`CONSOLE_SESSION_POLICY`). Десять — это уже не
      // «чуть дольше», а отсутствие срока, растянутое на смену и ночь.
      await refuses(
        client,
        'десять часов консольной сессии',
        `INSERT INTO sdelka.auth_session
           (session_id, account_id, person_id, role_id, on_duty, primary_method, primary_at,
            issued_at, expires_at, last_seen_at)
         VALUES ('ses-x', 'acc-fc', 'per-fc', 'financial_controller', false, 'passkey',
                 $1, $2, '2026-09-04T20:00:00Z', $2)`,
        [LOGIN, ISSUED],
        { state: '23514', key: 'auth.session.ttl_too_long' },
      );
      // Та же длительность у клиентского кабинета законна: сутки против восьми
      // часов — политика аудитории, а не одно число на всех.
      await openSession(client, {
        sessionId: 'ses-client',
        accountId: 'acc-party',
        personId: 'per-party',
        roleId: 'party',
        expiresAt: '2026-09-04T20:00:00Z',
      });
    });
  });

  it('абсолютный срок продлению не подлежит: db.auth.session_immutable', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client);
      await refuses(
        client,
        'продление срока',
        `UPDATE sdelka.auth_session SET expires_at = '2026-09-04T13:00:00Z'
          WHERE session_id = 'ses-1'`,
        [],
        { state: '23514', key: 'db.auth.session_immutable' },
      );
      await refuses(
        client,
        'подмена роли в выданной сессии',
        `UPDATE sdelka.auth_session SET role_id = 'head_of_operations'
          WHERE session_id = 'ses-1'`,
        [],
        { state: '23514', key: 'db.auth.session_immutable' },
      );
      // Отметка активности — единственное, что двигается. И только вперёд.
      await client.query(
        `UPDATE sdelka.auth_session SET last_seen_at = '2026-09-04T10:05:00Z'
          WHERE session_id = 'ses-1'`,
      );
      await refuses(
        client,
        'отметка активности назад',
        `UPDATE sdelka.auth_session SET last_seen_at = $1 WHERE session_id = 'ses-1'`,
        [ISSUED],
        { state: '23514', key: 'db.auth.last_seen_regression' },
      );
    });
  });

  it('отозванная сессия не оживает', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client);
      await verifyFactor(client);
      await client.query(
        `UPDATE sdelka.auth_session SET revoked_at = '2026-09-04T11:00:00Z'
          WHERE session_id = 'ses-1'`,
      );

      await refuses(
        client,
        'снятие отзыва',
        `UPDATE sdelka.auth_session SET revoked_at = NULL WHERE session_id = 'ses-1'`,
        [],
        { state: '23514', key: 'db.auth.session_revived' },
      );
      await refuses(
        client,
        'отметка активности после отзыва',
        `UPDATE sdelka.auth_session SET last_seen_at = '2026-09-04T11:30:00Z'
          WHERE session_id = 'ses-1'`,
        [],
        { state: '23514', key: 'db.auth.session_revived' },
      );
      await refuses(
        client,
        'новое подтверждение фактора после отзыва',
        `INSERT INTO sdelka.session_factor (challenge_id, session_id, kind, verified_at)
         VALUES ('ch-2', 'ses-1', 'webauthn', '2026-09-04T11:30:00Z')`,
        [],
        { state: '23514', key: 'auth.session.revoked' },
      );
      await refuses(
        client,
        'грант по отозванной сессии',
        grantStatement(),
        grantParams({ decidedAt: '2026-09-04T11:30:00Z', expiresAt: '2026-09-04T11:32:00Z' }),
        { state: '23514', key: 'auth.session.revoked' },
      );
    });
  });

  it('сессия с чужой ролью не выдаётся: db.auth.account_role_mismatch', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      // Переключателя ролей нет ни у клиента, ни у сотрудника: роль меняется у
      // учётной записи, а не внутри сессии (`events.ts`).
      await refuses(
        client,
        'роль сессии сильнее роли записи',
        `INSERT INTO sdelka.auth_session
           (session_id, account_id, person_id, role_id, on_duty, primary_method, primary_at,
            issued_at, expires_at, last_seen_at)
         VALUES ('ses-x', 'acc-an', 'per-an', 'head_of_operations', false, 'passkey',
                 $1, $2, $3, $2)`,
        [LOGIN, ISSUED, EXPIRES],
        { state: '23514', key: 'db.auth.account_role_mismatch' },
      );
      // Второй рубеж — человек: подменённая половина пары проходит любую
      // проверку несовместимости.
      await refuses(
        client,
        'чужой человек за той же записью',
        `INSERT INTO sdelka.auth_session
           (session_id, account_id, person_id, role_id, on_duty, primary_method, primary_at,
            issued_at, expires_at, last_seen_at)
         VALUES ('ses-x', 'acc-an', 'per-fc', 'compliance_analyst', false, 'passkey',
                 $1, $2, $3, $2)`,
        [LOGIN, ISSUED, EXPIRES],
        { state: '23514', key: 'db.auth.account_person_mismatch' },
      );
      // Учётной записи нет вовсе — отказывает внешний ключ, а не здешний ключ.
      await refuses(
        client,
        'сессия несуществующей записи',
        `INSERT INTO sdelka.auth_session
           (session_id, account_id, person_id, role_id, on_duty, primary_method, primary_at,
            issued_at, expires_at, last_seen_at)
         VALUES ('ses-x', 'acc-nobody', 'per-nobody', 'support', false, 'passkey',
                 $1, $2, $3, $2)`,
        [LOGIN, ISSUED, EXPIRES],
        { state: '23503' },
      );
    });
  });

  it('дежурство только у роли, которая вправе дежурить', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await refuses(
        client,
        'дежурит комплаенс-аналитик',
        `INSERT INTO sdelka.auth_session
           (session_id, account_id, person_id, role_id, on_duty, primary_method, primary_at,
            issued_at, expires_at, last_seen_at)
         VALUES ('ses-x', 'acc-an', 'per-an', 'compliance_analyst', true, 'passkey',
                 $1, $2, $3, $2)`,
        [LOGIN, ISSUED, EXPIRES],
        { state: '23514', key: 'auth.duty.role_not_eligible' },
      );
      // Оператор дежурить вправе — `ACTORS.md` §7.1.
      await openSession(client, {
        sessionId: 'ses-duty',
        accountId: 'acc-op',
        personId: 'per-op',
        roleId: 'operator',
        onDuty: true,
      });
    });
  });

  it('ссылка в письме не открывает консоль', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      // Р6 B: почта и есть компрометируемый канал, а консольная роль видит
      // деньги.
      await refuses(
        client,
        'magic_link у финансового контролёра',
        `INSERT INTO sdelka.auth_session
           (session_id, account_id, person_id, role_id, on_duty, primary_method, primary_at,
            issued_at, expires_at, last_seen_at)
         VALUES ('ses-x', 'acc-fc', 'per-fc', 'financial_controller', false, 'magic_link',
                 $1, $2, $3, $2)`,
        [LOGIN, ISSUED, EXPIRES],
        { state: '23514', key: 'auth.primary.method_not_allowed_for_console' },
      );
      await openSession(client, {
        sessionId: 'ses-client',
        accountId: 'acc-party',
        personId: 'per-party',
        roleId: 'party',
        primaryMethod: 'magic_link',
      });
    });
  });

  it('консольная сессия без второго фактора не доживает до конца транзакции', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      // Проверка отложенная: она смотрит на сессию **вместе** с её
      // подтверждениями. `SET CONSTRAINTS ALL IMMEDIATE` — это и есть «конец
      // транзакции» для теста, который обязан откатиться.
      await client.query('SAVEPOINT probe');
      await openSession(client, { sessionId: 'ses-nofactor' });
      let failed = false;
      try {
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      } catch (error) {
        failed = true;
        expect(errorKey(error)).toBe('auth.second_factor.missing');
      }
      await client.query('ROLLBACK TO SAVEPOINT probe');
      expect(failed, 'консоль без второго фактора').toBe(true);

      // Код в SMS вторым фактором для консоли не является: канал, который может
      // быть у нападающего, — это второй экран, а не второй фактор.
      await client.query('SAVEPOINT weak');
      await openSession(client, { sessionId: 'ses-weak' });
      await verifyFactor(client, { sessionId: 'ses-weak', challengeId: 'ch-weak', kind: 'sms' });
      let weakFailed = false;
      try {
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      } catch (error) {
        weakFailed = true;
        expect(errorKey(error)).toBe('auth.second_factor.too_weak');
      }
      await client.query('ROLLBACK TO SAVEPOINT weak');
      expect(weakFailed, 'консоль с кодом в SMS').toBe(true);

      // С ключом — проходит.
      await openSession(client, { sessionId: 'ses-ok' });
      await verifyFactor(client, { sessionId: 'ses-ok', challengeId: 'ch-ok' });
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });

  it('один вызов второго фактора отвечается один раз: SQLSTATE 23505', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client);
      await openSession(client, { sessionId: 'ses-2' });
      await verifyFactor(client);
      // «Повтор такого подтверждения нечем отличить от первого»
      // (`second-factor.ts`) — в том числе повтор в другой сессии.
      await refuses(
        client,
        'тот же вызов во второй сессии',
        `INSERT INTO sdelka.session_factor (challenge_id, session_id, kind, verified_at)
         VALUES ('ch-1', 'ses-2', 'webauthn', $1)`,
        [LOGIN],
        { state: '23505' },
      );
    });
  });

  /* --------------------------------------------------------------------- */
  /* Грант полномочия                                                       */
  /* --------------------------------------------------------------------- */

  it('грант без срока не вставляется: SQLSTATE 23502', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client);
      await verifyFactor(client);
      await refuses(client, 'грант без срока', grantStatement(), grantParams({ expiresAt: null }), {
        state: '23502',
      });
      await refuses(
        client,
        'грант с нулевым сроком',
        grantStatement(),
        grantParams({ expiresAt: DECIDED }),
        { state: '23514' },
      );
    });
  });

  it('грант живёт не дольше окна подтверждения: auth.authority.stale', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client);
      await verifyFactor(client);
      // Пять минут — `stepUpMaxAge` консоли. Час — это бессрочное доказательство
      // полномочия, пережившее и простой сессии, и её отзыв.
      await refuses(
        client,
        'грант на час',
        grantStatement(),
        grantParams({ expiresAt: '2026-09-04T11:00:10Z' }),
        { state: '23514', key: 'auth.authority.stale' },
      );
      await issueGrant(client);
      const rows = await client.query<{ capability: string }>(
        `SELECT capability FROM sdelka.auth_grant WHERE session_id = 'ses-1'`,
      );
      expect(rows.rows.map((row) => row.capability)).toEqual(['approve_payout']);
    });
  });

  it('полномочие, не выданное роли, не гранту не подлежит', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client);
      await verifyFactor(client);
      // `manage_access` не выдан ни одной роли: полномочие, которого нет в
      // `ACTORS.md` §5.1, здесь означает «не может никто».
      await refuses(
        client,
        'manage_access финансовому контролёру',
        grantStatement(),
        grantParams({ capability: 'manage_access' }),
        { state: '23514', key: 'auth.capability.not_granted' },
      );
      // Ввод реквизитов снят с оператора (`ACTORS.md` §4.2): реквизиты вводит
      // только сторона, в кабинете, под вторым фактором.
      await openSession(client, {
        sessionId: 'ses-op',
        accountId: 'acc-op',
        personId: 'per-op',
        roleId: 'operator',
      });
      await verifyFactor(client, { sessionId: 'ses-op', challengeId: 'ch-op' });
      await refuses(
        client,
        'write_beneficiary оператору',
        grantStatement(),
        grantParams({
          sessionId: 'ses-op',
          accountId: 'acc-op',
          personId: 'per-op',
          roleId: 'operator',
          capability: 'write_beneficiary',
        }),
        { state: '23514', key: 'auth.capability.not_granted' },
      );
    });
  });

  it('механика расчёта: база отвечает так же, как код (ACTORS.md §5.1.1)', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      const operator = {
        sessionId: 'ses-op',
        accountId: 'acc-op',
        personId: 'per-op',
        roleId: 'operator',
      } as const;
      await openSession(client, operator);
      await openSession(client);

      // Носителей два, и база это знает: казначейство — ФК, подготовка расчёта
      // и внешний факт платежа — ОП. Строка, отставшая от кода, означала бы
      // либо грант вопреки коду, либо отказ там, где код разрешает.
      await refuses(
        client,
        'operate_treasury оператору',
        grantStatement(),
        grantParams({ ...operator, capability: 'operate_treasury' }),
        { state: '23514', key: 'auth.capability.not_granted' },
      );
      await refuses(
        client,
        'prepare_settlement финансовому контролёру',
        grantStatement(),
        grantParams({ capability: 'prepare_settlement' }),
        { state: '23514', key: 'auth.capability.not_granted' },
      );
      await refuses(
        client,
        'record_bank_outcome финансовому контролёру',
        grantStatement(),
        grantParams({ capability: 'record_bank_outcome' }),
        { state: '23514', key: 'auth.capability.not_granted' },
      );

      // Второй фактор: у внешнего факта платежа он обязателен, у подготовки
      // расчёта — нет, и разница видна без единой строки кода приложения.
      await refuses(
        client,
        'record_bank_outcome без подтверждённого фактора',
        grantStatement(),
        grantParams({ ...operator, capability: 'record_bank_outcome' }),
        { state: '23514', key: 'auth.second_factor.missing' },
      );
      await issueGrant(client, { ...operator, capability: 'prepare_settlement' });

      await verifyFactor(client, { sessionId: 'ses-op', challengeId: 'ch-op' });
      await issueGrant(client, { ...operator, capability: 'record_bank_outcome' });
      await verifyFactor(client);
      await issueGrant(client, { capability: 'operate_treasury' });

      const rows = await client.query<{ capability: string }>(
        `SELECT capability FROM sdelka.auth_grant ORDER BY capability::text`,
      );
      expect(rows.rows.map((row) => row.capability)).toEqual([
        'operate_treasury',
        'prepare_settlement',
        'record_bank_outcome',
      ]);
    });
  });

  it('дежурное полномочие требует дежурства', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client, {
        sessionId: 'ses-op',
        accountId: 'acc-op',
        personId: 'per-op',
        roleId: 'operator',
      });
      await verifyFactor(client, { sessionId: 'ses-op', challengeId: 'ch-op' });
      // Флаг сам по себе полномочий не даёт, но и полномочие без флага не
      // выдаётся: `effectiveCapabilities(role, false)` не содержит
      // `confirm_incident`.
      await refuses(
        client,
        'confirm_incident без дежурства',
        grantStatement(),
        grantParams({
          sessionId: 'ses-op',
          accountId: 'acc-op',
          personId: 'per-op',
          roleId: 'operator',
          capability: 'confirm_incident',
        }),
        { state: '23514', key: 'auth.capability.not_granted' },
      );

      await openSession(client, {
        sessionId: 'ses-duty',
        accountId: 'acc-op',
        personId: 'per-op',
        roleId: 'operator',
        onDuty: true,
      });
      await verifyFactor(client, { sessionId: 'ses-duty', challengeId: 'ch-duty' });
      await issueGrant(client, {
        sessionId: 'ses-duty',
        accountId: 'acc-op',
        personId: 'per-op',
        roleId: 'operator',
        onDuty: true,
        capability: 'confirm_incident',
      });
    });
  });

  it('step-up требует свежего и достаточно сильного фактора', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      const party = {
        sessionId: 'ses-party',
        accountId: 'acc-party',
        personId: 'per-party',
        roleId: 'party',
      } as const;
      await openSession(client, party);

      await refuses(
        client,
        'ввод реквизитов без второго фактора',
        grantStatement(),
        grantParams({ ...party, capability: 'write_beneficiary' }),
        { state: '23514', key: 'auth.second_factor.missing' },
      );

      // Код в SMS слабее «владения» — минимума клиентской политики.
      await client.query('SAVEPOINT weak');
      await verifyFactor(client, {
        sessionId: 'ses-party',
        challengeId: 'ch-sms',
        kind: 'sms',
        verifiedAt: DECIDED,
      });
      await refuses(
        client,
        'ввод реквизитов по коду в SMS',
        grantStatement(),
        grantParams({ ...party, capability: 'write_beneficiary' }),
        { state: '23514', key: 'auth.second_factor.too_weak' },
      );
      await client.query('ROLLBACK TO SAVEPOINT weak');

      // Подтверждение получасовой давности подтверждает того, кто входил, а не
      // того, кто нажимает «сохранить реквизиты» сейчас: окно — пять минут.
      await client.query('SAVEPOINT stale');
      await verifyFactor(client, {
        sessionId: 'ses-party',
        challengeId: 'ch-old',
        kind: 'totp',
        verifiedAt: '2026-09-04T09:30:00Z',
      });
      await refuses(
        client,
        'подтверждение получасовой давности',
        grantStatement(),
        grantParams({ ...party, capability: 'write_beneficiary' }),
        { state: '23514', key: 'auth.second_factor.stale' },
      );
      await client.query('ROLLBACK TO SAVEPOINT stale');

      await verifyFactor(client, {
        sessionId: 'ses-party',
        challengeId: 'ch-fresh',
        kind: 'totp',
        verifiedAt: '2026-09-04T10:00:05Z',
      });
      await issueGrant(client, { ...party, capability: 'write_beneficiary' });

      // Полномочие без пометки `step_up` свежего подтверждения не требует.
      await client.query('SAVEPOINT plain');
      await openSession(client, { ...party, sessionId: 'ses-plain' });
      await issueGrant(client, { ...party, sessionId: 'ses-plain', capability: 'read_deal' });
      await client.query('ROLLBACK TO SAVEPOINT plain');
    });
  });

  it('простой и истечение сессии закрывают выдачу гранта', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client);
      await verifyFactor(client);
      // Пятнадцать минут простоя у консоли. Отметка активности не двигалась —
      // значит человека за клавиатурой уже полчаса как нет.
      await refuses(
        client,
        'грант через полчаса простоя',
        grantStatement(),
        grantParams({ decidedAt: '2026-09-04T10:30:00Z', expiresAt: '2026-09-04T10:32:00Z' }),
        { state: '23514', key: 'auth.session.idle' },
      );
      await refuses(
        client,
        'грант после истечения срока',
        grantStatement(),
        grantParams({ decidedAt: '2026-09-04T14:00:01Z', expiresAt: '2026-09-04T14:01:00Z' }),
        { state: '23514', key: 'auth.session.expired' },
      );
      await refuses(
        client,
        'грант раньше открытия сессии',
        grantStatement(),
        grantParams({ decidedAt: '2026-09-04T09:00:00Z', expiresAt: '2026-09-04T09:02:00Z' }),
        { state: '23514', key: 'db.auth.grant_before_session' },
      );
    });
  });

  it('грант не приписывает действие другому человеку: SQLSTATE 23503', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client);
      await verifyFactor(client);
      // Составная ссылка на сессию: совпасть обязаны учётная запись, человек,
      // роль и дежурство, а не один идентификатор сессии.
      await refuses(
        client,
        'чужой человек в гранте',
        grantStatement(),
        grantParams({ personId: 'per-op' }),
        { state: '23503' },
      );
      await refuses(
        client,
        'дежурство, которого не было в сессии',
        grantStatement(),
        grantParams({ onDuty: true }),
        { state: '23503' },
      );
    });
  });

  /* --------------------------------------------------------------------- */
  /* Учётная запись и смена роли                                            */
  /* --------------------------------------------------------------------- */

  it('роль себе не назначают — ни записью, ни человеком', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await refuses(
        client,
        'та же учётная запись',
        `UPDATE sdelka.auth_account SET role_assigned_by = 'acc-fc' WHERE account_id = 'acc-fc'`,
        [],
        { state: '23514' },
      );
      // Второй рубеж — по человеку: учётные записи разные, рука одна.
      await refuses(
        client,
        'тот же человек в другой записи',
        `INSERT INTO sdelka.auth_account
           (account_id, person_id, role_id, role_assigned_at, role_assigned_by)
         VALUES ('acc-fc-2', 'per-fc', 'head_of_operations', $1, 'acc-fc')`,
        [ASSIGNED],
        { state: '23514', key: 'auth.sod.self_approval' },
      );
      await client.query(
        `INSERT INTO sdelka.auth_account
           (account_id, person_id, role_id, role_assigned_at, role_assigned_by)
         VALUES ('acc-ho', 'per-ho', 'head_of_operations', $1, 'acc-fc')`,
        [ASSIGNED],
      );
    });
  });

  it('смена роли требует отозвать действующие сессии', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client, {
        sessionId: 'ses-an',
        accountId: 'acc-an',
        personId: 'per-an',
        roleId: 'compliance_analyst',
      });
      await refuses(
        client,
        'смена роли при живой сессии',
        `UPDATE sdelka.auth_account
            SET role_id = 'support', role_assigned_at = '2026-09-04T11:00:00Z'
          WHERE account_id = 'acc-an'`,
        [],
        { state: '23514', key: 'db.auth.role_change_with_live_session' },
      );
      await client.query(
        `UPDATE sdelka.auth_session SET revoked_at = '2026-09-04T10:59:00Z'
          WHERE session_id = 'ses-an'`,
      );
      await client.query(
        `UPDATE sdelka.auth_account
            SET role_id = 'support', role_assigned_at = '2026-09-04T11:00:00Z'
          WHERE account_id = 'acc-an'`,
      );
    });
  });

  /* --------------------------------------------------------------------- */
  /* Журнал доступа                                                         */
  /* --------------------------------------------------------------------- */

  it('форма события проверяется на входе', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client);
      await refuses(
        client,
        'вход без срока сессии',
        `INSERT INTO sdelka.auth_event
           (kind, occurred_at, account_id, person_id, role_id, on_duty, session_id,
            primary_method)
         VALUES ('session_established', $1, 'acc-fc', 'per-fc', 'financial_controller', false,
                 'ses-1', 'passkey')`,
        [ISSUED],
        { state: '23514' },
      );
      await refuses(
        client,
        'отказ во входе без причины',
        `INSERT INTO sdelka.auth_event
           (kind, occurred_at, account_id, person_id, on_duty, primary_method)
         VALUES ('session_denied', $1, 'acc-fc', 'per-fc', false, 'passkey')`,
        [ISSUED],
        { state: '23514' },
      );
      await refuses(
        client,
        'назначение роли внутри сессии',
        `INSERT INTO sdelka.auth_event
           (kind, occurred_at, account_id, person_id, role_id, on_duty, session_id)
         VALUES ('role_assigned', $1, 'acc-fc', 'per-fc', 'financial_controller', false, 'ses-1')`,
        [ISSUED],
        { state: '23514' },
      );

      // Отказ во входе по несуществующей учётной записи записывается: ровно
      // ради этой записи журнал входов и ведётся (`ACTORS.md` §4.1 A2).
      await client.query(
        `INSERT INTO sdelka.auth_event
           (kind, occurred_at, account_id, person_id, on_duty, primary_method, reason,
            network_fingerprint)
         VALUES ('session_denied', $1, 'acc-unknown', 'per-unknown', false, 'password',
                 'auth.capability.not_granted', $2)`,
        [ISSUED, 'b'.repeat(64)],
      );
      await client.query(
        `INSERT INTO sdelka.auth_event
           (kind, occurred_at, account_id, person_id, role_id, on_duty, session_id,
            primary_method, second_factor, expires_at)
         VALUES ('session_established', $1, 'acc-fc', 'per-fc', 'financial_controller', false,
                 'ses-1', 'passkey', 'webauthn', $2)`,
        [ISSUED, EXPIRES],
      );
    });
  });

  it('журнал доступа не редактируется: гранты и триггер', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await openSession(client);
      await client.query(
        `INSERT INTO sdelka.auth_event
           (kind, occurred_at, account_id, person_id, role_id, on_duty, session_id,
            primary_method, expires_at)
         VALUES ('session_established', $1, 'acc-fc', 'per-fc', 'financial_controller', false,
                 'ses-1', 'passkey', $2)`,
        [ISSUED, EXPIRES],
      );

      // Первый контур — гранты. Именно он назван инвариантом: «роль приложения
      // не имеет прав на изменение и удаление — проверяется грантами базы».
      for (const statement of [
        `UPDATE sdelka.auth_event SET occurred_at = now()`,
        `DELETE FROM sdelka.auth_event`,
        `UPDATE sdelka.auth_grant SET expires_at = now()`,
        `DELETE FROM sdelka.session_factor`,
        `DELETE FROM sdelka.second_factor_binding`,
        `INSERT INTO sdelka.role_capability (role_id, capability, requires_duty)
           VALUES ('support', 'approve_payout', false)`,
      ]) {
        await client.query('SAVEPOINT probe');
        await client.query('SET ROLE sdelka_app');
        let failed = false;
        try {
          await client.query(statement);
        } catch (error) {
          // Именно 42501: отказ по грантам, а не срабатывание триггера. Иначе
          // тест остался бы зелёным на одном втором контуре.
          failed = true;
          expect(sqlState(error), statement).toBe('42501');
        }
        expect(failed, statement).toBe(true);
        await client.query('ROLLBACK TO SAVEPOINT probe');
      }

      // Второй контур — триггер. Он ловит и владельца схемы, которого гранты не
      // ограничивают.
      await refuses(
        client,
        'правка журнала владельцем схемы',
        `UPDATE sdelka.auth_event SET reason = 'auth.session.idle'`,
        [],
        { state: '0A000', key: 'db.auth.append_only' },
      );
      await refuses(
        client,
        'удаление события владельцем схемы',
        `DELETE FROM sdelka.auth_event`,
        [],
        { state: '0A000', key: 'db.auth.append_only' },
      );
    });
  });

  it('привязка второго фактора только дописывается', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      await client.query(
        `INSERT INTO sdelka.second_factor_binding (account_id, kind, bound_at)
         VALUES ('acc-fc', 'webauthn', $1)`,
        [LOGIN],
      );
      await refuses(
        client,
        'повторная привязка того же вида',
        `INSERT INTO sdelka.second_factor_binding (account_id, kind, bound_at)
         VALUES ('acc-fc', 'webauthn', $1)`,
        [ISSUED],
        { state: '23505' },
      );
      await refuses(
        client,
        'правка привязки',
        `UPDATE sdelka.second_factor_binding SET bound_at = now()`,
        [],
        { state: '0A000', key: 'db.auth.append_only' },
      );
    });
  });

  it('перечни — типы, а не строки: SQLSTATE 22P02', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await seedAccounts(client);
      // Роль, которой нет в `ROLE_IDS`, не вставляется вовсе. Со строковой
      // колонкой она молча легла бы и обошла всю матрицу полномочий.
      await refuses(
        client,
        'выдуманная роль',
        `INSERT INTO sdelka.auth_account (account_id, person_id, role_id, role_assigned_at)
         VALUES ('acc-admin', 'per-admin', 'admin', $1)`,
        [ASSIGNED],
        { state: '22P02' },
      );
      await refuses(
        client,
        'выдуманное полномочие',
        `INSERT INTO sdelka.auth_capability (capability, effect, second_factor, journaled)
         VALUES ('do_everything', 'govern', 'none', true)`,
        [],
        { state: '22P02' },
      );
    });
  });

  it('идентификаторы непрозрачны: почта в учётной записи не лежит', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      // `auth/src/ids.ts`: «если бы `accountId` мог быть почтой, запрет в аудите
      // ловил бы её на последнем метре, когда решение уже принято».
      await refuses(
        client,
        'адрес почты вместо ключа',
        `INSERT INTO sdelka.auth_account (account_id, person_id, role_id, role_assigned_at)
         VALUES ('user@example.com', 'per-x', 'support', $1)`,
        [ASSIGNED],
        { state: '23514' },
      );
      await refuses(
        client,
        'имя с пробелом вместо ключа',
        `INSERT INTO sdelka.auth_account (account_id, person_id, role_id, role_assigned_at)
         VALUES ('acc-x', 'Ivane Kartveli', 'support', $1)`,
        [ASSIGNED],
        { state: '23514' },
      );
    });
  });
});
