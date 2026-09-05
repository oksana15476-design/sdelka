import {
  appendRecord,
  auditActor,
  auditInstant,
  auditRef,
  genesisChain,
} from '@sdelka/audit';
import { type PartyRef, dealState } from '@sdelka/domain';
import { clientKey, clientTopUp } from '@sdelka/ledger';
import { money } from '@sdelka/money';
import { expect, it } from 'vitest';
import { APP_ROLE } from '../../src/roles.ts';
import { appendAudit, readChain } from '../../src/store/audit.ts';
import { appendJournal, readJournal } from '../../src/store/journal.ts';
import { loadDeal, saveDeal } from '../../src/store/state.ts';
import { dbSuite, sqlState, withRollback } from './support/pg.ts';

/**
 * Хранилище под **ролью приложения**, а не под логин-ролью набора.
 *
 * Это отдельный набор, потому что до него никто никогда не писал в схему тем
 * способом, каким будет писать продукт. Интеграционные тесты ходят под
 * `sdelka_dev`, а она состоит и в `sdelka_owner` — то есть имеет права, которых
 * у приложения нет по построению (инвариант 21, `CORE.md` Ф11). Схему,
 * проверенную только этой ролью, нельзя назвать проверенной.
 */
const { run, title, pool } = await dbSuite('хранилище: права роли приложения');

const GEL = 'GEL' as const;
const BUYER: PartyRef = { partyId: 'party-grants', accountKey: 'buyer.grants' };
const SELLER: PartyRef = { partyId: 'party-grants-seller', accountKey: 'seller.grants' };
const ACTOR = auditActor('operator-grants', 'operator', 'tranche.prepare');

run(title, () => {
  it('журнал учёта роль приложения пишет и читает', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      const entry = clientTopUp(
        { id: 'grants-1', occurredAt: '2026-03-01T10:00:00.000Z' },
        clientKey(BUYER.accountKey),
        money(GEL, 1_000n),
      );
      expect(await appendJournal(client, [entry])).toEqual({ written: 1, repeated: 0 });
      expect((await readJournal(client)).entries).toEqual([entry]);
    });
  });

  it('состояние сделки роль приложения пишет и читает', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      const deal = {
        dealId: 'deal-grants',
        state: dealState('ready'),
        buyer: BUYER,
        seller: SELLER,
      };
      expect(await saveDeal(client, deal)).toEqual({ written: 1, repeated: 0 });
      expect(await loadDeal(client, 'deal-grants')).toEqual(deal);
    });
  });

  /**
   * **Здесь стояло надгробие: «роль приложения не может дописать журнал аудита
   * вовсе».** Найдено первым же прогоном сквозного сценария под `sdelka_app`.
   * Гранты были верны — `GRANT SELECT, INSERT ON sdelka.audit_record TO
   * sdelka_app` (`0007`) прямо разрешает дописывание. Дело было в триггере:
   * `sdelka.assert_audit_chain()` исполнялась от имени вызывающего и брала
   * `SELECT … FOR UPDATE`, а `FOR UPDATE` требует права `UPDATE`, которое
   * инвариант 21 у роли приложения отбирает явно. `INSERT` разрешён грантом и
   * невозможен на практике, `42501`.
   *
   * `0020_audit_append_only.sql` перевела функцию на `SECURITY DEFINER`:
   * блокировку берёт владелец схемы, права роли приложения не изменились ни на
   * джоуль. Утверждение стало обратным, и ниже проверяется обе его половины —
   * дописать можно, изменить нельзя.
   */
  it('журнал аудита роль приложения дописывает', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      const chain = appendRecord(
        genesisChain('chain-grants', auditInstant(Date.UTC(2026, 2, 1, 9, 0, 0)), ACTOR),
        {
          recordId: 'chain-grants:1',
          recordedAt: auditInstant(Date.UTC(2026, 2, 1, 10, 0, 0)),
          actor: ACTOR,
          subject: auditRef('deal', 'deal-grants'),
          body: {
            kind: 'state_transition',
            machine: 'deal',
            from: 'draft',
            to: 'ready',
            eventKey: 'parties_confirmed',
            failedGuards: [],
          },
        },
      );
      expect(await appendAudit(client, chain.records)).toEqual({ written: 2, repeated: 0 });
      // Прочитанное — та же цепочка: сцепку по хешу и нумерацию проверила база
      // на вставке, значение хеша проверяет код на чтении.
      const read = await readChain(client, 'chain-grants');
      expect(read).toEqual(chain);
    });
  });

  /**
   * Вторая половина того же утверждения, и ради неё этот набор существует.
   *
   * Проверяется **живой попыткой**, а не только грантами в `information_schema`:
   * находка выше показала ровно то, что список грантов и то, что роль может на
   * самом деле, — разные вещи. `SECURITY DEFINER` у триггера вставки соблазн
   * такой же: если бы он открывал изменение, список грантов остался бы прежним
   * и молчал бы об этом.
   *
   * `42501` — insufficient_privilege. Проверяется код, а не текст: тексты
   * драйвера не наш контракт и меняются с версией `pg`. Запись, на которой
   * пробуют, кладётся тем же `appendAudit` под той же ролью — то есть роль
   * заведомо трогает **свою** строку, а не чужую.
   */
  it('изменить, удалить и опустошить журнал аудита роль приложения не может', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      const chain = genesisChain(
        'chain-grants-locked',
        auditInstant(Date.UTC(2026, 2, 1, 9, 0, 0)),
        ACTOR,
      );
      await appendAudit(client, chain.records);
      for (const attempt of [
        `UPDATE sdelka.audit_record SET actor_id = 'someone-else'
          WHERE chain_id = 'chain-grants-locked'`,
        `DELETE FROM sdelka.audit_record WHERE chain_id = 'chain-grants-locked'`,
        'TRUNCATE sdelka.audit_record',
      ]) {
        // Каждая проба — в своей точке сохранения: отказ роняет транзакцию, и
        // без отката вторая проба ответила бы «транзакция прервана», то есть
        // не ответила бы вовсе.
        await client.query('SAVEPOINT probe');
        const error = await client.query(attempt).catch((item: unknown) => item);
        expect(sqlState(error), attempt).toBe('42501');
        await client.query('ROLLBACK TO SAVEPOINT probe');
      }
      // Строка на месте: ни одна проба до триггера append-only даже не дошла —
      // её остановил грант, то есть первый контур, который и назван инвариантом.
      const left = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM sdelka.audit_record WHERE chain_id = 'chain-grants-locked'`,
      );
      expect(left.rows[0]?.count).toBe('1');
    });
  });

  it('журнал учёта роль приложения тоже не изменяет и не удаляет', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await appendJournal(client, [
        clientTopUp(
          { id: 'grants-locked', occurredAt: '2026-03-01T10:00:00.000Z' },
          clientKey(BUYER.accountKey),
          money(GEL, 1_000n),
        ),
      ]);
      for (const attempt of [
        `UPDATE sdelka.ledger_entry SET memo_key = 'ledger.entry.other'
          WHERE entry_id = 'grants-locked'`,
        `DELETE FROM sdelka.ledger_entry WHERE entry_id = 'grants-locked'`,
        'TRUNCATE sdelka.ledger_posting',
      ]) {
        await client.query('SAVEPOINT probe');
        const error = await client.query(attempt).catch((item: unknown) => item);
        expect(sqlState(error), attempt).toBe('42501');
        await client.query('ROLLBACK TO SAVEPOINT probe');
      }
    });
  });

  it('инвариант 21 на месте: у роли приложения нет UPDATE и DELETE на журналах', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      const granted = await client.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_schema = 'sdelka'
            AND table_name IN ('audit_record', 'ledger_entry', 'ledger_posting')
            AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')`,
        [APP_ROLE],
      );
      expect(granted.rows).toEqual([]);
    });
  });

  /**
   * `SECURITY DEFINER` — свойство ровно одной функции, и это тоже проверяется.
   *
   * Функция с правами владельца — законный, но опасный инструмент: вторая
   * такая, заведённая мимоходом, обошла бы гранты в месте, о котором никто не
   * помнит. Поэтому список закрытый и сверяется с живой схемой, а не с
   * намерением.
   */
  it('функций с правами владельца ровно одна, и у неё задан search_path', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      const definers = await client.query<{ proname: string; proconfig: string[] | null }>(
        `SELECT p.proname, p.proconfig
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'sdelka' AND p.prosecdef
          ORDER BY p.proname`,
      );
      expect(definers.rows.map((row) => row.proname)).toEqual(['assert_audit_chain']);
      // Без явного `search_path` вызывающий подставляет свой, и
      // неквалифицированное имя в теле разрешается в его схему.
      expect(definers.rows[0]?.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
    });
  });
});
