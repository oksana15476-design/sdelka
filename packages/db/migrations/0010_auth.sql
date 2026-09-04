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
