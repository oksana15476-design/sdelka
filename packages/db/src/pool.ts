import pg from 'pg';
import { DbError, DbErrorCode } from './errors.ts';

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

/**
 * Таймауты пула. Все четыре заданы явно, потому что **по умолчанию их нет**.
 *
 * `pg-pool` ждёт соединения бесконечно (`connectionTimeoutMillis` не задан —
 * таймер не заводится вовсе), `query_timeout` и `statement_timeout` не заданы
 * тоже. Ждёт при этом не драйвер, а ядро: на адрес, который молча роняет
 * пакеты, Linux повторяет SYN `net.ipv4.tcp_syn_retries` раз (по умолчанию 6) и
 * сдаётся примерно через 130 с — и так на каждый файл набора.
 *
 * Замер на этом дереве до правки: `SDELKA_DATABASE_URL` на `10.255.255.1:5432`
 * (адрес, молча роняющий пакеты) — прогон убит по внешнему сроку на 200-й
 * секунде, успев отчитаться о пропуске ровно одного файла из восьми; каждый
 * файл пробует соединение заново, так что до конца набор шёл бы порядка
 * четверти часа. После правки тот же прогон — 44 с на все восемь файлов
 * (по 5,4 с на файл: 3 с проба плюс закрытие пула по сроку соединения).
 * «Базы нет» обязано звучать за считанные секунды, а не выглядеть как зависший
 * прогон: зависший прогон бросают по Ctrl-C и не читают вовсе.
 *
 * Откуда числа:
 *
 * - `CONNECT_TIMEOUT_MS` — рукопожатие с живым кластером занимает единицы
 *   миллисекунд локально и десятки в соседней сети. 5 с — это уже не
 *   «медленно», а «не отвечает». Сверху ограничено `hookTimeout` (60 с) и
 *   `testTimeout` (30 с) в `vitest.int.config.ts`: таймаут обязан сработать
 *   раньше, иначе вместо названной причины будет безымянный обрыв vitest;
 * - `STATEMENT_TIMEOUT_MS` — серверный. Сервер сам снимает запрос и отвечает
 *   `SQLSTATE 57014`: у отказа есть имя и место. 15 с при том, что самая
 *   тяжёлая наша операция — применение девяти файлов DDL на пустой базе
 *   (единицы секунд), а всё, что дольше, — это ожидание блокировки;
 * - `QUERY_TIMEOUT_MS` — клиентский подпор на случай, когда сервер не отвечает
 *   вовсе. Строго **больше** серверного: иначе клиент убил бы соединение
 *   раньше, чем сервер успел назвать причину, и вместо `57014` дежурный читал
 *   бы «connection terminated»;
 * - `IDLE_IN_TRANSACTION_TIMEOUT_MS` — открытая и забытая транзакция держит
 *   блокировки и блокирует следующий прогон миграций. 30 с — ровно `testTimeout`:
 *   транзакция, простаивающая дольше, чем тест имеет право жить, — это зависший
 *   тест, а не медленный.
 *
 * [открыто] Для боевых миграций серверный таймаут в 15 с мал: построение
 * индекса на заполненной таблице длится дольше. Решать это отдельным режимом
 * пула для миграций (или `CREATE INDEX CONCURRENTLY` с собственным таймаутом)
 * — вопрос к владельцу, пока таких миграций нет.
 */
export const CONNECT_TIMEOUT_MS = 5_000;
export const STATEMENT_TIMEOUT_MS = 15_000;
export const QUERY_TIMEOUT_MS = 20_000;
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * Срок пробы «база вообще есть?». Заведомо **короче** `CONNECT_TIMEOUT_MS`, и
 * это не украшение.
 *
 * Собственный таймаут `pg-pool` поднимает обычный `Error` с текстом
 * `Connection terminated due to connection timeout` — без кода, без класса.
 * Отличить его от любой другой ошибки можно было бы только разбором текста, а
 * текст сообщений драйвера не наш контракт и меняется с версией. Поэтому пробу
 * судит **наш** таймер: он срабатывает первым и поднимает `DbError` с
 * `db.connect.timeout`, который опознаётся по коду, а не по буквам. Таймаут
 * пула при этом остаётся — он рвёт сокет, который проба уже бросила.
 */
export const PROBE_TIMEOUT_MS = 3_000;

export function createPool(connectionString: string): pg.Pool {
  configureTypeParsers();
  return new pg.Pool({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });
}

/** Минимум, на что отвечает живой сервер. Разбирать нечего — важен сам ответ. */
const PROBE_SQL = 'SELECT 1';

/** Пробе достаточно уметь спросить: подделка в тестах не тащит за собой весь пул. */
export interface Queryable {
  query(text: string): Promise<unknown>;
}

/**
 * Проба соединения со сроком. Успех — база ответила; отказ — `DbError`
 * `db.connect.timeout` либо ошибка драйвера как есть.
 */
export async function probeConnection(
  pool: Queryable,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DbError(DbErrorCode.connectTimeout, { timeoutMs: String(timeoutMs) }));
    }, timeoutMs);
    // Незакрытый таймер не имеет права держать процесс живым дольше прогона.
    timer.unref?.();
  });
  try {
    await Promise.race([pool.query(PROBE_SQL), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Коды, при которых базы **нет**: не «мы с ней не сговорились», а до неё не
 * добрались. Список закрытый и назван поимённо — см. `isDatabaseUnreachable`.
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', // порт закрыт: кластер не поднят
  'ENOTFOUND', // имя хоста не разрешилось
  'EAI_AGAIN', // резолвер не ответил
  'EHOSTUNREACH', // хоста нет в сети
  'ENETUNREACH', // сети нет
  'ETIMEDOUT', // ядро сдалось после повторов SYN
]);

/**
 * «До базы не добрались» — единственное основание пропустить интеграционный
 * набор. Всё остальное обязано ронять прогон.
 *
 * Правило не по тексту ошибки, а по её роду:
 *
 * - наш `db.connect.timeout` — ответа не было в отведённый срок: недоступна;
 * - `DatabaseError` — **сервер ответил**. Неверный пароль (`28P01`), нет такой
 *   базы (`3D000`), нет записи в `pg_hba` (`28000`) — это настроено неверно, а
 *   не «базы нет». Пропустить набор здесь значило бы отчитаться зелёным о
 *   непроверенной схеме — ровно та ложь, ради которой каркас и переписывали;
 * - системная ошибка сокета из закрытого списка — недоступна;
 * - **всё прочее — не недоступность.** Неизвестная ошибка обязана быть
 *   громкой: пропуск требует доказательства, а не отсутствия возражений.
 */
export function isDatabaseUnreachable(error: unknown): boolean {
  if (error instanceof DbError) return error.code === DbErrorCode.connectTimeout;
  if (error instanceof pg.DatabaseError) return false;
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' && UNREACHABLE_CODES.has(code);
}

export type { Pool, PoolClient, QueryResult } from 'pg';
