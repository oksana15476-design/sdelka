import pg from 'pg';

/**
 * Разборщики типов драйвера.
 *
 * **Красная линия №4 переживает границу процесса только здесь.** По умолчанию
 * `pg` отдаёт `numeric` строкой, но `int8` — тоже строкой, а `int4`, `float4` и
 * `float8` — числом. Одна колонка, объявленная не тем типом, и сумма приезжает
 * из базы как `number`: до 2^53 незаметно, дальше молча теряет точность. В
 * денежном домене это не «редкий случай», а тихая порча.
 *
 * Поэтому:
 *
 * - `numeric` и `int8` остаются строкой и превращаются в `bigint` явно
 *   (`toBigInt` ниже). Строку в `Number` не приводит никто;
 * - `float4`/`float8` **не разбираются вовсе**: разборщик поднимает ошибку. В
 *   денежной схеме таких колонок нет по построению (тест дрейфа запрещает их в
 *   миграциях), и если такая колонка когда-нибудь появится, узнать об этом надо
 *   в тесте, а не в проде.
 *
 * `canonical.ts` в `packages/audit` предупреждает ровно об этом: запись,
 * поднятая из базы другим драйвером, обязана давать тот же хеш. Если `numeric`
 * где-то станет `number`, цепочка объявит себя сломанной.
 */
const OID_INT8 = 20;
const OID_FLOAT4 = 700;
const OID_FLOAT8 = 701;
const OID_NUMERIC = 1700;

export const FLOAT_PARSER_MESSAGE = 'db.driver.float_forbidden';

let configured = false;

export function configureTypeParsers(): void {
  if (configured) return;
  configured = true;
  pg.types.setTypeParser(OID_NUMERIC, (value: string) => value);
  pg.types.setTypeParser(OID_INT8, (value: string) => value);
  const forbidFloat = (): never => {
    throw new Error(FLOAT_PARSER_MESSAGE);
  };
  pg.types.setTypeParser(OID_FLOAT4, forbidFloat);
  pg.types.setTypeParser(OID_FLOAT8, forbidFloat);
}

/**
 * Целое из того, что вернул драйвер. Через `String`, а не через `Number`:
 * `BigInt(number)` для дробного значения бросает, но для целого `number`,
 * успевшего потерять точность, — молча возвращает испорченное значение.
 */
export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return BigInt(value);
  throw new Error(`db.driver.unexpected_numeric_type:${typeof value}`);
}

export function createPool(connectionString: string): pg.Pool {
  configureTypeParsers();
  return new pg.Pool({ connectionString });
}

export type { Pool, PoolClient, QueryResult } from 'pg';
