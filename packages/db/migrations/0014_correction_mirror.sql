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
