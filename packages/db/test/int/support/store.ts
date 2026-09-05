import type { PoolClient } from '../../../src/pool.ts';
import { APP_ROLE } from '../../../src/roles.ts';
import { translating } from '../../../src/store/errors.ts';
import type { WorldStore, WorldTransaction } from '../../../src/store/port.ts';
import { pgWorldTransaction } from '../../../src/store/pg-store.ts';

/**
 * Хранилище на точках сохранения — для сквозного сценария.
 *
 * **Зачем не `pgWorldStore`.** Настоящее хранилище фиксирует шаг `COMMIT`ом, и
 * убрать записанное потом нечем: журнал учёта и журнал аудита только
 * дополняются (`DELETE` запрещён и грантами, и триггером). Сквозной сценарий,
 * идущий через настоящий `COMMIT`, оставил бы после себя мусор, который увидел
 * бы следующий прогон — и `readJournal` сравнивал бы уже не то, что записал
 * этот тест.
 *
 * Поэтому шаг здесь — точка сохранения внутри одной откатываемой транзакции.
 * Свойство, ради которого хранилище вообще имеет границу шага, сохраняется
 * полностью: шаг либо ложится целиком, либо откатывается целиком.
 *
 * ⚠ **`SET CONSTRAINTS` — не украшение, а условие честности этой подмены.**
 * Триггеры `assert_entry_balanced` и `assert_entry_has_postings` отложенные:
 * они срабатывают на `COMMIT`, а `RELEASE SAVEPOINT` их не запускает. Без этих
 * двух строк сценарий на точках сохранения не проверял бы ровно тот инвариант,
 * ради которого триггеры и написаны, — и был бы зелёным на несбалансированной
 * записи. `IMMEDIATE` прогоняет накопленное, `DEFERRED` возвращает режим, иначе
 * первая же проводка следующего шага падала бы до второй.
 */
export function savepointStore(client: PoolClient, role: string = APP_ROLE): WorldStore {
  let depth = 0;
  return {
    async transact<T>(body: (tx: WorldTransaction) => Promise<T>): Promise<T> {
      depth += 1;
      const name = `step_${depth}`;
      await client.query(`SAVEPOINT ${name}`);
      // Роль — как в `pgWorldStore`. Умолчание то же самое: логин-роль набора
      // состоит и в `sdelka_owner`, то есть имеет права, которых у продукта
      // нет, и сценарий под ней проверял бы не то, что работает на проде.
      await client.query(`SET LOCAL ROLE ${role}`);
      try {
        const result = await body(pgWorldTransaction(client));
        await translating(async () => {
          await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        });
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
        await client.query('SET CONSTRAINTS ALL DEFERRED').catch(() => undefined);
        throw error;
      }
    },
  };
}
