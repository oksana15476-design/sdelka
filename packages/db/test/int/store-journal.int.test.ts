import {
  type EntryMeta,
  type Journal,
  type JournalEntry,
  DEFAULT_FEE_CEILING,
  accrueFee,
  appendEntry,
  checkLedgerInvariants,
  clientKey,
  clientTopUp,
  emptyJournal,
  feeCeiling,
  identifySuspense,
  lockForTranche,
  unlockToClientAccount,
} from '@sdelka/ledger';
import { LedgerError, LedgerErrorCode } from '@sdelka/ledger';
import { money, rational } from '@sdelka/money';
import { expect, it } from 'vitest';
import { DbError, DbErrorCode } from '../../src/errors.ts';
import { appendJournal, readJournal } from '../../src/store/journal.ts';
import { dbSuite, withRollback } from './support/pg.ts';

/**
 * Круг «мир → база → мир» по журналу учёта.
 *
 * Главное утверждение набора одно и оно проверяемо целиком:
 * **`checkLedgerInvariants` на прочитанном журнале даёт то же, что на
 * исходном**. Пока хранилища не было, эта проверка не могла существовать —
 * читать было нечего, и 161 интеграционный тест сторожил схему, которую в
 * рантайме не наполнял никто.
 */
const { run, title, pool } = await dbSuite('хранилище: журнал учёта');

const GEL = 'GEL' as const;
const BUYER = clientKey('buyer-store');
const DEAL = 'deal-store';
const TRANCHE = 'tranche-store';

function meta(id: string, at: string): EntryMeta {
  return { id, occurredAt: at };
}

/**
 * Журнал, который схема удержать может: зачисление, опознание непознанного,
 * запирание под транш и расфиксация. Ни одного объявления, для которого в
 * `ledger_entry` нет колонки, — см. `store-journal-refusal`.
 */
function sampleJournal(): Journal {
  const amount = money(GEL, 20_000_000n);
  const entries: readonly JournalEntry[] = [
    clientTopUp(meta('e-1-top-up', '2026-03-01T10:00:00.000Z'), BUYER, amount),
    identifySuspense(meta('e-2-identify', '2026-03-01T11:00:00.000Z'), BUYER, money(GEL, 500n)),
    lockForTranche(
      meta('e-3-lock', '2026-03-02T10:00:00.000Z'),
      BUYER,
      { dealId: DEAL, trancheId: TRANCHE },
      amount,
    ),
    unlockToClientAccount(
      meta('e-4-unlock', '2026-03-03T10:00:00.000Z'),
      BUYER,
      { dealId: DEAL, trancheId: TRANCHE },
      amount,
    ),
  ];
  return entries.reduce(appendEntry, emptyJournal);
}

run(title, () => {
  it('прочитанный журнал равен записанному', async () => {
    if (pool === null) return;
    const source = sampleJournal();
    await withRollback(pool, async (client) => {
      const outcome = await appendJournal(client, source.entries);
      expect(outcome).toEqual({ written: 4, repeated: 0 });
      const read = await readJournal(client);
      // Не «похож», а равен: идентификаторы, порядок, вид, ключ операции,
      // ссылка исправления, объявление расчёта и все проводки со счётом,
      // направлением, суммой и отнесением.
      expect(read).toEqual(source);
    });
  });

  it('инварианты на прочитанном совпадают с инвариантами на исходном', async () => {
    if (pool === null) return;
    const source = sampleJournal();
    await withRollback(pool, async (client) => {
      await appendJournal(client, source.entries);
      const read = await readJournal(client);
      expect(checkLedgerInvariants(read)).toEqual(checkLedgerInvariants(source));
    });
  });

  it('сумма приезжает обратно целым, а не числом', async () => {
    if (pool === null) return;
    // Красная линия №4. Величина заведомо больше 2^53: через `number` она
    // проходит с потерей, и потеря эта молчаливая.
    const huge = money(GEL, 9_007_199_254_740_993_000n);
    const entry = clientTopUp(meta('e-huge', '2026-03-01T10:00:00.000Z'), BUYER, huge);
    await withRollback(pool, async (client) => {
      await appendJournal(client, [entry]);
      const read = await readJournal(client);
      const posting = read.entries[0]?.postings[0];
      expect(typeof posting?.amount.minor).toBe('bigint');
      expect(posting?.amount.minor).toBe(9_007_199_254_740_993_000n);
    });
  });

  it('повтор того же шага не задваивает и не падает', async () => {
    if (pool === null) return;
    const source = sampleJournal();
    await withRollback(pool, async (client) => {
      await appendJournal(client, source.entries);
      const again = await appendJournal(client, source.entries);
      // Повтор виден числом, а не молчанием: «повторили» и «записали дважды»
      // обязаны различаться.
      expect(again).toEqual({ written: 0, repeated: 4 });
      const read = await readJournal(client);
      expect(read.entries).toHaveLength(4);
      expect(read).toEqual(source);
    });
  });

  it('другая запись под тем же идентификатором — конфликт с именем', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await appendJournal(client, [
        clientTopUp(meta('e-clash', '2026-03-01T10:00:00.000Z'), BUYER, money(GEL, 100n)),
      ]);
      const other = clientTopUp(
        meta('e-clash', '2026-03-01T10:00:00.000Z'),
        BUYER,
        money(GEL, 200n),
      );
      const error = await appendJournal(client, [other]).catch((item: unknown) => item);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe(DbErrorCode.stepConflict);
    });
  });

  it('объявление, которого схема не держит, отвергается на записи', async () => {
    if (pool === null) return;
    // Начисление комиссии несёт версию тарифного плана, а колонки под неё в
    // `ledger_entry` нет. Записать «как получится» значило бы вернуть при
    // чтении другую запись — см. `db.entry.declaration_not_storable`.
    const accrual = accrueFee(
      meta('e-accrual', '2026-03-01T10:00:00.000Z'),
      { dealId: DEAL, trancheId: TRANCHE },
      money(GEL, 1_000n),
      'tariff-v1',
    );
    await withRollback(pool, async (client) => {
      const error = await appendJournal(client, [accrual]).catch((item: unknown) => item);
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe(DbErrorCode.entryDeclarationNotStorable);
      expect((error as DbError).details['field']).toBe('accrues');
      // Отказ произошёл до вставки: половины записи в базе не осталось.
      const read = await readJournal(client);
      expect(read.entries).toEqual([]);
    });
  });

  it('потолок удержания строже жёсткого предела тоже отвергается', async () => {
    if (pool === null) return;
    // Потолок в схеме не хранится, а умолчание при чтении — жёсткий предел
    // учёта. Записать более строгий и прочитать более широкий значило бы
    // вернуть расчёт, которому разрешено больше, чем было разрешено.
    expect(DEFAULT_FEE_CEILING.maxShare).toEqual(rational(2n, 100n));
    expect(feeCeiling(rational(1n, 100n)).maxShare).toEqual(rational(1n, 100n));
  });

  it('отказ базы приезжает ключом учёта, а не текстом драйвера', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      // Отнесение проводки одновременно к клиенту и к траншу схема запрещает
      // ограничением `ledger_posting_attribution_shape`; в коде это то же
      // правило, что `postingAttributionMismatch`. Конструктор записи такую
      // проводку не соберёт, поэтому строка кладётся мимо него — так же, как
      // её положил бы посторонний инструмент.
      const error = await client
        .query(
          `INSERT INTO sdelka.ledger_posting (
             entry_id, ord, account_kind, direction, currency, amount_minor,
             attribution_client_key, attribution_deal_id, attribution_tranche_id
           ) VALUES ('e-x', 0, 'fee_income', 'debit', 'GEL', 1, 'c', 'd', 't')`,
        )
        .catch((item: unknown) => item);
      const { translateStorageError } = await import('../../src/store/errors.ts');
      const translated = translateStorageError(error);
      expect(translated).toBeInstanceOf(LedgerError);
      expect((translated as LedgerError).code).toBe(LedgerErrorCode.postingAttributionMismatch);
    });
  });
});
