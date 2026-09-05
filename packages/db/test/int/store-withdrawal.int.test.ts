import {
  type ClientAccountFacts,
  type PartyRef,
  type WithdrawalState,
  DomainError,
  RejectionCode,
  createWithdrawal,
  reduceWithdrawal,
} from '@sdelka/domain';
import { money } from '@sdelka/money';
import { expect, it } from 'vitest';
import { DbError, DbErrorCode } from '../../src/errors.ts';
import { APP_ROLE } from '../../src/roles.ts';
import { pgWorldTransaction } from '../../src/store/pg-store.ts';
import type { WithdrawalSnapshot } from '../../src/store/port.ts';
import { loadWithdrawals, saveWithdrawal } from '../../src/store/state.ts';
import { dbSuite, withRollback } from './support/pg.ts';

/**
 * Круг «мир → база → мир» по выводу со счёта клиента.
 *
 * **Зачем отдельный набор.** До него вывод был единственной частью состояния,
 * которая через порт не проходила вовсе: таблица (`0005_payout.sql`) и машина
 * из шести состояний (`domain/src/client-account.ts`) существовали, методов у
 * порта не было. Сделка, транш и поручение либо ложились, либо возвращали отказ
 * с ключом; вывод не возвращал ничего — и это то самое молчание, ради которого
 * порт вообще отдаёт `WriteOutcome` вместо `void`.
 *
 * **Всё под ролью приложения.** Логин-роль набора состоит в `sdelka_owner` и
 * имеет права, которых у продукта нет по построению (инвариант 21). Схема,
 * проверенная только ею, проверенной не считается — тот же довод, что в
 * `store-grants.int.test.ts`.
 *
 * **Статусы двигает редьюсер домена, а не тест.** Сценарий, в котором статусы
 * расставлены руками, проверяет аккуратность автора, а не автомат: пара
 * «состояние из базы ↔ состояние из машины» обязана сходиться на настоящих
 * переходах.
 */
const { run, title, pool } = await dbSuite('хранилище: вывод со счёта клиента');

const GEL = 'GEL' as const;
const CLIENT: PartyRef = { partyId: 'party-withdrawal', accountKey: 'client.withdrawal' };
const AMOUNT = money(GEL, 4_000_000n);
/** Отпечаток, а не реквизиты: номер счёта в открытом виде в базе не живёт. */
const FINGERPRINT = '9f'.repeat(32);

const FACTS: ClientAccountFacts = Object.freeze({
  free: money(GEL, 9_000_000n),
  locked: Object.freeze([]),
  requestedAmount: AMOUNT,
  sourceAccount: Object.freeze({ accountRef: FINGERPRINT, holderIsPayer: true }),
  preparedBy: 'operator-withdrawal',
  approvals: Object.freeze([{ userId: 'approver-1' }, { userId: 'approver-2' }]),
  activeWithdrawals: 0,
});

/** Переход настоящей машиной. Отказ здесь — дефект теста, и он обязан упасть. */
function advance(state: WithdrawalState, event: Parameters<typeof reduceWithdrawal>[1]) {
  const result = reduceWithdrawal(state, event, FACTS);
  if (!result.ok) {
    throw new Error(`переход не состоялся: ${JSON.stringify(result.error)}`);
  }
  return result.value.state;
}

const REQUESTED = createWithdrawal('withdrawal-1');
const APPROVED = advance(REQUESTED, { type: 'withdrawal_approved' });
const DISPATCHED = advance(APPROVED, { type: 'withdrawal_dispatched' });
const PAID_OUT = advance(DISPATCHED, { type: 'payout_result', outcome: 'settled' });

function snapshotOf(state: WithdrawalState): WithdrawalSnapshot {
  return Object.freeze({
    state,
    party: CLIENT,
    amount: AMOUNT,
    sourceAccountFingerprint: FINGERPRINT,
  });
}

run(title, () => {
  it('вывод возвращается тем же: состояние, сторона, сумма, отпечаток источника', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      expect(await saveWithdrawal(client, snapshotOf(REQUESTED), null)).toEqual({
        written: 1,
        repeated: 0,
      });
      expect(await loadWithdrawals(client, CLIENT.partyId)).toEqual([snapshotOf(REQUESTED)]);
    });
  });

  it('ключ идемпотентности переживает круг и остаётся функцией номера вывода', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await saveWithdrawal(client, snapshotOf(REQUESTED), null);
      const [read] = await loadWithdrawals(client, CLIENT.partyId);
      // Ни попытки, ни времени в ключе нет (`withdrawalIdempotencyKey`,
      // инвариант 13): иначе повтор при потерянном ответе банка создаст второй
      // вывод. Круг обязан вернуть тот же ключ, а не «какой-то uuid».
      expect(read?.state.idempotencyKey).toBe(REQUESTED.idempotencyKey);
      expect(read?.state.withdrawalId).toBe('withdrawal-1');
    });
  });

  it('повтор шага не двигает состояние и виден числом', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await saveWithdrawal(client, snapshotOf(REQUESTED), null);
      expect(
        await saveWithdrawal(client, snapshotOf(APPROVED), snapshotOf(REQUESTED)),
      ).toEqual({ written: 1, repeated: 0 });
      // Тот же шаг ещё раз: в базе уже лежит его цель.
      expect(
        await saveWithdrawal(client, snapshotOf(APPROVED), snapshotOf(REQUESTED)),
      ).toEqual({ written: 0, repeated: 1 });
      expect(await loadWithdrawals(client, CLIENT.partyId)).toEqual([snapshotOf(APPROVED)]);
    });
  });

  it('повторная заявка тем же снимком — повтор, а не второй вывод', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await saveWithdrawal(client, snapshotOf(REQUESTED), null);
      expect(await saveWithdrawal(client, snapshotOf(REQUESTED), null)).toEqual({
        written: 0,
        repeated: 1,
      });
      expect(await loadWithdrawals(client, CLIENT.partyId)).toHaveLength(1);
    });
  });

  it('шаг из состояния, которого в базе нет, — конфликт с именем', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await saveWithdrawal(client, snapshotOf(REQUESTED), null);
      await saveWithdrawal(client, snapshotOf(APPROVED), snapshotOf(REQUESTED));
      // Второй шаг из `requested`: так выглядит гонка или потерянный шаг.
      // Слепой `UPDATE` затёр бы чужое утверждение молча.
      const error = await saveWithdrawal(
        client,
        snapshotOf(DISPATCHED),
        snapshotOf(REQUESTED),
      ).catch((item: unknown) => item);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe(DbErrorCode.stepStateConflict);
      expect((error as DbError).details['relation']).toBe('withdrawal');
      expect(await loadWithdrawals(client, CLIENT.partyId)).toEqual([snapshotOf(APPROVED)]);
    });
  });

  it('подменённый на пути счёт-источник не проезжает под видом шага', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await saveWithdrawal(client, snapshotOf(REQUESTED), null);
      // Красная линия №9: возврат и вывод — только на счёт-источник. Подмена
      // отпечатка между заявкой и утверждением — это перевод не тому, и
      // «обновить статус заодно с реквизитами» обязано быть невыразимо.
      const swapped: WithdrawalSnapshot = {
        ...snapshotOf(APPROVED),
        sourceAccountFingerprint: '0a'.repeat(32),
      };
      const error = await saveWithdrawal(client, swapped, snapshotOf(REQUESTED)).catch(
        (item: unknown) => item,
      );
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe(DbErrorCode.stepStateConflict);
      expect(await loadWithdrawals(client, CLIENT.partyId)).toEqual([snapshotOf(REQUESTED)]);
    });
  });

  it('подменённая на пути сумма не проезжает под видом шага', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await saveWithdrawal(client, snapshotOf(REQUESTED), null);
      const swapped: WithdrawalSnapshot = {
        ...snapshotOf(APPROVED),
        amount: money(GEL, 8_000_000n),
      };
      const error = await saveWithdrawal(client, swapped, snapshotOf(REQUESTED)).catch(
        (item: unknown) => item,
      );
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe(DbErrorCode.stepStateConflict);
      expect(await loadWithdrawals(client, CLIENT.partyId)).toEqual([snapshotOf(REQUESTED)]);
    });
  });

  it('второй незавершённый вывод по счёту отвергается именем guard’а', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await saveWithdrawal(client, snapshotOf(REQUESTED), null);
      const second = snapshotOf(createWithdrawal('withdrawal-2'));
      // Правило держит частичный уникальный индекс `withdrawal_one_active_per_party`;
      // в коде то же правило — guard `g_no_active_withdrawal`. Отказ обязан
      // приезжать именем guard’а, а не текстом драйвера: «отказ автомата» без
      // указания правила дежурному не говорит ничего.
      const error = await saveWithdrawal(client, second, null).catch((item: unknown) => item);
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe(RejectionCode.guardFailed);
      expect((error as DomainError).message).toBe('g_no_active_withdrawal');
    });
  });

  it('после исполненного вывода следующий по тому же счёту заводится', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await saveWithdrawal(client, snapshotOf(REQUESTED), null);
      await saveWithdrawal(client, snapshotOf(APPROVED), snapshotOf(REQUESTED));
      await saveWithdrawal(client, snapshotOf(DISPATCHED), snapshotOf(APPROVED));
      await saveWithdrawal(client, snapshotOf(PAID_OUT), snapshotOf(DISPATCHED));
      // `paid_out` терминален, из предиката частичного индекса он выпадает —
      // и счёт снова свободен. Иначе один исполненный вывод запирал бы клиента
      // навсегда.
      const next = snapshotOf(createWithdrawal('withdrawal-3'));
      expect(await saveWithdrawal(client, next, null)).toEqual({ written: 1, repeated: 0 });
      const all = await loadWithdrawals(client, CLIENT.partyId);
      expect(all.map((item) => item.state.status)).toEqual(['paid_out', 'requested']);
    });
  });

  it('через порт вывод пишется и читается тем же способом, что и остальное', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      // Прямой вызов `state.ts` проверяет запрос; порт проверяет, что метод у
      // шага мира вообще есть. Пока его не было, вывод в базу не попадал и в
      // перечне непопавшего не появлялся.
      const tx = pgWorldTransaction(client);
      expect(await tx.saveWithdrawal(snapshotOf(REQUESTED), null)).toEqual({
        written: 1,
        repeated: 0,
      });
      expect(await tx.loadWithdrawals(CLIENT.partyId)).toEqual([snapshotOf(REQUESTED)]);
    });
  });

  it('выводы чужого клиента в список не попадают', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      const other: PartyRef = { partyId: 'party-withdrawal-other', accountKey: 'other.withdrawal' };
      await saveWithdrawal(client, snapshotOf(REQUESTED), null);
      await saveWithdrawal(
        client,
        { ...snapshotOf(createWithdrawal('withdrawal-other')), party: other },
        null,
      );
      expect(await loadWithdrawals(client, CLIENT.partyId)).toEqual([snapshotOf(REQUESTED)]);
      expect((await loadWithdrawals(client, other.partyId)).map((i) => i.state.withdrawalId)).toEqual(
        ['withdrawal-other'],
      );
    });
  });
});
