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
-- записи отдельной транзакцией, и тогда «второй» окажется старая запись.
-- Виновной названа при этом всегда более ранняя — она начислила первой.
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
