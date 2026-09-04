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
