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
