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
  -- Позиция обмена ключуется владельцем И ключом конверсии: без клиента в
  -- коде счёта позиции разных клиентов сливались бы под одним ключом, а
  -- открытая позиция — единственное, чем ловится «встречная валюта не
  -- поставлена». Отсюда file_scope owner_in_code и needs_client.
  ('fx_settlement',         'asset',     'client',   NULL,         'owner_in_code',  NULL,       false, true,  false, true),
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
--
-- **[исправляет предыдущее]** Актив прежде отбирался по `in_attribution`, и это
-- работало ровно потому, что из трёх клиентских активов файл приносило
-- отнесение у двух. Как только у счёта расчётов с валютным контрагентом
-- появился владелец в коде, деньги у контрагента выпали из числителя, и
-- покрытие между моментами 2 и 3 обмена проваливалось ниже единицы — при том,
-- что §3.3 описывает этот промежуток как **покрытый**: деньги клиента, просто
-- не на нашем счёте. Происхождение файла к вопросу «чьи это деньги и лежат ли
-- они где-то» отношения не имеет; терминальный пул исключается симметрично
-- обеим сторонам, потому что его считает `v_coverage_unclaimed`.
CREATE VIEW sdelka.v_coverage AS
SELECT currency,
       sum(CASE WHEN funds = 'client' AND acct_type = 'asset'
                     AND pool_direction IS DISTINCT FROM 'terminal'
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
-- ⚠ Ключ позиции — **код счёта**, а не ключ конверсии. Ключи конверсии двух
-- клиентов совпадают запросто, и при группировке по ним незакрытая нога одного
-- гасилась встречной ногой другого: «нам не поставили встречную валюту»
-- переставало быть величиной. Зеркало `openFxPositions` ключуется кодом счёта,
-- и подлежащим нарушения там стоит он же.
CREATE VIEW sdelka.v_fx_position AS
WITH by_entry AS (
  SELECT account_code, conversion_id, entry_seq, occurred_at, currency,
         sum(natural_minor) AS delta
    FROM sdelka.v_posting
   WHERE conversion_id IS NOT NULL
   GROUP BY 1, 2, 3, 4, 5
), running AS (
  SELECT account_code, conversion_id, entry_seq, occurred_at, currency,
         sum(delta) OVER (PARTITION BY account_code, currency
                          ORDER BY entry_seq
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
    FROM by_entry
), entry_state AS (
  -- Остаток по каждой валюте на конец каждой записи, тронувшей счёт. Валюта,
  -- не тронутая этой записью, свой прежний остаток сохраняет, поэтому берётся
  -- последнее известное значение.
  SELECT e.account_code, e.entry_seq, e.occurred_at,
         bool_and(COALESCE(r.balance, 0) = 0) AS flat
    FROM (SELECT DISTINCT account_code, entry_seq, occurred_at FROM by_entry) e
    LEFT JOIN LATERAL (
      SELECT DISTINCT ON (c.currency) c.currency, c.balance
        FROM running c
       WHERE c.account_code = e.account_code AND c.entry_seq <= e.entry_seq
       ORDER BY c.currency, c.entry_seq DESC
    ) r ON true
   GROUP BY 1, 2, 3
), opened AS (
  SELECT account_code,
         max(entry_seq) FILTER (WHERE flat) AS last_flat_seq
    FROM entry_state
   GROUP BY account_code
), current_balance AS (
  SELECT DISTINCT ON (account_code, currency)
         account_code, conversion_id, currency, balance
    FROM running
   ORDER BY account_code, currency, entry_seq DESC
)
SELECT c.account_code,
       c.conversion_id,
       c.currency,
       c.balance AS amount_minor,
       (SELECT min(s.occurred_at)
          FROM entry_state s
         WHERE s.account_code = c.account_code
           AND s.entry_seq > COALESCE(o.last_flat_seq, -1)) AS opened_at
  FROM current_balance c
  LEFT JOIN opened o ON o.account_code = c.account_code
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
-- Незакрытая дебиторка по комиссии
-- ---------------------------------------------------------------------------
--
-- Зеркало `openFeeReceivables`. Требование связывается со сделкой **только**
-- отнесением: счёт комиссии не клиентский, файла в его коде нет и быть не
-- может, поэтому требование без отнесения сюда не попадает — ровно как в коде.
--
-- Плоскость — по записи целиком, как у позиции обмена: расчёт гасит требование
-- и ничего нового в той же записи не начисляет, но реверс начисления двигает
-- счёт в обе стороны внутри одной записи.
--
-- `tranche_drained` — деньги транша ушли: запертая часть по этому траншу в этой
-- валюте **была** и обнулилась. Оба условия важны: без «была» под правило попал
-- бы транш, под который ещё ничего не запирали, — а это обычное окно между
-- начислением на входе в `release_pending` и расчётом.
CREATE VIEW sdelka.v_fee_receivable_open AS
WITH by_entry AS (
  SELECT attribution_deal_id AS deal_id, attribution_tranche_id AS tranche_id,
         currency, entry_seq, occurred_at, sum(natural_minor) AS delta
    FROM sdelka.v_posting
   WHERE account_kind = 'fee_receivable'
     AND attribution_deal_id IS NOT NULL
     AND attribution_tranche_id IS NOT NULL
   GROUP BY 1, 2, 3, 4, 5
), running AS (
  SELECT deal_id, tranche_id, currency, entry_seq, occurred_at,
         sum(delta) OVER (PARTITION BY deal_id, tranche_id, currency
                          ORDER BY entry_seq
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
    FROM by_entry
), last_flat AS (
  SELECT deal_id, tranche_id, currency, max(entry_seq) AS seq
    FROM running
   WHERE balance = 0
   GROUP BY 1, 2, 3
), current_balance AS (
  SELECT DISTINCT ON (deal_id, tranche_id, currency)
         deal_id, tranche_id, currency, balance
    FROM running
   ORDER BY deal_id, tranche_id, currency, entry_seq DESC
), locked AS (
  -- Запертая часть транша читается из **кода счёта**: у `client_locked`
  -- владелец в коде, отнесение на нём ничего не добавляет.
  SELECT account_deal_id AS deal_id, account_tranche_id AS tranche_id,
         currency, sum(natural_minor) AS balance
    FROM sdelka.v_posting
   WHERE account_kind = 'client_locked'
     AND account_tranche_id IS NOT NULL
   GROUP BY 1, 2, 3
)
SELECT c.deal_id,
       c.tranche_id,
       c.currency,
       c.balance AS outstanding_minor,
       (SELECT min(r.occurred_at)
          FROM running r
         WHERE r.deal_id = c.deal_id
           AND r.tranche_id = c.tranche_id
           AND r.currency = c.currency
           AND r.entry_seq > COALESCE(f.seq, -1)) AS opened_at,
       (l.deal_id IS NOT NULL AND l.balance = 0) AS tranche_drained
  FROM current_balance c
  LEFT JOIN last_flat f
    ON f.deal_id = c.deal_id AND f.tranche_id = c.tranche_id AND f.currency = c.currency
  LEFT JOIN locked l
    ON l.deal_id = c.deal_id AND l.tranche_id = c.tranche_id AND l.currency = c.currency
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
  stale_after_ms bigint DEFAULT 172800000,
  -- Окно требования по комиссии — отдельным аргументом и по умолчанию тем же,
  -- что у транзита (`InvariantOptions.feeStaleAfterMs`): ожидание расчёта
  -- законно длиннее межбанковского перевода, но настоящее окно — решение
  -- владельца, а не умолчание.
  fee_stale_after_ms bigint DEFAULT NULL
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
  SELECT 'ledger.invariant.fx_position_open', v.currency, v.account_code, v.amount_minor
    FROM sdelka.v_fx_position v, moment m
   WHERE m.at IS NOT NULL
     AND extract(epoch FROM (m.at - v.opened_at)) * 1000 > stale_after_ms

  UNION ALL
  SELECT 'ledger.invariant.transit_stale', v.currency, v.account_code, v.amount_minor
    FROM sdelka.v_transit_position v, moment m
   WHERE m.at IS NOT NULL
     AND extract(epoch FROM (m.at - v.opened_at)) * 1000 > stale_after_ms

  UNION ALL
  -- Начислено и удерживать уже не из чего: деньги транша ушли. Возраст здесь ни
  -- при чём — расхождение немедленное и постоянное.
  SELECT 'ledger.invariant.fee_not_withheld', v.currency,
         v.deal_id || ':' || v.tranche_id, v.outstanding_minor
    FROM sdelka.v_fee_receivable_open v
   WHERE v.outstanding_minor > 0 AND v.tranche_drained

  UNION ALL
  -- Начислено, не удержано и ждёт дольше окна. Отрицательный остаток требования
  -- сюда не попадает: это удержание без начисления, и у него свой код.
  SELECT 'ledger.invariant.fee_receivable_stale', v.currency,
         v.deal_id || ':' || v.tranche_id, v.outstanding_minor
    FROM sdelka.v_fee_receivable_open v, moment m
   WHERE v.outstanding_minor > 0 AND NOT v.tranche_drained
     AND m.at IS NOT NULL
     AND extract(epoch FROM (m.at - v.opened_at)) * 1000
         > COALESCE(fee_stale_after_ms, stale_after_ms)

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

-- ===== 0009_raw_source.sql =====
-- 0009 — записанные сырые ответы источников.
--
-- `CORE.md` Ф11: «разобранные поля без исходника суд не убедит». До этой
-- миграции требование держалось на форме строки: `registry_observation`
-- обязывала `raw_source_digest` быть шестнадцатеричным SHA-256 — и только.
-- Наблюдение с отпечатком, за которым не стоит ни одного полученного ответа,
-- вставлялось без единого возражения; ровно это и делала базовая фикстура
-- домена.
--
-- Здесь появляется вторая половина требования: **ссылка обязана на что-то
-- ссылаться**. Таблица `raw_source` — реестр полученных ответов; наблюдение и
-- карточка заявления ссылаются на него внешним ключом. `CLAUDE.md`,
-- «Инварианты, проверяемые базой, а не кодом»: проверка формы отвечает на
-- вопрос «похоже ли это на отпечаток», внешний ключ — на вопрос «есть ли за ним
-- ответ».
--
-- **Байтов здесь нет.** Они живут в модуле «Документы» по адресу `storage_ref`
-- (шифрование, журнал доступа — `FUNCTIONAL.md` §1), откуда их можно выдать
-- суду и, при законном требовании, удалить. Байты в вечной таблице дали бы
-- обратное: удалить нельзя, а доказательная сила та же.

SET LOCAL ROLE sdelka_owner;

-- Карточка заявления — бесплатный сигнал уровня L1 (`ORACLE.md` §2). Своим
-- видом, а не `registry_extract`: восстановление истории через год показало бы
-- карточку платной выпиской, то есть соврало бы об уровне доверия, на котором
-- двигались деньги. Дописывается в конец — `ALTER TYPE ... ADD VALUE` иначе не
-- умеет, и порядок меток обязан совпасть с `RAW_SOURCE_KINDS`.
--
-- Внутри транзакции это допустимо начиная с Postgres 12; новая метка в той же
-- транзакции не используется, поэтому «unsafe use of new value» здесь не
-- возникает.
ALTER TYPE sdelka.raw_source_kind ADD VALUE 'application_card';

-- ---------------------------------------------------------------------------
-- Реестр полученных ответов
-- ---------------------------------------------------------------------------
--
-- Ключ — сам отпечаток, а не суррогат. Два разных адреса хранения с одним
-- отпечатком — это один и тот же ответ, и различать их значило бы разрешить
-- второй записи ссылаться на «другой такой же» документ.
--
-- Формы `storage_ref`, `media_type` и `provider` — зеркало `AUDIT_TOKEN`
-- (`audit/src/values.ts`): пробелов нет, `@` нет, то есть ни свободного текста,
-- ни адреса почты, ни имени сюда физически не входит.
CREATE TABLE sdelka.raw_source (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  source_kind sdelka.raw_source_kind NOT NULL,

  -- Адрес в хранилище документов. Не сам ответ.
  storage_ref text NOT NULL CHECK (storage_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(storage_ref) <= 512),
  media_type text NOT NULL CHECK (media_type ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(media_type) <= 512),

  -- Длина хранится рядом с отпечатком: расхождение длины при совпавшем
  -- отпечатке — это подобранная коллизия, и такой случай обязан быть отличим
  -- от обычной подмены файла (`attestRawSource` в `@sdelka/audit`).
  byte_length bigint NOT NULL CHECK (byte_length >= 0),

  received_at timestamptz NOT NULL,

  -- Кто ответил: реестр, банк, провайдер выплат. Технический ключ, не название.
  provider text NOT NULL CHECK (provider ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(provider) <= 512)
);

CREATE INDEX raw_source_received_at ON sdelka.raw_source (received_at);

-- ---------------------------------------------------------------------------
-- Ссылки, которые обязаны ссылаться
-- ---------------------------------------------------------------------------
--
-- Красная линия №5: «выплата невозможна без ссылки на пакет доказательств».
-- Ссылка на несуществующий ответ ссылкой не является — ровно так же, как
-- запись-исправление со ссылкой на запись, которой нет в цепочке (`0007`).
ALTER TABLE sdelka.registry_observation
  ADD CONSTRAINT registry_observation_raw_source
  FOREIGN KEY (raw_source_digest) REFERENCES sdelka.raw_source (digest);

-- У заявления отпечаток есть только у карточки: названный стороной номер
-- документом не подтверждён и подтверждён быть не может (`0006`,
-- `registry_filing_card_has_source`). `NULL` внешний ключ не проверяет, поэтому
-- обе формы остаются выразимыми, а карточка без ответа — нет.
ALTER TABLE sdelka.registry_filing
  ADD CONSTRAINT registry_filing_raw_source
  FOREIGN KEY (raw_source_digest) REFERENCES sdelka.raw_source (digest);

-- ---------------------------------------------------------------------------
-- Гранты
-- ---------------------------------------------------------------------------
--
-- Полученный ответ — факт, а не строка состояния: правка его задним числом
-- рвала бы связь с наблюдениями, которые на него ссылаются. Поэтому роль
-- приложения получает только чтение и вставку, как с журналом аудита (`0007`).
GRANT SELECT, INSERT ON sdelka.raw_source TO sdelka_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sdelka.raw_source FROM sdelka_app;
REVOKE ALL ON sdelka.raw_source FROM PUBLIC;

-- ===== 0010_auth.sql =====
-- 0010 — учётные записи, роли, сессии, второй фактор, гранты и журнал доступа.
--
-- `packages/auth` построен целиком над значениями: «Хранилища здесь нет — ни на
-- чтение, ни на запись» (`auth/src/session.ts`). Порты объявлены
-- (`SessionStorePort`, `SecondFactorRegistryPort`), реализаций нет. Эта миграция
-- заводит то самое хранилище — и заводит его так, чтобы правила, которые пакет
-- держит типами внутри процесса, держались **базой** на границе процесса:
-- `CLAUDE.md`, «Инварианты, проверяемые базой, а не кодом».
--
-- Что здесь **не** заводится и почему:
--
-- - **никаких секретов.** Ни пароля, ни его верификатора, ни секрета TOTP, ни
--   приватного ключа, ни одноразового кода. Основание не осторожность, а
--   устройство пакета: подтверждение фактора выдаёт **порт**
--   (`SecondFactorPort`), и единственное, что реестр обязан уметь ответить, —
--   «привязан ли фактор» (`SecondFactorRegistryPort.bindingsFor` →
--   `SecondFactorBinding { kind, boundAt }`). Ровно это и хранится. Где живёт
--   верификатор пароля и каким преобразованием он получен — развилка владельца;
--   до неё места в схеме нет, и это сильнее, чем колонка «только хеш»;
-- - **имён, адресов и телефонов.** Идентификаторы непрозрачны (`auth/src/ids.ts`:
--   «если бы `accountId` мог быть почтой, запрет в аудите ловил бы её на
--   последнем метре»), устройство и сеть — отпечатки SHA-256;
-- - **истории назначений отдельной таблицей.** История — это `auth_event`
--   (`role_assigned` / `role_revoked`), и она только дополняется. Вторая копия
--   той же истории расходилась бы с первой молча.
--
-- Почему журнал доступа здесь, а не в `sdelka.audit_record`: `AUDIT_RECORD_KINDS`
-- (`packages/audit`) не содержит ни входа, ни отказа во входе, ни смены роли, а
-- класть их под `decision_made` нельзя — у того тела обязательны версия политики
-- и непустой пакет доказательств (`auth/src/events.ts`, то же расхождение назвал
-- сам пакет). Приём с грантами повторён буква в букву: роль приложения читает и
-- дополняет, но не правит и не удаляет.

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Перечни — построчные зеркала массивов из packages/auth
-- ---------------------------------------------------------------------------
--
-- Значения-перечни живут **типами, а не строками**: опечатка в строке
-- компилируется и молча запрещает всё, метка перечня — не вставляется вовсе.
-- Тест дрейфа (`test/enums.test.ts`) сверяет порядок и состав.

-- packages/auth: ROLE_IDS
CREATE TYPE sdelka.role_id AS ENUM (
  'party',
  'representative',
  'operator',
  'oracle_operator',
  'compliance_analyst',
  'compliance_officer',
  'financial_controller',
  'head_of_operations',
  'support',
  'principal',
  'auditor',
  'client_counsel'
);

-- packages/auth: RoleAudience
CREATE TYPE sdelka.role_audience AS ENUM ('console', 'client', 'external');

-- packages/auth: CAPABILITIES
CREATE TYPE sdelka.capability AS ENUM (
  'read_deal',
  'read_party',
  'read_beneficiary',
  'read_audit',
  'read_economics',
  'create_deal',
  'invite_party',
  'verify_property',
  'record_condition_act',
  'order_extract',
  'record_observation',
  'write_beneficiary',
  'confirm_test_transfer_code',
  'run_screening',
  'adjudicate_screening',
  'lift_block',
  'approve_lift_block',
  'approve_beneficiary_change',
  'approve_payout',
  'halt_intake',
  'freeze_participation',
  'confirm_incident',
  'lift_halt',
  'manage_settings',
  'manage_access',
  'export_personal_data',
  'erase_personal_data',
  'act_on_behalf'
);

-- packages/auth: CapabilityEffect
CREATE TYPE sdelka.capability_effect AS ENUM (
  'read',
  'prepare',
  'release',
  'narrow',
  'govern',
  'personal_data'
);

-- packages/auth: SecondFactorRequirement
CREATE TYPE sdelka.second_factor_requirement AS ENUM ('none', 'step_up');

-- packages/auth: SECOND_FACTOR_KINDS
CREATE TYPE sdelka.second_factor_kind AS ENUM ('webauthn', 'totp', 'push', 'sms', 'email');

-- packages/auth: FactorStrength
CREATE TYPE sdelka.factor_strength AS ENUM ('phishing_resistant', 'possession', 'channel');

-- packages/auth: PRIMARY_METHODS
CREATE TYPE sdelka.auth_primary_method AS ENUM (
  'passkey',
  'password',
  'federated',
  'magic_link'
);

-- packages/auth: AUTH_EVENT_KINDS
CREATE TYPE sdelka.auth_event_kind AS ENUM (
  'session_established',
  'session_denied',
  'session_revoked',
  'second_factor_verified',
  'duty_started',
  'duty_ended',
  'role_assigned',
  'role_revoked',
  'authorization_granted',
  'authorization_denied'
);

-- packages/auth: AUTH_REASON_KEYS
--
-- Ключ причины, а не текст: пользовательских строк в базе нет (`CLAUDE.md`,
-- «Три языка»). Перечень целиком, а не только те причины, которые поднимает
-- сама база: журнал доступа записывает и отказы, принятые кодом.
CREATE TYPE sdelka.auth_reason_key AS ENUM (
  'auth.session.expired',
  'auth.session.idle',
  'auth.session.revoked',
  'auth.session.ttl_too_long',
  'auth.primary.method_not_allowed_for_console',
  'auth.second_factor.missing',
  'auth.second_factor.too_weak',
  'auth.second_factor.stale',
  'auth.second_factor.challenge_mismatch',
  'auth.second_factor.not_bound',
  'auth.capability.not_granted',
  'auth.capability.held_by_no_role',
  'auth.duty.role_not_eligible',
  'auth.duty.does_not_widen',
  'auth.sod.preparer_cannot_approve',
  'auth.sod.observer_cannot_approve',
  'auth.sod.approval_level_missing',
  'auth.sod.requester_cannot_approve',
  'auth.sod.causer_cannot_lift',
  'auth.sod.economics_excludes_money',
  'auth.sod.self_approval',
  'auth.sod.context_unknown',
  'auth.quorum.level_one_missing',
  'auth.quorum.level_two_missing',
  'auth.quorum.approvers_not_distinct',
  'auth.quorum.tier_not_offered',
  'auth.quorum.requirement_invalid',
  'auth.quorum.preparer_unknown',
  'auth.authority.stale',
  'auth.access.current_role_unknown',
  'auth.access.current_role_mismatch',
  'auth.beneficiary.value_disclosed_to_no_role'
);

-- ---------------------------------------------------------------------------
-- Справочники — зеркала карт из packages/auth
-- ---------------------------------------------------------------------------

-- Роль и **право дежурства**. Дежурство — режим поверх роли (`ACTORS.md` §7.1),
-- поэтому это колонка справочника, а не тринадцатая роль: отдельная роль
-- «дежурный» сломала бы несовместимости через календарь.
CREATE TABLE sdelka.auth_role (
  role_id sdelka.role_id PRIMARY KEY,
  audience sdelka.role_audience NOT NULL,
  duty_eligible boolean NOT NULL
);

INSERT INTO sdelka.auth_role (role_id, audience, duty_eligible) VALUES
  ('party',                   'client',   false),
  ('representative',          'client',   false),
  ('operator',                'console',  true),
  ('oracle_operator',         'console',  false),
  ('compliance_analyst',      'console',  false),
  ('compliance_officer',      'console',  false),
  ('financial_controller',    'console',  true),
  ('head_of_operations',      'console',  true),
  ('support',                 'console',  false),
  ('principal',               'console',  false),
  ('auditor',                 'external', false),
  ('client_counsel',          'external', false);

-- Политика сессии — **функция аудитории, а не аргумент** (`auth/src/session.ts`:
-- «аргументом она была подменяема, и подмена ничего не ломала»). Здесь та же
-- мысль на границе процесса: срок сессии сверяется с таблицей, а не с числом,
-- пришедшим вместе со строкой.
--
-- Миллисекунды целые: `DurationMs` в домене — строго положительное целое, и
-- дробной миллисекунды не существует (красная линия №4 про то же).
CREATE TABLE sdelka.session_policy (
  audience sdelka.role_audience PRIMARY KEY,
  max_ttl_ms bigint NOT NULL CHECK (max_ttl_ms > 0),
  idle_ttl_ms bigint NOT NULL CHECK (idle_ttl_ms > 0),
  step_up_max_age_ms bigint NOT NULL CHECK (step_up_max_age_ms > 0),
  minimum_factor_strength sdelka.factor_strength NOT NULL,
  second_factor_at_login boolean NOT NULL,

  -- Простой длиннее абсолютного срока означал бы, что простоя нет вовсе.
  CONSTRAINT session_policy_idle_within_max CHECK (idle_ttl_ms <= max_ttl_ms),
  CONSTRAINT session_policy_step_up_within_idle CHECK (step_up_max_age_ms <= idle_ttl_ms)
);

INSERT INTO sdelka.session_policy
  (audience, max_ttl_ms, idle_ttl_ms, step_up_max_age_ms, minimum_factor_strength,
   second_factor_at_login) VALUES
  ('console',  28800000, 900000,  300000, 'phishing_resistant', true),
  ('client',   86400000, 3600000, 300000, 'possession',         false),
  ('external', 14400000, 900000,  300000, 'possession',         true);

-- Порядок строгости факторов — зеркало `STRENGTH_ORDER`. Сравнение по рангу, а
-- не по имени: «канал, который может быть у нападающего, не является вторым
-- фактором, он является вторым экраном» (`auth/src/second-factor.ts`).
CREATE TABLE sdelka.factor_strength_rank (
  strength sdelka.factor_strength PRIMARY KEY,
  rank smallint NOT NULL UNIQUE CHECK (rank >= 0)
);

INSERT INTO sdelka.factor_strength_rank (strength, rank) VALUES
  ('channel',            0),
  ('possession',         1),
  ('phishing_resistant', 2);

-- Вид фактора и его устойчивость — зеркало `FACTOR_STRENGTH`.
CREATE TABLE sdelka.second_factor (
  kind sdelka.second_factor_kind PRIMARY KEY,
  strength sdelka.factor_strength NOT NULL REFERENCES sdelka.factor_strength_rank (strength)
);

INSERT INTO sdelka.second_factor (kind, strength) VALUES
  ('webauthn',  'phishing_resistant'),
  ('totp',      'possession'),
  ('push',      'possession'),
  ('sms',       'channel'),
  ('email',     'channel');

-- Полномочия — зеркало `CAPABILITY_SPECS`. Класс действия и требование второго
-- фактора лежат **в справочнике**, а не перечнем имён внутри триггера: перечень
-- имён всегда оказывается неполным, и неполнота тихая (тот же довод, что у
-- `account_kind` в `0001`).
CREATE TABLE sdelka.auth_capability (
  capability sdelka.capability PRIMARY KEY,
  effect sdelka.capability_effect NOT NULL,
  second_factor sdelka.second_factor_requirement NOT NULL,
  journaled boolean NOT NULL
);

INSERT INTO sdelka.auth_capability (capability, effect, second_factor, journaled) VALUES
  ('read_deal',                   'read',           'none',     false),
  ('read_party',                  'read',           'none',     false),
  ('read_beneficiary',            'read',           'none',     false),
  ('read_audit',                  'read',           'none',     false),
  ('read_economics',              'read',           'none',     false),
  ('create_deal',                 'prepare',        'none',     true),
  ('invite_party',                'prepare',        'none',     true),
  ('verify_property',             'prepare',        'none',     true),
  ('record_condition_act',        'prepare',        'step_up',  true),
  ('order_extract',               'prepare',        'none',     true),
  ('record_observation',          'prepare',        'none',     true),
  ('write_beneficiary',           'prepare',        'step_up',  true),
  ('confirm_test_transfer_code',  'prepare',        'step_up',  true),
  ('run_screening',               'prepare',        'none',     true),
  ('adjudicate_screening',        'release',        'step_up',  true),
  ('lift_block',                  'release',        'step_up',  true),
  ('approve_lift_block',          'release',        'step_up',  true),
  ('approve_beneficiary_change',  'release',        'step_up',  true),
  ('approve_payout',              'release',        'step_up',  true),
  ('halt_intake',                 'narrow',         'none',     true),
  ('freeze_participation',        'narrow',         'none',     true),
  ('confirm_incident',            'narrow',         'none',     true),
  ('lift_halt',                   'release',        'step_up',  true),
  ('manage_settings',             'govern',         'step_up',  true),
  ('manage_access',               'govern',         'step_up',  true),
  ('export_personal_data',        'personal_data',  'step_up',  true),
  ('erase_personal_data',         'personal_data',  'step_up',  true),
  ('act_on_behalf',               'prepare',        'step_up',  true);

-- Карта «роль → полномочия» — зеркало `ROLE_CAPABILITIES` плюс три полномочия
-- дежурства (`DUTY_CAPABILITIES`), помеченные `requires_duty`.
--
-- `manage_access` не выдан **ни одной роли**: `auth/src/capabilities.ts` —
-- полномочия нет в `ACTORS.md` §5.1, а «полномочие, которого нет, — это либо
-- „может кто угодно“, либо „не может никто“». Взято второе, и здесь оно
-- выражается отсутствием строки, то есть отказом внешнего ключа гранта.
CREATE TABLE sdelka.role_capability (
  role_id sdelka.role_id NOT NULL REFERENCES sdelka.auth_role (role_id),
  capability sdelka.capability NOT NULL REFERENCES sdelka.auth_capability (capability),
  -- Полномочие доступно только при дежурстве. Дежурство **добавляет** и не
  -- убирает ничего (`ACTORS.md` §7.1 п.2), поэтому строка отдельная.
  requires_duty boolean NOT NULL,

  PRIMARY KEY (role_id, capability)
);

INSERT INTO sdelka.role_capability (role_id, capability, requires_duty) VALUES
  ('party',                   'read_deal',                   false),
  ('party',                   'read_party',                  false),
  ('party',                   'read_beneficiary',            false),
  ('party',                   'write_beneficiary',           false),
  ('party',                   'confirm_test_transfer_code',  false),
  ('party',                   'record_condition_act',        false),
  ('party',                   'freeze_participation',        false),
  ('representative',          'read_deal',                   false),
  ('representative',          'read_party',                  false),
  ('operator',                'read_deal',                   false),
  ('operator',                'read_party',                  false),
  ('operator',                'read_beneficiary',            false),
  ('operator',                'create_deal',                 false),
  ('operator',                'invite_party',                false),
  ('operator',                'verify_property',             false),
  ('operator',                'run_screening',               false),
  ('operator',                'halt_intake',                 false),
  ('operator',                'confirm_incident',            true),
  ('operator',                'freeze_participation',        true),
  ('oracle_operator',         'read_deal',                   false),
  ('oracle_operator',         'read_party',                  false),
  ('oracle_operator',         'order_extract',               false),
  ('oracle_operator',         'record_observation',          false),
  ('oracle_operator',         'lift_block',                  false),
  ('oracle_operator',         'halt_intake',                 false),
  ('compliance_analyst',      'read_deal',                   false),
  ('compliance_analyst',      'read_party',                  false),
  ('compliance_analyst',      'read_beneficiary',            false),
  ('compliance_analyst',      'run_screening',               false),
  ('compliance_analyst',      'adjudicate_screening',        false),
  ('compliance_analyst',      'lift_block',                  false),
  ('compliance_analyst',      'halt_intake',                 false),
  ('compliance_officer',      'read_deal',                   false),
  ('compliance_officer',      'read_party',                  false),
  ('compliance_officer',      'read_beneficiary',            false),
  ('compliance_officer',      'read_audit',                  false),
  ('compliance_officer',      'run_screening',               false),
  ('compliance_officer',      'adjudicate_screening',        false),
  ('compliance_officer',      'lift_block',                  false),
  ('compliance_officer',      'export_personal_data',        false),
  ('compliance_officer',      'erase_personal_data',         false),
  ('compliance_officer',      'halt_intake',                 false),
  ('financial_controller',    'read_deal',                   false),
  ('financial_controller',    'read_party',                  false),
  ('financial_controller',    'read_beneficiary',            false),
  ('financial_controller',    'approve_payout',              false),
  ('financial_controller',    'approve_beneficiary_change',  false),
  ('financial_controller',    'approve_lift_block',          false),
  ('financial_controller',    'lift_block',                  false),
  ('financial_controller',    'lift_halt',                   false),
  ('financial_controller',    'halt_intake',                 false),
  ('financial_controller',    'confirm_incident',            true),
  ('financial_controller',    'freeze_participation',        true),
  ('head_of_operations',      'read_deal',                   false),
  ('head_of_operations',      'read_party',                  false),
  ('head_of_operations',      'read_beneficiary',            false),
  ('head_of_operations',      'read_audit',                  false),
  ('head_of_operations',      'approve_payout',              false),
  ('head_of_operations',      'approve_beneficiary_change',  false),
  ('head_of_operations',      'approve_lift_block',          false),
  ('head_of_operations',      'lift_halt',                   false),
  ('head_of_operations',      'halt_intake',                 false),
  ('head_of_operations',      'confirm_incident',            true),
  ('head_of_operations',      'freeze_participation',        true),
  ('support',                 'read_deal',                   false),
  ('support',                 'read_party',                  false),
  ('support',                 'act_on_behalf',               false),
  ('support',                 'halt_intake',                 false),
  ('principal',               'read_deal',                   false),
  ('principal',               'read_economics',              false),
  ('principal',               'manage_settings',             false),
  ('auditor',                 'read_deal',                   false),
  ('auditor',                 'read_party',                  false),
  ('auditor',                 'read_beneficiary',            false),
  ('auditor',                 'read_audit',                  false),
  ('auditor',                 'read_economics',              false),
  ('client_counsel',          'read_deal',                   false),
  ('client_counsel',          'read_party',                  false);

-- Дежурное полномочие может стоять только у роли, которая вправе дежурить.
-- Проверка отложена до засева намеренно: она читает соседнюю таблицу, а
-- ограничение колонки этого не умеет.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM sdelka.role_capability AS rc
      JOIN sdelka.auth_role AS r ON r.role_id = rc.role_id
     WHERE rc.requires_duty AND NOT r.duty_eligible
  ) THEN
    RAISE EXCEPTION 'auth.duty.role_not_eligible'
      USING ERRCODE = '23514', DETAIL = 'source=role_capability';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Учётная запись
-- ---------------------------------------------------------------------------
--
-- **У учётной записи ровно одна роль** — не список (`auth/src/access.ts`):
-- сотрудник, оказавшийся стороной по своей сделке, заводит отдельную клиентскую
-- запись (§9 случай 2), а «вторая шляпа» запрещена человеку, а не записи.
-- Роль-список отменил бы обе несовместимости молча: набор ролей на одной записи
-- — это набор уровней утверждения на одном человеке.
--
-- `person_id` — второй рубеж разделения обязанностей: учётные записи разные,
-- человек может быть один (`ACTORS.md` §6.6 прямо предусматривает совмещение
-- должностей по времени). Уникальности по человеку здесь **нет** и быть не
-- должно: несколько записей на одного человека — законное состояние.
--
-- Формы идентификаторов — зеркало `OPAQUE_KEY` (`auth/src/ids.ts`): пробелов
-- нет, `@` нет, то есть ни почта, ни телефон, ни имя сюда физически не входят.
-- Длина ограничена отдельным `length`, а не счётчиком повторений: POSIX-регулярка
-- Postgres не принимает счётчик больше 255 и падает на первой вставке (`0007`).
CREATE TABLE sdelka.auth_account (
  account_id text PRIMARY KEY
    CHECK (account_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(account_id) <= 128),
  person_id text NOT NULL
    CHECK (person_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(person_id) <= 128),
  role_id sdelka.role_id NOT NULL REFERENCES sdelka.auth_role (role_id),
  role_assigned_at timestamptz NOT NULL,
  -- Кто распорядился. `NULL` — распоряжение вне системы, с записью в журнал:
  -- `manage_access` сегодня не выдан ни одной роли, поэтому первое назначение
  -- иначе невыразимо.
  role_assigned_by text REFERENCES sdelka.auth_account (account_id),
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Роль себе не назначают: это обход всей матрицы одной кнопкой
  -- (`changeAccountRole`). Первая половина — по учётной записи, вторая (по
  -- человеку) читает соседнюю строку и живёт в триггере.
  CONSTRAINT auth_account_no_self_assignment
    CHECK (role_assigned_by IS DISTINCT FROM account_id),

  UNIQUE (account_id, person_id, role_id)
);

CREATE INDEX auth_account_person ON sdelka.auth_account (person_id);

CREATE FUNCTION sdelka.assert_auth_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ordering_person text;
  live_sessions integer;
BEGIN
  -- Н «роль себе не назначают» проверяется по паре: совпадение либо учётной
  -- записи, либо человека — уже нарушение (`sameActor`, `auth/src/ids.ts`).
  IF NEW.role_assigned_by IS NOT NULL THEN
    SELECT person_id INTO ordering_person
      FROM sdelka.auth_account
     WHERE account_id = NEW.role_assigned_by;
    IF ordering_person = NEW.person_id THEN
      RAISE EXCEPTION 'auth.sod.self_approval'
        USING ERRCODE = '23514',
              DETAIL = format('account_id=%s', NEW.account_id);
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.role_id IS DISTINCT FROM OLD.role_id THEN
    -- «Смена роли отзывает действующие сессии всегда» (`RoleChangeOutcome`):
    -- иначе снятое полномочие продолжало бы действовать до восьми часов, пока
    -- живёт выданная сессия. Здесь это не пожелание вызывающему, а условие
    -- смены: сначала отзыв, потом роль.
    SELECT count(*) INTO live_sessions
      FROM sdelka.auth_session
     WHERE account_id = NEW.account_id
       AND revoked_at IS NULL
       AND expires_at > NEW.role_assigned_at;
    IF live_sessions > 0 THEN
      RAISE EXCEPTION 'db.auth.role_change_with_live_session'
        USING ERRCODE = '23514',
              DETAIL = format('account_id=%s;sessions=%s', NEW.account_id, live_sessions);
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER assert_auth_account
  BEFORE INSERT OR UPDATE ON sdelka.auth_account
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_auth_account();

-- ---------------------------------------------------------------------------
-- Привязка второго фактора
-- ---------------------------------------------------------------------------
--
-- Зеркало `SecondFactorBinding { kind, boundAt }` и ровно то, что обязан уметь
-- ответить `SecondFactorRegistryPort`: «привязан ли фактор» — **до** того, как
-- система покажет форму реквизитов (`ACTORS.md` §11 Р6 вариант A).
--
-- Секрета здесь нет: ни семени TOTP, ни открытого ключа, ни идентификатора
-- удостоверения. Всё это живёт у провайдера, чьи ключи — в окружении (красная
-- линия №12). Отвязка не выражена: снятие второго фактора — операция, для
-- которой в `packages/auth` нет ни функции, ни правила, и придумывать её здесь
-- значило бы принять продуктовое решение.
CREATE TABLE sdelka.second_factor_binding (
  account_id text NOT NULL REFERENCES sdelka.auth_account (account_id),
  kind sdelka.second_factor_kind NOT NULL REFERENCES sdelka.second_factor (kind),
  bound_at timestamptz NOT NULL,

  PRIMARY KEY (account_id, kind)
);

-- ---------------------------------------------------------------------------
-- Сессия
-- ---------------------------------------------------------------------------
--
-- Три правила пакета, которые здесь становятся правилами базы:
--
-- 1. **Сессия без срока невозможна.** `expiresAt` в `Session` не опционален, и
--    `expires_at` здесь `NOT NULL`. Мало: срок, который можно поставить на год,
--    — это отсутствие срока, поэтому триггер сверяет его с политикой аудитории
--    (`auth.session.ttl_too_long`, ровно как `establishSession`).
-- 2. **Абсолютный срок продлению не подлежит** («продлеваемый абсолютный срок —
--    не срок»). `touch` двигает только `lastSeenAt`; всё остальное неизменяемо,
--    и это проверяется триггером обновления, а не соглашением.
-- 3. **Отозванная сессия не оживает.** После `revoked_at` строка не меняется
--    вовсе: ни снятия отзыва, ни отметки активности, ни нового фактора, ни гранта.
CREATE TABLE sdelka.auth_session (
  session_id text PRIMARY KEY
    CHECK (session_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(session_id) <= 128),
  account_id text NOT NULL REFERENCES sdelka.auth_account (account_id),
  person_id text NOT NULL
    CHECK (person_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(person_id) <= 128),
  role_id sdelka.role_id NOT NULL REFERENCES sdelka.auth_role (role_id),
  -- Дежурство — флаг на сессии, включаемый расписанием на интервал, и ноль
  -- полей данных (`ACTORS.md` §4, колонка ДЖ пуста).
  on_duty boolean NOT NULL,

  primary_method sdelka.auth_primary_method NOT NULL,
  primary_at timestamptz NOT NULL,
  -- Отпечатки, а не сырые значения: `ACTORS.md` §4.1 A2 и инвариант 24.
  device_fingerprint text CHECK (device_fingerprint ~ '^[0-9a-f]{64}$'),
  network_fingerprint text CHECK (network_fingerprint ~ '^[0-9a-f]{64}$'),

  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz,

  CONSTRAINT auth_session_has_deadline CHECK (expires_at > issued_at),
  CONSTRAINT auth_session_seen_after_issue CHECK (last_seen_at >= issued_at),
  CONSTRAINT auth_session_revoked_after_issue
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  -- Вход не может случиться позже сессии, которую он открыл.
  CONSTRAINT auth_session_primary_before_issue CHECK (primary_at <= issued_at),

  -- Ключ для составной ссылки из гранта: доказательство полномочия обязано
  -- совпадать с сессией по учётной записи, человеку, роли и дежурству — иначе
  -- грант приписывает действие не тому, кто вошёл.
  UNIQUE (session_id, account_id, person_id, role_id, on_duty)
);

CREATE INDEX auth_session_account ON sdelka.auth_session (account_id, issued_at);

-- Миллисекунды между моментами. `EXTRACT(EPOCH ...)` в Postgres 14+ возвращает
-- `numeric`, а не число с плавающей точкой, — сравнение со сроком политики
-- остаётся точным (красная линия №4 про суммы, но дробная миллисекунда так же
-- не значит ничего).
CREATE FUNCTION sdelka.millis_between(earlier timestamptz, later timestamptz)
RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT EXTRACT(EPOCH FROM (later - earlier)) * 1000
$$;

CREATE FUNCTION sdelka.assert_auth_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  role_row sdelka.auth_role%ROWTYPE;
  policy sdelka.session_policy%ROWTYPE;
  account_row sdelka.auth_account%ROWTYPE;
BEGIN
  SELECT * INTO role_row FROM sdelka.auth_role WHERE role_id = NEW.role_id;
  SELECT * INTO policy FROM sdelka.session_policy WHERE audience = role_row.audience;

  -- Учётной записи может не быть вовсе — тогда отказывает внешний ключ, и
  -- отказывает своим кодом. Подменять его здешним ключом значило бы сообщить
  -- дежурному «роль не совпала» там, где записи просто нет.
  SELECT * INTO account_row
    FROM sdelka.auth_account WHERE account_id = NEW.account_id;
  IF FOUND THEN
    -- Роль в сессии — это роль учётной записи, а не пожелание вызывающего.
    -- Переключателя ролей нет ни у клиента, ни у сотрудника (`CABINETS.md` §0
    -- п.4), поэтому сессия с чужой ролью — не «расширенные права», а подлог.
    IF account_row.role_id IS DISTINCT FROM NEW.role_id THEN
      RAISE EXCEPTION 'db.auth.account_role_mismatch'
        USING ERRCODE = '23514',
              DETAIL = format('session_id=%s;account_role=%s;session_role=%s',
                              NEW.session_id, account_row.role_id, NEW.role_id);
    END IF;

    -- Человек за учётной записью — второй рубеж разделения обязанностей
    -- (`auth/src/ids.ts`). Сессия, назвавшая другого человека, отключает его
    -- молча: несовместимости сравнивают пару, и подменённая половина проходит
    -- любую проверку.
    IF account_row.person_id IS DISTINCT FROM NEW.person_id THEN
      RAISE EXCEPTION 'db.auth.account_person_mismatch'
        USING ERRCODE = '23514',
              DETAIL = format('session_id=%s;account_id=%s', NEW.session_id, NEW.account_id);
    END IF;
  END IF;

  -- Дежурство — режим поверх ОП, ФК, РО и больше ни поверх чего (§7.1).
  IF NEW.on_duty AND NOT role_row.duty_eligible THEN
    RAISE EXCEPTION 'auth.duty.role_not_eligible'
      USING ERRCODE = '23514',
            DETAIL = format('session_id=%s;role_id=%s', NEW.session_id, NEW.role_id);
  END IF;

  -- Ссылка в письме для консоли запрещена: почта и есть компрометируемый канал
  -- (`ACTORS.md` §11 Р6 B), а консольная роль видит деньги.
  IF role_row.audience = 'console' AND NEW.primary_method = 'magic_link' THEN
    RAISE EXCEPTION 'auth.primary.method_not_allowed_for_console'
      USING ERRCODE = '23514',
            DETAIL = format('session_id=%s;role_id=%s', NEW.session_id, NEW.role_id);
  END IF;

  IF sdelka.millis_between(NEW.issued_at, NEW.expires_at) > policy.max_ttl_ms THEN
    RAISE EXCEPTION 'auth.session.ttl_too_long'
      USING ERRCODE = '23514',
            DETAIL = format('session_id=%s;audience=%s', NEW.session_id, role_row.audience);
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER assert_auth_session
  BEFORE INSERT ON sdelka.auth_session
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_auth_session();

CREATE FUNCTION sdelka.assert_auth_session_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Отозванная сессия не оживает: после отзыва строка не меняется вовсе. Иначе
  -- «отзыв» был бы полем, которое кто-то может переписать обратно.
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'db.auth.session_revived'
      USING ERRCODE = '23514', DETAIL = format('session_id=%s', OLD.session_id);
  END IF;

  IF NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.role_id IS DISTINCT FROM OLD.role_id
     OR NEW.on_duty IS DISTINCT FROM OLD.on_duty
     OR NEW.primary_method IS DISTINCT FROM OLD.primary_method
     OR NEW.primary_at IS DISTINCT FROM OLD.primary_at
     OR NEW.device_fingerprint IS DISTINCT FROM OLD.device_fingerprint
     OR NEW.network_fingerprint IS DISTINCT FROM OLD.network_fingerprint
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     -- Абсолютный срок продлению не подлежит. Продлевается простой, и только он.
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'db.auth.session_immutable'
      USING ERRCODE = '23514', DETAIL = format('session_id=%s', OLD.session_id);
  END IF;

  -- Отметка активности идёт только вперёд: сдвинутая назад, она воскрешает
  -- сессию, простоявшую дольше допустимого.
  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'db.auth.last_seen_regression'
      USING ERRCODE = '23514', DETAIL = format('session_id=%s', OLD.session_id);
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER assert_auth_session_update
  BEFORE UPDATE ON sdelka.auth_session
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_auth_session_update();

-- ---------------------------------------------------------------------------
-- Подтверждения второго фактора внутри сессии
-- ---------------------------------------------------------------------------
--
-- Зеркало `SecondFactorAssertion`. `withAssertion` добавляет, не заменяя:
-- «прежние сохраняются: журнал, а не замена». Отсюда append-only.
--
-- Ключ — `challenge_id`, и он глобальный: «подтверждение без вызова, на который
-- оно отвечает, невозможно связать с операцией, и повтор такого подтверждения
-- нечем отличить от первого» (`auth/src/second-factor.ts`). Один вызов
-- отвечается один раз и в одной сессии.
CREATE TABLE sdelka.session_factor (
  challenge_id text PRIMARY KEY
    CHECK (challenge_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(challenge_id) <= 128),
  session_id text NOT NULL REFERENCES sdelka.auth_session (session_id),
  kind sdelka.second_factor_kind NOT NULL REFERENCES sdelka.second_factor (kind),
  verified_at timestamptz NOT NULL,
  device_fingerprint text CHECK (device_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX session_factor_session ON sdelka.session_factor (session_id, verified_at);

-- Второй фактор на входе — требование политики аудитории, а факторы приезжают
-- отдельными строками. Поэтому проверка **отложенная**: она обязана смотреть на
-- сессию вместе с её подтверждениями, то есть в конце транзакции, а не в
-- середине. Немедленной её сделать нельзя, не выдумав порядок вставки.
CREATE FUNCTION sdelka.assert_session_second_factor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  role_row sdelka.auth_role%ROWTYPE;
  policy sdelka.session_policy%ROWTYPE;
  freshest sdelka.session_factor%ROWTYPE;
  factor_rank smallint;
  minimum_rank smallint;
BEGIN
  SELECT * INTO role_row FROM sdelka.auth_role WHERE role_id = NEW.role_id;
  SELECT * INTO policy FROM sdelka.session_policy WHERE audience = role_row.audience;

  IF NOT policy.second_factor_at_login THEN
    RETURN NULL;
  END IF;

  SELECT * INTO freshest
    FROM sdelka.session_factor
   WHERE session_id = NEW.session_id AND verified_at <= NEW.issued_at
   ORDER BY verified_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'auth.second_factor.missing'
      USING ERRCODE = '23514', DETAIL = format('session_id=%s', NEW.session_id);
  END IF;

  SELECT r.rank INTO factor_rank
    FROM sdelka.second_factor AS f
    JOIN sdelka.factor_strength_rank AS r ON r.strength = f.strength
   WHERE f.kind = freshest.kind;
  SELECT rank INTO minimum_rank
    FROM sdelka.factor_strength_rank WHERE strength = policy.minimum_factor_strength;

  IF factor_rank < minimum_rank THEN
    RAISE EXCEPTION 'auth.second_factor.too_weak'
      USING ERRCODE = '23514',
            DETAIL = format('session_id=%s;kind=%s', NEW.session_id, freshest.kind);
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER assert_session_second_factor
  AFTER INSERT ON sdelka.auth_session
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_session_second_factor();

CREATE FUNCTION sdelka.assert_session_factor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  session_row sdelka.auth_session%ROWTYPE;
BEGIN
  SELECT * INTO session_row
    FROM sdelka.auth_session WHERE session_id = NEW.session_id;

  -- Отозванная сессия не оживает — в том числе новым подтверждением фактора.
  IF session_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'auth.session.revoked'
      USING ERRCODE = '23514', DETAIL = format('session_id=%s', NEW.session_id);
  END IF;

  IF NEW.verified_at >= session_row.expires_at THEN
    RAISE EXCEPTION 'auth.session.expired'
      USING ERRCODE = '23514', DETAIL = format('session_id=%s', NEW.session_id);
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER assert_session_factor
  BEFORE INSERT ON sdelka.session_factor
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_session_factor();

-- ---------------------------------------------------------------------------
-- Грант полномочия
-- ---------------------------------------------------------------------------
--
-- Зеркало `Grant<C>`: «подделать нельзя, не выписав; выписать нельзя иначе как
-- через `decide`». В базе то же самое означает, что строка не вставится, если
-- полномочия у роли нет, если сессия мертва или если второй фактор несвеж.
--
-- **Грант без срока невозможен.** В `Grant` срока нет как поля — есть
-- `decidedAt`, а годность считает `changeAccountRole`: «доказательство
-- полномочия живёт ровно столько, сколько живёт подтверждение, которым
-- получено», то есть `stepUpMaxAge` политики роли. Хранимое доказательство без
-- срока годности — это бессрочное доказательство, поэтому `expires_at` здесь
-- обязателен и не длиннее того же окна.
--
-- ⚠ Окно взято одно на все полномочия, включая те, у которых `secondFactor` =
-- `none`. Прочтения два: `access.ts` применяет его к `manage_access` (полномочие
-- со `step_up`), про остальные не сказано ничего. Взято строгое — см. отчёт.
CREATE TABLE sdelka.auth_grant (
  session_id text NOT NULL,
  account_id text NOT NULL,
  person_id text NOT NULL,
  role_id sdelka.role_id NOT NULL,
  on_duty boolean NOT NULL,
  capability sdelka.capability NOT NULL REFERENCES sdelka.auth_capability (capability),
  decided_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,

  PRIMARY KEY (session_id, capability, decided_at),

  CONSTRAINT auth_grant_has_deadline CHECK (expires_at > decided_at),

  -- Составная ссылка: грант обязан совпасть с сессией по всем четырём
  -- измерениям, а не только по её идентификатору.
  FOREIGN KEY (session_id, account_id, person_id, role_id, on_duty)
    REFERENCES sdelka.auth_session (session_id, account_id, person_id, role_id, on_duty)
);

CREATE INDEX auth_grant_account ON sdelka.auth_grant (account_id, decided_at);

CREATE FUNCTION sdelka.assert_auth_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  session_row sdelka.auth_session%ROWTYPE;
  role_row sdelka.auth_role%ROWTYPE;
  policy sdelka.session_policy%ROWTYPE;
  spec sdelka.auth_capability%ROWTYPE;
  held sdelka.role_capability%ROWTYPE;
  freshest sdelka.session_factor%ROWTYPE;
  factor_rank smallint;
  minimum_rank smallint;
BEGIN
  SELECT * INTO session_row
    FROM sdelka.auth_session WHERE session_id = NEW.session_id;
  SELECT * INTO role_row FROM sdelka.auth_role WHERE role_id = NEW.role_id;
  SELECT * INTO policy FROM sdelka.session_policy WHERE audience = role_row.audience;
  SELECT * INTO spec FROM sdelka.auth_capability WHERE capability = NEW.capability;

  -- Порядок проверок — как в `decideCapability`, и он задан ценой ошибки:
  -- сначала «жива ли сессия», иначе всё остальное считается по данным умершего
  -- входа.
  IF NEW.decided_at < session_row.issued_at THEN
    RAISE EXCEPTION 'db.auth.grant_before_session'
      USING ERRCODE = '23514', DETAIL = format('session_id=%s', NEW.session_id);
  END IF;

  IF session_row.revoked_at IS NOT NULL AND NEW.decided_at >= session_row.revoked_at THEN
    RAISE EXCEPTION 'auth.session.revoked'
      USING ERRCODE = '23514', DETAIL = format('session_id=%s', NEW.session_id);
  END IF;

  IF NEW.decided_at >= session_row.expires_at THEN
    RAISE EXCEPTION 'auth.session.expired'
      USING ERRCODE = '23514', DETAIL = format('session_id=%s', NEW.session_id);
  END IF;

  IF sdelka.millis_between(session_row.last_seen_at, NEW.decided_at) >= policy.idle_ttl_ms THEN
    RAISE EXCEPTION 'auth.session.idle'
      USING ERRCODE = '23514', DETAIL = format('session_id=%s', NEW.session_id);
  END IF;

  -- Рантайм-дубль компиляционного рубежа: тип роли не переживает границу
  -- процесса. Дежурное полномочие требует дежурства — флаг сам по себе
  -- полномочий не даёт (`effectiveCapabilities`).
  SELECT * INTO held
    FROM sdelka.role_capability
   WHERE role_id = NEW.role_id AND capability = NEW.capability;
  IF NOT FOUND OR (held.requires_duty AND NOT NEW.on_duty) THEN
    RAISE EXCEPTION 'auth.capability.not_granted'
      USING ERRCODE = '23514',
            DETAIL = format('role_id=%s;capability=%s', NEW.role_id, NEW.capability);
  END IF;

  IF sdelka.millis_between(NEW.decided_at, NEW.expires_at) > policy.step_up_max_age_ms THEN
    RAISE EXCEPTION 'auth.authority.stale'
      USING ERRCODE = '23514',
            DETAIL = format('session_id=%s;capability=%s', NEW.session_id, NEW.capability);
  END IF;

  IF spec.second_factor = 'step_up' THEN
    -- Свежесть считается от подтверждения, а не от выдачи сессии:
    -- подтверждение восьмичасовой давности подтверждает того, кто входил
    -- утром, а не того, кто нажимает «утвердить» сейчас.
    SELECT * INTO freshest
      FROM sdelka.session_factor
     WHERE session_id = NEW.session_id AND verified_at <= NEW.decided_at
     ORDER BY verified_at DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'auth.second_factor.missing'
        USING ERRCODE = '23514',
              DETAIL = format('session_id=%s;capability=%s', NEW.session_id, NEW.capability);
    END IF;

    SELECT r.rank INTO factor_rank
      FROM sdelka.second_factor AS f
      JOIN sdelka.factor_strength_rank AS r ON r.strength = f.strength
     WHERE f.kind = freshest.kind;
    SELECT rank INTO minimum_rank
      FROM sdelka.factor_strength_rank WHERE strength = policy.minimum_factor_strength;

    IF factor_rank < minimum_rank THEN
      RAISE EXCEPTION 'auth.second_factor.too_weak'
        USING ERRCODE = '23514',
              DETAIL = format('session_id=%s;kind=%s', NEW.session_id, freshest.kind);
    END IF;

    IF sdelka.millis_between(freshest.verified_at, NEW.decided_at) > policy.step_up_max_age_ms THEN
      RAISE EXCEPTION 'auth.second_factor.stale'
        USING ERRCODE = '23514',
              DETAIL = format('session_id=%s;capability=%s', NEW.session_id, NEW.capability);
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER assert_auth_grant
  BEFORE INSERT ON sdelka.auth_grant
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_auth_grant();

-- ---------------------------------------------------------------------------
-- Журнал доступа
-- ---------------------------------------------------------------------------
--
-- Зеркало `AuthEvent`. Форма каждого вида проверяется ограничением: событие
-- входа без срока сессии, отказ без причины и назначение роли внутри сессии —
-- это не «неполная запись», а запись, которой нельзя верить. Журнал не
-- редактируется (красная линия №11), дописать недостающее потом нельзя, значит
-- состав проверяется на входе.
--
-- Внешнего ключа на учётную запись здесь **нет намеренно**: отказ во входе по
-- несуществующей записи — ровно та запись, ради которой журнал входов и ведётся
-- (`ACTORS.md` §4.1 A2, подбор пароля). Ключ бы её и не пустил.
CREATE TABLE sdelka.auth_event (
  event_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind sdelka.auth_event_kind NOT NULL,
  occurred_at timestamptz NOT NULL,

  account_id text NOT NULL
    CHECK (account_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(account_id) <= 128),
  person_id text NOT NULL
    CHECK (person_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(person_id) <= 128),
  -- `NULL` там, где роль ещё не установлена: отказ во входе до её разбора.
  role_id sdelka.role_id,
  on_duty boolean NOT NULL,

  session_id text REFERENCES sdelka.auth_session (session_id),
  device_fingerprint text CHECK (device_fingerprint ~ '^[0-9a-f]{64}$'),
  network_fingerprint text CHECK (network_fingerprint ~ '^[0-9a-f]{64}$'),

  primary_method sdelka.auth_primary_method,
  second_factor sdelka.second_factor_kind,
  expires_at timestamptz,
  capability sdelka.capability,
  reason sdelka.auth_reason_key,
  ordered_by text
    CHECK (ordered_by ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(ordered_by) <= 128),

  -- Разбор союза `AuthEvent`. `ELSE false` обязателен: `CASE` без него вернул бы
  -- `NULL` на неучтённой метке, а `CHECK` пропускает `NULL` — то есть новый вид
  -- события проходил бы вообще без проверки формы.
  CONSTRAINT auth_event_shape CHECK (
    CASE kind
      WHEN 'session_established' THEN
        session_id IS NOT NULL AND role_id IS NOT NULL AND primary_method IS NOT NULL
        AND expires_at IS NOT NULL AND capability IS NULL AND reason IS NULL
        AND ordered_by IS NULL
      WHEN 'session_denied' THEN
        session_id IS NULL AND primary_method IS NOT NULL AND reason IS NOT NULL
        AND expires_at IS NULL AND capability IS NULL AND second_factor IS NULL
        AND ordered_by IS NULL
      WHEN 'session_revoked' THEN
        session_id IS NOT NULL AND role_id IS NOT NULL AND reason IS NOT NULL
        AND primary_method IS NULL AND expires_at IS NULL AND capability IS NULL
        AND second_factor IS NULL AND ordered_by IS NULL
      WHEN 'second_factor_verified' THEN
        second_factor IS NOT NULL AND primary_method IS NULL AND expires_at IS NULL
        AND capability IS NULL AND reason IS NULL AND ordered_by IS NULL
      WHEN 'duty_started' THEN
        session_id IS NOT NULL AND role_id IS NOT NULL AND on_duty
        AND primary_method IS NULL AND expires_at IS NULL AND capability IS NULL
        AND second_factor IS NULL AND reason IS NULL AND ordered_by IS NULL
      WHEN 'duty_ended' THEN
        session_id IS NOT NULL AND role_id IS NOT NULL
        AND primary_method IS NULL AND expires_at IS NULL AND capability IS NULL
        AND second_factor IS NULL AND reason IS NULL AND ordered_by IS NULL
      WHEN 'role_assigned' THEN
        role_id IS NOT NULL AND session_id IS NULL AND NOT on_duty
        AND primary_method IS NULL AND expires_at IS NULL AND capability IS NULL
        AND second_factor IS NULL AND reason IS NULL
      WHEN 'role_revoked' THEN
        role_id IS NOT NULL AND session_id IS NULL AND NOT on_duty
        AND primary_method IS NULL AND expires_at IS NULL AND capability IS NULL
        AND second_factor IS NULL AND reason IS NULL
      WHEN 'authorization_granted' THEN
        capability IS NOT NULL AND session_id IS NOT NULL AND role_id IS NOT NULL
        AND reason IS NULL AND primary_method IS NULL AND expires_at IS NULL
        AND second_factor IS NULL AND ordered_by IS NULL
      WHEN 'authorization_denied' THEN
        capability IS NOT NULL AND session_id IS NOT NULL AND role_id IS NOT NULL
        AND reason IS NOT NULL AND primary_method IS NULL AND expires_at IS NULL
        AND second_factor IS NULL AND ordered_by IS NULL
      ELSE false
    END
  )
);

CREATE INDEX auth_event_account ON sdelka.auth_event (account_id, occurred_at);
CREATE INDEX auth_event_occurred_at ON sdelka.auth_event (occurred_at);
CREATE INDEX auth_event_session ON sdelka.auth_event (session_id, occurred_at);

-- Второй контур append-only: ловит и владельца схемы, которого гранты не
-- ограничивают. Первый контур — гранты ниже, и именно он назван инвариантом
-- (`0007`, тот же приём).
CREATE FUNCTION sdelka.forbid_auth_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'db.auth.append_only'
    USING ERRCODE = '0A000',
          DETAIL = format('relation=%s;operation=%s', TG_TABLE_NAME, TG_OP);
END
$$;

CREATE TRIGGER forbid_auth_event_mutation
  BEFORE UPDATE OR DELETE ON sdelka.auth_event
  FOR EACH ROW EXECUTE FUNCTION sdelka.forbid_auth_mutation();

-- Подтверждение фактора, привязка и грант — такие же факты, а не строки
-- состояния: переписанный задним числом грант доказывает не то полномочие.
CREATE TRIGGER forbid_session_factor_mutation
  BEFORE UPDATE OR DELETE ON sdelka.session_factor
  FOR EACH ROW EXECUTE FUNCTION sdelka.forbid_auth_mutation();

CREATE TRIGGER forbid_second_factor_binding_mutation
  BEFORE UPDATE OR DELETE ON sdelka.second_factor_binding
  FOR EACH ROW EXECUTE FUNCTION sdelka.forbid_auth_mutation();

CREATE TRIGGER forbid_auth_grant_mutation
  BEFORE UPDATE OR DELETE ON sdelka.auth_grant
  FOR EACH ROW EXECUTE FUNCTION sdelka.forbid_auth_mutation();

-- ---------------------------------------------------------------------------
-- Гранты
-- ---------------------------------------------------------------------------
--
-- Справочники роль приложения только читает: карта ролей и полномочий — это
-- решение, принятое кодом и миграцией, а не данные, которые приложение правит на
-- ходу. Роль, дописавшая себе строку в `role_capability`, отменяет всю матрицу.
GRANT SELECT ON
  sdelka.auth_role,
  sdelka.session_policy,
  sdelka.factor_strength_rank,
  sdelka.second_factor,
  sdelka.auth_capability,
  sdelka.role_capability
TO sdelka_app;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  sdelka.auth_role,
  sdelka.session_policy,
  sdelka.factor_strength_rank,
  sdelka.second_factor,
  sdelka.auth_capability,
  sdelka.role_capability
FROM sdelka_app;

-- Учётная запись: заводится и меняет роль — но не исчезает. Удалённая запись
-- уносит с собой связь журнала с тем, кто действовал.
GRANT SELECT, INSERT, UPDATE ON sdelka.auth_account TO sdelka_app;
REVOKE DELETE, TRUNCATE ON sdelka.auth_account FROM sdelka_app;

-- Сессия: выдаётся, отмечается активной, отзывается. Не удаляется: отзыв — это
-- запись, а не пропажа строки.
GRANT SELECT, INSERT, UPDATE ON sdelka.auth_session TO sdelka_app;
REVOKE DELETE, TRUNCATE ON sdelka.auth_session FROM sdelka_app;

-- Подтверждения, привязки, гранты и журнал доступа — только чтение и вставка.
-- То же, что с журналом аудита (`0007`): «роль приложения не имеет прав на
-- изменение и удаление — проверяется грантами базы, а не кодом».
GRANT SELECT, INSERT ON
  sdelka.session_factor,
  sdelka.second_factor_binding,
  sdelka.auth_grant,
  sdelka.auth_event
TO sdelka_app;

REVOKE UPDATE, DELETE, TRUNCATE ON
  sdelka.session_factor,
  sdelka.second_factor_binding,
  sdelka.auth_grant,
  sdelka.auth_event
FROM sdelka_app;

REVOKE ALL ON
  sdelka.auth_role,
  sdelka.session_policy,
  sdelka.factor_strength_rank,
  sdelka.second_factor,
  sdelka.auth_capability,
  sdelka.role_capability,
  sdelka.auth_account,
  sdelka.auth_session,
  sdelka.session_factor,
  sdelka.second_factor_binding,
  sdelka.auth_grant,
  sdelka.auth_event
FROM PUBLIC;

-- ===== 0011_audit_security_records.sql =====
-- 0011 — виды записей о безопасности и два новых субъекта журнала.
--
-- `packages/audit` завёл четыре вида записи (`session_established`,
-- `session_denied`, `role_changed`, `setting_changed`) и два субъекта
-- (`account`, `setting`). До них двенадцать видов описывали деньги, решения и
-- просмотр персональных данных: вход, отказ во входе, смена роли и изменение
-- настройки не описывались ни одним, и события `packages/auth` ложиться в
-- журнал не могли (`auth/src/events.ts` называл это расхождение сам).
--
-- Здесь только перечни. **Метки дописываются в конец** — `ALTER TYPE ... ADD
-- VALUE` иначе не умеет, а порядок меток обязан совпасть с массивами в TS:
-- порядок виден в `ORDER BY`, и разошедшаяся сортировка отчёта дежурному ничем
-- себя не выдаёт. Та же оговорка стоит у `application_card` в `0009`.
--
-- Внутри транзакции это допустимо начиная с Postgres 12; новые метки в той же
-- транзакции не используются, поэтому «unsafe use of new value» не возникает.
--
-- **Чего здесь нет.** Проверок тела новых записей (`checkBodyInvariants`,
-- `audit/src/chain.ts`) база не повторяет: вторая реализация тех же правил на
-- PL/pgSQL — это ровно тот дрейф двух моделей, ради отказа от которого `0007`
-- не пересчитывает и `record_hash`. База держит сцепку, нумерацию, монотонность
-- времени и append-only; тело проверяет код на чтении и на записи.
--
-- Ограничения `0007` новым видам ничего не должны: `audit_record_kind_matches_body`
-- сверяет колонку с телом безотносительно вида, ветви `correction` и
-- `timestamp_token` в триггере трогают только свои виды, а `subject_scope` — это
-- сам перечень, который здесь и расширяется. Поэтому `0007` не правится: правка
-- применённой миграции расходится с тем, что стоит на проде, молча.

SET LOCAL ROLE sdelka_owner;

-- packages/audit: AUDIT_RECORD_KINDS
ALTER TYPE sdelka.audit_record_kind ADD VALUE 'session_established';
ALTER TYPE sdelka.audit_record_kind ADD VALUE 'session_denied';
ALTER TYPE sdelka.audit_record_kind ADD VALUE 'role_changed';
ALTER TYPE sdelka.audit_record_kind ADD VALUE 'setting_changed';

-- packages/audit: REF_SCOPES
--
-- `account` — учётная запись, а не `party`: сторона это участник сделки, и
-- запись «вход стороны party-3» через год прочиталась бы как действие по
-- сделке. Сотрудник стороной не бывает вовсе, а входит именно он.
ALTER TYPE sdelka.ref_scope ADD VALUE 'account';
ALTER TYPE sdelka.ref_scope ADD VALUE 'setting';

-- ===== 0012_settlement_capabilities.sql =====
-- 0012 — пять полномочий операционной механики расчёта: **только метки перечня**.
--
-- `packages/auth` завёл `prepare_settlement`, `record_bank_outcome`,
-- `operate_treasury`, `conduct_withdrawal` и `patch_tranche_facts`
-- (`ACTORS.md` §5.1.1). До них семь шагов приложения — выдача инструкций,
-- отнесение поступления, исход платёжного провайдера, зачисление по выписке,
-- конвертация, довнесение недостачи, заявка на вывод — выполнялись под
-- **чужим** полномочием `create_deal`: своего у них не было ни в документе, ни
-- в этом перечне, а односторонняя правка любой из двух сторон развалила бы
-- гранты (`sdelka.auth_grant` ссылается на `sdelka.auth_capability`).
--
-- **Метки дописываются в конец** — `ALTER TYPE … ADD VALUE` иначе не умеет, а
-- порядок меток обязан совпасть с массивом `CAPABILITIES`: порядок виден в
-- `ORDER BY`, и разошедшаяся сортировка ничем себя не выдаёт. Та же оговорка
-- стоит у `0011` и у `application_card` в `0009`.
--
-- **Почему это отдельная миграция от засева справочника.** Начиная с Postgres 12
-- `ALTER TYPE … ADD VALUE` внутри транзакции допустим, но **использовать**
-- новую метку в той же транзакции нельзя («unsafe use of new value of enum
-- type»). Раннер выполняет каждый файл одной транзакцией (`src/migrate.ts`),
-- поэтому строки справочника и гранты ролей заводит `0013`. Разбить надо было
-- именно так: обратный порядок не собрался бы вовсе.

SET LOCAL ROLE sdelka_owner;

-- packages/auth: CAPABILITIES (`ACTORS.md` §5.1.1)
ALTER TYPE sdelka.capability ADD VALUE 'prepare_settlement';
ALTER TYPE sdelka.capability ADD VALUE 'record_bank_outcome';
ALTER TYPE sdelka.capability ADD VALUE 'operate_treasury';
ALTER TYPE sdelka.capability ADD VALUE 'conduct_withdrawal';
ALTER TYPE sdelka.capability ADD VALUE 'patch_tranche_facts';

-- ===== 0013_settlement_grants.sql =====
-- 0013 — справочник и гранты для пяти полномочий из `0012`.
--
-- Отдельный файл, потому что метку перечня нельзя использовать в той же
-- транзакции, в которой она добавлена; довод целиком — в шапке `0012`.
--
-- Обе вставки — **дописывание**, а не переписывание: `0010` применена, править
-- её нельзя (контрольная сумма, `src/migrate.ts`). Тест дрейфа
-- (`test/auth-reference.test.ts`) читает засев по всем миграциям подряд,
-- поэтому порядок строк здесь обязан продолжать порядок `0010`: полномочия — в
-- порядке `CAPABILITIES`, пары «роль → полномочие» — в порядке
-- `ROLE_CAPABILITIES` внутри каждой роли.

SET LOCAL ROLE sdelka_owner;

-- packages/auth: CAPABILITY_SPECS
--
-- Второго фактора нет только у подготовки расчёта: она ничего не двигает сама,
-- а всё, что готовит, проходит через утверждение, у которого фактор есть.
-- `operate_treasury` — единственный `release` из пяти: здесь двигаются деньги
-- платформы (недостача признаётся её расходом, комиссия уходит на операционный
-- счёт), а не готовится чужая операция.
INSERT INTO sdelka.auth_capability (capability, effect, second_factor, journaled) VALUES
  ('prepare_settlement',   'prepare',  'none',     true),
  ('record_bank_outcome',  'prepare',  'step_up',  true),
  ('operate_treasury',     'release',  'step_up',  true),
  ('conduct_withdrawal',   'prepare',  'step_up',  true),
  ('patch_tranche_facts',  'prepare',  'step_up',  true);

-- packages/auth: ROLE_CAPABILITIES
--
-- Носителей два, и это разделение обязанностей, а не вкус: ОП готовит расчёт и
-- вносит внешний факт платежа, ФК двигает деньги платформы. Ни одного из пяти
-- нет у владельца (Н6), стороны, поддержки и аудитора; ни одно не выдаётся
-- дежурством (§7.3 — дежурство добавляет только сужающие).
INSERT INTO sdelka.role_capability (role_id, capability, requires_duty) VALUES
  ('operator',              'prepare_settlement',   false),
  ('operator',              'record_bank_outcome',  false),
  ('operator',              'conduct_withdrawal',   false),
  ('operator',              'patch_tranche_facts',  false),
  ('financial_controller',  'operate_treasury',     false);

-- ===== 0014_correction_mirror.sql =====
-- 0014 — исправление обязано быть зеркалом своей цели.
--
-- Красная линия №11 обещает не ссылку, а след: «журнал не редактируется,
-- исправление — только новой записью со ссылкой на предыдущую». До этой
-- миграции база проверяла у ссылки ровно две вещи: что цель существует
-- (`corrects_entry_id REFERENCES ledger_entry`, `0002`) и что ссылка есть
-- тогда и только тогда, когда запись — исправление. Содержание исправления со
-- своей целью не сверялось ничем, и этого хватало на такую запись:
--
--   Дт unclaimed:liability  100 000        Кт client:Z:free  100 000  {Z}
--   Кт transit:writeoff     100 000        Дт bank:nominal   100 000  {Z}
--
-- Четыре проводки, где кастодиан едет вместе с обязательством: запись
-- сбалансирована повалютно, форма счетов верна, пофайловый прирост ровно
-- нулевой, покрытие остаётся 1/1 — и невостребованные средства чужого транша
-- становятся свободным остатком постороннего лица. В коде это закрыто
-- зеркальностью (`ledger/src/journal.ts`, `assertCorrectionMirrorsTarget`);
-- здесь — второй контур, потому что роль приложения имеет право `INSERT` в
-- журнал и запись может лечь мимо `appendEntry`.
--
-- Правило то же, буква в букву: движение исправления по каждому счёту и файлу
-- обратно движению цели по тому же счёту и файлу, и в сумме по всем
-- исправлениям одной цели не больше того, что цель двинула.
--
-- ⚠ Ограничение, названное честно: два исправления одной цели в **параллельных**
-- транзакциях друг друга не видят и вдвоём могут отмотать цель дважды. Это то
-- же свойство, что у отложенного триггера баланса и у идемпотентности
-- начисления в коде; закрывается уровнем изоляции пишущей транзакции, а не
-- ограничением.

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Чистое движение записи по счёту и файлу
-- ---------------------------------------------------------------------------
--
-- Файл читается по объявленной природе счёта, без единого перечня имён — как
-- и в `v_posting_file`, но по **всем** счетам, а не только клиентским: у
-- требования по комиссии и у транзита файл тоже есть, и исправление обязано
-- сверяться с целью и по ним.
--
-- Зеркало `postingFile` и `postingMovementKey` (`ledger/src/entry.ts`):
-- владелец в коде — файл из кода счёта, пул — файла нет, всё остальное — файл
-- приносит отнесение. Валюта входит в ключ: сто лари и сто долларов на одном
-- счёте — два разных движения.
CREATE VIEW sdelka.v_ledger_movement AS
SELECT entry_id,
       account_code,
       currency,
       file_key,
       sum(signed_minor) AS minor
  FROM (
    SELECT p.entry_id,
           p.account_code,
           p.currency,
           p.signed_minor,
           CASE
             WHEN p.file_scope = 'pooled' THEN ''
             WHEN p.file_scope = 'owner_in_code' AND p.account_tranche_id IS NOT NULL
               THEN 'tranche|' || p.account_deal_id || '|' || p.account_tranche_id
             WHEN p.file_scope = 'owner_in_code' THEN 'client|' || p.client_key
             WHEN p.attribution_client_key IS NOT NULL
               THEN 'client|' || p.attribution_client_key
             WHEN p.attribution_deal_id IS NOT NULL
               THEN 'tranche|' || p.attribution_deal_id || '|' || p.attribution_tranche_id
             ELSE ''
           END AS file_key
      FROM sdelka.v_posting p
  ) m
 GROUP BY entry_id, account_code, currency, file_key;

COMMENT ON VIEW sdelka.v_ledger_movement IS
  'Чистое движение записи по счёту, валюте и файлу. Дебет — плюс.';

-- ---------------------------------------------------------------------------
-- Исправление — зеркало цели
-- ---------------------------------------------------------------------------
--
-- Триггер **отложенный** по той же причине, что и триггер баланса: до
-- последней проводки исправление не является зеркалом ничего. Следствие
-- известно вызывающему: нарушение всплывает на `COMMIT`.
CREATE FUNCTION sdelka.assert_correction_mirrors_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry text := COALESCE(NEW.entry_id, OLD.entry_id);
  v_target text;
  v_bad record;
BEGIN
  SELECT e.corrects_entry_id INTO v_target
    FROM sdelka.ledger_entry e
   WHERE e.entry_id = v_entry;
  -- Записи не осталось вовсе либо это не исправление — проверять нечего.
  IF v_target IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT this.account_code,
         this.currency,
         this.file_key,
         this.minor AS moved,
         COALESCE(target.minor, 0) AS target_minor,
         CASE
           -- Счёт или файл, которого цель не трогала. Ровно этим и ломается
           -- выдача содержимого пула постороннему лицу.
           WHEN COALESCE(target.minor, 0) = 0 THEN 'account_not_in_target'
           -- Та же сторона, что и у цели: не отмена, а второе такое же
           -- движение под видом отмены.
           WHEN sign(this.minor) = sign(target.minor) THEN 'same_direction'
           -- Отмотано больше, чем цель двинула: цель отдаётся один раз.
           ELSE 'exceeds_target'
         END AS reason
    INTO v_bad
    FROM sdelka.v_ledger_movement this
    LEFT JOIN sdelka.v_ledger_movement target
      ON target.entry_id = v_target
     AND target.account_code = this.account_code
     AND target.currency = this.currency
     AND target.file_key = this.file_key
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(prior.minor), 0) AS minor
        FROM sdelka.v_ledger_movement prior
        JOIN sdelka.ledger_entry pe ON pe.entry_id = prior.entry_id
       WHERE pe.corrects_entry_id = v_target
         AND prior.entry_id <> v_entry
         AND prior.account_code = this.account_code
         AND prior.currency = this.currency
         AND prior.file_key = this.file_key
    ) unwound ON true
   WHERE this.entry_id = v_entry
     -- Ноль — не движение: счёт, дебетованный и тут же кредитованный в том же
     -- файле, ничего не двинул. Переезд между файлами нулём не выглядит
     -- никогда: файл входит в ключ.
     AND this.minor <> 0
     AND (
       COALESCE(target.minor, 0) = 0
       OR sign(this.minor) = sign(target.minor)
       OR abs(unwound.minor + this.minor) > abs(target.minor)
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger.journal.correction_not_mirror'
      USING ERRCODE = '23514',
            DETAIL = format(
              'entry_id=%s;corrects_entry_id=%s;account=%s;currency=%s;file=%s;reason=%s;moved=%s;target=%s',
              v_entry, v_target, v_bad.account_code, v_bad.currency, v_bad.file_key,
              v_bad.reason, v_bad.moved, v_bad.target_minor);
  END IF;
  RETURN NULL;
END
$$;

-- Два триггера, а не один: проводку можно дописать к уже лежащей записи
-- отдельной транзакцией (журнал только дополняется, но не запечатывается), и
-- проверка, стоящая лишь на вставке записи, такую дописку не увидела бы.
CREATE CONSTRAINT TRIGGER assert_correction_mirrors_target
  AFTER INSERT ON sdelka.ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_correction_mirrors_target();

CREATE CONSTRAINT TRIGGER assert_correction_mirrors_target
  AFTER INSERT ON sdelka.ledger_posting
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_correction_mirrors_target();

GRANT SELECT ON sdelka.v_ledger_movement TO sdelka_app;

-- ===== 0015_condition_usable_type.sql =====
-- 0015 — годный тип условия: ограничение догоняет `isUsableReleaseCondition`.
--
-- `0004_deal_tranche.sql` называет `condition_act_usable_type` «зеркалом
-- `isUsableReleaseCondition`», но зеркалит половину: SQL отвергал один
-- `registration_preliminary`, а доменная функция отвергает **два** значения —
-- она требует `!requiresConfirmation` И `sourceImplemented`
-- (`domain/src/release-condition.ts`), а у `calendar_date`
-- `sourceImplemented: false`. Проба на живой базе: акт с `calendar_date`
-- вставлялся, то есть транш законно открывал приём средств под условие, по
-- которому расчёт невозможен никогда — ни наблюдения `L3` от
-- `time.independent_timestamp` не производит ни одна строка кода, ни пяти полей
-- выписки у календарной даты не бывает вовсе.
--
-- Это ровно тот дрейф, ради которого правило и заведено: код отвергает, база
-- принимает и молчит. Деньги при этом уже лежат у нас.
--
-- **Форма списка — «годные», а не «негодные», и это решение.** Перечисление
-- запрещённых значений означает, что метка, дописанная в
-- `sdelka.release_condition_type` завтра, проходит по умолчанию. Здесь
-- умолчание обязано быть отказом: непроверенное условие — видимый отказ, а не
-- тихое разрешение (`STATE-MACHINES.md` §8). Список сверяется с
-- `RELEASE_CONDITION_TYPES.filter(isUsableReleaseCondition)` тестом дрейфа,
-- поэтому подтверждённый владельцем тип не останется забытым: тест упадёт в
-- тот же день.

SET LOCAL ROLE sdelka_owner;

ALTER TABLE sdelka.condition_act DROP CONSTRAINT condition_act_usable_type;

ALTER TABLE sdelka.condition_act ADD CONSTRAINT condition_act_usable_type CHECK (
  condition_type IN (
    'registration_transfer'
  )
);

COMMENT ON CONSTRAINT condition_act_usable_type ON sdelka.condition_act IS
  'Зеркало isUsableReleaseCondition: !requiresConfirmation AND sourceImplemented.';

-- ===== 0016_fee_accrual_once.sql =====
-- 0016 — начисление комиссии по траншу одно.
--
-- Идемпотентность начисления (§4.6, Ф16) жила только в коде
-- (`ledger/src/journal.ts`, `assertFeeAccruedOnce`) и держалась ровно тем, что
-- журнал собирают конструкторами TS. Роль приложения имеет право `INSERT` в
-- журнал, и запись может лечь мимо `appendEntry`. Проба на живой базе: две
-- записи «Дт fee:receivable / Кт fee:income» по одному траншу принимаются, а
-- `v_ledger_invariant_violation` при этом **пуст** — доход признан дважды, и не
-- видит этого никто. Сводка и не могла увидеть: `fee_not_withheld` ждёт
-- опустошённого транша, `fee_receivable_stale` — возраста, а «начислено
-- дважды» не выражается ни тем, ни другим.
--
-- Правило то же, буква в букву: начисление — это чистый **дебет** требования по
-- комиссии, отнесённый к траншу, за вычетом того, что запись-исправление вправе
-- вернуть по своей цели. Валюта в ключ не входит — как и в TS: комиссия по
-- траншу величина одна, и второе начисление «в другой валюте» не второй тариф,
-- а расхождение.
--
-- ⚠ Ограничение, названное честно, то же, что у зеркальности исправления
-- (`0014`): два начисления в **параллельных** транзакциях друг друга не видят.
-- Закрывается уровнем изоляции пишущей транзакции, а не ограничением.

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Требование по комиссии живёт только с отнесением к траншу
-- ---------------------------------------------------------------------------
--
-- Зеркало `assertFeeAccrualAttributed` (`ledger/src/entry.ts`). Без него
-- правило ниже обходится молча: начисление без отнесения не попадает ни в один
-- из трёх отчётов по комиссии — ни в `v_fee_receivable_open`, ни в проверку
-- идемпотентности, — потому что все они ключуются парой «сделка, транш».
-- Отнесение к файлу клиента запрещено тем же выражением: `attribution_deal_id`
-- и `attribution_client_key` взаимно исключены формой отнесения (`0002`).
ALTER TABLE sdelka.ledger_posting ADD CONSTRAINT ledger_posting_fee_attributed CHECK (
  account_kind <> 'fee_receivable' OR attribution_deal_id IS NOT NULL
);

-- ---------------------------------------------------------------------------
-- Чистое движение требования по комиссии по траншу
-- ---------------------------------------------------------------------------
--
-- Зеркало `feeReceivableNet`. Дебет — плюс. Признак структурный, а не по
-- объявлению начисления: объявления в базе нет вовсе, а начисление, собранное
-- низкоуровневой дверью, обязано попадать под правило наравне с собранным
-- словарём.
CREATE VIEW sdelka.v_fee_receivable_net AS
SELECT p.entry_id,
       p.entry_seq,
       p.attribution_deal_id AS deal_id,
       p.attribution_tranche_id AS tranche_id,
       sum(p.signed_minor) AS minor
  FROM sdelka.v_posting p
 WHERE p.account_kind = 'fee_receivable'
   AND p.attribution_deal_id IS NOT NULL
 GROUP BY 1, 2, 3, 4;

COMMENT ON VIEW sdelka.v_fee_receivable_net IS
  'Чистое движение fee:receivable по траншу в записи. Дебет — плюс, валюты сложены.';

-- ---------------------------------------------------------------------------
-- Сколько исправление вправе вернуть по своей цели
-- ---------------------------------------------------------------------------
--
-- Зеркало `feeRestorableBy`. Возврат — не начисление, и различает их только
-- цель: вернуть можно столько, сколько **эта самая цель** сняла, за вычетом
-- того, что по ней уже вернули прежние исправления. Отсюда свойство, из-за
-- которого послабление не разворачивается в дверь: чтобы получить право на
-- дебет требования, нужна лежащая в журнале запись, это требование
-- уменьшившая, и каждое уменьшение отдаётся один раз.
--
-- «Прежние» — это записи с меньшим `seq`, то есть ровно те, что в TS лежат в
-- журнале на момент вызова. Порядок записей в журнале — это `seq`, а не
-- `occurred_at` (`0002`).
CREATE VIEW sdelka.v_fee_restorable AS
SELECT e.entry_id,
       target.deal_id,
       target.tranche_id,
       (-target.minor) - returned.minor AS minor
  FROM sdelka.ledger_entry e
  JOIN sdelka.v_fee_receivable_net target ON target.entry_id = e.corrects_entry_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(prior.minor), 0) AS minor
      FROM sdelka.v_fee_receivable_net prior
      JOIN sdelka.ledger_entry pe ON pe.entry_id = prior.entry_id
     WHERE pe.corrects_entry_id = e.corrects_entry_id
       AND pe.seq < e.seq
       AND prior.deal_id = target.deal_id
       AND prior.tranche_id = target.tranche_id
       AND prior.minor > 0
  ) returned ON true
 WHERE e.corrects_entry_id IS NOT NULL
   -- Цель требование увеличила — возвращать по ней нечего.
   AND target.minor < 0;

COMMENT ON VIEW sdelka.v_fee_restorable IS
  'Предел возврата требования по комиссии для записи-исправления: сколько сняла её цель.';

-- ---------------------------------------------------------------------------
-- Транши, по которым запись начисляет
-- ---------------------------------------------------------------------------
--
-- Зеркало `feeAccrualTranches`: начислением считается только остаток дебета
-- сверх того, что исправление вправе вернуть по своей цели. Без этого вычета
-- законная операция — реверс расчёта целиком — оказывалась бы невыразимой.
CREATE VIEW sdelka.v_fee_accrual AS
SELECT net.entry_id,
       net.entry_seq,
       net.deal_id,
       net.tranche_id,
       net.minor
  FROM sdelka.v_fee_receivable_net net
  LEFT JOIN sdelka.v_fee_restorable restorable
    ON restorable.entry_id = net.entry_id
   AND restorable.deal_id = net.deal_id
   AND restorable.tranche_id = net.tranche_id
 WHERE net.minor > GREATEST(COALESCE(restorable.minor, 0), 0);

COMMENT ON VIEW sdelka.v_fee_accrual IS
  'Транши, по которым запись начисляет комиссию (а не возвращает снятое целью).';

-- ---------------------------------------------------------------------------
-- Одно начисление на транш
-- ---------------------------------------------------------------------------
--
-- Триггер **отложенный** по той же причине, что и триггер баланса: до
-- последней проводки запись не начисляет ничего. Следствие известно
-- вызывающему: нарушение всплывает на `COMMIT`.
--
-- Сравнение идёт с **любой** другой записью, а не только с более ранней, и
-- это не строгость ради строгости: проводку можно дописать к уже лежащей
-- записи отдельной транзакцией, и тогда «вторым» окажется начисление старой
-- записи. В сообщении названы обе — проверяемая (`entry_id`) и встречная
-- (`accrued_by`); какая из двух легла в журнал первой, видно по `seq`, и
-- порядок срабатывания отложенных триггеров на это не влияет.
CREATE FUNCTION sdelka.assert_fee_accrued_once() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry text := COALESCE(NEW.entry_id, OLD.entry_id);
  v_bad record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM sdelka.ledger_posting p
     WHERE p.entry_id = v_entry AND p.account_kind = 'fee_receivable'
  ) AND EXISTS (
    SELECT 1 FROM sdelka.ledger_posting p
     WHERE p.entry_id = v_entry
       AND p.account_kind = 'fee_income'
       AND p.attribution_deal_id IS NULL
  ) THEN
    -- Вторая половина `assertFeeAccrualAttributed`: доходная нога записи, в
    -- которой есть требование по комиссии, обязана назвать тот же файл. Иначе
    -- отчёт покажет «не удержано 500» при «начислено 0».
    RAISE EXCEPTION 'ledger.posting.fee_without_tranche_attribution'
      USING ERRCODE = '23514', DETAIL = format('entry_id=%s;account=fee:income', v_entry);
  END IF;

  SELECT this.deal_id, this.tranche_id, other.entry_id AS accrued_by
    INTO v_bad
    FROM sdelka.v_fee_accrual this
    JOIN sdelka.v_fee_accrual other
      ON other.deal_id = this.deal_id
     AND other.tranche_id = this.tranche_id
     AND other.entry_id <> this.entry_id
   WHERE this.entry_id = v_entry
   ORDER BY other.entry_seq
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger.journal.fee_accrued_twice'
      USING ERRCODE = '23514',
            DETAIL = format('entry_id=%s;accrued_by=%s;deal_id=%s;tranche_id=%s',
                            v_entry, v_bad.accrued_by, v_bad.deal_id, v_bad.tranche_id);
  END IF;
  RETURN NULL;
END
$$;

-- Два триггера, а не один, по тому же доводу, что в `0014`: запись и её
-- проводки приезжают порознь, и проверка, стоящая лишь на одной из двух
-- вставок, вторую не увидела бы.
CREATE CONSTRAINT TRIGGER assert_fee_accrued_once
  AFTER INSERT ON sdelka.ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_fee_accrued_once();

CREATE CONSTRAINT TRIGGER assert_fee_accrued_once
  AFTER INSERT ON sdelka.ledger_posting
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_fee_accrued_once();

GRANT SELECT ON sdelka.v_fee_receivable_net, sdelka.v_fee_restorable, sdelka.v_fee_accrual
  TO sdelka_app;

-- ===== 0017_conversion_key.sql =====
-- 0017 — ключ конверсии называет один обмен.
--
-- В коде правило есть (`ledger/src/journal.ts`,
-- `assertConversionKeyNotReused`), в базе не было ни одного соответствия.
-- Проба на живой базе: обмен пройден целиком (M1, M2, M3), позиция схлопнулась
-- — и вторая запись под тем же ключом принимается. Два обмена становятся
-- неразличимы в журнале навсегда: подлежащее `v_fx_position` — код счёта, а
-- ключ конверсии входит в код счёта, поэтому «сколько нам не поставили по
-- этому обмену» перестаёт быть величиной ровно так, как обещает не допускать
-- комментарий к представлению.
--
-- Что здесь зеркалится, а что нет, — названо прямо.
--
-- Зеркалится **структурная** часть правила, та, что читается по проводкам:
--
--  1. `position_already_closed` — схлопнувшийся ключ потрачен. Позиция стала
--     плоской, обмен закрыт, и новое движение под тем же ключом это уже другой
--     обмен. Ему нужен свой ключ.
--  2. `currency_pair` — за всю жизнь счёта обмена на нём бывает ровно пара
--     валют: M1 отдаёт исходную, M2 меняет одну на другую, M3 принимает
--     встречную. Третья валюта на счёте — другой обмен под тем же ключом.
--     Ловится именно **третья**: после M1 на счёте видна одна валюта, и какая
--     у обмена встречная, до M2 не знает никто, кроме объявления.
--  3. Счёт обмена в записи один (`assertConversionDeclared`, правило 2): запись,
--     трогающая две конверсии сразу, снова сложила бы их позиции в одну.
--
-- ⚠ **[открыто]** Не зеркалится `legs_exceed_opening` и перестановка ног той же
-- пары. Обе половины сверяются с **объявлением** обмена (`entry.converts`), а
-- объявления в базе нет вовсе: колонок под `converts`, `accrues` и `funds` у
-- `ledger_entry` не заведено. Чтобы правило зеркалилось целиком, объявление
-- нужно хранить — это отдельное решение о форме таблицы, и принимается оно не
-- заодно с починкой. До тех пор эта половина живёт только в TS, и здесь об
-- этом сказано, а не умолчано.

SET LOCAL ROLE sdelka_owner;

CREATE FUNCTION sdelka.assert_conversion_key_not_reused() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry text := COALESCE(NEW.entry_id, OLD.entry_id);
  v_seq bigint;
  v_account text;
  v_accounts integer;
BEGIN
  SELECT e.seq INTO v_seq FROM sdelka.ledger_entry e WHERE e.entry_id = v_entry;
  -- Записи не осталось вовсе — проверять нечего (откат).
  IF v_seq IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(DISTINCT p.account_code) INTO v_accounts
    FROM sdelka.v_posting p
   WHERE p.entry_id = v_entry AND p.conversion_id IS NOT NULL;
  IF v_accounts = 0 THEN
    RETURN NULL;
  END IF;
  IF v_accounts > 1 THEN
    -- Сверяется код счёта, а не ключ конверсии: с владельцем в коде один и тот
    -- же ключ у двух клиентов — это два разных счёта, и проверка по одному
    -- ключу пропустила бы запись, гасящую позицию клиента A ногой клиента B.
    RAISE EXCEPTION 'ledger.entry.conversion_undeclared'
      USING ERRCODE = '23514',
            DETAIL = format('entry_id=%s;reason=two_conversion_accounts', v_entry);
  END IF;

  SELECT DISTINCT p.account_code INTO v_account
    FROM sdelka.v_posting p
   WHERE p.entry_id = v_entry AND p.conversion_id IS NOT NULL;

  IF (SELECT count(DISTINCT p.currency) FROM sdelka.v_posting p
       WHERE p.account_code = v_account) > 2 THEN
    RAISE EXCEPTION 'ledger.journal.conversion_key_reused'
      USING ERRCODE = '23514',
            DETAIL = format('entry_id=%s;account=%s;reason=currency_pair', v_entry, v_account);
  END IF;

  -- «Прежние» — записи с меньшим `seq`: порядок журнала это `seq`, а не
  -- `occurred_at` (`0002`). Позиция читается **до** этой записи, как в TS, где
  -- проверяемой записи в журнале ещё нет.
  IF EXISTS (
    SELECT 1 FROM sdelka.v_posting p
     WHERE p.account_code = v_account AND p.entry_seq < v_seq
  ) AND NOT EXISTS (
    SELECT 1 FROM sdelka.v_posting p
     WHERE p.account_code = v_account AND p.entry_seq < v_seq
     GROUP BY p.currency
    HAVING sum(p.signed_minor) <> 0
  ) THEN
    RAISE EXCEPTION 'ledger.journal.conversion_key_reused'
      USING ERRCODE = '23514',
            DETAIL = format('entry_id=%s;account=%s;reason=position_already_closed',
                            v_entry, v_account);
  END IF;
  RETURN NULL;
END
$$;

-- Отложенный и в двух экземплярах — по тем же двум доводам, что в `0014`: до
-- последней проводки запись не является обменом, а проводку можно дописать к
-- уже лежащей записи отдельной транзакцией.
CREATE CONSTRAINT TRIGGER assert_conversion_key_not_reused
  AFTER INSERT ON sdelka.ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_conversion_key_not_reused();

CREATE CONSTRAINT TRIGGER assert_conversion_key_not_reused
  AFTER INSERT ON sdelka.ledger_posting
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_conversion_key_not_reused();

-- ===== 0018_payout_leg.sql =====
-- 0018 — нога перевода и ссылка на ответ провайдера.
--
-- Две правки, и обе про одно: строка `sdelka.payout` разошлась с `PayoutState`
-- (`domain/src/payout.ts`) в обе стороны сразу.
--
-- **Нога.** У домена их две, и это две разные операции с деньгами: `release` —
-- расчёт получателю, `refund` — возврат покупателю на счёт-источник (красная
-- линия №9). Ключ идемпотентности с их появлением стал функцией **транша и
-- ноги** (`payoutIdempotencyKey` / `refundIdempotencyKey`), а `0005` про это
-- ещё не знает и называет его функцией одного транша. В базе ноги не было
-- вовсе: две строки по одному траншу неразличимы, и «поручение на возврат»
-- читалось как «повтор расчёта».
--
-- Умолчания у колонки нет намеренно — по тому же доводу, по которому его нет у
-- конструктора в домене: нога выбирается тем, какое обязательство исполняется,
-- и молчаливого варианта у этого выбора быть не должно. Уже лежащие строки
-- заполняются `release` разово: возврат до этой миграции своей строки не имел.
--
-- **Ссылка на ответ.** `0005` обосновывает `payout_unknown_has_no_response`
-- так: «отказ — это явный ответ провайдера, поэтому у него обязана быть ссылка
-- на ответ; у `unknown` её быть не может». Обоснование верное, ограничение из
-- него не следовало, и следствие проверено на живой базе:
--
--   · `submitted` со ссылкой на ответ **принимался**, а `UPDATE` того же
--     поручения в `unknown` после этого падал. То есть законный и обязательный
--     переход §2.2 (сеть отвалилась — только «неизвестно») становился
--     незаписываемым, и записать его можно было, лишь стерев ссылку, то есть
--     потеряв след. Красная линия №8 говорит обратное: «неизвестно» — легальное
--     состояние;
--   · вторая половина обоснования («у отказа обязана быть ссылка») не
--     выполнима вовсе: `rejected` достигается и сверкой
--     (`reconciliation_absent_from_statement`), где ответа провайдера нет по
--     построению — есть выписка. Требовать ссылку у отказа значило бы сделать
--     незаписываемым путь восстановления из `unknown`.
--
-- Отсюда правило целиком: ссылка на ответ **возможна** только там, где ответ
-- уже получен, то есть в терминальных статусах, и не обязательна нигде.
-- Список — зеркало `TERMINAL_PAYOUT_STATUSES`, и его сверяет тест дрейфа.
--
-- ⚠ **[открыто]** Квитанция о приёме поручения (ответ провайдера на отправку, а
-- не на исполнение) в домене места не имеет: у `PayoutState` такого поля нет.
-- Появится — ей нужна своя колонка и своё правило, а не эта.

SET LOCAL ROLE sdelka_owner;

-- packages/domain: PAYOUT_LEGS
CREATE TYPE sdelka.payout_leg AS ENUM ('release', 'refund');

ALTER TABLE sdelka.payout ADD COLUMN leg sdelka.payout_leg;
UPDATE sdelka.payout SET leg = 'release' WHERE leg IS NULL;
ALTER TABLE sdelka.payout ALTER COLUMN leg SET NOT NULL;

COMMENT ON COLUMN sdelka.payout.leg IS
  'Какое обязательство исполняет перевод: расчёт получателю или возврат покупателю.';

-- Инвариант 9 ногу не различает, и это не упущение: домен считает активные
-- выплаты по траншу целиком (`activePayoutsForTranche`), потому что вторая нога
-- наружу по тем же запертым деньгам — это двойная выплата независимо от того,
-- как называется каждая. Частичный индекс `payout_one_active_per_tranche`
-- остаётся по паре «сделка, транш».

ALTER TABLE sdelka.payout DROP CONSTRAINT payout_unknown_has_no_response;

ALTER TABLE sdelka.payout ADD CONSTRAINT payout_response_only_when_answered CHECK (
  provider_reference IS NULL OR status IN (
    'settled',
    'rejected'
  )
);

COMMENT ON CONSTRAINT payout_response_only_when_answered ON sdelka.payout IS
  'Ссылка на ответ провайдера возможна только в терминальных статусах и не обязательна нигде.';

-- ===== 0019_ledger_truncate.sql =====
-- 0019 — журнал не опустошается: append-only ловит и `TRUNCATE`.
--
-- `0002` ставит два контура: гранты (роль приложения не получает
-- `UPDATE`/`DELETE`) и триггер `forbid_ledger_mutation`, объявленный как
-- ловящий «и владельца, который грантом не ограничен». Второй контур этого не
-- делал: построчный триггер в PostgreSQL на `TRUNCATE` **не срабатывает** —
-- `TRUNCATE` вызывает только операторные триггеры (`FOR EACH STATEMENT`), а их
-- в схеме не было ни одного.
--
-- Следствие шире, чем «строки исчезли». `TRUNCATE` — единственный путь записи,
-- обходящий **все** отложенные проверки журнала разом: опустошить
-- `ledger_posting`, оставив `ledger_entry`, значит получить записи без
-- проводок, ни одна из которых не пройдёт через `assert_entry_balanced`, — он
-- вешается на вставку и на изменение строк, а `TRUNCATE` не является ни тем,
-- ни другим.
--
-- Функция та же (`sdelka.forbid_ledger_mutation`): ключ ошибки у нарушения
-- один, и `TG_OP` в подробностях назовёт `TRUNCATE`.
--
-- ⚠ Тот же пробел есть у `sdelka.audit_record` (`0007`), и он **не** закрыт
-- здесь намеренно: журнал аудита — предмет отдельной находки, и чинить его
-- заодно значило бы разложить одно правило по двум местам.

SET LOCAL ROLE sdelka_owner;

CREATE TRIGGER forbid_ledger_entry_truncate
  BEFORE TRUNCATE ON sdelka.ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION sdelka.forbid_ledger_mutation();

CREATE TRIGGER forbid_ledger_posting_truncate
  BEFORE TRUNCATE ON sdelka.ledger_posting
  FOR EACH STATEMENT EXECUTE FUNCTION sdelka.forbid_ledger_mutation();

-- ===== 0020_audit_append_only.sql =====
-- 0020 — журнал аудита снова **дописывается**, и по-прежнему только дописывается.
--
-- Находка первого прогона хранилища под настоящей ролью приложения
-- (`test/int/store-grants.int.test.ts`, тест-надгробие): роль приложения не
-- могла дописать в журнал аудита ни одной записи.
--
-- Причина не в грантах — они верны и остаются нетронутыми. `0007` прямо
-- разрешает дописывание (`GRANT SELECT, INSERT ON sdelka.audit_record TO
-- sdelka_app`) и прямо отбирает изменение (`REVOKE UPDATE, DELETE, TRUNCATE`),
-- то есть выражает инвариант 21 (`CLAUDE.md`, «Инварианты, проверяемые базой»;
-- `CORE.md` Ф11) буква в букву. Причина в триггере вставки:
--
-- - `sdelka.assert_audit_chain()` объявлена `SECURITY INVOKER` (умолчание), то
--   есть исполняется от имени вызывающего;
-- - внутри она берёт `SELECT … FROM sdelka.audit_record … FOR UPDATE`, и берёт
--   правильно: без блокировки две параллельные вставки прочитали бы одну и ту
--   же «последнюю» запись и обе получили бы `seq = n+1`;
-- - `FOR UPDATE` требует права `UPDATE` на таблицу — блокировка строки в
--   PostgreSQL проверяется правом изменения, а не правом чтения.
--
-- Итог: `INSERT` разрешён грантом и невозможен на практике, `42501`
-- insufficient_privilege. Красная линия №11 выполнялась предельно строго —
-- журнал было не дописать вовсе.
--
-- ---------------------------------------------------------------------------
-- Чем это чинится и чем — нет
-- ---------------------------------------------------------------------------
--
-- **Права роли приложения не трогаются ни на джоуль.** Выдать `sdelka_app`
-- право `UPDATE` ради блокировки значило бы отменить инвариант 21 ради
-- удобства: право «изменить строку журнала аудита» и «взять на ней
-- блокировку» — одно и то же право, и второй контур (триггер
-- `forbid_audit_mutation`) прикрывал бы то, что первый обязан делать сам.
--
-- Вместо этого блокировку берёт **владелец схемы**: `SECURITY DEFINER`
-- переводит исполнение тела функции на её владельца (`sdelka_owner`), у
-- которого право на таблицу есть по владению. Роль приложения при этом
-- по-прежнему не может ни `UPDATE`, ни `DELETE`, ни `TRUNCATE` — это
-- проверяется и грантами в `information_schema`, и живыми попытками
-- (`store-grants.int.test.ts`).
--
-- `SET search_path` — обязательная гигиена функции с `SECURITY DEFINER`:
-- без неё вызывающий подставляет свой `search_path`, и неквалифицированное имя
-- в теле разрешается в его схему. Тело `assert_audit_chain` квалифицировано
-- целиком (`sdelka.audit_record`), остальное — `pg_catalog`, поэтому пути
-- ровно два элемента и `sdelka` среди них нет: имя таблицы обязано оставаться
-- явным, а не подбираться поиском.
--
-- `REVOKE ALL … FROM PUBLIC` стоит явно, по тому же доводу, что и `REVOKE` в
-- `0007`: подразумеваемое отсутствие права не читается глазами при ревью.
-- Функцию это не ломает — исполнение триггерной функции права `EXECUTE` у
-- вызывающего не требует (проверено на живой базе: вставка под `sdelka_app`
-- проходит), а вызвать её напрямую нельзя вовсе, `RETURNS trigger`.
--
-- Тело функции здесь **не переписывается**. `ALTER FUNCTION` меняет только
-- свойство: вторая копия тела рядом с первой разошлась бы с ней при первой же
-- правке, и читающий не знал бы, какая из двух стоит на проде.

SET LOCAL ROLE sdelka_owner;

ALTER FUNCTION sdelka.assert_audit_chain()
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp;

REVOKE ALL ON FUNCTION sdelka.assert_audit_chain() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Второй контур: журнал аудита не опустошается
-- ---------------------------------------------------------------------------
--
-- `0019` закрыл ту же дыру у журнала учёта и назвал её у журнала аудита,
-- оставив «предметом отдельной находки», чтобы не раскладывать одно правило по
-- двум местам. Место нашлось: это оно.
--
-- Построчный триггер на `TRUNCATE` не срабатывает — `TRUNCATE` вызывает только
-- операторные триггеры, — поэтому `forbid_audit_mutation` ловил изменение и
-- удаление, но не опустошение. Грант у роли приложения на `TRUNCATE` отобран
-- (`0007`), так что первый контур держит; второй контур ловит и владельца,
-- которого гранты не ограничивают, — ради этого он и написан.
--
-- Функция та же: ключ ошибки у нарушения один, а `TG_OP` в подробностях
-- назовёт `TRUNCATE`.

CREATE TRIGGER forbid_audit_truncate
  BEFORE TRUNCATE ON sdelka.audit_record
  FOR EACH STATEMENT EXECUTE FUNCTION sdelka.forbid_audit_mutation();

-- ===== 0021_entry_declarations.sql =====
-- 0021 — три недостающих объявления записи журнала и потолок удержания расчёта.
--
-- `sdelka.ledger_entry` держала одно объявление из четырёх. `JournalEntry`
-- (`ledger/src/entry.ts`) несёт `settles`, `converts`, `accrues` и `funds`, и
-- колонок было только под `settles`, да и у того не хранился потолок удержания.
-- Хранилище такую запись **отвергало** (`db.entry.declaration_not_storable`), а
-- не писало с потерей, и отвергало верно: молча потерянная ссылка на признание
-- позволила бы довносить одно признание сколько угодно раз, потерянная версия
-- тарифного плана — пересчитать комиссию задним числом (§4.2), потерянные три
-- курса — не восстановить курс из двух сумм (усечение необратимо, И14.2).
--
-- Следствием расчёт получателю и начисление комиссии в базу не ложились вовсе:
-- расчёт идёт двумя записями, вторая из которых — начисление с версией плана.
-- То есть боевой путь денег заканчивался на возврате.
--
-- ---------------------------------------------------------------------------
-- Что здесь решено и почему именно так
-- ---------------------------------------------------------------------------
--
-- **Объявление — хранимый факт о прошлом.** Задним числом оно не переписывается
-- по той же причине, по которой не переписывается вся запись: `ledger_entry`
-- только дополняется — гранты роли приложения без `UPDATE`/`DELETE` (`0002`),
-- триггеры `forbid_ledger_*_mutation` (`0002`) и `forbid_ledger_*_truncate`
-- (`0019`). Новые колонки живут внутри той же строки и наследуют это целиком;
-- отдельного контура им не нужно, и заводить его значило бы завести второе
-- место, где правило можно ослабить.
--
-- **Курсы — числителем и знаменателем, целыми.** Красная линия №4 говорит о
-- суммах, но курс — это то, из чего сумма считается: `2,6686875` в double уже
-- не равен себе после трёх операций, а из него получается число, которое видит
-- клиент. В TS курс — `Rational` из двух `bigint` (`money/src/rational.ts`),
-- здесь — две колонки `numeric(38, 0)`. Ни одного `numeric` с дробной частью в
-- схеме нет, и это проверяется тестом (`test/no-float.test.ts`).
--
-- Сокращённость дроби не проверяется намеренно: `rational()` сокращает при
-- чтении, поэтому `5/10` и `1/2` дают одно и то же значение. Ограничение
-- «храните сокращённой» ловило бы форму записи, а не величину.
--
-- **Дата курса — `text` с формой `YYYY-MM-DD`, а не `date`.** `IsoDate`
-- (`money/src/fx.ts`) — это строка ровно такой формы; тип `date` драйвер
-- отдаёт `Date`, то есть моментом времени в часовом поясе процесса, и круг
-- «запись → база → запись» ломался бы на сутки в зависимости от `TZ`. Форма
-- колонки — буквальное зеркало `ISO_DATE_PATTERN`, включая то, что `2026-13-45`
-- она пропускает: расходиться с кодом строгостью — это тот же дрейф, только в
-- другую сторону.
--
-- **Пара валют курса отдельными колонками не хранится.** `FxRates` несёт
-- `base`/`quote`, и каждый из трёх `FxRate` — тоже, но все они выводятся из
-- сумм: `fxExecution` пропускает объявление только через
-- `convertAtRate(source, rates.client, 'trunc')`, а тот отказывает, если
-- `source.currency <> rate.base` (`assertRateApplies`), и сверяет, что
-- полученная валюта равна валюте `target`. Значит `base = валюта исходной
-- суммы`, `quote = валюта встречной`, и вторая копия этих кодов была бы вторым
-- источником истины. Так же, как `account_code` в `ledger_posting` не хранится
-- заполняемым приложением.
--
-- **Чего база не проверяет.** Она не пересчитывает встречную сумму по
-- клиентскому курсу и не сверяет объявления с проводками. Это ровно тот дрейф
-- двух моделей, из-за которого `0007` не пересчитывает `record_hash`: пересчёт
-- потребовал бы второй реализации `convertAtRate` на PL/pgSQL вместе с числом
-- знаков валюты, а сверка объявления с проводками — второй реализации
-- `assertConversionDeclared`, `assertFeeAccrualDeclared` и
-- `assertShortfallFundingDeclared`. Обе живут в `createJournalEntry`, через
-- который проходит **и запись, и чтение** (`store/journal.ts`, `entryOfRows`):
-- строка, из которой запись не собирается, поднимает `LedgerError` на чтении, а
-- не расходится молча в отчётности через месяц.
--
-- База держит здесь то, что умеет держать одна: форму (объявление целиком или
-- никак), алфавит идентификаторов, положительность сумм и курсов, ссылочную
-- целостность признания и то, что одно признание довносится один раз.
--
-- ⚠ **Заполнения прошлых строк здесь нет, и это решение.** Потолок удержания у
-- уже лежащих расчётов был бы известен — до этой миграции хранилище принимало
-- расчёт только с жёстким пределом учёта, — но заполнение потребовало бы
-- `UPDATE` по `ledger_entry`, то есть снятия append-only с журнала учёта на
-- время миграции. Такой прецедент дороже удобства. На пустой таблице (а она
-- пуста везде, где эти миграции применены: до порта хранилища в `ledger_entry`
-- не писал никто) ограничение ниже применяется без единой правки строк; на
-- непустой оно **остановит миграцию по имени**, и что делать с историей —
-- решает владелец, а не мы. Помечено **[открыто]**.

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Колонки
-- ---------------------------------------------------------------------------

ALTER TABLE sdelka.ledger_entry
  -- `TrancheSettlement.ceiling` (`ledger/src/fee-ceiling.ts`): предельная доля
  -- суммы к распределению, которую платформа вправе оставить себе. Едет в
  -- объявлении, а не в настройке, потому что политика принадлежит решению,
  -- принятому в момент расчёта (`CORE.md` Ф11).
  ADD COLUMN settles_ceiling_numerator numeric(38, 0),
  ADD COLUMN settles_ceiling_denominator numeric(38, 0),

  -- `FxExecution` (`ledger/src/entry.ts`) плюс `ConvertedAmount`
  -- (`money/src/fx.ts`): ключ обмена, обе ноги и три курса с датой.
  ADD COLUMN converts_conversion_id text,
  ADD COLUMN converts_source_currency text REFERENCES sdelka.currency (code),
  ADD COLUMN converts_source_amount_minor numeric(38, 0),
  ADD COLUMN converts_target_currency text REFERENCES sdelka.currency (code),
  ADD COLUMN converts_target_amount_minor numeric(38, 0),
  ADD COLUMN converts_client_rate_numerator numeric(38, 0),
  ADD COLUMN converts_client_rate_denominator numeric(38, 0),
  ADD COLUMN converts_reference_rate_numerator numeric(38, 0),
  ADD COLUMN converts_reference_rate_denominator numeric(38, 0),
  ADD COLUMN converts_official_rate_numerator numeric(38, 0),
  ADD COLUMN converts_official_rate_denominator numeric(38, 0),
  ADD COLUMN converts_as_of text,

  -- `FeeAccrualDeclaration`: по какой сделке, сколько и по какой версии
  -- тарифного плана. Версия обязательна: журнал переживает сделку и читается
  -- отдельно от неё, а §4.2 запрещает пересчёт задним числом.
  ADD COLUMN accrues_deal_id text,
  ADD COLUMN accrues_tranche_id text,
  ADD COLUMN accrues_fee_currency text REFERENCES sdelka.currency (code),
  ADD COLUMN accrues_fee_amount_minor numeric(38, 0),
  ADD COLUMN accrues_tariff_version_id text,

  -- `ShortfallFunding`: какое именно признание закрывает это довнесение.
  -- Ссылка внешним ключом на ту же таблицу — как у `corrects_entry_id`:
  -- ссылка на запись, которой в журнале нет, ссылкой не является.
  ADD COLUMN funds_recognised_entry_id text REFERENCES sdelka.ledger_entry (entry_id),
  ADD COLUMN funds_owner text,
  ADD COLUMN funds_amount_currency text REFERENCES sdelka.currency (code),
  ADD COLUMN funds_amount_minor numeric(38, 0);

COMMENT ON COLUMN sdelka.ledger_entry.settles_ceiling_numerator IS
  'Числитель предельной доли удержания, действовавшей для этого расчёта.';

COMMENT ON COLUMN sdelka.ledger_entry.accrues_tariff_version_id IS
  'Версия тарифного плана, по которой начислена комиссия. Пересчёт задним числом невозможен.';

COMMENT ON COLUMN sdelka.ledger_entry.funds_recognised_entry_id IS
  'Признание недостачи, которое закрывает это довнесение. Одно признание довносится один раз.';

-- ---------------------------------------------------------------------------
-- Форма: объявление целиком или никак
-- ---------------------------------------------------------------------------
--
-- Тот же довод, что у `ledger_entry_settles_whole` в `0002`: в TS это одно
-- значение, и половина объявления не является объявлением. Потолок привязан к
-- наличию расчёта, а не к самому себе: расчёт без потолка — это расчёт, которому
-- разрешено неизвестно сколько.

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_settles_ceiling_whole CHECK (
  num_nonnulls(settles_ceiling_numerator, settles_ceiling_denominator)
    = CASE WHEN settles_deal_id IS NULL THEN 0 ELSE 2 END
);

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_whole CHECK (
  num_nonnulls(
    converts_conversion_id,
    converts_source_currency, converts_source_amount_minor,
    converts_target_currency, converts_target_amount_minor,
    converts_client_rate_numerator, converts_client_rate_denominator,
    converts_reference_rate_numerator, converts_reference_rate_denominator,
    converts_official_rate_numerator, converts_official_rate_denominator,
    converts_as_of
  ) IN (0, 12)
);

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_accrues_whole CHECK (
  num_nonnulls(
    accrues_deal_id, accrues_tranche_id,
    accrues_fee_currency, accrues_fee_amount_minor,
    accrues_tariff_version_id
  ) IN (0, 5)
);

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_funds_whole CHECK (
  num_nonnulls(
    funds_recognised_entry_id, funds_owner,
    funds_amount_currency, funds_amount_minor
  ) IN (0, 4)
);

-- ---------------------------------------------------------------------------
-- Величины
-- ---------------------------------------------------------------------------

-- Зеркало `feeCeiling()`: доля не бывает отрицательной и не бывает больше
-- единицы — удержать больше суммы нельзя ни при какой ставке.
--
-- ⚠ Жёсткий предел учёта (`DEFAULT_FEE_CEILING`, сегодня два процента) здесь
-- **не** дублируется: само значение помечено `[открыто]` владельцу, и вторая
-- его копия в SQL разошлась бы с первой в день, когда владелец назначит своё.
-- Сужение до жёсткого предела делает `trancheSettlement` на чтении, а
-- расхождение прочитанного с записанным ловит `db.entry.ceiling_mismatch`.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_settles_ceiling_share CHECK (
  settles_ceiling_numerator IS NULL
  OR (settles_ceiling_numerator >= 0
      AND settles_ceiling_denominator > 0
      AND settles_ceiling_numerator <= settles_ceiling_denominator)
);

-- Зеркало `fxExecution`: обе ноги строго положительны. Ноль на ноге — это не
-- обмен, а запись, у которой одна сторона исчезла.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_positive CHECK (
  converts_source_amount_minor IS NULL
  OR (converts_source_amount_minor > 0 AND converts_target_amount_minor > 0)
);

-- Зеркало `fxRate()`: ноль и отрицательный курс — не курс. Ноль обнуляет чужие
-- деньги, знак выворачивает направление, и обе величины проходят всю арифметику
-- молча. Знаменатель положителен, потому что `rational()` нормализует знак в
-- числитель.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_rates_positive CHECK (
  converts_client_rate_numerator IS NULL
  OR (converts_client_rate_numerator > 0 AND converts_client_rate_denominator > 0
      AND converts_reference_rate_numerator > 0 AND converts_reference_rate_denominator > 0
      AND converts_official_rate_numerator > 0 AND converts_official_rate_denominator > 0)
);

-- Зеркало `fxRate()`: пара валют курса — это две **разные** валюты.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_pair_distinct CHECK (
  converts_source_currency IS NULL OR converts_source_currency <> converts_target_currency
);

-- Зеркало `ISO_DATE_PATTERN` (`money/src/fx.ts`): курс без даты не является
-- курсом, а дата без формы не является датой.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_as_of_form CHECK (
  converts_as_of IS NULL OR converts_as_of ~ '^\d{4}-\d{2}-\d{2}$'
);

-- Зеркало `accrueFee`: нулевая комиссия — это отсутствие комиссии, а не
-- проводка на ноль. Знак несёт вид записи (исправление двигает доход обратно),
-- а не сумма объявления.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_accrues_positive CHECK (
  accrues_fee_amount_minor IS NULL OR accrues_fee_amount_minor > 0
);

-- Зеркало `absorbShortfall`: недостача без недостачи — обычное зачисление.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_funds_positive CHECK (
  funds_amount_minor IS NULL OR funds_amount_minor > 0
);

-- Зеркало `assertShortfallFundingDeclared`: исправление довнесения — обратная
-- проводка со ссылкой на исправляемую запись, а не второе довнесение по тому же
-- признанию. Объявление на исправлении означало бы, что признание закрыто ещё
-- раз.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_funds_settlement_only CHECK (
  funds_recognised_entry_id IS NULL OR kind = 'settlement'
);

-- Довнесение по самому себе — не ссылка на признание, а её отсутствие.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_funds_not_self CHECK (
  funds_recognised_entry_id <> entry_id
);

-- ---------------------------------------------------------------------------
-- Алфавит идентификаторов
-- ---------------------------------------------------------------------------
--
-- Зеркало `assertAccountIdentifier` и `CLIENT_KEY_PATTERN` (`ledger/src/accounts.ts`),
-- как у `ledger_entry_settles_alphabet` в `0002`: двоеточие разделяет сегменты
-- кода счёта, вертикальная черта — ключи файла источника средств. Идентификатор
-- с любым из них делает два разных счёта неотличимыми в сверке.

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_alphabet CHECK (
  converts_conversion_id IS NULL OR converts_conversion_id ~ '^[^:|]+$'
);

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_accrues_alphabet CHECK (
  (accrues_deal_id IS NULL OR accrues_deal_id ~ '^[^:|]+$')
  AND (accrues_tranche_id IS NULL OR accrues_tranche_id ~ '^[^:|]+$')
  AND (accrues_tariff_version_id IS NULL OR accrues_tariff_version_id ~ '^[^:|]+$')
);

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_funds_owner_alphabet CHECK (
  funds_owner IS NULL OR funds_owner ~ '^[A-Za-z0-9._-]{1,128}$'
);

-- ---------------------------------------------------------------------------
-- Одно признание довносится один раз
-- ---------------------------------------------------------------------------
--
-- Зеркало `assertShortfallFundingResolves` (`ledger/src/journal.ts`), и это тот
-- самый повод, ради которого ссылка вообще заведена: пока её не было, «доложить
-- по одному признанию дважды» ловил только инвариант `shortfall_overfunded` и
-- только постфактум, сложением по клиенту за всю историю.
--
-- Частичный уникальный индекс, а не триггер: правило выражается ключом, а
-- ключевые правила в этой схеме держит индекс (`payout_one_active_per_tranche`,
-- инвариант 9). В отличие от сложения постфактум он работает и на записи,
-- пришедшей мимо `appendEntry`.
CREATE UNIQUE INDEX ledger_entry_shortfall_funded_once
  ON sdelka.ledger_entry (funds_recognised_entry_id)
  WHERE funds_recognised_entry_id IS NOT NULL;

COMMENT ON INDEX sdelka.ledger_entry_shortfall_funded_once IS
  'Одно признание недостачи закрывается ровно одним довнесением.';

-- ===== 0022_withdrawal_deadline.sql =====
-- ---------------------------------------------------------------------------
-- 0022. Часы заявки на вывод: срок операции и возраст состояния
-- ---------------------------------------------------------------------------
--
-- Что чинится. У транша «нетерминальное состояние без дедлайна» невозможно и в
-- типах (`TrancheState`), и в базе (`tranche_state_shape`): это инвариант 7 и
-- строка в `CLAUDE.md`. У заявки на вывод не было ни того, ни другого — заявка
-- могла стоять сколько угодно, и никто об этом не узнавал
-- (`DECISIONS-REVIEW.md` §H4). Машину починил домен
-- (`domain/src/client-account.ts`: дедлайн внутри нетерминального варианта
-- союза), здесь то же правило встаёт проверкой базы, а не дисциплиной кода.
--
-- Две отметки времени, и смешивать их нельзя (`STATE-MACHINES.md` §5), — ровно
-- как у транша в `0004`:
--
--   * `deadline_at` — срок операции. **Двигается**: повторный ответ банка
--     «неизвестно» пересчитывает его.
--   * `entered_at` — момент входа в состояние. **Не двигается** внутренним
--     самопереходом, и по нему считается возраст и норматив простоя. Считай
--     возраст по дедлайну — застрявшая в «неизвестно» заявка выглядела бы вечно
--     свежей и в очередь разбора не попадала бы никогда.
--
-- Колонки добавляются обнуляемыми, а ограничение — сразу проверяющим. Если в
-- таблице лежит нетерминальная заявка без часов, миграция **упадёт**, и это
-- намеренно: такая строка и есть та самая заявка, о которой никто не узнает, и
-- молча дописать ей выдуманный срок значило бы назначить норматив за владельца.
SET LOCAL ROLE sdelka_owner;

ALTER TABLE sdelka.withdrawal
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN entered_at timestamptz;

-- Зеркало двух вариантов союза `WithdrawalState`:
--
--   1. Терминальный (`paid_out|cancelled`) — часов нет вовсе: у закрытой заявки
--      ни срока, ни возраста, её не эскалируют.
--   2. Остальные (`requested|approved|paying_out|blocked`) — есть и срок, и
--      возраст. Это и есть «нетерминальная заявка без дедлайна невыразима»,
--      сказанное базой.
--
-- Перечень терминальных статусов повторён здесь строками, а не выведен: SQL
-- перечня из TS не видит. Расхождение ловит тест дрейфа (`enums.test.ts`), тем
-- же способом, каким он ловит расхождение частичного индекса.
ALTER TABLE sdelka.withdrawal
  ADD CONSTRAINT withdrawal_state_shape CHECK (
    CASE
      WHEN status IN ('paid_out', 'cancelled') THEN
        deadline_at IS NULL AND entered_at IS NULL
      ELSE
        deadline_at IS NOT NULL AND entered_at IS NOT NULL
    END
  );

-- Срок операции: список «у кого срок вышел» обязан быть дешёвым.
CREATE INDEX withdrawal_deadline ON sdelka.withdrawal (deadline_at)
  WHERE deadline_at IS NOT NULL;

-- Возраст: по нему идёт эскалация в очередь разбора (`withdrawal_stalled`,
-- `compliance/src/queue.ts`). Индекс по `entered_at`, а не по `deadline_at`, —
-- это тот же выбор, что и в самом правиле: дежурного поднимает возраст, а не
-- срок, который двигается ответом банка.
CREATE INDEX withdrawal_stalled ON sdelka.withdrawal (entered_at)
  WHERE status IN ('requested', 'approved', 'paying_out', 'blocked');

-- ===== 0023_audit_role_split.sql =====
-- 0023 — семь меток роли журнала: пять непредставленных ролей и два уровня
-- утверждения вместо одного `approver`.
--
-- Перечень `sdelka.audit_role` был восьмизначным против четырнадцати ролей
-- доступа (`packages/auth`, `ROLE_IDS` плюс два нечеловеческих актора). Пять
-- ролей — `oracle_operator`, `compliance_officer`, `principal`, `auditor`,
-- `client_counsel` — не отображались в него **никуда**: действие такой роли
-- записать было нечем, а актор записи обязателен. Практическое следствие было
-- не крайним случаем, а обычным путём: полномочие `manage_settings` есть ровно
-- у `principal`, то есть изменение настройки владельцем не записывалось вовсе
-- (`BACKLOG.md` E16-12, `DECISIONS-REVIEW.md` §K5).
--
-- `approver` при этом покрывал **оба** уровня утверждения. `ACTORS.md` §1
-- расхождение №5 относит это к дефектам, а §5.2 — **[решение]** владельца:
-- `financial_controller` даёт уровень 1, `head_of_operations` — уровень 2, ни
-- одна роль не даёт оба. Запись «утвердил approver» не отвечает на вопрос, кто
-- утвердил, — то есть «четыре глаза» по журналу не доказываются ровно там, ради
-- чего журнал и ведётся.
--
-- ## Дописывание, а не переименование
--
-- Красная линия №11: журнал не редактируется. `ALTER TYPE ... RENAME VALUE`
-- сменил бы прочтение уже записанных строк — прежняя запись начала бы читаться
-- ролью, которой в ней не было; какой из двух уровней за ней стоял, не знает
-- никто. Поэтому `approver` **остаётся** в перечне: под ним читают прежние
-- записи и не делают новых (`RETIRED_AUDIT_ROLES`, `packages/audit`).
--
-- Метки дописываются **в конец** — `ALTER TYPE ... ADD VALUE` иначе не умеет, а
-- порядок обязан совпасть с массивом `AUDIT_ROLES` в TS: порядок меток виден в
-- `ORDER BY`, и разошедшаяся сортировка отчёта дежурному ничем себя не выдаёт.
-- Та же оговорка стоит у `application_card` в `0009` и у видов записей в `0011`.
--
-- Внутри транзакции это допустимо начиная с Postgres 12; новые метки в той же
-- транзакции не используются, поэтому «unsafe use of new value» не возникает.
--
-- ## Чего здесь нет
--
-- 1. **Ни одного `GRANT` и `REVOKE`.** Права роли приложения на журнал аудита
--    правка перечня не трогает: инвариант 21 стоит на грантах `0007` и `0013`,
--    и `sdelka_app` как не мог изменить и удалить запись, так и не может
--    (`test/int/store-grants.int.test.ts` проверяет это живой попыткой).
-- 2. **Ни одного `UPDATE`.** Строки `sdelka.audit_record` не читаются и не
--    трогаются: миграция расширяет тип, а не переписывает записанное.
-- 3. **Переименований `client → party` и `oracle → oracle_source`.** Обе метки
--    соответствие имеют, речь только об имени, и цена переименования — то же
--    переписывание прочтения прежних записей. Развилка вынесена владельцу
--    (`DECISIONS-REVIEW.md` §O1).

SET LOCAL ROLE sdelka_owner;

-- packages/audit: AUDIT_ROLES (порядком `ROLE_IDS` из `packages/auth`)
ALTER TYPE sdelka.audit_role ADD VALUE 'oracle_operator';
ALTER TYPE sdelka.audit_role ADD VALUE 'compliance_officer';
ALTER TYPE sdelka.audit_role ADD VALUE 'financial_controller';
ALTER TYPE sdelka.audit_role ADD VALUE 'head_of_operations';
ALTER TYPE sdelka.audit_role ADD VALUE 'principal';
ALTER TYPE sdelka.audit_role ADD VALUE 'auditor';
ALTER TYPE sdelka.audit_role ADD VALUE 'client_counsel';

-- ===== 0024_identity_challenge.sql =====
-- 0024 — доказательство личности: вызов, срок, попытки, однократность.
--
-- До этой миграции войти в систему было нечем. `establishSession`
-- (`auth/src/session.ts`) принимает личность **уже доказанной**, а произвести
-- доказательство было некому: ни выдачи одноразового кода, ни его проверки, ни
-- места, где живут срок и счётчик попыток. Сессия при этом существовала только
-- в памяти процесса — таблица `sdelka.auth_session` (`0010`) стояла пустой,
-- потому что адаптера `SessionStorePort` не было ни одного.
--
-- Здесь заводится недостающая половина — **вызов**, на который отвечают кодом.
--
-- ## Кода здесь нет, и это не оговорка, а условие
--
-- Ни открытым, ни хешированным. `test/auth-reference.test.ts` («секретов в
-- схеме нет места») запрещает колонку под материал прямо, и запрет обоснован:
-- отпечаток шестизначного кода перебирается за миллисекунды, то есть «хранить
-- хеш» здесь не защита, а её видимость.
--
-- Код поэтому **выводится** из вызова ключом, живущим только в окружении
-- процесса (`auth/src/code.ts`, `HMAC-SHA256` с усечением HOTP; красная линия
-- №12). В базе остаются идентификатор вызова, учётная запись, срок, счётчик
-- попыток и момент принятия — по ним код не восстанавливается ничем.
--
-- ## Три правила пакета, которые здесь становятся правилами базы
--
-- 1. **Вызов без срока невозможен.** `expiresAt` не опционален в
--    `IdentityChallenge`, `expires_at` здесь `NOT NULL` и строго позже выдачи;
--    сверх того срок ограничен сверху — «десять минут» превращается в «год»
--    одной опечаткой вызывающего, и такой вызов уже не одноразовый код, а
--    пароль.
-- 2. **Счётчик попыток идёт только вперёд.** Иначе ограничение подбора
--    снимается обновлением строки: попытки обнулены, окно то же.
-- 3. **Принятый код второй раз не принимается.** После `consumed_at` строка не
--    меняется вовсе — ни попытками, ни снятием отметки.
--
-- ## Чего здесь нет
--
-- **Канала доставки.** Ни адреса, ни телефона, ни имени: адрес знает адаптер
-- канала, а не решение (`auth/src/delivery.ts`), и в схему он не попадает —
-- `test/pii.test.ts` этого и не пустил бы. Что доставка **состоялась**,
-- записано отдельным моментом; чем именно и куда — здесь не хранится.
--
-- **Ограничения частоты выдачи.** Подбор кода закрыт счётчиком попыток; поток
-- запросов «пришлите код» ограничивается на транспорте и относится к отказу в
-- обслуживании, а не к аутентификации. Развилка вынесена в
-- `DECISIONS-REVIEW.md` §Z2 **[открыто]**, а не решена молча колонкой.

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Ключи причин отказа во входе
-- ---------------------------------------------------------------------------
--
-- Зеркало `AUTH_REASON_KEYS` (`auth/src/keys.ts`), сверяется
-- `test/enums.test.ts`. **Метки дописываются в конец** — `ALTER TYPE ... ADD
-- VALUE` иначе не умеет, а порядок обязан совпадать с порядком объявления в TS.
-- Внутри транзакции это допустимо начиная с Postgres 12; в этой же транзакции
-- новые метки не используются, поэтому «unsafe use of new value» не возникает.
--
-- `auth.identity.rejected` — единственная причина, которую видит экран: «такого
-- лица нет» и «код неверен» снаружи обязаны быть неразличимы, иначе форма входа
-- работает перечислителем учётных записей. Остальные семь существуют ради
-- журнала, который эту разницу как раз обязан сохранить.
ALTER TYPE sdelka.auth_reason_key ADD VALUE 'auth.identity.rejected';
ALTER TYPE sdelka.auth_reason_key ADD VALUE 'auth.identity.challenge_not_found';
ALTER TYPE sdelka.auth_reason_key ADD VALUE 'auth.identity.challenge_expired';
ALTER TYPE sdelka.auth_reason_key ADD VALUE 'auth.identity.challenge_consumed';
ALTER TYPE sdelka.auth_reason_key ADD VALUE 'auth.identity.attempts_exhausted';
ALTER TYPE sdelka.auth_reason_key ADD VALUE 'auth.identity.code_mismatch';
ALTER TYPE sdelka.auth_reason_key ADD VALUE 'auth.identity.account_unknown';
ALTER TYPE sdelka.auth_reason_key ADD VALUE 'auth.identity.channel_unavailable';

-- ---------------------------------------------------------------------------
-- Вызов
-- ---------------------------------------------------------------------------
--
-- Внешнего ключа на учётную запись **нет намеренно**, по той же причине, что и
-- у `auth_event` (`0010`): вызов выдаётся до того, как система признаёт запись
-- существующей, и одинаково — существующей и несуществующей. Ключ бы этого не
-- пустил, и «есть ли такая запись» читалось бы по тому, выдался вызов или нет.
CREATE TABLE sdelka.identity_challenge (
  challenge_id text PRIMARY KEY
    CHECK (challenge_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(challenge_id) <= 128),
  account_id text NOT NULL
    CHECK (account_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]*$' AND length(account_id) <= 128),

  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,

  attempts_used smallint NOT NULL DEFAULT 0 CHECK (attempts_used >= 0),
  max_attempts smallint NOT NULL CHECK (max_attempts > 0 AND max_attempts <= 10),
  consumed_at timestamptz,

  -- Момент, когда канал принял код к доставке. `NULL` — не принял: попытка
  -- входа, о которой человеку не сообщили ничем, обязана быть отличима от
  -- доставленной, иначе «код не пришёл» нечем разобрать.
  delivered_at timestamptz,

  CONSTRAINT identity_challenge_has_deadline CHECK (expires_at > issued_at),
  CONSTRAINT identity_challenge_consumed_after_issue
    CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CONSTRAINT identity_challenge_attempts_within
    CHECK (attempts_used <= max_attempts),
  CONSTRAINT identity_challenge_delivered_after_issue
    CHECK (delivered_at IS NULL OR delivered_at >= issued_at)
);

-- Подбор ищется по учётной записи и времени: «сколько вызовов выдано этой
-- записи за час» — первый вопрос при разборе инцидента.
CREATE INDEX identity_challenge_account ON sdelka.identity_challenge (account_id, issued_at);

-- Потолок срока. Число здесь, а не в `session_policy`: политика описывает
-- **сессию**, а вызов живёт до неё и сессией ещё не является. Полчаса — вдвое
-- шире рабочего срока в десять минут (`IDENTITY_CODE_POLICY`), то есть запас на
-- изменение политики без миграции, но не на превращение кода в пароль.
CREATE FUNCTION sdelka.assert_identity_challenge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF sdelka.millis_between(NEW.issued_at, NEW.expires_at) > 30 * 60 * 1000 THEN
    RAISE EXCEPTION 'auth.identity.challenge_expired'
      USING ERRCODE = '23514',
            DETAIL = format('challenge_id=%s', NEW.challenge_id);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER assert_identity_challenge
  BEFORE INSERT ON sdelka.identity_challenge
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_identity_challenge();

CREATE FUNCTION sdelka.assert_identity_challenge_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Принятый код второй раз не принимается: после отметки строка не меняется
  -- вовсе. Иначе «однократность» была бы полем, которое кто-то перепишет назад.
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'auth.identity.challenge_consumed'
      USING ERRCODE = '23514', DETAIL = format('challenge_id=%s', OLD.challenge_id);
  END IF;

  IF NEW.challenge_id IS DISTINCT FROM OLD.challenge_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     -- Срок продлению не подлежит: продлеваемый срок — не срок.
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts THEN
    RAISE EXCEPTION 'db.auth.challenge_immutable'
      USING ERRCODE = '23514', DETAIL = format('challenge_id=%s', OLD.challenge_id);
  END IF;

  -- Счётчик попыток идёт только вперёд. Обнуление — это снятие ограничения
  -- подбора одним `UPDATE`, и заметить его потом было бы нечем.
  IF NEW.attempts_used < OLD.attempts_used THEN
    RAISE EXCEPTION 'db.auth.challenge_attempts_regression'
      USING ERRCODE = '23514', DETAIL = format('challenge_id=%s', OLD.challenge_id);
  END IF;

  -- Отметка доставки ставится один раз: канал доставляет код однажды, и
  -- переписанная отметка врёт о том, когда человеку сообщили.
  IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
    RAISE EXCEPTION 'db.auth.challenge_immutable'
      USING ERRCODE = '23514', DETAIL = format('challenge_id=%s', OLD.challenge_id);
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER assert_identity_challenge_update
  BEFORE UPDATE ON sdelka.identity_challenge
  FOR EACH ROW EXECUTE FUNCTION sdelka.assert_identity_challenge_update();

-- ---------------------------------------------------------------------------
-- Гранты
-- ---------------------------------------------------------------------------
--
-- Вызов выдаётся, отмечается попыткой и закрывается — но не исчезает: удалённый
-- вызов уносит с собой след подбора. Уборка отработавших вызовов — отдельная
-- операция от имени владельца схемы, а не право приложения.
GRANT SELECT, INSERT, UPDATE ON sdelka.identity_challenge TO sdelka_app;
REVOKE DELETE, TRUNCATE ON sdelka.identity_challenge FROM sdelka_app;

REVOKE ALL ON sdelka.identity_challenge FROM PUBLIC;
