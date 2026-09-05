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

/**
 * Потолок удержания подставляется вместе с объявлением расчёта, а не
 * перечисляется в каждом вызове: `ledger_entry_settles_ceiling_whole` требует
 * его ровно там, где расчёт объявлен, и без этой подстановки каждая проба ниже
 * падала бы на потолке, а не на том ограничении, ради которого написана.
 * Величина — жёсткий предел учёта, две сотых.
 */
const ENTRY = `INSERT INTO sdelka.ledger_entry
  (entry_id, occurred_at, kind, memo_key, corrects_entry_id,
   settles_deal_id, settles_tranche_id, settles_payer, settles_recipient, settles_evidence_ref,
   settles_ceiling_numerator, settles_ceiling_denominator)
  VALUES ($1, '2026-09-05T10:00:00Z', $2, 'ledger.entry.client_top_up', $3, $4, $5, $6, $7, $8,
          CASE WHEN $4::text IS NULL THEN NULL ELSE 2 END,
          CASE WHEN $4::text IS NULL THEN NULL ELSE 100 END)`;

const PLAIN = `INSERT INTO sdelka.ledger_entry (entry_id, occurred_at, kind, memo_key)
               VALUES ($1, '2026-09-05T10:00:00Z', 'settlement', 'ledger.entry.client_top_up')`;

/* ------------------------------------------------------------------------- */
/* Объявления, заведённые 0021                                               */
/* ------------------------------------------------------------------------- */

const CONVERTS = `INSERT INTO sdelka.ledger_entry
  (entry_id, occurred_at, kind, memo_key,
   converts_conversion_id, converts_source_currency, converts_source_amount_minor,
   converts_target_currency, converts_target_amount_minor,
   converts_client_rate_numerator, converts_client_rate_denominator,
   converts_reference_rate_numerator, converts_reference_rate_denominator,
   converts_official_rate_numerator, converts_official_rate_denominator,
   converts_as_of)
  VALUES ($1, '2026-09-05T10:00:00Z', 'settlement', 'ledger.entry.fx_executed',
          $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

/** Объявление обмена, которое схема принимает. Пробы правят по одному полю. */
function converts(overrides: Partial<Record<number, string | null>> = {}): (string | null)[] {
  const row: (string | null)[] = [
    'x1',
    'USD',
    '8000000',
    'GEL',
    '21349500',
    '26686875',
    '10000000',
    '26875',
    '10000',
    '27',
    '10',
    '2026-09-05',
  ];
  for (const [index, value] of Object.entries(overrides)) {
    row[Number(index)] = value ?? null;
  }
  return row;
}

const ACCRUES = `INSERT INTO sdelka.ledger_entry
  (entry_id, occurred_at, kind, memo_key,
   accrues_deal_id, accrues_tranche_id, accrues_fee_currency, accrues_fee_amount_minor,
   accrues_tariff_version_id)
  VALUES ($1, '2026-09-05T10:00:00Z', 'settlement', 'ledger.entry.fee_accrued',
          $2, $3, $4, $5, $6)`;

const FUNDS = `INSERT INTO sdelka.ledger_entry
  (entry_id, occurred_at, kind, memo_key, corrects_entry_id,
   funds_recognised_entry_id, funds_owner, funds_amount_currency, funds_amount_minor)
  VALUES ($1, '2026-09-05T10:00:00Z', $2, 'ledger.entry.shortfall_funded', $3, $4, $5, $6, $7)`;

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

  /**
   * Отказ не по `CHECK`, а по ключу или ссылке: у них свои коды `SQLSTATE`, и
   * проверять их тем же `23514` значило бы проверять не то.
   */
  async function rejectsWith(
    sqlstate: string,
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
        expect(sqlState(error), constraint).toBe(sqlstate);
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

  /* --- Объявления, заведённые 0021 --- */

  it('расчёт без потолка удержания не вставляется', async () => {
    // `TrancheSettlement.ceiling` необязательным полем не бывает: расчёт без
    // потолка — расчёт, которому разрешено неизвестно сколько.
    await rejects('ledger_entry_settles_ceiling_whole', async (client) => {
      await client.query(
        `INSERT INTO sdelka.ledger_entry
           (entry_id, occurred_at, kind, memo_key,
            settles_deal_id, settles_tranche_id, settles_payer, settles_recipient,
            settles_evidence_ref)
         VALUES ('nc-1', '2026-09-05T10:00:00Z', 'settlement', 'ledger.entry.tranche_settled',
                 'deal-1', 'tranche-1', 'buyer-1', 'seller-1', 'evidence-1')`,
      );
    });
  });

  it('потолок удержания в одну целую с лишним не вставляется', async () => {
    // Зеркало `feeCeiling`: удержать больше суммы нельзя ни при какой ставке.
    await rejects('ledger_entry_settles_ceiling_share', async (client) => {
      await client.query(
        `INSERT INTO sdelka.ledger_entry
           (entry_id, occurred_at, kind, memo_key,
            settles_deal_id, settles_tranche_id, settles_payer, settles_recipient,
            settles_evidence_ref, settles_ceiling_numerator, settles_ceiling_denominator)
         VALUES ('cs-1', '2026-09-05T10:00:00Z', 'settlement', 'ledger.entry.tranche_settled',
                 'deal-1', 'tranche-1', 'buyer-1', 'seller-1', 'evidence-1', 3, 2)`,
      );
    });
  });

  it('половина объявления обмена — не объявление', async () => {
    // Три курса и дата едут вместе с суммами: курс без даты не является курсом,
    // а сумма без курса не восстанавливается — усечение необратимо (И14.2).
    await rejects('ledger_entry_converts_whole', async (client) => {
      await client.query(CONVERTS, ['cw-1', ...converts({ 11: null })]);
    });
  });

  it('нулевая нога обмена не вставляется', async () => {
    await rejects('ledger_entry_converts_positive', async (client) => {
      await client.query(CONVERTS, ['cp-1', ...converts({ 4: '0' })]);
    });
  });

  it('нулевой курс не вставляется', async () => {
    // Зеркало `fxRate`: ноль обнуляет чужие деньги, знак выворачивает
    // направление, и обе величины проходят всю арифметику молча.
    await rejects('ledger_entry_converts_rates_positive', async (client) => {
      await client.query(CONVERTS, ['cr-1', ...converts({ 7: '0' })]);
    });
  });

  it('обмен валюты саму на себя не вставляется', async () => {
    await rejects('ledger_entry_converts_pair_distinct', async (client) => {
      await client.query(CONVERTS, ['cd-1', ...converts({ 3: 'USD', 4: '8000000' })]);
    });
  });

  it('дата курса не той формы не вставляется', async () => {
    // Зеркало `ISO_DATE_PATTERN`: `IsoDate` — строка ровно этой формы, и
    // хранится она текстом именно затем, чтобы часовой пояс процесса не сдвинул
    // её на сутки.
    await rejects('ledger_entry_converts_as_of_form', async (client) => {
      await client.query(CONVERTS, ['ca-1', ...converts({ 11: '05.09.2026' })]);
    });
  });

  it('ключ обмена с разделителем сегментов не вставляется', async () => {
    await rejects('ledger_entry_converts_alphabet', async (client) => {
      await client.query(CONVERTS, ['cx-1', ...converts({ 0: 'x:1' })]);
    });
  });

  it('начисление без версии тарифного плана не вставляется', async () => {
    // §4.2: на сделке хранится версия плана, применённая в момент создания,
    // иначе через год нельзя воспроизвести, почему списали именно столько.
    await rejects('ledger_entry_accrues_whole', async (client) => {
      await client.query(ACCRUES, ['aw-1', 'deal-1', 'tranche-1', 'GEL', '2000', null]);
    });
  });

  it('нулевое начисление не вставляется', async () => {
    // Нулевая комиссия — это отсутствие комиссии, а не проводка на ноль.
    await rejects('ledger_entry_accrues_positive', async (client) => {
      await client.query(ACCRUES, ['ap-1', 'deal-1', 'tranche-1', 'GEL', '0', 'tariff-v1']);
    });
  });

  it('версия тарифного плана с разделителем сегментов не вставляется', async () => {
    await rejects('ledger_entry_accrues_alphabet', async (client) => {
      await client.query(ACCRUES, ['aa-1', 'deal-1', 'tranche-1', 'GEL', '2000', 'tariff:v1']);
    });
  });

  it('половина объявления довнесения — не объявление', async () => {
    await rejects('ledger_entry_funds_whole', async (client) => {
      await client.query(PLAIN, ['fw-0']);
      await client.query(FUNDS, ['fw-1', 'settlement', null, 'fw-0', null, 'GEL', '100']);
    });
  });

  it('нулевое довнесение не вставляется', async () => {
    await rejects('ledger_entry_funds_positive', async (client) => {
      await client.query(PLAIN, ['fp-0']);
      await client.query(FUNDS, ['fp-1', 'settlement', null, 'fp-0', 'buyer-1', 'GEL', '0']);
    });
  });

  it('довнесение на записи-исправлении не вставляется', async () => {
    // Зеркало `assertShortfallFundingDeclared`: исправление довнесения — это
    // обратная проводка со ссылкой на исправляемую запись, а не второе
    // довнесение по тому же признанию.
    await rejects('ledger_entry_funds_settlement_only', async (client) => {
      await client.query(PLAIN, ['fk-0']);
      await client.query(FUNDS, ['fk-1', 'correction', 'fk-0', 'fk-0', 'buyer-1', 'GEL', '100']);
    });
  });

  it('довнесение по самому себе не вставляется', async () => {
    await rejects('ledger_entry_funds_not_self', async (client) => {
      await client.query(FUNDS, ['fs-1', 'settlement', null, 'fs-1', 'buyer-1', 'GEL', '100']);
    });
  });

  it('владелец довнесения с разделителем сегментов не вставляется', async () => {
    await rejects('ledger_entry_funds_owner_alphabet', async (client) => {
      await client.query(PLAIN, ['fo-0']);
      await client.query(FUNDS, ['fo-1', 'settlement', null, 'fo-0', 'buyer:1', 'GEL', '100']);
    });
  });

  it('ссылка на признание, которого в журнале нет, не вставляется', async () => {
    // Внешний ключ, как у `corrects_entry_id`: ссылка на запись, которой в
    // журнале нет, ссылкой не является. `23503` — foreign_key_violation.
    await rejectsWith(
      '23503',
      'ledger_entry_funds_recognised_entry_id_fkey',
      async (client) => {
        await client.query(FUNDS, [
          'fn-1',
          'settlement',
          null,
          'fn-missing',
          'buyer-1',
          'GEL',
          '100',
        ]);
      },
    );
  });

  it('второе довнесение по тому же признанию не вставляется', async () => {
    // Ровно то, ради чего ссылка заведена. `23505` — unique_violation: правило
    // выражается ключом, и держит его частичный уникальный индекс, а не
    // сложение постфактум.
    await rejectsWith('23505', 'ledger_entry_shortfall_funded_once', async (client) => {
      await client.query(PLAIN, ['ft-0']);
      await client.query(FUNDS, ['ft-1', 'settlement', null, 'ft-0', 'buyer-1', 'GEL', '100']);
      await client.query(FUNDS, ['ft-2', 'settlement', null, 'ft-0', 'buyer-1', 'GEL', '100']);
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
