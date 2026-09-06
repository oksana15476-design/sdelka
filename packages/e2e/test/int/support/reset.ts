import type { Pool } from '../../../../db/src/pool';
import { APP_ROLE, OWNER_ROLE } from '../../../../db/src/roles';

/**
 * Предусловие набора: в этой базе не писал **чужой мир**.
 *
 * **Что изменилось и почему проверка осталась.** Заводилась она под другой
 * дефект: идентификатор записи журнала учёта был уникален только внутри мира
 * (`entry-<seq>-<label>`), и чужой мир занимал наши номера — предусловие
 * всплывало на девятом шаге отказом `db.step.conflict` и читалось как дефект
 * хранилища, хотя было дефектом окружения. Сегодня идентификатор несёт цепочку
 * (`app/src/ids.ts`), и чужие номера нам не мешают.
 *
 * Не мешает и второе: у чтения журнала появился охват (`app/src/store.ts`,
 * `JournalScope`), и подъём мира берёт его по своей цепочке — чужие проводки в
 * инварианты поднятого мира больше не попадают.
 *
 * Проверка остаётся, и вот зачем. Первое: чужая цепочка в этой базе означает,
 * что база не та, на которую набор рассчитан, и сказать об этом надо **до**
 * первого шага, а не разбирать потом расхождение в числах. Второе: наборы,
 * читающие журнал целиком написанным охватом (`packages/db`,
 * `store-journal.int.test.ts`), после чужого мира красные — и это тоже про
 * состояние базы, а не про их код.
 *
 * Признак мира — его цепочка аудита: у каждого мира она своя и заводится первым
 * же шагом (`genesisChain`).
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
 * **Зачем это нужно и почему это не уборка мусора.** Продолжить мир из базы
 * теперь можно (`app/src/resume.ts`), но **этот набор так не делает**: он ведёт
 * свой мир от первого шага и проверяет весь путь денег, а не подъём. Значит
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
 *
 * Выводы (`sdelka.withdrawal`) здесь тоже не снимаются, но по другой причине,
 * чем прежде: раньше порт в них не писал вовсе, а теперь пишет — заявка стала
 * полем мира (`app/src/world.ts`), и шаг кладёт её той же дельтой, что и транш.
 * Сделки у заявки нет, поэтому снять её по `deal_id` нельзя; снимает её
 * `resetWithdrawals` по номерам, и зовёт его тот набор, который заявки заводит.
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

/**
 * Снятие заявок на вывод перед прогоном — по номерам, а не по сделке.
 *
 * Сделки у заявки нет вовсе (`sdelka.withdrawal` ссылается только на сторону),
 * поэтому список приходит номерами. Причина снятия та же, что у состояния
 * сделок: набор ведёт свой мир от первого шага и первым же шагом объявляет
 * «завожу заявку в `requested`», а в базе после прошлого прогона лежит она же в
 * `paid_out`. Это не повтор шага, а заявка на состояние, из которого уже ушли, —
 * и хранилище верно отвечает `db.step.state_conflict`.
 *
 * ⚠ **Роль — владелец схемы, и по-другому нельзя.** У `sdelka_app` прав
 * `DELETE` нет (`0005`: `GRANT SELECT, INSERT, UPDATE`), и это часть продукта:
 * приложение заявок не удаляет. Снятие идёт мимо `pgWorldStore` — иначе у
 * хранилища появилась бы дверь, которой у него нет.
 */
export async function resetWithdrawals(
  pool: Pool,
  withdrawalIds: readonly string[],
): Promise<void> {
  if (withdrawalIds.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${OWNER_ROLE}`);
    await client.query('DELETE FROM sdelka.withdrawal WHERE withdrawal_id = ANY($1)', [
      withdrawalIds,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Цепочки аудита, которые ведёт **весь** интеграционный набор сквозного контура.
 *
 * Перечень один на все файлы намеренно: предусловие `assertNoForeignWorld`
 * объявляет чужой всякую цепочку, которой здесь нет, и файл, заведший свою
 * цепочку молча, ронял бы соседа на втором прогоне — причём отказом «чужой мир»,
 * который читался бы как грязная база, а не как забытая строка.
 */
export const INT_CHAINS: readonly string[] = Object.freeze([
  'chain-int-e2e',
  'chain-int-other',
  'chain-int-withdrawal',
]);
