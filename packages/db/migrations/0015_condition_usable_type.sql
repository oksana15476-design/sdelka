-- 0015 — годный тип условия: ограничение догоняет `isUsableReleaseCondition`.
--
-- `0004_deal_tranche.sql` называет `condition_act_usable_type` «зеркалом
-- `isUsableReleaseCondition`», но зеркалит половину: SQL отвергал один
-- `registration_preliminary`, а доменная функция отвергает **два** значения —
-- она требует `!requiresConfirmation` И `sourceImplemented`
-- (`domain/src/release-condition.ts`), а у `calendar_date`
-- `sourceImplemented: false`. Проба на живой базе: акт с `calendar_date`
-- вставлялся, то есть транш законно открывал приём средств под условие, по
-- которому расчёт невозможен никогда — ни наблюдения `L3` от
-- `time.independent_timestamp` не производит ни одна строка кода, ни пяти полей
-- выписки у календарной даты не бывает вовсе.
--
-- Это ровно тот дрейф, ради которого правило и заведено: код отвергает, база
-- принимает и молчит. Деньги при этом уже лежат у нас.
--
-- **Форма списка — «годные», а не «негодные», и это решение.** Перечисление
-- запрещённых значений означает, что метка, дописанная в
-- `sdelka.release_condition_type` завтра, проходит по умолчанию. Здесь
-- умолчание обязано быть отказом: непроверенное условие — видимый отказ, а не
-- тихое разрешение (`STATE-MACHINES.md` §8). Список сверяется с
-- `RELEASE_CONDITION_TYPES.filter(isUsableReleaseCondition)` тестом дрейфа,
-- поэтому подтверждённый владельцем тип не останется забытым: тест упадёт в
-- тот же день.

SET LOCAL ROLE sdelka_owner;

ALTER TABLE sdelka.condition_act DROP CONSTRAINT condition_act_usable_type;

ALTER TABLE sdelka.condition_act ADD CONSTRAINT condition_act_usable_type CHECK (
  condition_type IN (
    'registration_transfer'
  )
);

COMMENT ON CONSTRAINT condition_act_usable_type ON sdelka.condition_act IS
  'Зеркало isUsableReleaseCondition: !requiresConfirmation AND sourceImplemented.';
