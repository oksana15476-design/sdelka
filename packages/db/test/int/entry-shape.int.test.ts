import { expect, it } from 'vitest';
import type { PoolClient } from '../../src/pool.ts';
import { dbSuite, sqlState, withRollback } from './support/pg.ts';

/**
 * Форма записи и проводки — ограничения, которые база объявляет, а нарушить их
 * до сих пор не пробовал ни один тест.
 *
 * Это отдельный род дефекта, и он тише остальных: ограничение стоит, читается
 * как исполненное обещание, а работает ли оно — не знает никто. Ошибка в
 * выражении (`OR` вместо `AND`, забытый `IS NULL`) не роняет ничего: миграция
 * применяется, набор зелёный, и первое нарушение приезжает из продукта.
 *
 * Каждое ограничение здесь **нарушается** и обязано ответить своим именем.
 * Все они — зеркала правил конструктора записи (`ledger/src/entry.ts`), и
 * сверяются они с тем же SQLSTATE `23514`, что и остальные проверки формы.
 */
const suite = await dbSuite('форма записи журнала');

const ENTRY = `INSERT INTO sdelka.ledger_entry
  (entry_id, occurred_at, kind, memo_key, corrects_entry_id,
   settles_deal_id, settles_tranche_id, settles_payer, settles_recipient, settles_evidence_ref)
  VALUES ($1, '2026-09-05T10:00:00Z', $2, 'ledger.entry.client_top_up', $3, $4, $5, $6, $7, $8)`;

const PLAIN = `INSERT INTO sdelka.ledger_entry (entry_id, occurred_at, kind, memo_key)
               VALUES ($1, '2026-09-05T10:00:00Z', 'settlement', 'ledger.entry.client_top_up')`;

suite.run(suite.title, () => {
  const pool = suite.pool;

  async function rejects(
    constraint: string,
    body: (client: PoolClient) => Promise<void>,
  ): Promise<void> {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      let failed = false;
      try {
        await body(client);
      } catch (error) {
        failed = true;
        expect(sqlState(error), constraint).toBe('23514');
        expect(String(error), constraint).toContain(constraint);
      }
      expect(failed, `ожидался отказ ${constraint}`).toBe(true);
    });
  }

  it('исправление без ссылки на цель не вставляется', async () => {
    // `entryCorrectionWithoutReference`. Одно выражение зеркалит сразу два
    // отказа конструктора, поэтому проверяются обе его стороны.
    await rejects('ledger_entry_correction_reference', async (client) => {
      await client.query(ENTRY, ['c-1', 'correction', null, null, null, null, null, null]);
    });
  });

  it('расчёт со ссылкой на цель не вставляется', async () => {
    // `entrySettlementWithReference`: ссылка на исправляемую запись у обычной
    // записи означала бы, что исправлением можно назвать что угодно задним
    // числом.
    await rejects('ledger_entry_correction_reference', async (client) => {
      await client.query(PLAIN, ['s-0']);
      await client.query(ENTRY, ['s-1', 'settlement', 's-0', null, null, null, null, null]);
    });
  });

  it('исправление самого себя не вставляется', async () => {
    await rejects('ledger_entry_correction_not_self', async (client) => {
      await client.query(ENTRY, ['self-1', 'correction', 'self-1', null, null, null, null, null]);
    });
  });

  it('половина объявления расчёта — не объявление', async () => {
    // `ledger_entry_settles_whole`: пять полей ровно потому, что в TS это одно
    // значение. Запись с одним лишь получателем — расчёт без плательщика,
    // сделки и доказательств.
    await rejects('ledger_entry_settles_whole', async (client) => {
      await client.query(ENTRY, ['w-1', 'settlement', null, null, null, null, 'seller-1', null]);
    });
  });

  it('расчёт самому себе не вставляется', async () => {
    // `settlementSelfDealing`, `FUNCTIONAL.md` §2.1: одна и та же личность на
    // обеих сторонах одной сделки — отказ, а не предупреждение.
    await rejects('ledger_entry_settles_not_self', async (client) => {
      await client.query(ENTRY, [
        'self-2',
        'settlement',
        null,
        'deal-1',
        'tranche-1',
        'party-1',
        'party-1',
        'evidence-1',
      ]);
    });
  });

  it('расчёт с пустой ссылкой на пакет доказательств не вставляется', async () => {
    // Красная линия №5. Пустая строка — не ссылка: `NOT NULL` её пропускает,
    // поэтому длина проверяется отдельно.
    await rejects('ledger_entry_evidence_present', async (client) => {
      await client.query(ENTRY, [
        'e-1',
        'settlement',
        null,
        'deal-1',
        'tranche-1',
        'buyer-1',
        'seller-1',
        '',
      ]);
    });
  });

  it('идентификатор расчёта с разделителем сегментов не вставляется', async () => {
    // Алфавит расчёта тот же, что у кода счёта: двоеточие разделяет сегменты
    // кода, черта — ключи файла. Сравнение по коду счёта работает только тогда,
    // когда обе стороны собраны по одним правилам.
    await rejects('ledger_entry_settles_alphabet', async (client) => {
      await client.query(ENTRY, [
        'a-1',
        'settlement',
        null,
        'deal:1',
        'tranche-1',
        'buyer-1',
        'seller-1',
        'evidence-1',
      ]);
    });
  });

  it('половина отнесения к сделке не вставляется', async () => {
    // `ledger_posting_attribution_shape`: файл проводки — либо клиент, либо
    // сделка с траншем, либо ничего. Из половины ссылки файл не восстановить.
    await rejects('ledger_posting_attribution_shape', async (client) => {
      await client.query(PLAIN, ['sh-1']);
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, account_currency, direction, currency, amount_minor,
            attribution_deal_id)
         VALUES ('sh-1', 0, 'bank_nominal', 'GEL', 'debit', 'GEL', 100, 'deal-1')`,
      );
    });
  });

  it('клиент и сделка в одном отнесении не вставляются', async () => {
    await rejects('ledger_posting_attribution_shape', async (client) => {
      await client.query(PLAIN, ['sh-2']);
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, account_currency, direction, currency, amount_minor,
            attribution_client_key, attribution_deal_id, attribution_tranche_id)
         VALUES ('sh-2', 0, 'bank_nominal', 'GEL', 'debit', 'GEL', 100,
                 'client-1', 'deal-1', 'tranche-1')`,
      );
    });
  });

  it('лари на долларовом счёте не вставляются', async () => {
    // `ledger_posting_account_currency_matches`: это не проводка, а опечатка.
    await rejects('ledger_posting_account_currency_matches', async (client) => {
      await client.query(PLAIN, ['cur-1']);
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, account_currency, direction, currency, amount_minor,
            attribution_client_key)
         VALUES ('cur-1', 0, 'bank_nominal', 'USD', 'debit', 'GEL', 100, 'client-1')`,
      );
    });
  });

  it('владелец счёта с разделителем сегментов не вставляется', async () => {
    // Зеркало `CLIENT_KEY_PATTERN`: двоеточие в ключе клиента дало бы код чужого
    // счёта.
    await rejects('ledger_posting_client_key_alphabet', async (client) => {
      await client.query(PLAIN, ['ck-1']);
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, client_key, direction, currency, amount_minor,
            attribution_client_key)
         VALUES ('ck-1', 0, 'client_free', 'client:1', 'credit', 'GEL', 100, 'client-1')`,
      );
    });
  });

  it('идентификатор сделки с разделителем сегментов не вставляется', async () => {
    await rejects('ledger_posting_identifier_alphabet', async (client) => {
      await client.query(PLAIN, ['id-1']);
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, client_key, account_deal_id, account_tranche_id,
            direction, currency, amount_minor, attribution_deal_id, attribution_tranche_id)
         VALUES ('id-1', 0, 'client_locked', 'client-1', 'deal|1', 'tranche-1',
                 'credit', 'GEL', 100, 'deal|1', 'tranche-1')`,
      );
    });
  });

  it('отнесение к клиенту с разделителем сегментов не вставляется', async () => {
    await rejects('ledger_posting_attribution_client_alphabet', async (client) => {
      await client.query(PLAIN, ['ac-1']);
      await client.query(
        `INSERT INTO sdelka.ledger_posting
           (entry_id, ord, account_kind, account_currency, direction, currency, amount_minor,
            attribution_client_key)
         VALUES ('ac-1', 0, 'bank_nominal', 'GEL', 'debit', 'GEL', 100, 'client|1')`,
      );
    });
  });

  it('сумма проводки нулём и минусом не бывает', async () => {
    // `postingNonPositiveAmount`: знак несёт направление (Дт/Кт), а не сумма.
    // Иначе одна операция записывается двумя способами и сверка перестаёт быть
    // однозначной.
    for (const amount of ['0', '-100']) {
      await rejects('amount_minor', async (client) => {
        await client.query(PLAIN, [`neg-${amount}`]);
        await client.query(
          `INSERT INTO sdelka.ledger_posting
             (entry_id, ord, account_kind, account_currency, direction, currency, amount_minor,
              attribution_client_key)
           VALUES ($1, 0, 'bank_nominal', 'GEL', 'debit', 'GEL', $2, 'client-1')`,
          [`neg-${amount}`, amount],
        );
      });
    }
  });
});
