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
