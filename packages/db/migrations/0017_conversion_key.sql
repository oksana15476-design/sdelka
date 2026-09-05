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
