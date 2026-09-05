import {
  type ClientKey,
  type DealPartiesAttestation,
  type EntryMeta,
  type Journal,
  type JournalEntry,
  type TrancheRef,
  DEFAULT_FEE_CEILING,
  absorbShortfall,
  accrueFee,
  appendEntries,
  appendEntry,
  checkLedgerInvariants,
  clientKey,
  clientTopUp,
  emptyJournal,
  executeConversion,
  feeCeiling,
  fundShortfall,
  fxExecution,
  identifySuspense,
  lockForTranche,
  receiveConversion,
  receiveFee,
  sendForConversion,
  settleTrancheToClientAccount,
  trancheSettlement,
  unlockToClientAccount,
} from '@sdelka/ledger';
import { LedgerError, LedgerErrorCode } from '@sdelka/ledger';
import {
  convert,
  fxRates,
  isoDate,
  money,
  platformSpread,
  rational,
  rationalFromDecimalString,
} from '@sdelka/money';
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
const SELLER = clientKey('seller-store');
const DEAL = 'deal-store';
const TRANCHE = 'tranche-store';

function meta(id: string, at: string): EntryMeta {
  return { id, occurredAt: at };
}

/**
 * Подтверждение сторон домена — приведением, как в наборе-зеркале.
 * `DealPartiesAttestation` держится на ambient-символе: значения этого типа не
 * существует, и построить его кодом нельзя. Учёт состав участников не знает и
 * знать не может, поэтому в тесте домен играет тест — но играет честно: то же
 * подтверждение, что выдаст автомат сделки, на ту же пару сторон.
 */
function attest(deal: TrancheRef, payer: ClientKey, recipient: ClientKey): DealPartiesAttestation {
  return {
    dealId: deal.dealId,
    trancheId: deal.trancheId,
    payer,
    recipient,
    evidenceRef: 'evidence-store',
  } as unknown as DealPartiesAttestation;
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

  /**
   * Три объявления, которых схема не держала вовсе, и потолок удержания
   * четвёртого.
   *
   * Прежде здесь стояла проба на отказ `db.entry.declaration_not_storable`:
   * колонок под `converts`, `accrues` и `funds` в `ledger_entry` не было, и
   * писать запись «как получится» значило бы вернуть при чтении другую.
   * `0021_entry_declarations.sql` завела колонки, отказ снят, и утверждение
   * стало обратным — **каждое объявление ложится и поднимается тем же
   * значением**. Проверяется равенством записи целиком, а не наличием колонок:
   * колонка, в которую пишут и не читают, равна сама себе всегда.
   */
  it('начисление комиссии ложится с версией тарифного плана и читается обратно', async () => {
    if (pool === null) return;
    const tranche = { dealId: DEAL, trancheId: TRANCHE };
    const accrual = accrueFee(
      meta('e-accrual', '2026-03-01T12:00:00.000Z'),
      tranche,
      money(GEL, 2_000n),
      'tariff-v1',
    );
    const source = appendEntries(emptyJournal, [
      clientTopUp(meta('e-a1-top-up', '2026-03-01T10:00:00.000Z'), BUYER, money(GEL, 100_000n)),
      lockForTranche(
        meta('e-a2-lock', '2026-03-01T11:00:00.000Z'),
        BUYER,
        tranche,
        money(GEL, 100_000n),
      ),
      accrual,
      settleTrancheToClientAccount(
        meta('e-a3-settle', '2026-03-01T13:00:00.000Z'),
        trancheSettlement(tranche, BUYER, SELLER, attest(tranche, BUYER, SELLER)),
        money(GEL, 100_000n),
        accrual,
      ),
      receiveFee(meta('e-a4-fee', '2026-03-01T14:00:00.000Z'), tranche, money(GEL, 2_000n)),
    ]);
    await withRollback(pool, async (client) => {
      expect(await appendJournal(client, source.entries)).toEqual({ written: 5, repeated: 0 });
      const read = await readJournal(client);
      expect(read).toEqual(source);
      // Версия плана — не украшение записи: §4.2 запрещает пересчёт задним
      // числом, и восстановить её из проводок нельзя.
      expect(read.entries[2]?.accrues?.tariffVersionId).toBe('tariff-v1');
    });
  });

  it('обмен ложится с тремя курсами и датой', async () => {
    if (pool === null) return;
    const usd = money('USD', 8_000_000n);
    const converted = convert(
      usd,
      fxRates('USD', GEL, {
        client: rationalFromDecimalString('2.6686875'),
        reference: rationalFromDecimalString('2.6875'),
        official: rationalFromDecimalString('2.7000'),
      }),
      isoDate('2026-03-01'),
      'trunc',
    );
    const exchange = fxExecution('x-store', converted);
    const source = appendEntries(emptyJournal, [
      clientTopUp(meta('e-c0-top-up', '2026-03-01T10:00:00.000Z'), BUYER, usd),
      sendForConversion(meta('e-c1-sent', '2026-03-01T11:00:00.000Z'), BUYER, exchange),
      executeConversion(meta('e-c2-executed', '2026-03-01T12:00:00.000Z'), BUYER, exchange),
      receiveConversion(
        meta('e-c3-received', '2026-03-01T13:00:00.000Z'),
        BUYER,
        exchange,
        platformSpread(converted, 'trunc'),
      ),
    ]);
    await withRollback(pool, async (client) => {
      expect(await appendJournal(client, source.entries)).toEqual({ written: 4, repeated: 0 });
      const read = await readJournal(client);
      expect(read).toEqual(source);
      // И14.2: выписка требует курсы. Из двух сумм курс не восстанавливается —
      // усечение необратимо, — поэтому все три хранятся целыми числителем и
      // знаменателем, а не числом с плавающей точкой (красная линия №4).
      const rates = read.entries[1]?.converts?.converted.rates;
      expect(rates?.client.value).toEqual(rational(26_686_875n, 10_000_000n));
      expect(rates?.reference.value).toEqual(rational(26_875n, 10_000n));
      expect(rates?.official.value).toEqual(rational(27_000n, 10_000n));
      expect(read.entries[1]?.converts?.converted.asOf).toBe('2026-03-01');
    });
  });

  it('довнесение недостачи ложится со ссылкой на признание', async () => {
    if (pool === null) return;
    const recognised = absorbShortfall(
      meta('e-sh1-recognised', '2026-03-01T10:00:00.000Z'),
      BUYER,
      money(GEL, 99_900n),
      money(GEL, 100n),
    );
    const source = appendEntries(emptyJournal, [
      recognised,
      fundShortfall(meta('e-sh2-funded', '2026-03-01T11:00:00.000Z'), recognised),
    ]);
    await withRollback(pool, async (client) => {
      expect(await appendJournal(client, source.entries)).toEqual({ written: 2, repeated: 0 });
      const read = await readJournal(client);
      expect(read).toEqual(source);
      expect(read.entries[1]?.funds?.recognisedEntryId).toBe('e-sh1-recognised');
    });
  });

  it('второе довнесение по тому же признанию база не принимает', async () => {
    if (pool === null) return;
    // Ровно то, ради чего ссылка и заведена: пока её не было, одно признание
    // довносилось сколько угодно раз, и ловил это только инвариант
    // `shortfall_overfunded` — сложением по клиенту за всю историю, постфактум.
    // В коде это `assertShortfallFundingResolves`, в схеме — частичный
    // уникальный индекс `ledger_entry_shortfall_funded_once`.
    const recognised = absorbShortfall(
      meta('e-twice-recognised', '2026-03-01T10:00:00.000Z'),
      BUYER,
      money(GEL, 99_900n),
      money(GEL, 100n),
    );
    const first = fundShortfall(meta('e-twice-1', '2026-03-01T11:00:00.000Z'), recognised);
    const second = fundShortfall(meta('e-twice-2', '2026-03-01T12:00:00.000Z'), recognised);
    await withRollback(pool, async (client) => {
      await appendJournal(client, [recognised, first]);
      const error = await appendJournal(client, [second]).catch((item: unknown) => item);
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe(LedgerErrorCode.journalShortfallFundedTwice);
    });
  });

  it('потолок удержания строже жёсткого предела ложится и читается тем же', async () => {
    if (pool === null) return;
    // Прежде запись с таким потолком отвергалась: потолок в схеме не хранился,
    // а умолчанием при чтении стоял жёсткий предел учёта, то есть чтение
    // вернуло бы расчёт, которому разрешено больше, чем было разрешено.
    expect(DEFAULT_FEE_CEILING.maxShare).toEqual(rational(2n, 100n));
    const tranche = { dealId: DEAL, trancheId: TRANCHE };
    const strict = feeCeiling(rational(1n, 100n));
    const source = appendEntries(emptyJournal, [
      clientTopUp(meta('e-p1-top-up', '2026-03-01T10:00:00.000Z'), BUYER, money(GEL, 100_000n)),
      lockForTranche(
        meta('e-p2-lock', '2026-03-01T11:00:00.000Z'),
        BUYER,
        tranche,
        money(GEL, 100_000n),
      ),
      settleTrancheToClientAccount(
        meta('e-p3-settle', '2026-03-01T12:00:00.000Z'),
        trancheSettlement(tranche, BUYER, SELLER, attest(tranche, BUYER, SELLER), strict),
        money(GEL, 100_000n),
      ),
    ]);
    await withRollback(pool, async (client) => {
      await appendJournal(client, source.entries);
      const read = await readJournal(client);
      expect(read).toEqual(source);
      expect(read.entries[2]?.settles?.ceiling.maxShare).toEqual(rational(1n, 100n));
    });
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
