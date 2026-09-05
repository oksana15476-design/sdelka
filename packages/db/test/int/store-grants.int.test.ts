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
import { appendAudit } from '../../src/store/audit.ts';
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
   * ⚠ **Тест-надгробие. Роль приложения не может дописать журнал аудита вовсе.**
   *
   * Найдено первым же прогоном сквозного сценария под `sdelka_app`. Причина не
   * в грантах на таблицу — они верны: `GRANT SELECT, INSERT ON
   * sdelka.audit_record TO sdelka_app` (`0007_audit.sql`) прямо разрешает
   * дописывание, и намерение авторов недвусмысленно. Причина в триггере:
   *
   * - `sdelka.assert_audit_chain()` объявлена без `SECURITY DEFINER`, то есть
   *   исполняется от имени вызывающего;
   * - внутри она берёт `SELECT … FROM sdelka.audit_record … FOR UPDATE` — и
   *   правильно делает: без блокировки две параллельные вставки прочитали бы
   *   одну и ту же «последнюю» запись и обе получили бы `seq = n+1`;
   * - `FOR UPDATE` требует права `UPDATE` на таблицу, а инвариант 21 это право
   *   у роли приложения **отбирает явно** (`REVOKE UPDATE, DELETE, TRUNCATE`).
   *
   * Итог: `INSERT` разрешён грантом и невозможен на практике. Красная линия
   * №11 («журнал аудита не редактируется») выполняется предельно строго — его
   * и не дописать. Заметить это можно было только записью под настоящей ролью,
   * а такой записи до появления хранилища не существовало.
   *
   * Чинится одной строкой в новой миграции: `SECURITY DEFINER` у
   * `assert_audit_chain()` (плюс `SET search_path` — обязательная гигиена
   * такой функции). Блокировку тогда берёт владелец, а права роли приложения
   * не меняются ни на джоуль. Миграции сейчас правит другой агент, поэтому
   * здесь — проба, фиксирующая факт, а не исправление.
   *
   * Тест обязан покраснеть, когда дефект починят: тогда его надо заменить на
   * утверждение «роль приложения дописывает журнал аудита».
   */
  it('[надгробие] журнал аудита роль приложения дописать не может', async () => {
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
      const error = await appendAudit(client, chain.records).catch((item: unknown) => item);
      // `42501` — insufficient_privilege. Проверяется код, а не текст: тексты
      // драйвера не наш контракт и меняются с версией `pg`.
      expect(sqlState(error)).toBe('42501');
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
});
