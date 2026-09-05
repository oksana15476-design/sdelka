import type { Pool } from '../../../../db/src/pool';
import { APP_ROLE, OWNER_ROLE } from '../../../../db/src/roles';

/**
 * Предусловие набора: в этой базе не писал **чужой мир**.
 *
 * Проверка нужна потому, что нарушение предусловия иначе всплывает на девятом
 * шаге сценария отказом `db.step.conflict` по идентификатору записи журнала — и
 * читается как дефект хранилища, хотя это дефект окружения. Причина у обоих
 * одна: идентификатор записи журнала учёта уникален только внутри мира
 * (`app/src/flow.ts`, `nextMeta`), поэтому база сегодня вмещает ровно один мир.
 *
 * Признак мира — его цепочка аудита: у каждого мира она своя и заводится первым
 * же шагом (`genesisChain`). Чужая цепочка в `audit_record` означает, что здесь
 * жил другой мир, а значит его номера записей журнала заняты.
 *
 * Идентификаторы цепочек — не секрет (в отличие от строки подключения, красная
 * линия №12), поэтому в сообщении они называются: без них дежурному нечего
 * делать с отказом.
 */
export async function assertNoForeignWorld(
  pool: Pool,
  ownChainIds: readonly string[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Чтение под ролью приложения: набор не смотрит в базу правами, которых у
    // продукта нет.
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    const found = await client.query<{ chain_id: string }>(
      'SELECT DISTINCT chain_id FROM sdelka.audit_record WHERE chain_id <> ALL($1) ORDER BY chain_id',
      [ownChainIds],
    );
    if (found.rowCount !== 0) {
      const names = found.rows.map((row) => row.chain_id).join(',');
      throw new Error(`e2e.int.foreign_world:${names}`);
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/**
 * Снятие **состояния** сделок перед прогоном. Журналы не трогаются вовсе.
 *
 * **Зачем это нужно и почему это не уборка мусора.** Мир приложения из базы
 * сегодня не продолжается: `restoreWorld` отдаёт `RestoredWorld`, и это
 * намеренно **не** `World` (`app/src/store.ts`) — фактов приложения в схеме нет,
 * а дозаполнить их умолчаниями значило бы выдумать факты о деньгах. Значит
 * второй прогон набора начинает мир с нуля и первым же шагом объявляет «завожу
 * транш в `pending`», а в базе лежит тот же транш в `paid_out`. Хранилище
 * отвечает `db.step.state_conflict` — и отвечает **верно**: это не повтор шага,
 * это заявка на состояние, из которого уже ушли.
 *
 * Поэтому изменяемое (сделка, транш, поручение, акт) снимается, а дополняемое —
 * журнал учёта и журнал аудита — остаётся лежать. Следствие приятное и
 * намеренное: повторный прогон пишет состояние заново, а обе журнальные строки
 * встречает **своими же** и опознаёт повтором. То есть второй запуск набора и
 * есть проверка идемпотентности на живой базе, а не обход неудобства.
 *
 * ⚠ **Роль — владелец схемы, и по-другому нельзя.** У `sdelka_app` прав
 * `DELETE` на эти таблицы нет вовсе (`0004`, `0005`: `GRANT SELECT, INSERT,
 * UPDATE`), и это часть продукта: приложение сделок не удаляет. Снятие делает
 * оператор набора, а не шаг мира, и идёт оно **мимо** `pgWorldStore` — иначе у
 * хранилища появилась бы дверь, которой у него нет.
 *
 * Стороны (`sdelka.party`) не снимаются: строка справочная, ключ у неё
 * естественный, и повторная запись той же стороны — повтор, а не конфликт.
 * Выводы (`sdelka.withdrawal`) не снимаются потому, что сделки не знают:
 * у вывода нет ни транша, ни сделки — и порт в него не пишет вовсе
 * (`app/src/store.ts`, оговорка про `WithdrawalWorld`).
 */
export async function resetDealState(pool: Pool, dealIds: readonly string[]): Promise<void> {
  if (dealIds.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${OWNER_ROLE}`);
    // Порядок — обратный ссылочной целостности: поручение ссылается на транш,
    // транш на акт и на сделку, акт на сделку.
    await client.query('DELETE FROM sdelka.payout WHERE deal_id = ANY($1)', [dealIds]);
    await client.query('DELETE FROM sdelka.tranche WHERE deal_id = ANY($1)', [dealIds]);
    await client.query('DELETE FROM sdelka.condition_act WHERE deal_id = ANY($1)', [dealIds]);
    await client.query('DELETE FROM sdelka.deal WHERE deal_id = ANY($1)', [dealIds]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
