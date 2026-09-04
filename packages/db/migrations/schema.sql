-- Снимок схемы: склейка миграций в порядке применения.
-- Файл собирается командой `pnpm db:generate`; править его руками бесполезно.
-- Источник истины — сами миграции.
-- ===== 0001_foundation.sql =====
-- 0001 — фундамент: роли, схема, справочники, перечни.
--
-- Разделение ролей — это инвариант 21 (`FUNCTIONAL.md` §2, «Данные и аудит») и
-- `CORE.md` Ф11: «роль приложения не имеет прав на изменение и удаление —
-- проверяется грантами базы, а не кодом». У владельца объекта права отобрать
-- нельзя: он выдаст их себе обратно. Поэтому владелец и приложение — разные
-- роли, и вторая не член первой.
--
-- Обе роли без права входа и без пароля: пароля нет ни в репозитории, ни здесь
-- (красная линия №12). Логин-роль заводит оператор и включает в нужную
-- групповую роль — см. `scripts/dev-db.sh`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sdelka_owner') THEN
    CREATE ROLE sdelka_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sdelka_app') THEN
    CREATE ROLE sdelka_app NOLOGIN;
  END IF;
END
$$;

-- Схему и таблицу учёта миграций создаёт раннер до первой миграции: записать
-- факт применения этой миграции больше некуда. Владельца назначаем здесь,
-- когда роль уже есть.
ALTER SCHEMA sdelka OWNER TO sdelka_owner;
ALTER TABLE sdelka.schema_migration OWNER TO sdelka_owner;

REVOKE ALL ON SCHEMA sdelka FROM PUBLIC;
GRANT USAGE ON SCHEMA sdelka TO sdelka_app;

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Валюты
-- ---------------------------------------------------------------------------
--
-- Число знаков — свойство валюты, а не константа сто (`money/src/currency.ts`).
-- JPY с нулём знаков держится намеренно: он ловит захардкоженную степень
-- десяти, и убирать его из справочника нельзя.

CREATE TABLE sdelka.currency (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  exponent smallint NOT NULL CHECK (exponent >= 0 AND exponent <= 8)
);

INSERT INTO sdelka.currency (code, exponent) VALUES
  ('GEL', 2),
  ('USD', 2),
  ('EUR', 2),
  ('JPY', 0);

-- ---------------------------------------------------------------------------
-- Перечни
-- ---------------------------------------------------------------------------
--
-- Каждый перечень — построчное зеркало массива из TS, буква в букву и в том же
-- порядке. Тест дрейфа (`test/enums.test.ts`) сверяет их автоматически: правка
-- перечня в одном месте роняет тест, а не расходится молча.

-- packages/ledger: Direction
CREATE TYPE sdelka.direction AS ENUM ('debit', 'credit');

-- packages/ledger: JournalEntryKind
CREATE TYPE sdelka.journal_entry_kind AS ENUM ('settlement', 'correction');

-- packages/ledger: AccountType
CREATE TYPE sdelka.account_type AS ENUM ('asset', 'liability', 'income', 'expense');

-- packages/ledger: FundsOwnership
CREATE TYPE sdelka.funds_ownership AS ENUM ('client', 'platform');

-- packages/ledger: PlatformFundsRole
CREATE TYPE sdelka.platform_funds_role AS ENUM ('bank', 'receivable', 'transit', 'result');

-- packages/ledger: FundsFileScope
CREATE TYPE sdelka.funds_file_scope AS ENUM ('owner_in_code', 'in_attribution', 'pooled');

-- packages/ledger: PoolDirection
CREATE TYPE sdelka.pool_direction AS ENUM ('intake', 'terminal');

-- packages/domain: TRANCHE_STATUSES
CREATE TYPE sdelka.tranche_status AS ENUM (
  'pending',
  'collecting',
  'collected',
  'reserved',
  'release_pending',
  'release_blocked',
  'paying_out',
  'paid_out',
  'refund_pending',
  'refunding',
  'refunded',
  'written_off',
  'frozen'
);

-- packages/domain: DEAL_STATUSES
CREATE TYPE sdelka.deal_status AS ENUM (
  'draft',
  'parties_pending',
  'property_pending',
  'ready',
  'funding',
  'funded',
  'filed',
  'settling',
  'settled',
  'unwinding',
  'unwound',
  'cancelled',
  'frozen'
);

-- packages/domain: PAYOUT_STATUSES
CREATE TYPE sdelka.payout_status AS ENUM (
  'created',
  'submitted',
  'settled',
  'rejected',
  'unknown'
);

-- packages/domain: WITHDRAWAL_STATUSES
CREATE TYPE sdelka.withdrawal_status AS ENUM (
  'requested',
  'approved',
  'paying_out',
  'paid_out',
  'blocked',
  'cancelled'
);

-- packages/domain: RELEASE_CONDITION_TYPES
CREATE TYPE sdelka.release_condition_type AS ENUM (
  'registration_transfer',
  'registration_preliminary',
  'calendar_date'
);

-- packages/domain: FREEZE_REASONS
CREATE TYPE sdelka.freeze_reason AS ENUM ('sanctions', 'compliance_review', 'dispute');

-- packages/domain: UNFREEZE_TARGETS
CREATE TYPE sdelka.unfreeze_target AS ENUM (
  'suspended_from',
  'refund_pending',
  'release_blocked'
);

-- packages/domain: BENEFICIARY_STATUSES
CREATE TYPE sdelka.beneficiary_status AS ENUM (
  'draft',
  'name_consistent',
  'verified',
  'blocked'
);

-- packages/domain: OBSERVATION_LEVELS
CREATE TYPE sdelka.observation_level AS ENUM ('L0', 'L1', 'L2', 'L3', 'L4', 'L5');

-- packages/domain: OWNER_CHECKS
CREATE TYPE sdelka.owner_check AS ENUM ('established', 'refuted', 'insufficient');

-- packages/domain: FILING_SOURCES
CREATE TYPE sdelka.filing_source AS ENUM ('party_claim', 'application_card');

-- packages/audit: AUDIT_RECORD_KINDS
CREATE TYPE sdelka.audit_record_kind AS ENUM (
  'chain_opened',
  'decision_made',
  'state_transition',
  'condition_act_recorded',
  'evidence_attached',
  'payout_ordered',
  'payout_result',
  'beneficiary_changed',
  'personal_data_viewed',
  'correction',
  'timestamp_token',
  'anchor_published'
);

-- packages/audit: AUDIT_ROLES
CREATE TYPE sdelka.audit_role AS ENUM (
  'operator',
  'approver',
  'compliance_analyst',
  'support',
  'representative',
  'client',
  'system',
  'oracle'
);

-- packages/audit: RAW_SOURCE_KINDS
CREATE TYPE sdelka.raw_source_kind AS ENUM (
  'identity_document',
  'kinship_document',
  'ownership_document',
  'contract',
  'registry_extract',
  'bank_statement',
  'screening_response',
  'test_transfer',
  'operator_note',
  'condition_act',
  'payment_provider_response',
  'timestamp_response'
);

-- packages/audit: FINGERPRINT_SUBJECTS
CREATE TYPE sdelka.fingerprint_subject AS ENUM (
  'document_number',
  'personal_number',
  'account',
  'device',
  'network_address',
  'phone',
  'name',
  'address',
  'raw_source'
);

-- packages/audit: REF_SCOPES
CREATE TYPE sdelka.ref_scope AS ENUM (
  'deal',
  'tranche',
  'payout',
  'party',
  'beneficiary',
  'document',
  'evidence',
  'statement',
  'chain'
);

-- ---------------------------------------------------------------------------
-- Справочник видов счёта — построчное зеркало ACCOUNT_NATURE
-- ---------------------------------------------------------------------------
--
-- Классификация счёта живёт **в справочнике**, а не в перечнях имён внутри
-- запросов. Перечень имён счетов — та самая дыра, которая дважды стоила учёту
-- `isClientObligationAccount`: сначала через неё прошла отмывка через
-- `suspense:unidentified`, потом та же через `unclaimed:liability`. Перечень
-- всегда оказывается неполным, и неполнота тихая.
--
-- Поэтому представления сверки (`0008_views.sql`) джойнят эту таблицу, а новый
-- вид счёта, добавленный в `packages/ledger`, роняет `pnpm typecheck` пакета
-- `@sdelka/db` (`src/accounts.ts`) и тест дрейфа — то есть попадает сюда
-- сознательно.

CREATE TYPE sdelka.account_kind_code AS ENUM (
  'bank_nominal',
  'bank_operating',
  'client_free',
  'client_locked',
  'suspense_unidentified',
  'fee_income',
  'fx_income',
  'service_income',
  'psp_fee_expense',
  'oracle_cost_expense',
  'shortfall_expense',
  'unclaimed_liability',
  'transit_writeoff',
  'fx_settlement',
  'fee_receivable',
  'transit_fee',
  'fx_accounting_diff'
);

CREATE TABLE sdelka.account_kind (
  kind sdelka.account_kind_code PRIMARY KEY,
  acct_type sdelka.account_type NOT NULL,
  funds sdelka.funds_ownership NOT NULL,
  platform_role sdelka.platform_funds_role,
  file_scope sdelka.funds_file_scope,
  pool_direction sdelka.pool_direction,
  needs_currency boolean NOT NULL,
  needs_client boolean NOT NULL,
  needs_tranche boolean NOT NULL,
  needs_conversion boolean NOT NULL,

  -- Объявив средства платформы, счёт обязан назвать роль; объявив клиентские —
  -- происхождение файла. Ровно то же самое держит союз `AccountNature` в TS:
  -- «запись с необязательными полями» там отвергнута сознательно.
  CONSTRAINT account_kind_declares_nature CHECK (
    (funds = 'platform' AND platform_role IS NOT NULL AND file_scope IS NULL)
    OR (funds = 'client' AND platform_role IS NULL AND file_scope IS NOT NULL)
  ),
  -- Пул обязан объявить направление, непул — не может.
  CONSTRAINT account_kind_pool_direction CHECK (
    (file_scope = 'pooled') = (pool_direction IS NOT NULL)
  ),
  -- Зеркало `AssertOwnerInCodeCarriesOwner`: счёт, объявивший «владелец в
  -- коде», обязан нести владельца в коде. Иначе владелец обязательства
  -- становится `null` у счёта, который по объявлению владельца имеет, и
  -- движение между владельцами снова делается невидимым.
  CONSTRAINT account_kind_owner_in_code_carries_owner CHECK (
    file_scope IS DISTINCT FROM 'owner_in_code' OR needs_client
  ),
  -- Зеркало `AssertObligationFileIsNotAttributed`: обязательство перед клиентом
  -- не берёт файл из отнесения проводки. Отнесение назначает тот, кто строит
  -- запись, — обязательство с назначаемым извне файлом ничем не привязано к
  -- владельцу.
  CONSTRAINT account_kind_obligation_file_not_attributed CHECK (
    NOT (acct_type = 'liability' AND funds = 'client' AND file_scope = 'in_attribution')
  ),
  -- Зеркало `AssertPlatformResultRoleMatchesType`: счёт результата — это доход
  -- или расход, и наоборот. Роль `result` на активе означала бы, что признание
  -- дохода подпирается чем угодно; роль средств на счёте дохода — что доход
  -- можно раздать как деньги.
  CONSTRAINT account_kind_result_matches_type CHECK (
    (platform_role IS NOT DISTINCT FROM 'result') = (acct_type IN ('income', 'expense'))
  )
);

INSERT INTO sdelka.account_kind
  (kind, acct_type, funds, platform_role, file_scope, pool_direction,
   needs_currency, needs_client, needs_tranche, needs_conversion) VALUES
  ('bank_nominal',          'asset',     'client',   NULL,         'in_attribution', NULL,       true,  false, false, false),
  ('bank_operating',        'asset',     'platform', 'bank',       NULL,             NULL,       true,  false, false, false),
  ('client_free',           'liability', 'client',   NULL,         'owner_in_code',  NULL,       false, true,  false, false),
  ('client_locked',         'liability', 'client',   NULL,         'owner_in_code',  NULL,       false, true,  true,  false),
  ('suspense_unidentified', 'liability', 'client',   NULL,         'pooled',         'intake',   false, false, false, false),
  ('fee_income',            'income',    'platform', 'result',     NULL,             NULL,       false, false, false, false),
  ('fx_income',             'income',    'platform', 'result',     NULL,             NULL,       false, false, false, false),
  ('service_income',        'income',    'platform', 'result',     NULL,             NULL,       false, false, false, false),
  ('psp_fee_expense',       'expense',   'platform', 'result',     NULL,             NULL,       false, false, false, false),
  ('oracle_cost_expense',   'expense',   'platform', 'result',     NULL,             NULL,       false, false, false, false),
  ('shortfall_expense',     'expense',   'platform', 'result',     NULL,             NULL,       false, false, false, false),
  ('unclaimed_liability',   'liability', 'client',   NULL,         'pooled',         'terminal', false, false, false, false),
  ('transit_writeoff',      'asset',     'client',   NULL,         'pooled',         'terminal', false, false, false, false),
  ('fx_settlement',         'asset',     'client',   NULL,         'in_attribution', NULL,       false, false, false, true),
  ('fee_receivable',        'asset',     'platform', 'receivable', NULL,             NULL,       false, false, false, false),
  ('transit_fee',           'asset',     'platform', 'transit',    NULL,             NULL,       false, false, false, false),
  ('fx_accounting_diff',    'expense',   'platform', 'result',     NULL,             NULL,       false, false, false, false);

GRANT SELECT ON sdelka.currency, sdelka.account_kind TO sdelka_app;

-- ===== 0002_ledger.sql =====
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
      WHEN 'fx_settlement' THEN 'fx:settlement:' || conversion_id
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

-- ===== 0003_balance.sql =====
-- 0003 — отрицательный остаток невозможен.
--
-- `CLAUDE.md`, «Инварианты, проверяемые базой»: «отрицательный остаток
-- клиентского счёта невозможен». `FUNCTIONAL.md` §2, инвариант 3. Зеркало
-- `negativeClientBalances`, `negativeBankBalances` и
-- `negativePlatformAssetBalances` из `ledger/src/balance.ts`.

SET LOCAL ROLE sdelka_owner;

-- Материализованного остатка нет намеренно. Хранимая сумма — второй источник
-- истины, и он дрейфует: разойтись с проводками он может только молча. Остаток
-- считается агрегатом по затронутому счёту, а цену этого решения платит индекс
-- ниже. Решение названо, а не сложилось.
CREATE INDEX ledger_posting_account_currency
  ON sdelka.ledger_posting (account_code, currency);

-- Остаток в **естественном знаке счёта**: актив и расход — Дт минус Кт,
-- обязательство и доход — Кт минус Дт (`naturalSign`). Так «отрицательный
-- остаток клиентского счёта» означает ровно то, что означает в инварианте, а не
-- зависит от того, с какой стороны смотреть.
--
-- Классификация — **джойном справочника**, без единого перечня имён счетов:
-- перечень имён дважды оказывался неполным в TS, и повторять эту дыру в SQL
-- незачем (`0001_foundation.sql`, комментарий к `sdelka.account_kind`).
--
-- Триггер отложенный по той же причине, что и нулевая сумма: внутри одной
-- записи счёт законно проваливается в минус между первой и второй проводкой.
-- Проверять его в этот момент значило бы запретить половину законных записей.
CREATE FUNCTION sdelka.assert_no_negative_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_balance numeric;
  v_funds sdelka.funds_ownership;
  v_role sdelka.platform_funds_role;
BEGIN
  SELECT k.funds,
         k.platform_role,
         sum(
           CASE WHEN (k.acct_type IN ('asset', 'expense')) = (p.direction = 'debit')
                THEN p.amount_minor ELSE -p.amount_minor END
         )
    INTO v_funds, v_role, v_balance
    FROM sdelka.ledger_posting p
    JOIN sdelka.account_kind k ON k.kind = p.account_kind
   WHERE p.account_code = NEW.account_code
     AND p.currency = NEW.currency
   GROUP BY k.funds, k.platform_role;

  IF v_balance IS NULL OR v_balance >= 0 THEN
    RETURN NULL;
  END IF;

  -- Клиентские средства — и обязательства, и активы: `negativeClientBalances`
  -- фильтрует по обоим, потому что минус на номинальном счёте — это ровно
  -- такая же невозможность, как минус на счёте клиента.
  IF v_funds = 'client' THEN
    RAISE EXCEPTION 'ledger.invariant.negative_client_balance'
      USING ERRCODE = '23514',
            DETAIL = format('account_code=%s;currency=%s;balance=%s',
                            NEW.account_code, NEW.currency, v_balance);
  END IF;

  -- Овердрафта нет: запись, уводящая банковский счёт платформы ниже нуля,
  -- утверждает перевод, которого банк не исполнил бы. Прямой случай —
  -- довнесение недостачи (§3.1, случай А, момент 2) с пустого операционного
  -- счёта: дыра в клиентских средствах закрыта обещанием, за которым ничего
  -- нет.
  IF v_role = 'bank' THEN
    RAISE EXCEPTION 'ledger.invariant.negative_bank_balance'
      USING ERRCODE = '23514',
            DETAIL = format('account_code=%s;currency=%s;balance=%s',
                            NEW.account_code, NEW.currency, v_balance);
  END IF;

  -- Требование или транзит в минусе — другое расхождение и разбирается иначе,
  -- поэтому и код другой. «Банковский счёт в минусе» на требовании по
  -- начисленной комиссии было бы ложным сообщением дежурному.
  IF v_role IN ('receivable', 'transit') THEN
    RAISE EXCEPTION 'ledger.invariant.platform_asset_negative'
      USING ERRCODE = '23514',
            DETAIL = format('account_code=%s;currency=%s;balance=%s',
                            NEW.account_code, NEW.currency, v_balance);
  END IF;

  -- Счёт результата (доход, расход) в минусе — не нарушение: реверс начисления
  -- законно уводит доход ниже нуля, а знак `fx:accounting:diff` несёт
  -- направление (`FUNCTIONAL.md` §3.1).
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER assert_no_negative_balance
  AFTER INSERT OR UPDATE ON sdelka.ledger_posting
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_no_negative_balance();

-- ===== 0004_deal_tranche.sql =====
-- 0004 — стороны, сделки, акт об условии, транши.
--
-- Главный инвариант этой миграции — `CLAUDE.md`: «транш в нетерминальном
-- состоянии без дедлайна — ошибка». В TS он выражен **формой союза**
-- `TrancheState` (`domain/src/tranche.ts`): дедлайн лежит внутри нетерминального
-- варианта, и состояние без него невозможно собрать. Здесь то же самое
-- выражается ограничением: строка, не соответствующая ни одному из трёх
-- вариантов союза, не вставляется.

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Сторона
-- ---------------------------------------------------------------------------
--
-- Обе половины `PartyRef` в **одной строке** (`domain/src/party.ts`): порознь их
-- взять неоткуда, и это не удобство, а защита. Пока ключ стороны и ключ её
-- счёта лежали в разных местах, приложение могло назвать стороной одного, а
-- деньги взять со счёта другого, и ни один guard этого не видел.
--
-- Алфавиты у половин **разные и остаются разными**: `party_id` — ключ в
-- профилях и скрининге, `account_key` — форма того же лица в плане счетов, где
-- двоеточие занято под разделитель сегментов. Свести их в один ключ значило бы
-- навязать одному из пакетов чужой алфавит.
CREATE TABLE sdelka.party (
  party_id text PRIMARY KEY CHECK (length(party_id) > 0 AND length(party_id) <= 128),
  account_key text NOT NULL UNIQUE CHECK (account_key ~ '^[A-Za-z0-9._-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Сделка
-- ---------------------------------------------------------------------------

CREATE TABLE sdelka.deal (
  deal_id text PRIMARY KEY CHECK (deal_id ~ '^[^:|]+$' AND length(deal_id) <= 128),
  status sdelka.deal_status NOT NULL,
  buyer_party_id text NOT NULL REFERENCES sdelka.party (party_id),
  seller_party_id text NOT NULL REFERENCES sdelka.party (party_id),
  created_at timestamptz NOT NULL DEFAULT now(),

  -- `FUNCTIONAL.md` §2.1, «Что запрещено жёстко»: одна и та же личность на
  -- обеих сторонах одной сделки — отказ, а не предупреждение. Ключ счёта
  -- уникален по стороне, поэтому сверки по `party_id` достаточно: две стороны с
  -- одним счётом невозможны по построению таблицы выше.
  CONSTRAINT deal_parties_distinct CHECK (buyer_party_id <> seller_party_id)
);

-- ---------------------------------------------------------------------------
-- Акт получателя об условии — CORE.md Ф13
-- ---------------------------------------------------------------------------
--
-- Порождающий акт всей конструкции: статья 27(2) держится на том, что
-- обстоятельство определяет **получатель**, а не платформа. Условие, зависящее
-- от усмотрения платформы, делает сделку ничтожной (красная линия №6).
CREATE TABLE sdelka.condition_act (
  deal_id text NOT NULL REFERENCES sdelka.deal (deal_id),
  tranche_id text NOT NULL CHECK (tranche_id ~ '^[^:|]+$' AND length(tranche_id) <= 128),
  recipient_party_id text NOT NULL REFERENCES sdelka.party (party_id),
  agreed_at timestamptz NOT NULL,

  -- Редакция текста условия, действовавшая в момент акта (инвариант 23). Здесь
  -- ключ версии, а не сам текст: текста для клиента в базе нет, а неизменяемое
  -- хранение редакции — забота хранилища документов.
  condition_text_version text NOT NULL CHECK (length(condition_text_version) > 0),
  condition_type sdelka.release_condition_type NOT NULL,

  PRIMARY KEY (deal_id, tranche_id),
  -- Транш ссылается на акт по этому ключу: наличие акта становится внешним
  -- ключом, а не совпадением идентификаторов.
  UNIQUE (deal_id, tranche_id, agreed_at),

  -- `STATE-MACHINES.md` §8: `registration_preliminary` помечен **[открыто]** и
  -- до подтверждения не используется. Зеркало `isUsableReleaseCondition`:
  -- непроверенное условие обязано быть видимым отказом, а не раствориться в
  -- конфигурации.
  CONSTRAINT condition_act_usable_type CHECK (condition_type <> 'registration_preliminary')
);

-- ---------------------------------------------------------------------------
-- Транш
-- ---------------------------------------------------------------------------
--
-- Суммы и сроки живут **на транше, а не на сделке**: транш — гражданин первого
-- класса (`docs/research/CTO-architecture.md`), сделка его оркестрирует.
CREATE TABLE sdelka.tranche (
  deal_id text NOT NULL REFERENCES sdelka.deal (deal_id),
  tranche_id text NOT NULL CHECK (tranche_id ~ '^[^:|]+$' AND length(tranche_id) <= 128),
  status sdelka.tranche_status NOT NULL,

  -- Две отметки времени, и смешивать их нельзя (`STATE-MACHINES.md` §5):
  -- `deadline_at` двигается и по нему наступает автоматический переход,
  -- `entered_at` не двигается и по нему считается возраст и эскалация. Пока
  -- возраст считали по дедлайну, застрявшая выплата выглядела вечно свежей.
  deadline_at timestamptz,
  entered_at timestamptz,

  -- Заморозка (`CORE.md` Ф17): дедлайн **не отменён, а приостановлен**.
  -- Отсутствие дедлайна вместе с наличием остатка — и есть приостановка.
  suspended_from sdelka.tranche_status,
  remaining_ms bigint CHECK (remaining_ms IS NULL OR remaining_ms > 0),
  freeze_reason sdelka.freeze_reason,
  frozen_by text,

  required_amount_minor numeric(38, 0) CHECK (
    required_amount_minor IS NULL OR required_amount_minor > 0
  ),
  required_currency text REFERENCES sdelka.currency (code),

  -- Наличие акта — внешний ключ, а не флаг.
  condition_act_agreed_at timestamptz,

  PRIMARY KEY (deal_id, tranche_id),
  FOREIGN KEY (deal_id, tranche_id, condition_act_agreed_at)
    REFERENCES sdelka.condition_act (deal_id, tranche_id, agreed_at),

  CONSTRAINT tranche_amount_whole CHECK (
    (required_amount_minor IS NULL) = (required_currency IS NULL)
  ),

  -- Три варианта союза `TrancheState`, построчно.
  --
  -- 1. Терминальный (`paid_out|refunded|written_off`) — в TS у него нет ни
  --    одного поля кроме статуса: часы остановлены навсегда.
  -- 2. `frozen` — дедлайна нет, остаток есть, приостановленный статус, причина
  --    и тот, кто заморозил, есть; возраст (`entered_at`) идёт как обычно,
  --    потому что §5 требует обязательного срока разбора именно здесь.
  -- 3. Остальные (остывшие) — дедлайн и возраст есть, остатка и признаков
  --    заморозки нет.
  --
  -- Это и есть инвариант «транш в нетерминальном состоянии без дедлайна —
  -- ошибка» (`CLAUDE.md`, `FUNCTIONAL.md` инвариант 7) вместе с оговоркой про
  -- остаток приостановленного дедлайна, добавленной вместе с заморозкой.
  CONSTRAINT tranche_state_shape CHECK (
    CASE
      WHEN status IN ('paid_out', 'refunded', 'written_off') THEN
        deadline_at IS NULL AND entered_at IS NULL AND suspended_from IS NULL
        AND remaining_ms IS NULL AND freeze_reason IS NULL AND frozen_by IS NULL
      WHEN status = 'frozen' THEN
        deadline_at IS NULL AND entered_at IS NOT NULL AND suspended_from IS NOT NULL
        AND remaining_ms IS NOT NULL AND freeze_reason IS NOT NULL AND frozen_by IS NOT NULL
      ELSE
        deadline_at IS NOT NULL AND entered_at IS NOT NULL AND suspended_from IS NULL
        AND remaining_ms IS NULL AND freeze_reason IS NULL AND frozen_by IS NULL
    END
  ),

  -- Заморозить можно из любого остывшего состояния, **кроме `pending`**
  -- (`FREEZABLE_TRANCHE_STATUSES`). В `pending` денег ещё нет — замораживать
  -- нечего, а обратный переход открыл бы вход в стартовое состояние заново:
  -- транш, у которого деньги уже были, снова назывался бы «создан, денег нет».
  -- Гарантия §5 «стартовое состояние не переоткрывается» держится этим списком.
  CONSTRAINT tranche_freezable_origin CHECK (
    suspended_from IS NULL OR suspended_from IN (
      'collecting',
      'collected',
      'reserved',
      'release_pending',
      'release_blocked',
      'paying_out',
      'refund_pending',
      'refunding'
    )
  ),

  -- Зеркало `assertConditionAct` (`CORE.md` Ф13): состояние после `pending` без
  -- акта получателя собрать нельзя — приём средств открывается только актом.
  --
  -- ⚠ Отличие от TS, названное сознательно: терминальный вариант союза акта не
  -- несёт вовсе, здесь он остаётся. Акт — история транша, а не его текущее
  -- состояние, и стирать его в момент расчёта значило бы терять основание,
  -- ради которого весь механизм и построен.
  CONSTRAINT tranche_condition_act_required CHECK (
    status = 'pending' OR condition_act_agreed_at IS NOT NULL
  )
);

CREATE INDEX tranche_deadline ON sdelka.tranche (deadline_at)
  WHERE deadline_at IS NOT NULL;

-- Замороженные транши разбирает дежурный, и §5 требует обязательного срока
-- разбора: список обязан быть дешёвым.
CREATE INDEX tranche_frozen ON sdelka.tranche (entered_at) WHERE status = 'frozen';

GRANT SELECT, INSERT, UPDATE ON
  sdelka.party, sdelka.deal, sdelka.condition_act, sdelka.tranche TO sdelka_app;

-- ===== 0005_payout.sql =====
-- 0005 — выплаты и выводы: частичный уникальный индекс.
--
-- `CLAUDE.md`, «Инварианты, проверяемые базой»: «не более одной выплаты по
-- траншу в активных статусах — частичный уникальный индекс». `FUNCTIONAL.md`
-- §2, инвариант 9.

SET LOCAL ROLE sdelka_owner;

CREATE TABLE sdelka.payout (
  payout_id text PRIMARY KEY CHECK (length(payout_id) > 0 AND length(payout_id) <= 128),
  deal_id text NOT NULL,
  tranche_id text NOT NULL,
  status sdelka.payout_status NOT NULL,

  -- Ключ идемпотентности детерминирован **по траншу** и только по нему
  -- (`payoutIdempotencyKey`, инвариант 13): ни номера попытки, ни времени, иначе
  -- повтор при потерянном ответе банка создаст вторую выплату.
  --
  -- Глобального `UNIQUE` на этой колонке нет **намеренно**. Повторная выплата
  -- после `rejected` несёт тот же ключ — он функция транша, — и глобальная
  -- уникальность запретила бы задокументированный путь восстановления
  -- `paying_out --payout_result(rejected)--> release_blocked → release_pending →
  -- paying_out` (`STATE-MACHINES.md` §1.4). Уникальность живёт ровно там, где
  -- она означает то, что нужно: в частичном индексе по активным статусам.
  idempotency_key uuid NOT NULL,

  -- Красная линия №5: «выплата невозможна без ссылки на пакет доказательств.
  -- Кнопки „просто выплатить“ не существует». `NOT NULL` на уровне колонки —
  -- это и есть отсутствие такой кнопки.
  evidence_bundle_id text NOT NULL CHECK (length(evidence_bundle_id) > 0),

  amount_minor numeric(38, 0) NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL REFERENCES sdelka.currency (code),
  beneficiary_party_id text NOT NULL REFERENCES sdelka.party (party_id),

  created_at timestamptz NOT NULL DEFAULT now(),
  -- Ответ провайдера, если он был. NULL — ответа нет, и это `unknown`.
  provider_reference text,

  FOREIGN KEY (deal_id, tranche_id) REFERENCES sdelka.tranche (deal_id, tranche_id),

  -- `STATE-MACHINES.md` §2.2: ни один адаптер не возвращает «отказ» при сетевой
  -- ошибке — только «неизвестно». Отказ — это явный ответ провайдера, поэтому
  -- у него обязана быть ссылка на ответ; у `unknown` её быть не может.
  CONSTRAINT payout_unknown_has_no_response CHECK (
    status <> 'unknown' OR provider_reference IS NULL
  )
);

-- Инвариант 9 целиком.
--
-- Предикат — дословно `ACTIVE_PAYOUT_STATUSES` (`domain/src/payout.ts`).
-- `unknown` здесь **активен**, и это главное: деньги, возможно, ушли
-- (`STATE-MACHINES.md` §2.2, красная линия №8). Считать «неизвестно»
-- завершением значило бы разрешить вторую выплату по тому же траншу ровно в тот
-- момент, когда первая, вероятно, исполнена.
CREATE UNIQUE INDEX payout_one_active_per_tranche
  ON sdelka.payout (deal_id, tranche_id)
  WHERE status IN ('created', 'submitted', 'unknown');

-- ---------------------------------------------------------------------------
-- Вывод со счёта клиента — ROADMAP.md И12.2
-- ---------------------------------------------------------------------------
--
-- Своя машина и свой ключ идемпотентности (`withdrawalIdempotencyKey`): у
-- вывода транша нет вовсе, поэтому ключ по траншу здесь не годится.
CREATE TABLE sdelka.withdrawal (
  withdrawal_id text PRIMARY KEY CHECK (length(withdrawal_id) > 0 AND length(withdrawal_id) <= 128),
  party_id text NOT NULL REFERENCES sdelka.party (party_id),
  status sdelka.withdrawal_status NOT NULL,
  idempotency_key uuid NOT NULL,

  amount_minor numeric(38, 0) NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL REFERENCES sdelka.currency (code),

  -- Красная линия №9: возврат и вывод — только на счёт-источник, на имя
  -- плательщика. Здесь отпечаток реквизитов, а не сами реквизиты
  -- (`compliance/src/pii.ts`): номер счёта в открытом виде в базе не живёт.
  source_account_fingerprint text NOT NULL CHECK (source_account_fingerprint ~ '^[0-9a-f]{64}$'),

  created_at timestamptz NOT NULL DEFAULT now()
);

-- Зеркало `g_no_active_withdrawal` (`domain/src/client-account.ts`): вывод не
-- выпускается, пока по счёту есть незавершённый.
--
-- ⚠ **Решение там, где спека молчит.** Домен считает активные выводы числом
-- (`facts.activeWithdrawals`), а какие статусы в это число входят, не сказано
-- нигде. Берём все нетерминальные: `WITHDRAWAL_STATUSES` минус
-- `TERMINAL_WITHDRAWAL_STATUSES`. Следствие: заблокированный вывод не даёт
-- завести следующий, пока оператор его не отменит (`blocked → cancelled` в
-- таблице переходов есть). Это сознательно закрытая сторона: незавершённый
-- вывод, о котором забыли, — худшее из двух состояний.
CREATE UNIQUE INDEX withdrawal_one_active_per_party
  ON sdelka.withdrawal (party_id)
  WHERE status IN ('requested', 'approved', 'paying_out', 'blocked');

GRANT SELECT, INSERT, UPDATE ON sdelka.payout, sdelka.withdrawal TO sdelka_app;

-- ===== 0006_facts.sql =====
-- 0006 — факты, на которых стоят решения: реквизиты, наблюдение оракула,
-- входящие платежи, исходящая очередь.
--
-- Общее правило этой миграции: **персональных данных в открытом виде здесь
-- нет**. Номер документа, личный номер и реквизиты счёта живут отпечатками
-- (`compliance/src/pii.ts`, инвариант 24): сравнение «тот же документ / тот же
-- счёт» остаётся возможным, а сам номер физически недоступен ни решению, ни
-- журналу, ни тесту. Офлайн-тест `test/pii.test.ts` держит перечень запрещённых
-- имён колонок.

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Реквизиты выплаты — CORE.md Ф15, ROADMAP.md И13.1
-- ---------------------------------------------------------------------------

CREATE TABLE sdelka.beneficiary (
  party_id text PRIMARY KEY REFERENCES sdelka.party (party_id),
  status sdelka.beneficiary_status NOT NULL,

  -- Только отпечаток: ни номера счёта, ни имени владельца в открытом виде.
  account_fingerprint text NOT NULL CHECK (account_fingerprint ~ '^[0-9a-f]{64}$'),

  -- Два **разных** признака, и склеивать их нельзя: `g_beneficiary_verified`
  -- (доказательство владения есть) и `g_beneficiary_locked` (реквизиты заперты
  -- и не менялись в запретном окне). §1.3 требует, чтобы каждое условие
  -- проверялось поимённо: два условия под одним именем не тестируются по
  -- отдельности.
  locked boolean NOT NULL DEFAULT false,
  last_changed_at timestamptz,

  -- ⚠ **[открыто]**, и схема этого не решает. Инвариант 17 говорит, что
  -- реквизиты блокируются при **резервировании**; `CORE.md` Ф15 и
  -- `packages/compliance` — при **финансировании сделки**. Расхождение старше
  -- этой миграции и помечено в `FUNCTIONAL.md` инвариант 17. Здесь хранится
  -- только факт: когда и по какому событию заперли. Решение принимает тот, кто
  -- закроет расхождение.
  locked_at timestamptz,
  locked_by_event text,

  CONSTRAINT beneficiary_lock_whole CHECK (locked = (locked_at IS NOT NULL)),
  CONSTRAINT beneficiary_lock_event CHECK ((locked_at IS NULL) = (locked_by_event IS NULL))
);

-- ---------------------------------------------------------------------------
-- Наблюдение оракула — CORE.md Ф7, ORACLE.md
-- ---------------------------------------------------------------------------
--
-- Хранится **факт**, а не состояние машины. `STATE-MACHINES.md` §10 называет
-- машину наблюдения, но её переходы здесь не моделируются: они живут в
-- `packages/oracle`, и до решения о том, что из них попадает в базу, это
-- **[открыто]**.
--
-- Пять полей выписки — **поимённо, а не счётчиком** (`StatementFields`):
-- «сошлось четыре из пяти» — не результат, а расхождение. Счётчик именно это
-- различие и стирает.
CREATE TABLE sdelka.registry_observation (
  observation_id text PRIMARY KEY CHECK (length(observation_id) > 0),
  deal_id text NOT NULL,
  tranche_id text NOT NULL,

  level sdelka.observation_level NOT NULL,
  condition_type sdelka.release_condition_type NOT NULL,
  -- Ключ источника из `RELEASE_CONDITIONS`, а не название поставщика.
  source_key text NOT NULL CHECK (source_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  cadastral_code text NOT NULL CHECK (length(cadastral_code) > 0),

  field_cadastral_code boolean NOT NULL,
  -- Собственник сверяется **по номеру документа, а не по имени** (`CORE.md`
  -- Ф7): латинизация грузинского необратима, пять пар букв схлопываются, и
  -- сверка по именам либо пропустит мошенничество, либо заблокирует половину
  -- честных сделок.
  field_owner_document_number boolean NOT NULL,
  field_share boolean NOT NULL,
  field_basis boolean NOT NULL,
  field_no_unexpected_encumbrances boolean NOT NULL,

  owner_check sdelka.owner_check NOT NULL,
  observed_at timestamptz NOT NULL,

  -- Отпечаток сырого ответа источника обязателен: «разобранные поля без
  -- исходника суд не убедит» (`CORE.md` Ф11). Требование, выраженное схемой,
  -- невозможно забыть.
  raw_source_digest text NOT NULL CHECK (raw_source_digest ~ '^[0-9a-f]{64}$'),

  FOREIGN KEY (deal_id, tranche_id) REFERENCES sdelka.tranche (deal_id, tranche_id)
);

CREATE INDEX registry_observation_tranche
  ON sdelka.registry_observation (deal_id, tranche_id, observed_at DESC);

-- Откуда известно о подаче заявления — `ROADMAP.md` И3.2. Источник факта —
-- атрибут, а не флаг: разница между «сторона назвала номер» и «мы сами увидели
-- карточку» — это разница между тем, управляет ли сторона нашим дедлайном.
CREATE TABLE sdelka.registry_filing (
  filing_id text PRIMARY KEY CHECK (length(filing_id) > 0),
  deal_id text NOT NULL,
  tranche_id text NOT NULL,
  source sdelka.filing_source NOT NULL,
  claimed_at timestamptz NOT NULL,
  raw_source_digest text CHECK (
    raw_source_digest IS NULL OR raw_source_digest ~ '^[0-9a-f]{64}$'
  ),

  FOREIGN KEY (deal_id, tranche_id) REFERENCES sdelka.tranche (deal_id, tranche_id),

  -- Карточка заявления — это документ, и без отпечатка ответа реестра она не
  -- отличается от слов стороны. Названный стороной номер отпечатка не имеет и
  -- иметь не может.
  CONSTRAINT registry_filing_card_has_source CHECK (
    (source = 'application_card') = (raw_source_digest IS NOT NULL)
  )
);

-- ---------------------------------------------------------------------------
-- Входящий платёж и очередь непознанных — packages/intake
-- ---------------------------------------------------------------------------

CREATE TABLE sdelka.inbound_payment (
  payment_id text PRIMARY KEY CHECK (length(payment_id) > 0),
  received_at timestamptz NOT NULL,
  amount_minor numeric(38, 0) NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL REFERENCES sdelka.currency (code),

  -- Референс, названный плательщиком. Технический ключ, не текст назначения:
  -- назначение платежа — свободная строка, и её место в хранилище документов.
  reference text,

  -- Имя отправителя не хранится строкой: инвариант 19 требует **сверки** имени
  -- отправителя с покупателем, и сверку делает комплаенс по отпечаткам.
  payer_name_fingerprint text CHECK (
    payer_name_fingerprint IS NULL OR payer_name_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  payer_account_fingerprint text CHECK (
    payer_account_fingerprint IS NULL OR payer_account_fingerprint ~ '^[0-9a-f]{64}$'
  ),

  -- Запись журнала, которой поступление опознано. `NULL` — поступление ещё
  -- висит в непознанных (`suspense:unidentified`, §3.3, шаг 1).
  identified_by_entry_id text REFERENCES sdelka.ledger_entry (entry_id),
  identified_client_key text CHECK (
    identified_client_key IS NULL OR identified_client_key ~ '^[A-Za-z0-9._-]{1,128}$'
  ),

  CONSTRAINT inbound_payment_identification_whole CHECK (
    (identified_by_entry_id IS NULL) = (identified_client_key IS NULL)
  )
);

CREATE INDEX inbound_payment_unidentified
  ON sdelka.inbound_payment (received_at)
  WHERE identified_by_entry_id IS NULL;

-- ---------------------------------------------------------------------------
-- Исходящая очередь — инвариант 15
-- ---------------------------------------------------------------------------
--
-- «Внешние вызовы только через исходящую очередь, никогда внутри транзакции
-- базы». Смысл таблицы ровно в этом: транзакция кладёт **намерение**, а вызов
-- делает отдельный процесс. Иначе откат транзакции не отменяет уже отправленное
-- поручение, а сетевой таймаут держит транзакцию открытой.
CREATE TABLE sdelka.outbox (
  outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  topic text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  -- Ключ идемпотентности вызова: повтор при потерянном ответе обязан быть
  -- тем же вызовом, а не вторым (инвариант 13).
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  dispatched_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),

  UNIQUE (topic, idempotency_key)
);

CREATE INDEX outbox_pending ON sdelka.outbox (created_at) WHERE dispatched_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON
  sdelka.beneficiary, sdelka.registry_observation, sdelka.registry_filing,
  sdelka.inbound_payment, sdelka.outbox TO sdelka_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA sdelka TO sdelka_app;

-- ===== 0007_audit.sql =====
-- 0007 — журнал аудита: хеш-цепочка и **гранты**.
--
-- `CLAUDE.md`, «Инварианты, проверяемые базой»: «роль приложения не имеет прав
-- на изменение и удаление журнала аудита — проверяется грантами».
-- `FUNCTIONAL.md` инвариант 21, `CORE.md` Ф11: «проверяется грантами базы, а не
-- кодом».
--
-- **Чего база не делает.** Значение `record_hash` она не пересчитывает. Для
-- этого нужна вторая реализация `canonical.ts` на PL/pgSQL — типовые теги,
-- длины частей в байтах, отказ от плавающей точки, — то есть ровно тот дрейф
-- двух моделей, который в этом проекте уже случался. База держит **сцепку,
-- нумерацию, монотонность времени и append-only**; значение хеша проверяет
-- `verifyChain` из `@sdelka/audit` на чтении.

SET LOCAL ROLE sdelka_owner;

-- Форма идентификатора — зеркало `AUDIT_TOKEN` (`audit/src/values.ts`):
-- «пробелов нет, `@` нет — значит, в журнал физически не входит ни свободный
-- текст, ни адрес почты, ни имя».
--
-- Записана она как `*` плюс явная длина, а не `{0,511}`: POSIX-регулярка
-- Postgres ограничивает счётчик повторений двумя с половиной сотнями, и
-- выражение со счётчиком больше компилируется молча, а падает на первой
-- вставке. Форма другая, множество допустимых строк то же самое.
CREATE TABLE sdelka.audit_record (
  chain_id text NOT NULL CHECK (chain_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(chain_id) <= 512),
  seq integer NOT NULL CHECK (seq >= 0),
  record_id text NOT NULL CHECK (record_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(record_id) <= 512),

  version integer NOT NULL CHECK (version >= 1),
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  record_hash text NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,

  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(actor_id) <= 512),
  role_id sdelka.audit_role NOT NULL,
  -- Полномочие, под которым совершено действие. `NULL` для `system` и `oracle`:
  -- у перехода по дедлайну и у наблюдения из реестра человека нет.
  capability text,

  subject_scope sdelka.ref_scope NOT NULL,
  subject_id text NOT NULL CHECK (subject_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(subject_id) <= 512),
  related jsonb NOT NULL DEFAULT '[]'::jsonb,

  kind sdelka.audit_record_kind NOT NULL,
  body jsonb NOT NULL,

  PRIMARY KEY (chain_id, seq),
  UNIQUE (record_id),
  -- Хеш записи уникален: два одинаковых хеша означают либо копию, либо
  -- коллизию, и оба случая — повод остановиться, а не продолжить.
  UNIQUE (chain_id, record_hash),

  -- Вид записи лежит и колонкой, и в теле. Расхождение между ними сделало бы
  -- выборку по виду ложью, а хеш считается по телу.
  CONSTRAINT audit_record_kind_matches_body CHECK (body ->> 'kind' = kind::text),
  CONSTRAINT audit_record_related_is_array CHECK (jsonb_typeof(related) = 'array')
);

CREATE INDEX audit_record_subject ON sdelka.audit_record (subject_scope, subject_id, seq);
CREATE INDEX audit_record_recorded_at ON sdelka.audit_record (recorded_at);

-- ---------------------------------------------------------------------------
-- Сцепка — зеркало appendRecord (audit/src/chain.ts)
-- ---------------------------------------------------------------------------
--
-- Немонотонное время отвергается **при вставке**, а не только при проверке:
-- «запись не правилась задним числом» обязано быть невозможно совершить, а не
-- только заметно постфактум.
CREATE FUNCTION sdelka.assert_audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last sdelka.audit_record%ROWTYPE;
  covered sdelka.audit_record%ROWTYPE;
  target_id text;
BEGIN
  -- `FOR UPDATE` — иначе две параллельные вставки прочитают одну и ту же
  -- «последнюю» запись и обе получат `seq = n+1`. Уникальность (chain_id, seq)
  -- поймала бы это вторым контуром, но с бессмысленным сообщением.
  SELECT * INTO last
    FROM sdelka.audit_record
   WHERE chain_id = NEW.chain_id
   ORDER BY seq DESC
   LIMIT 1
     FOR UPDATE;

  IF NOT FOUND THEN
    -- Начало цепочки — явная запись `chain_opened` с нулевым предыдущим хешом.
    -- Без явного генезиса «пустая цепочка» и «цепочка, у которой отрезали
    -- начало» неразличимы, а вторая — ровно та порча, которую журнал обязан
    -- ловить (`genesisChain`).
    IF NEW.seq <> 0 OR NEW.prev_hash <> repeat('0', 64) OR NEW.kind <> 'chain_opened' THEN
      RAISE EXCEPTION 'db.audit.genesis_required'
        USING ERRCODE = '23514',
              DETAIL = format('chain_id=%s;seq=%s;kind=%s', NEW.chain_id, NEW.seq, NEW.kind);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.seq <> last.seq + 1 THEN
    RAISE EXCEPTION 'db.audit.chain_gap'
      USING ERRCODE = '23514',
            DETAIL = format('chain_id=%s;expected=%s;actual=%s',
                            NEW.chain_id, last.seq + 1, NEW.seq);
  END IF;

  IF NEW.prev_hash <> last.record_hash THEN
    RAISE EXCEPTION 'db.audit.prev_hash_mismatch'
      USING ERRCODE = '23514',
            DETAIL = format('chain_id=%s;seq=%s', NEW.chain_id, NEW.seq);
  END IF;

  IF NEW.recorded_at < last.recorded_at THEN
    RAISE EXCEPTION 'audit.record.time_regression'
      USING ERRCODE = '23514',
            DETAIL = format('chain_id=%s;seq=%s', NEW.chain_id, NEW.seq);
  END IF;

  -- Красная линия №11: исправление — новой записью **со ссылкой на предыдущую**.
  -- Ссылка на запись, которой в цепочке нет, ссылкой не является.
  IF NEW.kind = 'correction' THEN
    target_id := NEW.body ->> 'correctsRecordId';
    IF target_id = NEW.record_id THEN
      RAISE EXCEPTION 'audit.correction.self_reference'
        USING ERRCODE = '23514', DETAIL = format('record_id=%s', NEW.record_id);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM sdelka.audit_record
       WHERE chain_id = NEW.chain_id AND record_id = target_id
    ) THEN
      RAISE EXCEPTION 'audit.correction.target_missing'
        USING ERRCODE = '23514', DETAIL = format('record_id=%s', NEW.record_id);
    END IF;
  END IF;

  -- Метка времени, покрывающая не тот хеш, доказывает не ту запись.
  IF NEW.kind = 'timestamp_token' THEN
    SELECT * INTO covered
      FROM sdelka.audit_record
     WHERE chain_id = NEW.chain_id AND record_id = NEW.body ->> 'coversRecordId';
    IF NOT FOUND OR covered.record_hash <> NEW.body ->> 'coveredHash' THEN
      RAISE EXCEPTION 'audit.timestamp.target_missing'
        USING ERRCODE = '23514', DETAIL = format('record_id=%s', NEW.record_id);
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER assert_audit_chain
  BEFORE INSERT ON sdelka.audit_record
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_audit_chain();

-- Второй контур append-only: ловит и владельца схемы, которого гранты не
-- ограничивают. Первый контур — гранты ниже, и именно он назван инвариантом.
CREATE FUNCTION sdelka.forbid_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'db.audit.append_only'
    USING ERRCODE = '0A000', DETAIL = format('operation=%s', TG_OP);
END
$$;

CREATE TRIGGER forbid_audit_mutation
  BEFORE UPDATE OR DELETE ON sdelka.audit_record
  FOR EACH ROW EXECUTE FUNCTION sdelka.forbid_audit_mutation();

-- ---------------------------------------------------------------------------
-- Гранты — это и есть инвариант 21
-- ---------------------------------------------------------------------------
--
-- Роль приложения получает **только** чтение и вставку. `REVOKE` стоит явно, а
-- не подразумевается отсутствием `GRANT`: подразумеваемое не читается глазами
-- при ревью и не проверяется запросом к `information_schema`.
--
-- ⚠ Гранты не защищают от суперпользователя и от владельца объекта — это и не
-- их работа. Поэтому роль приложения намеренно **не** владелец (`roles.ts`), а
-- триггер выше стоит вторым контуром.
GRANT SELECT, INSERT ON sdelka.audit_record TO sdelka_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sdelka.audit_record FROM sdelka_app;
REVOKE ALL ON sdelka.audit_record FROM PUBLIC;

-- На будущее: таблица, заведённая следующей миграцией, не должна тихо
-- достаться роли приложения с полными правами.
ALTER DEFAULT PRIVILEGES FOR ROLE sdelka_owner IN SCHEMA sdelka
  REVOKE UPDATE, DELETE, TRUNCATE ON TABLES FROM sdelka_app;

-- ===== 0008_views.sql =====
-- 0008 — сверка представлениями.
--
-- Здесь база **видит** то, что не запрещает. Разница принципиальная и названа
-- честно: покрытие клиентских средств (красная линия №3) ограничением быть не
-- может, потому что недостачу нужно уметь **записать**, чтобы её увидеть.
-- Ограничение сделало бы её непроводимой и невидимой одновременно. Поэтому
-- покрытие — представление плюс стоп-кран приложения, а не CHECK.
--
-- Все представления классифицируют счета **джойном справочника**
-- `sdelka.account_kind`. Ни одного перечня имён счетов в SQL нет: перечень имён
-- — та самая дыра, которая дважды стоила учёту `isClientObligationAccount`.

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Проводка вместе с природой счёта и остатком в естественном знаке
-- ---------------------------------------------------------------------------
--
-- Естественный знак: актив и расход — Дт минус Кт, обязательство и доход — Кт
-- минус Дт (`naturalSign`). Так «отрицательный остаток» означает ровно то, что
-- означает в инварианте, а не зависит от точки зрения.
CREATE VIEW sdelka.v_posting AS
SELECT p.entry_id,
       p.ord,
       e.seq AS entry_seq,
       e.occurred_at,
       e.kind AS entry_kind,
       p.account_code,
       p.account_kind,
       p.currency,
       p.direction,
       p.amount_minor,
       p.client_key,
       p.account_deal_id,
       p.account_tranche_id,
       p.conversion_id,
       p.attribution_client_key,
       p.attribution_deal_id,
       p.attribution_tranche_id,
       k.acct_type,
       k.funds,
       k.platform_role,
       k.file_scope,
       k.pool_direction,
       CASE WHEN (k.acct_type IN ('asset', 'expense')) = (p.direction = 'debit')
            THEN p.amount_minor ELSE -p.amount_minor END AS natural_minor,
       CASE WHEN p.direction = 'debit' THEN p.amount_minor ELSE -p.amount_minor END AS signed_minor
  FROM sdelka.ledger_posting p
  JOIN sdelka.ledger_entry e ON e.entry_id = p.entry_id
  JOIN sdelka.account_kind k ON k.kind = p.account_kind;

CREATE VIEW sdelka.v_ledger_balance AS
SELECT account_code,
       currency,
       min(account_kind::text) AS account_kind,
       min(acct_type::text) AS acct_type,
       min(funds::text) AS funds,
       sum(natural_minor) AS balance_minor
  FROM sdelka.v_posting
 GROUP BY account_code, currency;

-- ---------------------------------------------------------------------------
-- Отрицательные остатки
-- ---------------------------------------------------------------------------

CREATE VIEW sdelka.v_negative_client_balance AS
SELECT b.account_code, b.currency, b.balance_minor
  FROM sdelka.v_ledger_balance b
 WHERE b.funds = 'client' AND b.balance_minor < 0;

CREATE VIEW sdelka.v_negative_bank_balance AS
SELECT b.account_code, b.currency, b.balance_minor
  FROM sdelka.v_ledger_balance b
  JOIN sdelka.account_kind k ON k.kind::text = b.account_kind
 WHERE k.platform_role = 'bank' AND b.balance_minor < 0;

-- Требование или транзит платформы в минусе. Отдельно от банковского счёта
-- намеренно: «банковский счёт в минусе» на требовании по начисленной комиссии —
-- ложное сообщение дежурному, а разбираются они по-разному.
CREATE VIEW sdelka.v_negative_platform_asset AS
SELECT b.account_code, b.currency, b.balance_minor
  FROM sdelka.v_ledger_balance b
  JOIN sdelka.account_kind k ON k.kind::text = b.account_kind
 WHERE k.platform_role IN ('receivable', 'transit') AND b.balance_minor < 0;

-- ---------------------------------------------------------------------------
-- Покрытие
-- ---------------------------------------------------------------------------
--
-- Отношение покрытия — **двумя целыми**, никогда одним дробным числом и тем
-- более не `float` (красная линия №4). Делить здесь нечего: сравнение
-- `custody >= obligations` целочисленное, а отношение нужно только для отчёта.
CREATE VIEW sdelka.v_coverage AS
SELECT currency,
       sum(CASE WHEN funds = 'client' AND acct_type = 'asset' AND file_scope = 'in_attribution'
                THEN natural_minor ELSE 0 END) AS custody_minor,
       sum(CASE WHEN funds = 'client' AND acct_type = 'liability'
                     AND pool_direction IS DISTINCT FROM 'terminal'
                THEN natural_minor ELSE 0 END) AS obligations_minor
  FROM sdelka.v_posting
 WHERE funds = 'client'
 GROUP BY currency;

COMMENT ON VIEW sdelka.v_coverage IS
  'Портфельное покрытие. Невостребованные средства сюда не входят: §3.1 требует для них отдельной проверки.';

-- Вторая проверка, которую требует §3.1: деньги, признанные чужими, ушли с
-- номинального счёта и потому выпадают из основного отношения. Сопоставляются с
-- тем, где физически лежат: банковские счета платформы плюс транзит списания.
--
-- ⚠ Показывает **достаточность**, а не раздельность: на операционном счёте
-- лежат и собственные деньги платформы. Раздельность даст только отдельный
-- счёт, и это решение владельца вместе с ответом на вопрос §3.1 **[открыто]**.
CREATE VIEW sdelka.v_coverage_unclaimed AS
SELECT currency, custody_minor, obligations_minor
  FROM (
    SELECT currency,
           sum(CASE WHEN platform_role = 'bank'
                      OR (pool_direction = 'terminal' AND acct_type = 'asset')
                    THEN natural_minor ELSE 0 END) AS custody_minor,
           sum(CASE WHEN pool_direction = 'terminal' AND acct_type = 'liability'
                    THEN natural_minor ELSE 0 END) AS obligations_minor
      FROM sdelka.v_posting
     GROUP BY currency
  ) t
 -- Валюта без невостребованных обязательств отношения не образует: остаток
 -- операционного счёта сам по себе ничего не покрывает.
 WHERE obligations_minor <> 0;

-- ---------------------------------------------------------------------------
-- Файл проводки и пофайловое покрытие
-- ---------------------------------------------------------------------------
--
-- Файл: у обязательства с владельцем в коде — из кода счёта, у кастодиана — из
-- отнесения, у пулов его нет вовсе. Перечня видов счетов здесь нет: и то и
-- другое читается по объявленной природе счёта (`sourceOfPosting`).
CREATE VIEW sdelka.v_posting_file AS
SELECT p.*,
       CASE
         WHEN p.file_scope = 'owner_in_code' AND p.account_tranche_id IS NOT NULL THEN 'tranche'
         WHEN p.file_scope = 'owner_in_code' THEN 'client'
         WHEN p.file_scope = 'in_attribution' AND p.attribution_deal_id IS NOT NULL THEN 'tranche'
         WHEN p.file_scope = 'in_attribution' AND p.attribution_client_key IS NOT NULL THEN 'client'
       END AS source_kind,
       CASE
         WHEN p.file_scope = 'owner_in_code' THEN p.client_key
         WHEN p.file_scope = 'in_attribution' THEN p.attribution_client_key
       END AS source_client_key,
       CASE
         WHEN p.file_scope = 'owner_in_code' THEN p.account_deal_id
         WHEN p.file_scope = 'in_attribution' THEN p.attribution_deal_id
       END AS source_deal_id,
       CASE
         WHEN p.file_scope = 'owner_in_code' THEN p.account_tranche_id
         WHEN p.file_scope = 'in_attribution' THEN p.attribution_tranche_id
       END AS source_tranche_id
  FROM sdelka.v_posting p
 WHERE p.funds = 'client';

-- Пофайловое обеспечение по обоим видам файла: транш и клиент вне сделки
-- (`FUNCTIONAL.md` §3.1, `CORE.md` Ф10). Портфельная сверка расхождения внутри
-- отдельного файла не видит — это прямое требование Ф10.
CREATE VIEW sdelka.v_coverage_by_funds_source AS
SELECT source_kind,
       CASE WHEN source_kind = 'client' THEN source_client_key
            ELSE source_deal_id || ':' || source_tranche_id END AS subject,
       currency,
       sum(CASE WHEN acct_type = 'asset' THEN natural_minor ELSE 0 END) AS custody_minor,
       sum(CASE WHEN acct_type = 'liability' THEN natural_minor ELSE 0 END) AS obligations_minor
  FROM sdelka.v_posting_file
 WHERE source_kind IS NOT NULL
 GROUP BY 1, 2, 3;

-- Частный случай — метрика Г1 «пофайловое обеспечение 100%» (`FUNCTIONAL.md`
-- §3.1). Обязательства берутся с запертых счетов, кастодиан — по отнесению к
-- траншу; свободная часть счёта клиента сюда не попадает, у неё нет транша.
CREATE VIEW sdelka.v_coverage_by_tranche AS
SELECT COALESCE(p.account_deal_id, p.attribution_deal_id) AS deal_id,
       COALESCE(p.account_tranche_id, p.attribution_tranche_id) AS tranche_id,
       p.currency,
       sum(CASE WHEN p.acct_type = 'asset' AND p.attribution_deal_id IS NOT NULL
                THEN p.natural_minor ELSE 0 END) AS custody_minor,
       sum(CASE WHEN p.account_kind = 'client_locked' THEN p.natural_minor ELSE 0 END)
         AS obligations_minor
  FROM sdelka.v_posting p
 WHERE p.funds = 'client'
   AND (p.account_tranche_id IS NOT NULL OR p.attribution_tranche_id IS NOT NULL)
   AND (p.account_kind = 'client_locked' OR p.acct_type = 'asset')
 GROUP BY 1, 2, 3;

-- ⚠ Файл транша попадает сюда, если его тронула **любая** из двух сторон —
-- обязательство или кастодиан, — а не только обязательство. Соблазн отфильтровать
-- по наличию `client_locked` был, и он неверен: кредит номинального счёта,
-- отнесённый к траншу, по которому обязательства не заводилось, уводит файл в
-- минус, и `coverageByTranche` такой файл видит (список строится обеими
-- сторонами). Фильтр по обязательству молча прятал бы ровно этот случай.

-- ---------------------------------------------------------------------------
-- Открытые позиции: обмен и транзит
-- ---------------------------------------------------------------------------
--
-- Ненулевая позиция сама по себе не нарушение — между тремя моментами обмена
-- она обязана быть ненулевой. Расхождением её делает **возраст**, и это уже
-- инвариант, а не отчёт.
--
-- Плоскость проверяется **по записи целиком**, а не после каждой проводки:
-- момент 2 сначала гасит ногу исходной валюты и лишь потом открывает ногу
-- встречной, и по проводкам позиция на миг обнуляется. Возраст обмена — это
-- возраст обмена, а не последнего движения по нему.
CREATE VIEW sdelka.v_fx_position AS
WITH by_entry AS (
  SELECT conversion_id, entry_seq, occurred_at, currency,
         sum(natural_minor) AS delta
    FROM sdelka.v_posting
   WHERE conversion_id IS NOT NULL
   GROUP BY 1, 2, 3, 4
), running AS (
  SELECT conversion_id, entry_seq, occurred_at, currency,
         sum(delta) OVER (PARTITION BY conversion_id, currency
                          ORDER BY entry_seq
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
    FROM by_entry
), entry_state AS (
  -- Остаток по каждой валюте на конец каждой записи, тронувшей обмен. Валюта,
  -- не тронутая этой записью, свой прежний остаток сохраняет, поэтому берётся
  -- последнее известное значение.
  SELECT e.conversion_id, e.entry_seq, e.occurred_at,
         bool_and(COALESCE(r.balance, 0) = 0) AS flat
    FROM (SELECT DISTINCT conversion_id, entry_seq, occurred_at FROM by_entry) e
    LEFT JOIN LATERAL (
      SELECT DISTINCT ON (c.currency) c.currency, c.balance
        FROM running c
       WHERE c.conversion_id = e.conversion_id AND c.entry_seq <= e.entry_seq
       ORDER BY c.currency, c.entry_seq DESC
    ) r ON true
   GROUP BY 1, 2, 3
), opened AS (
  SELECT conversion_id,
         max(occurred_at) FILTER (WHERE flat) AS last_flat_at,
         max(entry_seq) FILTER (WHERE flat) AS last_flat_seq
    FROM entry_state
   GROUP BY conversion_id
), current_balance AS (
  SELECT DISTINCT ON (conversion_id, currency) conversion_id, currency, balance
    FROM running
   ORDER BY conversion_id, currency, entry_seq DESC
)
SELECT c.conversion_id,
       c.currency,
       c.balance AS amount_minor,
       (SELECT min(s.occurred_at)
          FROM entry_state s
         WHERE s.conversion_id = c.conversion_id
           AND s.entry_seq > COALESCE(o.last_flat_seq, -1)) AS opened_at
  FROM current_balance c
  LEFT JOIN opened o ON o.conversion_id = c.conversion_id
 WHERE c.balance <> 0;

-- Транзит: `transit:writeoff` и `transit:fee`. §3.1 обещает про первый дословно
-- — «остаток на нём старше двух банковских дней — расхождение для сверки, а не
-- норма»; Ф16 обещает то же про второй.
CREATE VIEW sdelka.v_transit_position AS
WITH by_entry AS (
  SELECT account_code, currency, entry_seq, occurred_at, sum(natural_minor) AS delta
    FROM sdelka.v_posting
   WHERE platform_role = 'transit'
      OR (pool_direction = 'terminal' AND acct_type = 'asset')
   GROUP BY 1, 2, 3, 4
), running AS (
  SELECT account_code, currency, entry_seq, occurred_at,
         sum(delta) OVER (PARTITION BY account_code, currency
                          ORDER BY entry_seq
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
    FROM by_entry
), last_flat AS (
  SELECT account_code, currency, max(entry_seq) AS seq
    FROM running
   WHERE balance = 0
   GROUP BY 1, 2
), current_balance AS (
  SELECT DISTINCT ON (account_code, currency) account_code, currency, balance
    FROM running
   ORDER BY account_code, currency, entry_seq DESC
)
SELECT c.account_code,
       c.currency,
       c.balance AS amount_minor,
       (SELECT min(r.occurred_at)
          FROM running r
         WHERE r.account_code = c.account_code
           AND r.currency = c.currency
           AND r.entry_seq > COALESCE(f.seq, -1)) AS opened_at
  FROM current_balance c
  LEFT JOIN last_flat f ON f.account_code = c.account_code AND f.currency = c.currency
 WHERE c.balance <> 0;

-- ---------------------------------------------------------------------------
-- Довнесено сверх признанного
-- ---------------------------------------------------------------------------
--
-- Признание считается по проводкам `shortfall:expense` с отнесением к клиенту;
-- довнесённое — это сумма приростов файла этого клиента по всем записям.
-- Прирост больше нуля бывает только там, где платформа положила в файл
-- собственные деньги (это держит `assertNoUnfundedClientFileGain`), поэтому
-- отдельного признака «это довнесение» не требуется — и хорошо, что не
-- требуется: признак ставит тот же, кто строит запись.
CREATE VIEW sdelka.v_shortfall_overfunded AS
WITH recognised AS (
  SELECT attribution_client_key AS client_key, currency, sum(natural_minor) AS minor
    FROM sdelka.v_posting
   WHERE account_kind = 'shortfall_expense' AND attribution_client_key IS NOT NULL
   GROUP BY 1, 2
), gains AS (
  SELECT entry_id, source_client_key AS client_key, currency,
         sum(CASE WHEN acct_type = 'asset' THEN natural_minor ELSE -natural_minor END) AS minor
    FROM sdelka.v_posting_file
   WHERE source_kind = 'client'
   GROUP BY 1, 2, 3
), funded AS (
  SELECT client_key, currency, sum(minor) AS minor
    FROM gains
   WHERE minor > 0
   GROUP BY 1, 2
)
SELECT f.client_key,
       f.currency,
       f.minor - COALESCE(r.minor, 0) AS excess_minor
  FROM funded f
  LEFT JOIN recognised r ON r.client_key = f.client_key AND r.currency = f.currency
 WHERE f.minor - COALESCE(r.minor, 0) > 0;

-- ---------------------------------------------------------------------------
-- Сводка нарушений — зеркало checkLedgerInvariants
-- ---------------------------------------------------------------------------
--
-- Коды **дословно** из `InvariantCode` (`ledger/src/invariants.ts`). Тест
-- дрейфа сверяет оба перечня, а интеграционный тест сверяет саму выдачу:
-- `SELECT * FROM v_ledger_invariant_violation` посимвольно равно
-- `checkLedgerInvariants(journal)` на каждом сценарии.
--
-- Функция, а не только представление: у двух проверок есть возраст, и у него
-- есть настройки (`InvariantOptions`). Умолчания те же, что в TS: `as_of` —
-- самая поздняя `occurred_at` в журнале («сейчас» для журнала это момент
-- последнего известного факта, а не системные часы), окно — 48 часов
-- календарных, потому что банковского календаря в учёте нет и быть не должно.
CREATE FUNCTION sdelka.ledger_invariant_violation(
  as_of timestamptz DEFAULT NULL,
  stale_after_ms bigint DEFAULT 172800000
)
RETURNS TABLE (
  code text,
  currency text,
  subject text,
  amount_minor numeric
)
LANGUAGE sql STABLE AS $$
  WITH moment AS (
    SELECT COALESCE(as_of, (SELECT max(occurred_at) FROM sdelka.ledger_entry)) AS at
  )
  SELECT 'ledger.invariant.entry_unbalanced', p.currency, p.entry_id, sum(p.signed_minor)
    FROM sdelka.v_posting p
   GROUP BY p.entry_id, p.currency
  HAVING sum(p.signed_minor) <> 0

  UNION ALL
  SELECT 'ledger.invariant.negative_client_balance', v.currency, v.account_code, v.balance_minor
    FROM sdelka.v_negative_client_balance v

  UNION ALL
  SELECT 'ledger.invariant.negative_bank_balance', v.currency, v.account_code, v.balance_minor
    FROM sdelka.v_negative_bank_balance v

  UNION ALL
  SELECT 'ledger.invariant.coverage_below_one', v.currency, 'portfolio',
         v.custody_minor - v.obligations_minor
    FROM sdelka.v_coverage v
   WHERE v.custody_minor < v.obligations_minor

  UNION ALL
  SELECT 'ledger.invariant.unclaimed_uncovered', v.currency, 'unclaimed',
         v.custody_minor - v.obligations_minor
    FROM sdelka.v_coverage_unclaimed v
   WHERE v.custody_minor < v.obligations_minor

  UNION ALL
  SELECT 'ledger.invariant.tranche_uncovered', v.currency,
         v.deal_id || ':' || v.tranche_id, v.custody_minor - v.obligations_minor
    FROM sdelka.v_coverage_by_tranche v
   WHERE v.custody_minor < v.obligations_minor

  UNION ALL
  SELECT 'ledger.invariant.platform_asset_negative', v.currency, v.account_code, v.balance_minor
    FROM sdelka.v_negative_platform_asset v

  UNION ALL
  SELECT 'ledger.invariant.fx_position_open', v.currency, v.conversion_id, v.amount_minor
    FROM sdelka.v_fx_position v, moment m
   WHERE m.at IS NOT NULL
     AND extract(epoch FROM (m.at - v.opened_at)) * 1000 > stale_after_ms

  UNION ALL
  SELECT 'ledger.invariant.transit_stale', v.currency, v.account_code, v.amount_minor
    FROM sdelka.v_transit_position v, moment m
   WHERE m.at IS NOT NULL
     AND extract(epoch FROM (m.at - v.opened_at)) * 1000 > stale_after_ms

  UNION ALL
  SELECT 'ledger.invariant.shortfall_overfunded', v.currency, v.client_key, v.excess_minor
    FROM sdelka.v_shortfall_overfunded v

  UNION ALL
  -- Недостача по файлу клиента. Транши посчитаны выше своим отношением: одно и
  -- то же расхождение не должно попадать в отчёт дважды.
  SELECT 'ledger.invariant.client_account_uncovered', v.currency, v.subject,
         v.custody_minor - v.obligations_minor
    FROM sdelka.v_coverage_by_funds_source v
   WHERE v.source_kind = 'client' AND v.custody_minor < v.obligations_minor

  UNION ALL
  -- Профицит по **обоим** видам файла: деньги платформы на счёте клиентских
  -- средств (красная линия №2) и опустошённый файл (красная линия №1) выглядят
  -- одинаково — средств больше, чем обязательств, — и оба обязаны быть
  -- расхождением, а не запасом прочности.
  SELECT 'ledger.invariant.custody_surplus', v.currency, v.subject,
         v.custody_minor - v.obligations_minor
    FROM sdelka.v_coverage_by_funds_source v
   WHERE v.custody_minor > v.obligations_minor;
$$;

CREATE VIEW sdelka.v_ledger_invariant_violation AS
SELECT * FROM sdelka.ledger_invariant_violation();

-- Стоп-кран приёма новых сделок (красная линия №3, `CORE.md` Ф10). Решение
-- принимает приложение — здесь только признак, вычисленный из журнала.
CREATE VIEW sdelka.v_should_stop_accepting_deals AS
SELECT EXISTS (
  SELECT 1 FROM sdelka.v_ledger_invariant_violation
   WHERE code IN (
     'ledger.invariant.coverage_below_one',
     'ledger.invariant.tranche_uncovered',
     'ledger.invariant.client_account_uncovered',
     'ledger.invariant.custody_surplus',
     'ledger.invariant.negative_client_balance'
   )
) AS stop;

GRANT SELECT ON ALL TABLES IN SCHEMA sdelka TO sdelka_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sdelka.ledger_entry, sdelka.ledger_posting FROM sdelka_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sdelka.audit_record FROM sdelka_app;
