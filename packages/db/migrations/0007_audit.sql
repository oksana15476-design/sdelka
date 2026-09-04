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
