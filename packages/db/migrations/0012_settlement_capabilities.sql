-- 0012 — пять полномочий операционной механики расчёта: **только метки перечня**.
--
-- `packages/auth` завёл `prepare_settlement`, `record_bank_outcome`,
-- `operate_treasury`, `conduct_withdrawal` и `patch_tranche_facts`
-- (`ACTORS.md` §5.1.1). До них семь шагов приложения — выдача инструкций,
-- отнесение поступления, исход платёжного провайдера, зачисление по выписке,
-- конвертация, довнесение недостачи, заявка на вывод — выполнялись под
-- **чужим** полномочием `create_deal`: своего у них не было ни в документе, ни
-- в этом перечне, а односторонняя правка любой из двух сторон развалила бы
-- гранты (`sdelka.auth_grant` ссылается на `sdelka.auth_capability`).
--
-- **Метки дописываются в конец** — `ALTER TYPE … ADD VALUE` иначе не умеет, а
-- порядок меток обязан совпасть с массивом `CAPABILITIES`: порядок виден в
-- `ORDER BY`, и разошедшаяся сортировка ничем себя не выдаёт. Та же оговорка
-- стоит у `0011` и у `application_card` в `0009`.
--
-- **Почему это отдельная миграция от засева справочника.** Начиная с Postgres 12
-- `ALTER TYPE … ADD VALUE` внутри транзакции допустим, но **использовать**
-- новую метку в той же транзакции нельзя («unsafe use of new value of enum
-- type»). Раннер выполняет каждый файл одной транзакцией (`src/migrate.ts`),
-- поэтому строки справочника и гранты ролей заводит `0013`. Разбить надо было
-- именно так: обратный порядок не собрался бы вовсе.

SET LOCAL ROLE sdelka_owner;

-- packages/auth: CAPABILITIES (`ACTORS.md` §5.1.1)
ALTER TYPE sdelka.capability ADD VALUE 'prepare_settlement';
ALTER TYPE sdelka.capability ADD VALUE 'record_bank_outcome';
ALTER TYPE sdelka.capability ADD VALUE 'operate_treasury';
ALTER TYPE sdelka.capability ADD VALUE 'conduct_withdrawal';
ALTER TYPE sdelka.capability ADD VALUE 'patch_tranche_facts';
