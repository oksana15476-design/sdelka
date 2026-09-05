import { expect, it } from 'vitest';
import type { PoolClient } from '../../src/pool.ts';
import { dbSuite, errorKey, withRollback } from './support/pg.ts';

/**
 * Второй контур зеркальности исправления — на живой базе.
 *
 * Правило живёт в коде (`ledger/src/journal.ts`,
 * `assertCorrectionMirrorsTarget`), но роль приложения имеет право `INSERT` в
 * журнал, и запись может лечь мимо `appendEntry`. Здесь проверяется, что тогда
 * её останавливает база — тем же ключом, что и код.
 *
 * Сценарий каждый раз начинается с законного пути целиком: деньги пришли,
 * заперлись под транш и списаны в терминальный пул. Иначе первым сработал бы
 * отрицательный остаток клиентского счёта — и тест был бы зелёным не по той
 * причине, по которой написан.
 */
const suite = await dbSuite('исправление — зеркало своей цели');

const ENTRY = `INSERT INTO sdelka.ledger_entry (entry_id, occurred_at, kind, memo_key, corrects_entry_id)
               VALUES ($1, '2026-09-05T10:00:00Z', $2, 'ledger.entry.unclaimed', $3)`;

const POSTING = `INSERT INTO sdelka.ledger_posting
  (entry_id, ord, account_kind, account_currency, client_key,
   account_deal_id, account_tranche_id, direction, currency, amount_minor,
   attribution_client_key, attribution_deal_id, attribution_tranche_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'GEL', $9, $10, $11, $12)`;

type Row = readonly [
  kind: string,
  currency: string | null,
  clientKey: string | null,
  dealId: string | null,
  trancheId: string | null,
  direction: string,
  minor: string,
  attributionClient: string | null,
  attributionDeal: string | null,
  attributionTranche: string | null,
];

const SUM = '10000000';

/** Зачисление на счёт клиента (`clientTopUp`). */
const TOP_UP: readonly Row[] = [
  ['bank_nominal', 'GEL', null, null, null, 'debit', SUM, 'c1', null, null],
  ['client_free', null, 'c1', null, null, 'credit', SUM, 'c1', null, null],
];

/** Привязка денег к траншу (`lockForTranche`). */
const LOCK: readonly Row[] = [
  ['client_free', null, 'c1', null, null, 'debit', SUM, 'c1', null, null],
  ['client_locked', null, 'c1', 'A', 't1', 'credit', SUM, null, 'A', 't1'],
  ['bank_nominal', 'GEL', null, null, null, 'credit', SUM, 'c1', null, null],
  ['bank_nominal', 'GEL', null, null, null, 'debit', SUM, null, 'A', 't1'],
];

/** Списание невостребованных, момент 1 (`writeOffUnclaimed`). */
const WRITE_OFF: readonly Row[] = [
  ['client_locked', null, 'c1', 'A', 't1', 'debit', SUM, null, 'A', 't1'],
  ['bank_nominal', 'GEL', null, null, null, 'credit', SUM, null, 'A', 't1'],
  ['transit_writeoff', null, null, null, null, 'debit', SUM, null, null, null],
  ['unclaimed_liability', null, null, null, null, 'credit', SUM, null, null, null],
];

function mirrored(rows: readonly Row[]): readonly Row[] {
  return rows.map(
    (row) =>
      [
        row[0],
        row[1],
        row[2],
        row[3],
        row[4],
        row[5] === 'debit' ? 'credit' : 'debit',
        row[6],
        row[7],
        row[8],
        row[9],
      ] as unknown as Row,
  );
}

/** То же самое в обратную сторону: отмена ошибочного списания. */
const UNDO_WRITE_OFF = mirrored(WRITE_OFF);

/**
 * Атака: содержимое терминального пула уезжает постороннему лицу.
 *
 * Кастодиан едет вместе с обязательством, поэтому пофайловый прирост ровно
 * нулевой, покрытие остаётся 1/1, а сама запись сбалансирована повалютно.
 * Единственное, чем она отличается от отмены списания, — счета и файлы,
 * которых её цель не трогала.
 */
const POOL_PAYOUT: readonly Row[] = [
  ['unclaimed_liability', null, null, null, null, 'debit', SUM, null, null, null],
  ['client_free', null, 'c9', null, null, 'credit', SUM, 'c9', null, null],
  ['transit_writeoff', null, null, null, null, 'credit', SUM, null, null, null],
  ['bank_nominal', 'GEL', null, null, null, 'debit', SUM, 'c9', null, null],
];

suite.run(suite.title, () => {
  const pool = suite.pool;

  async function write(
    client: PoolClient,
    entryId: string,
    correctsEntryId: string | null,
    rows: readonly Row[],
  ): Promise<void> {
    await client.query(ENTRY, [
      entryId,
      correctsEntryId === null ? 'settlement' : 'correction',
      correctsEntryId,
    ]);
    let ord = 0;
    for (const row of rows) {
      await client.query(POSTING, [entryId, ord, ...row]);
      ord += 1;
    }
  }

  /** Законный путь целиком, с проверенными отложенными правилами. */
  async function writtenOff(client: PoolClient, prefix: string): Promise<void> {
    await write(client, `${prefix}-1`, null, TOP_UP);
    await write(client, `${prefix}-2`, null, LOCK);
    await write(client, `${prefix}-3`, null, WRITE_OFF);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    // Дальше пишется ещё одна запись, а немедленные проверки не дают собрать её
    // по строкам: до последней проводки запись не сходится никогда.
    await client.query('SET CONSTRAINTS ALL DEFERRED');
  }

  async function expectRefused(client: PoolClient, hint: string): Promise<void> {
    let failed = false;
    try {
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    } catch (error) {
      failed = true;
      expect(errorKey(error)).toBe('ledger.journal.correction_not_mirror');
    }
    expect(failed, hint).toBe(true);
  }

  it('отмена ошибочного списания проходит: зеркало цели целиком', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await writtenOff(client, 'm-w');
      await write(client, 'm-w-undo', 'm-w-3', UNDO_WRITE_OFF);
      // Именно здесь отложенные проверки и срабатывают.
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });

  it('выдача невостребованных постороннему лицу отвергается на коммите', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await writtenOff(client, 'm-a');
      await write(client, 'm-a-attack', 'm-a-3', POOL_PAYOUT);
      await expectRefused(client, 'файла постороннего лица цель не трогала');
    });
  });

  it('ссылка на постороннюю запись исправлением её не делает', async () => {
    if (pool === null) return;
    // Цель существует — внешний ключ доволен, — но к содержанию исправления
    // отношения не имеет: `m-b-1` это зачисление. До зеркальности существование
    // цели было единственной проверкой ссылки.
    await withRollback(pool, async (client) => {
      await writtenOff(client, 'm-b');
      await write(client, 'm-b-attack', 'm-b-1', POOL_PAYOUT);
      await expectRefused(client, 'цель к содержанию исправления отношения не имеет');
    });
  });

  it('движение в ту же сторону, что и цель, исправлением не является', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await writtenOff(client, 'm-c');
      await write(client, 'm-c-again', 'm-c-3', WRITE_OFF);
      await expectRefused(client, 'это второе такое же списание, а не отмена');
    });
  });

  it('цель отдаётся один раз: второе исправление той же цели отвергается', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await writtenOff(client, 'm-d');
      await write(client, 'm-d-undo', 'm-d-3', UNDO_WRITE_OFF);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await write(client, 'm-d-undo-2', 'm-d-3', UNDO_WRITE_OFF);
      await expectRefused(client, 'отмотано вдвое больше, чем цель двинула');
    });
  });

  it('проводка, дописанная к лежащему исправлению, тоже проверяется', async () => {
    if (pool === null) return;
    // Журнал дополняется, но не запечатывается: проводку можно дописать к уже
    // лежащей записи отдельной транзакцией. Проверка, стоящая только на вставке
    // записи, такую дописку не увидела бы.
    await withRollback(pool, async (client) => {
      await writtenOff(client, 'm-e');
      await write(client, 'm-e-undo', 'm-e-3', UNDO_WRITE_OFF);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      // Две проводки: запись остаётся сбалансированной, поэтому ответить
      // обязана именно зеркальность, а не триггер нулевой суммы.
      await client.query(POSTING, [
        'm-e-undo',
        9,
        'client_free',
        null,
        'c9',
        null,
        null,
        'credit',
        SUM,
        'c9',
        null,
        null,
      ]);
      await client.query(POSTING, [
        'm-e-undo',
        10,
        'bank_nominal',
        'GEL',
        null,
        null,
        null,
        'debit',
        SUM,
        'c9',
        null,
        null,
      ]);
      await expectRefused(client, 'дописка мимо цели обязана быть видна');
    });
  });
});
