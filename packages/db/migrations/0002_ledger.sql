-- 0002 — журнал учёта: записи, проводки и триггер нулевой суммы.
--
-- `FUNCTIONAL.md` §2, инвариант 1: «сумма проводок в любом журнале равна нулю».
-- `CLAUDE.md`, «Инварианты, проверяемые базой»: это **триггер**.

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Запись журнала
-- ---------------------------------------------------------------------------

CREATE TABLE sdelka.ledger_entry (
  entry_id text PRIMARY KEY CHECK (length(entry_id) > 0 AND length(entry_id) <= 128),

  -- Порядок, в котором факты стали известны, — не то же самое, что порядок
  -- `occurred_at`. Возраст открытой позиции по обмену и возраст транзита
  -- считаются **по порядку записей в журнале**, потому что журнал только
  -- дополняется (`openFxPositions`, `openTransitPositions`). Без этой колонки
  -- порядок пришлось бы восстанавливать по метке времени, а две записи с одной
  -- меткой сделали бы его случайным.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,

  occurred_at timestamptz NOT NULL,
  kind sdelka.journal_entry_kind NOT NULL,

  -- Ключ локализации, а не текст для клиента: три языка, `FUNCTIONAL.md` §5.
  -- Ни пробела, ни заглавной, ни кириллицы форма ключа не допускает — строка
  -- пользовательского текста в это поле физически не входит.
  memo_key text NOT NULL CHECK (memo_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),

  -- Красная линия №11: исправление — только новой записью со ссылкой на
  -- предыдущую. Внешний ключ на себя же делает ссылку на несуществующую запись
  -- невозможной; в TS это отдельная проверка `journalCorrectionTargetMissing`,
  -- потому что конструктор записи журнала не видит.
  corrects_entry_id text REFERENCES sdelka.ledger_entry (entry_id),

  -- Объявление расчёта (`TrancheSettlement`). Пять полей ровно потому, что в TS
  -- это одно значение: половина объявления — не объявление.
  settles_deal_id text,
  settles_tranche_id text,
  settles_payer text,
  settles_recipient text,
  settles_evidence_ref text,

  -- Одно выражение зеркалит сразу два отказа конструктора:
  -- `entryCorrectionWithoutReference` и `entrySettlementWithReference`.
  CONSTRAINT ledger_entry_correction_reference CHECK (
    (kind = 'correction') = (corrects_entry_id IS NOT NULL)
  ),
  CONSTRAINT ledger_entry_settles_whole CHECK (
    num_nonnulls(
      settles_deal_id, settles_tranche_id, settles_payer,
      settles_recipient, settles_evidence_ref
    ) IN (0, 5)
  ),
  -- `settlementSelfDealing` — `FUNCTIONAL.md` §2.1, «Что запрещено жёстко»:
  -- одна и та же личность на обеих сторонах одной сделки это отказ, а не
  -- предупреждение. Возврат самому себе расчётом не является: у него своя
  -- запись (`unlockToClientAccount`).
  CONSTRAINT ledger_entry_settles_not_self CHECK (
    settles_payer IS NULL OR settles_payer <> settles_recipient
  ),
  -- Красная линия №5: выплата невозможна без ссылки на пакет доказательств.
  CONSTRAINT ledger_entry_evidence_present CHECK (
    settles_evidence_ref IS NULL OR length(settles_evidence_ref) > 0
  ),
  -- Алфавит идентификаторов расчёта тот же, что у кода счёта
  -- (`assertAccountIdentifier`): двоеточие разделяет сегменты кода, черта —
  -- ключи файла источника средств. Сравнение по коду счёта работает только
  -- тогда, когда обе стороны собраны по одним правилам.
  CONSTRAINT ledger_entry_settles_alphabet CHECK (
    (settles_deal_id IS NULL OR settles_deal_id ~ '^[^:|]+$')
    AND (settles_tranche_id IS NULL OR settles_tranche_id ~ '^[^:|]+$')
    AND (settles_payer IS NULL OR settles_payer ~ '^[A-Za-z0-9._-]{1,128}$')
    AND (settles_recipient IS NULL OR settles_recipient ~ '^[A-Za-z0-9._-]{1,128}$')
  ),
  CONSTRAINT ledger_entry_correction_not_self CHECK (corrects_entry_id <> entry_id)
);

COMMENT ON TABLE sdelka.ledger_entry IS
  'Журнал учёта. Только дополняется: UPDATE и DELETE запрещены грантами и триггером.';

-- ---------------------------------------------------------------------------
-- Проводка
-- ---------------------------------------------------------------------------

CREATE TABLE sdelka.ledger_posting (
  entry_id text NOT NULL REFERENCES sdelka.ledger_entry (entry_id),
  ord integer NOT NULL CHECK (ord >= 0),

  -- Счёт разобран на колонки, а не хранится строкой кода. Строку из колонок
  -- собирает вычисляемая колонка ниже; обратный разбор кода не делается нигде —
  -- он потребовал бы второй реализации `accountCode()` в другую сторону.
  account_kind sdelka.account_kind_code NOT NULL REFERENCES sdelka.account_kind (kind),
  account_currency text REFERENCES sdelka.currency (code),
  client_key text,
  account_deal_id text,
  account_tranche_id text,
  conversion_id text,

  direction sdelka.direction NOT NULL,
  currency text NOT NULL REFERENCES sdelka.currency (code),

  -- Красная линия №4: только целые минорные единицы. `numeric(38,0)` — целое
  -- произвольной величины; `bigint` не годится, потому что минорные единицы
  -- слабой валюты выходят за 2^63 быстрее, чем кажется. Дробной части у типа
  -- нет вовсе, поэтому «случайно записать копейку с хвостом» невозможно.
  amount_minor numeric(38, 0) NOT NULL CHECK (amount_minor > 0),

  -- Отнесение проводки: клиент вне сделки либо сделка с траншем. Знак несёт
  -- направление (Дт/Кт), а не сумма: иначе одна операция записывается двумя
  -- способами и сверка перестаёт быть однозначной.
  attribution_client_key text,
  attribution_deal_id text,
  attribution_tranche_id text,

  -- Код счёта — зеркало `accountCode()` из `packages/ledger/src/accounts.ts`,
  -- сегмент в сегмент, включая фиксированные `free` и `tranche`: без них
  -- сделка с идентификатором `free` давала бы код чужого счёта.
  --
  -- Колонка вычисляемая, а не заполняемая приложением: код, собранный на
  -- стороне приложения, — это второй источник истины, и расходиться он начнёт
  -- ровно в тот день, когда учёт заведёт новый вид счёта.
  account_code text GENERATED ALWAYS AS (
    CASE account_kind
      WHEN 'bank_nominal' THEN 'bank:nominal:' || lower(account_currency)
      WHEN 'bank_operating' THEN 'bank:operating:' || lower(account_currency)
      WHEN 'client_free' THEN 'client:' || client_key || ':free'
      WHEN 'client_locked'
        THEN 'client:' || client_key || ':tranche:' || account_deal_id || ':' || account_tranche_id
      WHEN 'suspense_unidentified' THEN 'suspense:unidentified'
      WHEN 'fee_income' THEN 'fee:income'
      WHEN 'fx_income' THEN 'fx:income'
      WHEN 'service_income' THEN 'service:income'
      WHEN 'psp_fee_expense' THEN 'psp:fee:expense'
      WHEN 'oracle_cost_expense' THEN 'oracle:cost:expense'
      WHEN 'shortfall_expense' THEN 'shortfall:expense'
      WHEN 'unclaimed_liability' THEN 'unclaimed:liability'
      WHEN 'transit_writeoff' THEN 'transit:writeoff'
      -- Владелец в коде счёта: позиции разных клиентов не сливаются под одним
      -- ключом конверсии. Формат совпадает с accountCode() в @sdelka/ledger,
      -- и тест дрейфа сверяет их посимвольно.
      WHEN 'fx_settlement' THEN 'fx:settlement:' || client_key || ':' || conversion_id
      WHEN 'fee_receivable' THEN 'fee:receivable'
      WHEN 'transit_fee' THEN 'transit:fee'
      WHEN 'fx_accounting_diff' THEN 'fx:accounting:diff'
    END
  ) STORED,

  PRIMARY KEY (entry_id, ord),

  -- Алфавит идентификаторов — зеркало `CLIENT_KEY_PATTERN` и
  -- `assertAccountIdentifier`.
  CONSTRAINT ledger_posting_client_key_alphabet CHECK (
    client_key IS NULL OR client_key ~ '^[A-Za-z0-9._-]{1,128}$'
  ),
  CONSTRAINT ledger_posting_attribution_client_alphabet CHECK (
    attribution_client_key IS NULL OR attribution_client_key ~ '^[A-Za-z0-9._-]{1,128}$'
  ),
  CONSTRAINT ledger_posting_identifier_alphabet CHECK (
    (account_deal_id IS NULL OR account_deal_id ~ '^[^:|]+$')
    AND (account_tranche_id IS NULL OR account_tranche_id ~ '^[^:|]+$')
    AND (conversion_id IS NULL OR conversion_id ~ '^[^:|]+$')
    AND (attribution_deal_id IS NULL OR attribution_deal_id ~ '^[^:|]+$')
    AND (attribution_tranche_id IS NULL OR attribution_tranche_id ~ '^[^:|]+$')
  ),
  -- Файл проводки — либо клиент, либо сделка с траншем, либо ничего
  -- (непознанное поступление, `FUNCTIONAL.md` §3.3, шаг 1). Половина ссылки на
  -- сделку — это отнесение, из которого файл не восстановить.
  CONSTRAINT ledger_posting_attribution_shape CHECK (
    (attribution_client_key IS NULL AND attribution_deal_id IS NULL AND attribution_tranche_id IS NULL)
    OR (attribution_client_key IS NOT NULL AND attribution_deal_id IS NULL AND attribution_tranche_id IS NULL)
    OR (attribution_client_key IS NULL AND attribution_deal_id IS NOT NULL AND attribution_tranche_id IS NOT NULL)
  ),
  -- Валюта счёта, если она у него есть, обязана совпадать с валютой проводки:
  -- лари на долларовом номинальном счёте — не проводка, а опечатка.
  CONSTRAINT ledger_posting_account_currency_matches CHECK (
    account_currency IS NULL OR account_currency = currency
  )
);

-- Форма счёта проверяется **по справочнику**, а не перечнем имён в выражении:
-- CHECK не умеет заглядывать в другую таблицу, поэтому это триггер. Он
-- немедленный: неверная форма счёта — ошибка вызывающего, и откладывать её до
-- коммита незачем.
CREATE FUNCTION sdelka.assert_posting_account_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  spec sdelka.account_kind%ROWTYPE;
BEGIN
  SELECT * INTO spec FROM sdelka.account_kind WHERE kind = NEW.account_kind;
  IF spec.needs_currency <> (NEW.account_currency IS NOT NULL)
     OR spec.needs_client <> (NEW.client_key IS NOT NULL)
     OR spec.needs_tranche <> (NEW.account_deal_id IS NOT NULL)
     OR spec.needs_tranche <> (NEW.account_tranche_id IS NOT NULL)
     OR spec.needs_conversion <> (NEW.conversion_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'db.posting.account_shape'
      USING ERRCODE = '23514',
            DETAIL = format('entry_id=%s;ord=%s;kind=%s', NEW.entry_id, NEW.ord, NEW.account_kind);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER assert_posting_account_shape
  BEFORE INSERT ON sdelka.ledger_posting
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_posting_account_shape();

-- ---------------------------------------------------------------------------
-- Инвариант: сумма проводок записи равна нулю
-- ---------------------------------------------------------------------------
--
-- Зеркало `assertBalanced` и `balanceByCurrency` (`ledger/src/entry.ts`):
-- мультивалютная запись балансируется **в каждой валюте отдельно**, а не в
-- пересчёте. Пересчёт зависит от курса, а курс — это отдельная проводка
-- (`FUNCTIONAL.md` §3.3). Запись, сходящаяся «в лари по курсу дня», но не
-- сходящаяся по валютам, — не запись.
--
-- Триггер **отложенный**, и это не оптимизация. Немедленный падал бы на первой
-- же проводке любой записи: до второй строки сумма не равна нулю никогда.
-- Следствие, которое обязано быть известно вызывающему: нарушение всплывает на
-- `COMMIT`, а не на `INSERT`.
CREATE FUNCTION sdelka.assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry text := COALESCE(NEW.entry_id, OLD.entry_id);
  v_count integer;
  v_currency text;
  v_total numeric;
BEGIN
  SELECT count(*) INTO v_count FROM sdelka.ledger_posting WHERE entry_id = v_entry;
  -- Записи не осталось вовсе — проверять нечего. Удаление проводок запрещено
  -- отдельно (append-only ниже), так что этот случай означает откат.
  IF v_count = 0 THEN
    RETURN NULL;
  END IF;
  -- `entryTooFewPostings`: одна проводка — это не двойная запись.
  IF v_count < 2 THEN
    RAISE EXCEPTION 'ledger.entry.too_few_postings'
      USING ERRCODE = '23514', DETAIL = format('entry_id=%s;postings=%s', v_entry, v_count);
  END IF;
  FOR v_currency, v_total IN
    SELECT p.currency,
           sum(CASE p.direction WHEN 'debit' THEN p.amount_minor ELSE -p.amount_minor END)
    FROM sdelka.ledger_posting p
    WHERE p.entry_id = v_entry
    GROUP BY p.currency
  LOOP
    IF v_total <> 0 THEN
      RAISE EXCEPTION 'ledger.invariant.entry_unbalanced'
        USING ERRCODE = '23514',
              DETAIL = format('entry_id=%s;currency=%s;difference=%s', v_entry, v_currency, v_total);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER assert_entry_balanced
  AFTER INSERT OR UPDATE OR DELETE ON sdelka.ledger_posting
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_entry_balanced();

-- Запись без проводок — не запись. Проверяется тем же отложенным механизмом со
-- стороны `ledger_entry`: на момент вставки записи проводок ещё нет.
CREATE FUNCTION sdelka.assert_entry_has_postings() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM sdelka.ledger_posting WHERE entry_id = NEW.entry_id;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'ledger.entry.too_few_postings'
      USING ERRCODE = '23514', DETAIL = format('entry_id=%s;postings=%s', NEW.entry_id, v_count);
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER assert_entry_has_postings
  AFTER INSERT ON sdelka.ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_entry_has_postings();

-- ---------------------------------------------------------------------------
-- Журнал только дополняется
-- ---------------------------------------------------------------------------
--
-- `journal.ts`: «журнал только дополняется. Изменяющих операций нет ни одной —
-- ни в типе, ни в модуле». В TS нарушение невыразимо, поэтому у него там нет и
-- кода ошибки; в базе оно выразимо всегда, поэтому код появляется здесь
-- (`src/errors.ts`, `db.ledger.append_only`).
--
-- Два контура: гранты (роль приложения `UPDATE`/`DELETE` не получает вовсе) и
-- триггер (ловит и владельца, который грантом не ограничен).
CREATE FUNCTION sdelka.forbid_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'db.ledger.append_only'
    USING ERRCODE = '0A000', DETAIL = format('relation=%s;operation=%s', TG_TABLE_NAME, TG_OP);
END
$$;

CREATE TRIGGER forbid_ledger_entry_mutation
  BEFORE UPDATE OR DELETE ON sdelka.ledger_entry
  FOR EACH ROW EXECUTE FUNCTION sdelka.forbid_ledger_mutation();

CREATE TRIGGER forbid_ledger_posting_mutation
  BEFORE UPDATE OR DELETE ON sdelka.ledger_posting
  FOR EACH ROW EXECUTE FUNCTION sdelka.forbid_ledger_mutation();

GRANT SELECT, INSERT ON sdelka.ledger_entry, sdelka.ledger_posting TO sdelka_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sdelka.ledger_entry, sdelka.ledger_posting FROM sdelka_app;
