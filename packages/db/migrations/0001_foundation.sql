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
