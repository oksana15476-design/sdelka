-- 0008 — сверка представлениями.
--
-- Здесь база **видит** то, что не запрещает. Разница принципиальная и названа
-- честно: покрытие клиентских средств (красная линия №3) ограничением быть не
-- может, потому что недостачу нужно уметь **записать**, чтобы её увидеть.
-- Ограничение сделало бы её непроводимой и невидимой одновременно. Поэтому
-- покрытие — представление плюс стоп-кран приложения, а не CHECK.
--
-- Все представления классифицируют счета **джойном справочника**
-- `sdelka.account_kind`. Ни одного перечня имён счетов в SQL нет: перечень имён
-- — та самая дыра, которая дважды стоила учёту `isClientObligationAccount`.

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Проводка вместе с природой счёта и остатком в естественном знаке
-- ---------------------------------------------------------------------------
--
-- Естественный знак: актив и расход — Дт минус Кт, обязательство и доход — Кт
-- минус Дт (`naturalSign`). Так «отрицательный остаток» означает ровно то, что
-- означает в инварианте, а не зависит от точки зрения.
CREATE VIEW sdelka.v_posting AS
SELECT p.entry_id,
       p.ord,
       e.seq AS entry_seq,
       e.occurred_at,
       e.kind AS entry_kind,
       p.account_code,
       p.account_kind,
       p.currency,
       p.direction,
       p.amount_minor,
       p.client_key,
       p.account_deal_id,
       p.account_tranche_id,
       p.conversion_id,
       p.attribution_client_key,
       p.attribution_deal_id,
       p.attribution_tranche_id,
       k.acct_type,
       k.funds,
       k.platform_role,
       k.file_scope,
       k.pool_direction,
       CASE WHEN (k.acct_type IN ('asset', 'expense')) = (p.direction = 'debit')
            THEN p.amount_minor ELSE -p.amount_minor END AS natural_minor,
       CASE WHEN p.direction = 'debit' THEN p.amount_minor ELSE -p.amount_minor END AS signed_minor
  FROM sdelka.ledger_posting p
  JOIN sdelka.ledger_entry e ON e.entry_id = p.entry_id
  JOIN sdelka.account_kind k ON k.kind = p.account_kind;

CREATE VIEW sdelka.v_ledger_balance AS
SELECT account_code,
       currency,
       min(account_kind::text) AS account_kind,
       min(acct_type::text) AS acct_type,
       min(funds::text) AS funds,
       sum(natural_minor) AS balance_minor
  FROM sdelka.v_posting
 GROUP BY account_code, currency;

-- ---------------------------------------------------------------------------
-- Отрицательные остатки
-- ---------------------------------------------------------------------------

CREATE VIEW sdelka.v_negative_client_balance AS
SELECT b.account_code, b.currency, b.balance_minor
  FROM sdelka.v_ledger_balance b
 WHERE b.funds = 'client' AND b.balance_minor < 0;

CREATE VIEW sdelka.v_negative_bank_balance AS
SELECT b.account_code, b.currency, b.balance_minor
  FROM sdelka.v_ledger_balance b
  JOIN sdelka.account_kind k ON k.kind::text = b.account_kind
 WHERE k.platform_role = 'bank' AND b.balance_minor < 0;

-- Требование или транзит платформы в минусе. Отдельно от банковского счёта
-- намеренно: «банковский счёт в минусе» на требовании по начисленной комиссии —
-- ложное сообщение дежурному, а разбираются они по-разному.
CREATE VIEW sdelka.v_negative_platform_asset AS
SELECT b.account_code, b.currency, b.balance_minor
  FROM sdelka.v_ledger_balance b
  JOIN sdelka.account_kind k ON k.kind::text = b.account_kind
 WHERE k.platform_role IN ('receivable', 'transit') AND b.balance_minor < 0;

-- ---------------------------------------------------------------------------
-- Покрытие
-- ---------------------------------------------------------------------------
--
-- Отношение покрытия — **двумя целыми**, никогда одним дробным числом и тем
-- более не `float` (красная линия №4). Делить здесь нечего: сравнение
-- `custody >= obligations` целочисленное, а отношение нужно только для отчёта.
CREATE VIEW sdelka.v_coverage AS
SELECT currency,
       sum(CASE WHEN funds = 'client' AND acct_type = 'asset' AND file_scope = 'in_attribution'
                THEN natural_minor ELSE 0 END) AS custody_minor,
       sum(CASE WHEN funds = 'client' AND acct_type = 'liability'
                     AND pool_direction IS DISTINCT FROM 'terminal'
                THEN natural_minor ELSE 0 END) AS obligations_minor
  FROM sdelka.v_posting
 WHERE funds = 'client'
 GROUP BY currency;

COMMENT ON VIEW sdelka.v_coverage IS
  'Портфельное покрытие. Невостребованные средства сюда не входят: §3.1 требует для них отдельной проверки.';

-- Вторая проверка, которую требует §3.1: деньги, признанные чужими, ушли с
-- номинального счёта и потому выпадают из основного отношения. Сопоставляются с
-- тем, где физически лежат: банковские счета платформы плюс транзит списания.
--
-- ⚠ Показывает **достаточность**, а не раздельность: на операционном счёте
-- лежат и собственные деньги платформы. Раздельность даст только отдельный
-- счёт, и это решение владельца вместе с ответом на вопрос §3.1 **[открыто]**.
CREATE VIEW sdelka.v_coverage_unclaimed AS
SELECT currency, custody_minor, obligations_minor
  FROM (
    SELECT currency,
           sum(CASE WHEN platform_role = 'bank'
                      OR (pool_direction = 'terminal' AND acct_type = 'asset')
                    THEN natural_minor ELSE 0 END) AS custody_minor,
           sum(CASE WHEN pool_direction = 'terminal' AND acct_type = 'liability'
                    THEN natural_minor ELSE 0 END) AS obligations_minor
      FROM sdelka.v_posting
     GROUP BY currency
  ) t
 -- Валюта без невостребованных обязательств отношения не образует: остаток
 -- операционного счёта сам по себе ничего не покрывает.
 WHERE obligations_minor <> 0;

-- ---------------------------------------------------------------------------
-- Файл проводки и пофайловое покрытие
-- ---------------------------------------------------------------------------
--
-- Файл: у обязательства с владельцем в коде — из кода счёта, у кастодиана — из
-- отнесения, у пулов его нет вовсе. Перечня видов счетов здесь нет: и то и
-- другое читается по объявленной природе счёта (`sourceOfPosting`).
CREATE VIEW sdelka.v_posting_file AS
SELECT p.*,
       CASE
         WHEN p.file_scope = 'owner_in_code' AND p.account_tranche_id IS NOT NULL THEN 'tranche'
         WHEN p.file_scope = 'owner_in_code' THEN 'client'
         WHEN p.file_scope = 'in_attribution' AND p.attribution_deal_id IS NOT NULL THEN 'tranche'
         WHEN p.file_scope = 'in_attribution' AND p.attribution_client_key IS NOT NULL THEN 'client'
       END AS source_kind,
       CASE
         WHEN p.file_scope = 'owner_in_code' THEN p.client_key
         WHEN p.file_scope = 'in_attribution' THEN p.attribution_client_key
       END AS source_client_key,
       CASE
         WHEN p.file_scope = 'owner_in_code' THEN p.account_deal_id
         WHEN p.file_scope = 'in_attribution' THEN p.attribution_deal_id
       END AS source_deal_id,
       CASE
         WHEN p.file_scope = 'owner_in_code' THEN p.account_tranche_id
         WHEN p.file_scope = 'in_attribution' THEN p.attribution_tranche_id
       END AS source_tranche_id
  FROM sdelka.v_posting p
 WHERE p.funds = 'client';

-- Пофайловое обеспечение по обоим видам файла: транш и клиент вне сделки
-- (`FUNCTIONAL.md` §3.1, `CORE.md` Ф10). Портфельная сверка расхождения внутри
-- отдельного файла не видит — это прямое требование Ф10.
CREATE VIEW sdelka.v_coverage_by_funds_source AS
SELECT source_kind,
       CASE WHEN source_kind = 'client' THEN source_client_key
            ELSE source_deal_id || ':' || source_tranche_id END AS subject,
       currency,
       sum(CASE WHEN acct_type = 'asset' THEN natural_minor ELSE 0 END) AS custody_minor,
       sum(CASE WHEN acct_type = 'liability' THEN natural_minor ELSE 0 END) AS obligations_minor
  FROM sdelka.v_posting_file
 WHERE source_kind IS NOT NULL
 GROUP BY 1, 2, 3;

-- Частный случай — метрика Г1 «пофайловое обеспечение 100%» (`FUNCTIONAL.md`
-- §3.1). Обязательства берутся с запертых счетов, кастодиан — по отнесению к
-- траншу; свободная часть счёта клиента сюда не попадает, у неё нет транша.
CREATE VIEW sdelka.v_coverage_by_tranche AS
SELECT COALESCE(p.account_deal_id, p.attribution_deal_id) AS deal_id,
       COALESCE(p.account_tranche_id, p.attribution_tranche_id) AS tranche_id,
       p.currency,
       sum(CASE WHEN p.acct_type = 'asset' AND p.attribution_deal_id IS NOT NULL
                THEN p.natural_minor ELSE 0 END) AS custody_minor,
       sum(CASE WHEN p.account_kind = 'client_locked' THEN p.natural_minor ELSE 0 END)
         AS obligations_minor
  FROM sdelka.v_posting p
 WHERE p.funds = 'client'
   AND (p.account_tranche_id IS NOT NULL OR p.attribution_tranche_id IS NOT NULL)
   AND (p.account_kind = 'client_locked' OR p.acct_type = 'asset')
 GROUP BY 1, 2, 3;

-- ⚠ Файл транша попадает сюда, если его тронула **любая** из двух сторон —
-- обязательство или кастодиан, — а не только обязательство. Соблазн отфильтровать
-- по наличию `client_locked` был, и он неверен: кредит номинального счёта,
-- отнесённый к траншу, по которому обязательства не заводилось, уводит файл в
-- минус, и `coverageByTranche` такой файл видит (список строится обеими
-- сторонами). Фильтр по обязательству молча прятал бы ровно этот случай.

-- ---------------------------------------------------------------------------
-- Открытые позиции: обмен и транзит
-- ---------------------------------------------------------------------------
--
-- Ненулевая позиция сама по себе не нарушение — между тремя моментами обмена
-- она обязана быть ненулевой. Расхождением её делает **возраст**, и это уже
-- инвариант, а не отчёт.
--
-- Плоскость проверяется **по записи целиком**, а не после каждой проводки:
-- момент 2 сначала гасит ногу исходной валюты и лишь потом открывает ногу
-- встречной, и по проводкам позиция на миг обнуляется. Возраст обмена — это
-- возраст обмена, а не последнего движения по нему.
CREATE VIEW sdelka.v_fx_position AS
WITH by_entry AS (
  SELECT conversion_id, entry_seq, occurred_at, currency,
         sum(natural_minor) AS delta
    FROM sdelka.v_posting
   WHERE conversion_id IS NOT NULL
   GROUP BY 1, 2, 3, 4
), running AS (
  SELECT conversion_id, entry_seq, occurred_at, currency,
         sum(delta) OVER (PARTITION BY conversion_id, currency
                          ORDER BY entry_seq
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
    FROM by_entry
), entry_state AS (
  -- Остаток по каждой валюте на конец каждой записи, тронувшей обмен. Валюта,
  -- не тронутая этой записью, свой прежний остаток сохраняет, поэтому берётся
  -- последнее известное значение.
  SELECT e.conversion_id, e.entry_seq, e.occurred_at,
         bool_and(COALESCE(r.balance, 0) = 0) AS flat
    FROM (SELECT DISTINCT conversion_id, entry_seq, occurred_at FROM by_entry) e
    LEFT JOIN LATERAL (
      SELECT DISTINCT ON (c.currency) c.currency, c.balance
        FROM running c
       WHERE c.conversion_id = e.conversion_id AND c.entry_seq <= e.entry_seq
       ORDER BY c.currency, c.entry_seq DESC
    ) r ON true
   GROUP BY 1, 2, 3
), opened AS (
  SELECT conversion_id,
         max(occurred_at) FILTER (WHERE flat) AS last_flat_at,
         max(entry_seq) FILTER (WHERE flat) AS last_flat_seq
    FROM entry_state
   GROUP BY conversion_id
), current_balance AS (
  SELECT DISTINCT ON (conversion_id, currency) conversion_id, currency, balance
    FROM running
   ORDER BY conversion_id, currency, entry_seq DESC
)
SELECT c.conversion_id,
       c.currency,
       c.balance AS amount_minor,
       (SELECT min(s.occurred_at)
          FROM entry_state s
         WHERE s.conversion_id = c.conversion_id
           AND s.entry_seq > COALESCE(o.last_flat_seq, -1)) AS opened_at
  FROM current_balance c
  LEFT JOIN opened o ON o.conversion_id = c.conversion_id
 WHERE c.balance <> 0;

-- Транзит: `transit:writeoff` и `transit:fee`. §3.1 обещает про первый дословно
-- — «остаток на нём старше двух банковских дней — расхождение для сверки, а не
-- норма»; Ф16 обещает то же про второй.
CREATE VIEW sdelka.v_transit_position AS
WITH by_entry AS (
  SELECT account_code, currency, entry_seq, occurred_at, sum(natural_minor) AS delta
    FROM sdelka.v_posting
   WHERE platform_role = 'transit'
      OR (pool_direction = 'terminal' AND acct_type = 'asset')
   GROUP BY 1, 2, 3, 4
), running AS (
  SELECT account_code, currency, entry_seq, occurred_at,
         sum(delta) OVER (PARTITION BY account_code, currency
                          ORDER BY entry_seq
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
    FROM by_entry
), last_flat AS (
  SELECT account_code, currency, max(entry_seq) AS seq
    FROM running
   WHERE balance = 0
   GROUP BY 1, 2
), current_balance AS (
  SELECT DISTINCT ON (account_code, currency) account_code, currency, balance
    FROM running
   ORDER BY account_code, currency, entry_seq DESC
)
SELECT c.account_code,
       c.currency,
       c.balance AS amount_minor,
       (SELECT min(r.occurred_at)
          FROM running r
         WHERE r.account_code = c.account_code
           AND r.currency = c.currency
           AND r.entry_seq > COALESCE(f.seq, -1)) AS opened_at
  FROM current_balance c
  LEFT JOIN last_flat f ON f.account_code = c.account_code AND f.currency = c.currency
 WHERE c.balance <> 0;

-- ---------------------------------------------------------------------------
-- Довнесено сверх признанного
-- ---------------------------------------------------------------------------
--
-- Признание считается по проводкам `shortfall:expense` с отнесением к клиенту;
-- довнесённое — это сумма приростов файла этого клиента по всем записям.
-- Прирост больше нуля бывает только там, где платформа положила в файл
-- собственные деньги (это держит `assertNoUnfundedClientFileGain`), поэтому
-- отдельного признака «это довнесение» не требуется — и хорошо, что не
-- требуется: признак ставит тот же, кто строит запись.
CREATE VIEW sdelka.v_shortfall_overfunded AS
WITH recognised AS (
  SELECT attribution_client_key AS client_key, currency, sum(natural_minor) AS minor
    FROM sdelka.v_posting
   WHERE account_kind = 'shortfall_expense' AND attribution_client_key IS NOT NULL
   GROUP BY 1, 2
), gains AS (
  SELECT entry_id, source_client_key AS client_key, currency,
         sum(CASE WHEN acct_type = 'asset' THEN natural_minor ELSE -natural_minor END) AS minor
    FROM sdelka.v_posting_file
   WHERE source_kind = 'client'
   GROUP BY 1, 2, 3
), funded AS (
  SELECT client_key, currency, sum(minor) AS minor
    FROM gains
   WHERE minor > 0
   GROUP BY 1, 2
)
SELECT f.client_key,
       f.currency,
       f.minor - COALESCE(r.minor, 0) AS excess_minor
  FROM funded f
  LEFT JOIN recognised r ON r.client_key = f.client_key AND r.currency = f.currency
 WHERE f.minor - COALESCE(r.minor, 0) > 0;

-- ---------------------------------------------------------------------------
-- Сводка нарушений — зеркало checkLedgerInvariants
-- ---------------------------------------------------------------------------
--
-- Коды **дословно** из `InvariantCode` (`ledger/src/invariants.ts`). Тест
-- дрейфа сверяет оба перечня, а интеграционный тест сверяет саму выдачу:
-- `SELECT * FROM v_ledger_invariant_violation` посимвольно равно
-- `checkLedgerInvariants(journal)` на каждом сценарии.
--
-- Функция, а не только представление: у двух проверок есть возраст, и у него
-- есть настройки (`InvariantOptions`). Умолчания те же, что в TS: `as_of` —
-- самая поздняя `occurred_at` в журнале («сейчас» для журнала это момент
-- последнего известного факта, а не системные часы), окно — 48 часов
-- календарных, потому что банковского календаря в учёте нет и быть не должно.
CREATE FUNCTION sdelka.ledger_invariant_violation(
  as_of timestamptz DEFAULT NULL,
  stale_after_ms bigint DEFAULT 172800000
)
RETURNS TABLE (
  code text,
  currency text,
  subject text,
  amount_minor numeric
)
LANGUAGE sql STABLE AS $$
  WITH moment AS (
    SELECT COALESCE(as_of, (SELECT max(occurred_at) FROM sdelka.ledger_entry)) AS at
  )
  SELECT 'ledger.invariant.entry_unbalanced', p.currency, p.entry_id, sum(p.signed_minor)
    FROM sdelka.v_posting p
   GROUP BY p.entry_id, p.currency
  HAVING sum(p.signed_minor) <> 0

  UNION ALL
  SELECT 'ledger.invariant.negative_client_balance', v.currency, v.account_code, v.balance_minor
    FROM sdelka.v_negative_client_balance v

  UNION ALL
  SELECT 'ledger.invariant.negative_bank_balance', v.currency, v.account_code, v.balance_minor
    FROM sdelka.v_negative_bank_balance v

  UNION ALL
  SELECT 'ledger.invariant.coverage_below_one', v.currency, 'portfolio',
         v.custody_minor - v.obligations_minor
    FROM sdelka.v_coverage v
   WHERE v.custody_minor < v.obligations_minor

  UNION ALL
  SELECT 'ledger.invariant.unclaimed_uncovered', v.currency, 'unclaimed',
         v.custody_minor - v.obligations_minor
    FROM sdelka.v_coverage_unclaimed v
   WHERE v.custody_minor < v.obligations_minor

  UNION ALL
  SELECT 'ledger.invariant.tranche_uncovered', v.currency,
         v.deal_id || ':' || v.tranche_id, v.custody_minor - v.obligations_minor
    FROM sdelka.v_coverage_by_tranche v
   WHERE v.custody_minor < v.obligations_minor

  UNION ALL
  SELECT 'ledger.invariant.platform_asset_negative', v.currency, v.account_code, v.balance_minor
    FROM sdelka.v_negative_platform_asset v

  UNION ALL
  SELECT 'ledger.invariant.fx_position_open', v.currency, v.conversion_id, v.amount_minor
    FROM sdelka.v_fx_position v, moment m
   WHERE m.at IS NOT NULL
     AND extract(epoch FROM (m.at - v.opened_at)) * 1000 > stale_after_ms

  UNION ALL
  SELECT 'ledger.invariant.transit_stale', v.currency, v.account_code, v.amount_minor
    FROM sdelka.v_transit_position v, moment m
   WHERE m.at IS NOT NULL
     AND extract(epoch FROM (m.at - v.opened_at)) * 1000 > stale_after_ms

  UNION ALL
  SELECT 'ledger.invariant.shortfall_overfunded', v.currency, v.client_key, v.excess_minor
    FROM sdelka.v_shortfall_overfunded v

  UNION ALL
  -- Недостача по файлу клиента. Транши посчитаны выше своим отношением: одно и
  -- то же расхождение не должно попадать в отчёт дважды.
  SELECT 'ledger.invariant.client_account_uncovered', v.currency, v.subject,
         v.custody_minor - v.obligations_minor
    FROM sdelka.v_coverage_by_funds_source v
   WHERE v.source_kind = 'client' AND v.custody_minor < v.obligations_minor

  UNION ALL
  -- Профицит по **обоим** видам файла: деньги платформы на счёте клиентских
  -- средств (красная линия №2) и опустошённый файл (красная линия №1) выглядят
  -- одинаково — средств больше, чем обязательств, — и оба обязаны быть
  -- расхождением, а не запасом прочности.
  SELECT 'ledger.invariant.custody_surplus', v.currency, v.subject,
         v.custody_minor - v.obligations_minor
    FROM sdelka.v_coverage_by_funds_source v
   WHERE v.custody_minor > v.obligations_minor;
$$;

CREATE VIEW sdelka.v_ledger_invariant_violation AS
SELECT * FROM sdelka.ledger_invariant_violation();

-- Стоп-кран приёма новых сделок (красная линия №3, `CORE.md` Ф10). Решение
-- принимает приложение — здесь только признак, вычисленный из журнала.
CREATE VIEW sdelka.v_should_stop_accepting_deals AS
SELECT EXISTS (
  SELECT 1 FROM sdelka.v_ledger_invariant_violation
   WHERE code IN (
     'ledger.invariant.coverage_below_one',
     'ledger.invariant.tranche_uncovered',
     'ledger.invariant.client_account_uncovered',
     'ledger.invariant.custody_surplus',
     'ledger.invariant.negative_client_balance'
   )
) AS stop;

GRANT SELECT ON ALL TABLES IN SCHEMA sdelka TO sdelka_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sdelka.ledger_entry, sdelka.ledger_posting FROM sdelka_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sdelka.audit_record FROM sdelka_app;
