-- 0021 — три недостающих объявления записи журнала и потолок удержания расчёта.
--
-- `sdelka.ledger_entry` держала одно объявление из четырёх. `JournalEntry`
-- (`ledger/src/entry.ts`) несёт `settles`, `converts`, `accrues` и `funds`, и
-- колонок было только под `settles`, да и у того не хранился потолок удержания.
-- Хранилище такую запись **отвергало** (`db.entry.declaration_not_storable`), а
-- не писало с потерей, и отвергало верно: молча потерянная ссылка на признание
-- позволила бы довносить одно признание сколько угодно раз, потерянная версия
-- тарифного плана — пересчитать комиссию задним числом (§4.2), потерянные три
-- курса — не восстановить курс из двух сумм (усечение необратимо, И14.2).
--
-- Следствием расчёт получателю и начисление комиссии в базу не ложились вовсе:
-- расчёт идёт двумя записями, вторая из которых — начисление с версией плана.
-- То есть боевой путь денег заканчивался на возврате.
--
-- ---------------------------------------------------------------------------
-- Что здесь решено и почему именно так
-- ---------------------------------------------------------------------------
--
-- **Объявление — хранимый факт о прошлом.** Задним числом оно не переписывается
-- по той же причине, по которой не переписывается вся запись: `ledger_entry`
-- только дополняется — гранты роли приложения без `UPDATE`/`DELETE` (`0002`),
-- триггеры `forbid_ledger_*_mutation` (`0002`) и `forbid_ledger_*_truncate`
-- (`0019`). Новые колонки живут внутри той же строки и наследуют это целиком;
-- отдельного контура им не нужно, и заводить его значило бы завести второе
-- место, где правило можно ослабить.
--
-- **Курсы — числителем и знаменателем, целыми.** Красная линия №4 говорит о
-- суммах, но курс — это то, из чего сумма считается: `2,6686875` в double уже
-- не равен себе после трёх операций, а из него получается число, которое видит
-- клиент. В TS курс — `Rational` из двух `bigint` (`money/src/rational.ts`),
-- здесь — две колонки `numeric(38, 0)`. Ни одного `numeric` с дробной частью в
-- схеме нет, и это проверяется тестом (`test/no-float.test.ts`).
--
-- Сокращённость дроби не проверяется намеренно: `rational()` сокращает при
-- чтении, поэтому `5/10` и `1/2` дают одно и то же значение. Ограничение
-- «храните сокращённой» ловило бы форму записи, а не величину.
--
-- **Дата курса — `text` с формой `YYYY-MM-DD`, а не `date`.** `IsoDate`
-- (`money/src/fx.ts`) — это строка ровно такой формы; тип `date` драйвер
-- отдаёт `Date`, то есть моментом времени в часовом поясе процесса, и круг
-- «запись → база → запись» ломался бы на сутки в зависимости от `TZ`. Форма
-- колонки — буквальное зеркало `ISO_DATE_PATTERN`, включая то, что `2026-13-45`
-- она пропускает: расходиться с кодом строгостью — это тот же дрейф, только в
-- другую сторону.
--
-- **Пара валют курса отдельными колонками не хранится.** `FxRates` несёт
-- `base`/`quote`, и каждый из трёх `FxRate` — тоже, но все они выводятся из
-- сумм: `fxExecution` пропускает объявление только через
-- `convertAtRate(source, rates.client, 'trunc')`, а тот отказывает, если
-- `source.currency <> rate.base` (`assertRateApplies`), и сверяет, что
-- полученная валюта равна валюте `target`. Значит `base = валюта исходной
-- суммы`, `quote = валюта встречной`, и вторая копия этих кодов была бы вторым
-- источником истины. Так же, как `account_code` в `ledger_posting` не хранится
-- заполняемым приложением.
--
-- **Чего база не проверяет.** Она не пересчитывает встречную сумму по
-- клиентскому курсу и не сверяет объявления с проводками. Это ровно тот дрейф
-- двух моделей, из-за которого `0007` не пересчитывает `record_hash`: пересчёт
-- потребовал бы второй реализации `convertAtRate` на PL/pgSQL вместе с числом
-- знаков валюты, а сверка объявления с проводками — второй реализации
-- `assertConversionDeclared`, `assertFeeAccrualDeclared` и
-- `assertShortfallFundingDeclared`. Обе живут в `createJournalEntry`, через
-- который проходит **и запись, и чтение** (`store/journal.ts`, `entryOfRows`):
-- строка, из которой запись не собирается, поднимает `LedgerError` на чтении, а
-- не расходится молча в отчётности через месяц.
--
-- База держит здесь то, что умеет держать одна: форму (объявление целиком или
-- никак), алфавит идентификаторов, положительность сумм и курсов, ссылочную
-- целостность признания и то, что одно признание довносится один раз.
--
-- ⚠ **Заполнения прошлых строк здесь нет, и это решение.** Потолок удержания у
-- уже лежащих расчётов был бы известен — до этой миграции хранилище принимало
-- расчёт только с жёстким пределом учёта, — но заполнение потребовало бы
-- `UPDATE` по `ledger_entry`, то есть снятия append-only с журнала учёта на
-- время миграции. Такой прецедент дороже удобства. На пустой таблице (а она
-- пуста везде, где эти миграции применены: до порта хранилища в `ledger_entry`
-- не писал никто) ограничение ниже применяется без единой правки строк; на
-- непустой оно **остановит миграцию по имени**, и что делать с историей —
-- решает владелец, а не мы. Помечено **[открыто]**.

SET LOCAL ROLE sdelka_owner;

-- ---------------------------------------------------------------------------
-- Колонки
-- ---------------------------------------------------------------------------

ALTER TABLE sdelka.ledger_entry
  -- `TrancheSettlement.ceiling` (`ledger/src/fee-ceiling.ts`): предельная доля
  -- суммы к распределению, которую платформа вправе оставить себе. Едет в
  -- объявлении, а не в настройке, потому что политика принадлежит решению,
  -- принятому в момент расчёта (`CORE.md` Ф11).
  ADD COLUMN settles_ceiling_numerator numeric(38, 0),
  ADD COLUMN settles_ceiling_denominator numeric(38, 0),

  -- `FxExecution` (`ledger/src/entry.ts`) плюс `ConvertedAmount`
  -- (`money/src/fx.ts`): ключ обмена, обе ноги и три курса с датой.
  ADD COLUMN converts_conversion_id text,
  ADD COLUMN converts_source_currency text REFERENCES sdelka.currency (code),
  ADD COLUMN converts_source_amount_minor numeric(38, 0),
  ADD COLUMN converts_target_currency text REFERENCES sdelka.currency (code),
  ADD COLUMN converts_target_amount_minor numeric(38, 0),
  ADD COLUMN converts_client_rate_numerator numeric(38, 0),
  ADD COLUMN converts_client_rate_denominator numeric(38, 0),
  ADD COLUMN converts_reference_rate_numerator numeric(38, 0),
  ADD COLUMN converts_reference_rate_denominator numeric(38, 0),
  ADD COLUMN converts_official_rate_numerator numeric(38, 0),
  ADD COLUMN converts_official_rate_denominator numeric(38, 0),
  ADD COLUMN converts_as_of text,

  -- `FeeAccrualDeclaration`: по какой сделке, сколько и по какой версии
  -- тарифного плана. Версия обязательна: журнал переживает сделку и читается
  -- отдельно от неё, а §4.2 запрещает пересчёт задним числом.
  ADD COLUMN accrues_deal_id text,
  ADD COLUMN accrues_tranche_id text,
  ADD COLUMN accrues_fee_currency text REFERENCES sdelka.currency (code),
  ADD COLUMN accrues_fee_amount_minor numeric(38, 0),
  ADD COLUMN accrues_tariff_version_id text,

  -- `ShortfallFunding`: какое именно признание закрывает это довнесение.
  -- Ссылка внешним ключом на ту же таблицу — как у `corrects_entry_id`:
  -- ссылка на запись, которой в журнале нет, ссылкой не является.
  ADD COLUMN funds_recognised_entry_id text REFERENCES sdelka.ledger_entry (entry_id),
  ADD COLUMN funds_owner text,
  ADD COLUMN funds_amount_currency text REFERENCES sdelka.currency (code),
  ADD COLUMN funds_amount_minor numeric(38, 0);

COMMENT ON COLUMN sdelka.ledger_entry.settles_ceiling_numerator IS
  'Числитель предельной доли удержания, действовавшей для этого расчёта.';

COMMENT ON COLUMN sdelka.ledger_entry.accrues_tariff_version_id IS
  'Версия тарифного плана, по которой начислена комиссия. Пересчёт задним числом невозможен.';

COMMENT ON COLUMN sdelka.ledger_entry.funds_recognised_entry_id IS
  'Признание недостачи, которое закрывает это довнесение. Одно признание довносится один раз.';

-- ---------------------------------------------------------------------------
-- Форма: объявление целиком или никак
-- ---------------------------------------------------------------------------
--
-- Тот же довод, что у `ledger_entry_settles_whole` в `0002`: в TS это одно
-- значение, и половина объявления не является объявлением. Потолок привязан к
-- наличию расчёта, а не к самому себе: расчёт без потолка — это расчёт, которому
-- разрешено неизвестно сколько.

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_settles_ceiling_whole CHECK (
  num_nonnulls(settles_ceiling_numerator, settles_ceiling_denominator)
    = CASE WHEN settles_deal_id IS NULL THEN 0 ELSE 2 END
);

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_whole CHECK (
  num_nonnulls(
    converts_conversion_id,
    converts_source_currency, converts_source_amount_minor,
    converts_target_currency, converts_target_amount_minor,
    converts_client_rate_numerator, converts_client_rate_denominator,
    converts_reference_rate_numerator, converts_reference_rate_denominator,
    converts_official_rate_numerator, converts_official_rate_denominator,
    converts_as_of
  ) IN (0, 12)
);

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_accrues_whole CHECK (
  num_nonnulls(
    accrues_deal_id, accrues_tranche_id,
    accrues_fee_currency, accrues_fee_amount_minor,
    accrues_tariff_version_id
  ) IN (0, 5)
);

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_funds_whole CHECK (
  num_nonnulls(
    funds_recognised_entry_id, funds_owner,
    funds_amount_currency, funds_amount_minor
  ) IN (0, 4)
);

-- ---------------------------------------------------------------------------
-- Величины
-- ---------------------------------------------------------------------------

-- Зеркало `feeCeiling()`: доля не бывает отрицательной и не бывает больше
-- единицы — удержать больше суммы нельзя ни при какой ставке.
--
-- ⚠ Жёсткий предел учёта (`DEFAULT_FEE_CEILING`, сегодня два процента) здесь
-- **не** дублируется: само значение помечено `[открыто]` владельцу, и вторая
-- его копия в SQL разошлась бы с первой в день, когда владелец назначит своё.
-- Сужение до жёсткого предела делает `trancheSettlement` на чтении, а
-- расхождение прочитанного с записанным ловит `db.entry.ceiling_mismatch`.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_settles_ceiling_share CHECK (
  settles_ceiling_numerator IS NULL
  OR (settles_ceiling_numerator >= 0
      AND settles_ceiling_denominator > 0
      AND settles_ceiling_numerator <= settles_ceiling_denominator)
);

-- Зеркало `fxExecution`: обе ноги строго положительны. Ноль на ноге — это не
-- обмен, а запись, у которой одна сторона исчезла.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_positive CHECK (
  converts_source_amount_minor IS NULL
  OR (converts_source_amount_minor > 0 AND converts_target_amount_minor > 0)
);

-- Зеркало `fxRate()`: ноль и отрицательный курс — не курс. Ноль обнуляет чужие
-- деньги, знак выворачивает направление, и обе величины проходят всю арифметику
-- молча. Знаменатель положителен, потому что `rational()` нормализует знак в
-- числитель.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_rates_positive CHECK (
  converts_client_rate_numerator IS NULL
  OR (converts_client_rate_numerator > 0 AND converts_client_rate_denominator > 0
      AND converts_reference_rate_numerator > 0 AND converts_reference_rate_denominator > 0
      AND converts_official_rate_numerator > 0 AND converts_official_rate_denominator > 0)
);

-- Зеркало `fxRate()`: пара валют курса — это две **разные** валюты.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_pair_distinct CHECK (
  converts_source_currency IS NULL OR converts_source_currency <> converts_target_currency
);

-- Зеркало `ISO_DATE_PATTERN` (`money/src/fx.ts`): курс без даты не является
-- курсом, а дата без формы не является датой.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_as_of_form CHECK (
  converts_as_of IS NULL OR converts_as_of ~ '^\d{4}-\d{2}-\d{2}$'
);

-- Зеркало `accrueFee`: нулевая комиссия — это отсутствие комиссии, а не
-- проводка на ноль. Знак несёт вид записи (исправление двигает доход обратно),
-- а не сумма объявления.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_accrues_positive CHECK (
  accrues_fee_amount_minor IS NULL OR accrues_fee_amount_minor > 0
);

-- Зеркало `absorbShortfall`: недостача без недостачи — обычное зачисление.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_funds_positive CHECK (
  funds_amount_minor IS NULL OR funds_amount_minor > 0
);

-- Зеркало `assertShortfallFundingDeclared`: исправление довнесения — обратная
-- проводка со ссылкой на исправляемую запись, а не второе довнесение по тому же
-- признанию. Объявление на исправлении означало бы, что признание закрыто ещё
-- раз.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_funds_settlement_only CHECK (
  funds_recognised_entry_id IS NULL OR kind = 'settlement'
);

-- Довнесение по самому себе — не ссылка на признание, а её отсутствие.
ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_funds_not_self CHECK (
  funds_recognised_entry_id <> entry_id
);

-- ---------------------------------------------------------------------------
-- Алфавит идентификаторов
-- ---------------------------------------------------------------------------
--
-- Зеркало `assertAccountIdentifier` и `CLIENT_KEY_PATTERN` (`ledger/src/accounts.ts`),
-- как у `ledger_entry_settles_alphabet` в `0002`: двоеточие разделяет сегменты
-- кода счёта, вертикальная черта — ключи файла источника средств. Идентификатор
-- с любым из них делает два разных счёта неотличимыми в сверке.

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_converts_alphabet CHECK (
  converts_conversion_id IS NULL OR converts_conversion_id ~ '^[^:|]+$'
);

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_accrues_alphabet CHECK (
  (accrues_deal_id IS NULL OR accrues_deal_id ~ '^[^:|]+$')
  AND (accrues_tranche_id IS NULL OR accrues_tranche_id ~ '^[^:|]+$')
  AND (accrues_tariff_version_id IS NULL OR accrues_tariff_version_id ~ '^[^:|]+$')
);

ALTER TABLE sdelka.ledger_entry ADD CONSTRAINT ledger_entry_funds_owner_alphabet CHECK (
  funds_owner IS NULL OR funds_owner ~ '^[A-Za-z0-9._-]{1,128}$'
);

-- ---------------------------------------------------------------------------
-- Одно признание довносится один раз
-- ---------------------------------------------------------------------------
--
-- Зеркало `assertShortfallFundingResolves` (`ledger/src/journal.ts`), и это тот
-- самый повод, ради которого ссылка вообще заведена: пока её не было, «доложить
-- по одному признанию дважды» ловил только инвариант `shortfall_overfunded` и
-- только постфактум, сложением по клиенту за всю историю.
--
-- Частичный уникальный индекс, а не триггер: правило выражается ключом, а
-- ключевые правила в этой схеме держит индекс (`payout_one_active_per_tranche`,
-- инвариант 9). В отличие от сложения постфактум он работает и на записи,
-- пришедшей мимо `appendEntry`.
CREATE UNIQUE INDEX ledger_entry_shortfall_funded_once
  ON sdelka.ledger_entry (funds_recognised_entry_id)
  WHERE funds_recognised_entry_id IS NOT NULL;

COMMENT ON INDEX sdelka.ledger_entry_shortfall_funded_once IS
  'Одно признание недостачи закрывается ровно одним довнесением.';
