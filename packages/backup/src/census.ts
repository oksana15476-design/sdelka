import { SCHEMA_NAME, readAppliedMigrations, readJournal, toBigInt } from '@sdelka/db';
import { coverage } from '@sdelka/ledger';
import { BackupError, BackupErrorCode } from './errors.ts';
import type { PoolClient } from './pool.ts';

/**
 * Перепись базы — то, с чем потом сверяется восстановленное.
 *
 * **Зачем она вообще нужна.** Без переписи проверка восстановления умеет
 * ответить только «файл прочитался и `pg_restore` не ругался». Этого мало до
 * бесполезности: обрезанный дамп восстанавливается молча ровно до места
 * обрыва, а копия, снятая не с той базы, восстанавливается целиком и выглядит
 * безупречно. Проверка обязана знать, **сколько** и **чего** было в источнике
 * — иначе ноль строк в восстановленной базе читается как успех.
 *
 * Перепись снимается **в том же снимке**, что и дамп (`dump.ts`, экспорт
 * снимка). Перепись, снятая до или после `pg_dump`, сверяла бы копию с другим
 * состоянием базы, и каждое расхождение приходилось бы объяснять «наверное,
 * просто что-то дописалось».
 *
 * Все количества — **строки десятичных цифр**, а не числа. `count(*)` в
 * Postgres это `bigint`, а суммы проводок — `numeric(38,0)`; и то и другое
 * выходит за 2^53, а красная линия №4 запрещает плавающую точку не только в
 * домене. Строка переживает JSON без потерь, число — нет.
 */
export const CENSUS_FORMAT_VERSION = 1;

export interface TableCount {
  readonly table: string;
  readonly rows: string;
}

export interface AppliedMigrationRow {
  readonly version: string;
  readonly checksum: string;
}

export interface ChainSummary {
  readonly chainId: string;
  readonly records: string;
  /** Хеш последней записи цепочки. Меняется от любой правки любого её звена. */
  readonly head: string;
}

export interface PostingSum {
  readonly currency: string;
  /** Дебет минус кредит по всем проводкам. Обязан быть нулём. */
  readonly sumMinor: string;
}

export interface CoveragePoint {
  readonly currency: string;
  readonly custodyMinor: string;
  readonly obligationsMinor: string;
  readonly covered: boolean;
}

export interface Census {
  readonly formatVersion: number;
  /** Последняя применённая миграция. Пусто — таблицы учёта миграций нет вовсе. */
  readonly schemaVersion: string;
  readonly migrations: readonly AppliedMigrationRow[];
  readonly tables: readonly TableCount[];
  readonly auditRecords: string;
  readonly chains: readonly ChainSummary[];
  readonly journalEntries: string;
  readonly postingSums: readonly PostingSum[];
  readonly coverage: readonly CoveragePoint[];
}

/**
 * Пояс безопасности над именем таблицы. Имена приезжают из `pg_class` нашей же
 * схемы, то есть подставить туда чужое нечем; но запрос собирается склейкой, а
 * склейка без проверки — это привычка, которая однажды применяется к имени,
 * пришедшему снаружи.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;

const SELECT_TABLES = `
  SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relkind = 'r'
   ORDER BY c.relname`;

/**
 * Головы цепочек. `DISTINCT ON` по убыванию `seq` — последняя запись каждой
 * цепочки; её хеш покрывает весь конверт и, через `prev_hash`, всю историю до
 * генезиса. Одна изменённая запись в середине меняет голову.
 */
const SELECT_CHAINS = `
  SELECT chain_id, count(*)::text AS records
    FROM sdelka.audit_record
   GROUP BY chain_id
   ORDER BY chain_id`;

const SELECT_CHAIN_HEADS = `
  SELECT DISTINCT ON (chain_id) chain_id, record_hash
    FROM sdelka.audit_record
   ORDER BY chain_id, seq DESC`;

/**
 * Сумма проводок по валютам. Знак несёт направление, а не сумма
 * (`0002_ledger.sql`), поэтому знак восстанавливается здесь, а не берётся из
 * колонки. Ноль по каждой валюте — тот же инвариант, что держит триггер
 * `assert_entry_balanced`, только посчитанный по журналу целиком: триггер
 * сторожит запись, а копия может потерять строку из уже принятой записи.
 */
const SELECT_POSTING_SUMS = `
  SELECT currency,
         sum(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END)::text AS sum_minor
    FROM sdelka.ledger_posting
   GROUP BY currency
   ORDER BY currency`;

async function countRows(client: PoolClient, table: string): Promise<string> {
  if (!IDENTIFIER.test(table)) {
    throw new BackupError(BackupErrorCode.manifestInvalid, { table });
  }
  const result = await client.query<{ rows: string }>(
    `SELECT count(*)::text AS rows FROM "${SCHEMA_NAME}"."${table}"`,
  );
  return result.rows[0]?.rows ?? '0';
}

async function tableCounts(client: PoolClient): Promise<readonly TableCount[]> {
  const names = await client.query<{ name: string }>(SELECT_TABLES, [SCHEMA_NAME]);
  const counts: TableCount[] = [];
  for (const row of names.rows) {
    counts.push(Object.freeze({ table: row.name, rows: await countRows(client, row.name) }));
  }
  return Object.freeze(counts);
}

async function chainSummaries(client: PoolClient): Promise<readonly ChainSummary[]> {
  const counts = await client.query<{ chain_id: string; records: string }>(SELECT_CHAINS);
  const heads = await client.query<{ chain_id: string; record_hash: string }>(SELECT_CHAIN_HEADS);
  const headOf = new Map(heads.rows.map((row) => [row.chain_id, row.record_hash]));
  return Object.freeze(
    counts.rows.map((row) =>
      Object.freeze({
        chainId: row.chain_id,
        records: row.records,
        head: headOf.get(row.chain_id) ?? '',
      }),
    ),
  );
}

/**
 * Причина, по которой журнал поднимается целиком. Охват у `readJournal`
 * обязателен намеренно, и «весь журнал» обязано быть написанным решением
 * (`db/src/store/port.ts`), а не пропущенным аргументом.
 */
export const CENSUS_JOURNAL_REASON = 'backup.census.full_journal';

/**
 * Покрытие клиентских средств (красная линия №3) считается **тем же кодом**,
 * что и в бою: журнал поднимается `readJournal`, покрытие — `coverage` из
 * `@sdelka/ledger`. Второй реализации «покрытия для резервных копий» здесь нет
 * и быть не должно — она разошлась бы с первой и объявляла бы сходимость там,
 * где её нет.
 *
 * ⚠ Подъём журнала целиком заново прогоняет правила учёта (`appendEntry`), и
 * это дорого: на боевом объёме перепись будет измеряться минутами.
 * **[гипотеза]** — измерено только на учебных объёмах; порог, за которым нужен
 * инкрементальный расчёт, назовёт первый прогон на живых данных.
 */
async function coveragePoints(client: PoolClient): Promise<readonly CoveragePoint[]> {
  const journal = await readJournal(client, {
    kind: 'everything',
    reasonKey: CENSUS_JOURNAL_REASON,
  });
  return Object.freeze(
    coverage(journal).map((item) =>
      Object.freeze({
        currency: item.currency,
        custodyMinor: item.custody.minor.toString(),
        obligationsMinor: item.obligations.minor.toString(),
        covered: item.covered,
      }),
    ),
  );
}

async function scalar(client: PoolClient, sql: string): Promise<string> {
  const result = await client.query<{ value: string }>(sql);
  return result.rows[0]?.value ?? '0';
}

/** Перепись по живому соединению. Ничего не меняет и ничего не блокирует. */
export async function takeCensus(client: PoolClient): Promise<Census> {
  const applied = await readAppliedMigrations(client);
  const migrations = (applied ?? []).map((item) =>
    Object.freeze({ version: item.version, checksum: item.checksum }),
  );
  const postings = await client.query<{ currency: string; sum_minor: string }>(
    SELECT_POSTING_SUMS,
  );
  return Object.freeze({
    formatVersion: CENSUS_FORMAT_VERSION,
    schemaVersion: migrations.at(-1)?.version ?? '',
    migrations: Object.freeze(migrations),
    tables: await tableCounts(client),
    auditRecords: await scalar(
      client,
      'SELECT count(*)::text AS value FROM sdelka.audit_record',
    ),
    chains: await chainSummaries(client),
    journalEntries: await scalar(
      client,
      'SELECT count(*)::text AS value FROM sdelka.ledger_entry',
    ),
    postingSums: Object.freeze(
      postings.rows.map((row) =>
        // Через `toBigInt` и обратно: драйвер отдаёт `numeric` строкой, и
        // сравнивать строки напрямую значило бы считать `-0` и `0` разными.
        Object.freeze({ currency: row.currency, sumMinor: toBigInt(row.sum_minor).toString() }),
      ),
    ),
    coverage: await coveragePoints(client),
  });
}
