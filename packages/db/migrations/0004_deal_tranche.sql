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
