-- 0023 — семь меток роли журнала: пять непредставленных ролей и два уровня
-- утверждения вместо одного `approver`.
--
-- Перечень `sdelka.audit_role` был восьмизначным против четырнадцати ролей
-- доступа (`packages/auth`, `ROLE_IDS` плюс два нечеловеческих актора). Пять
-- ролей — `oracle_operator`, `compliance_officer`, `principal`, `auditor`,
-- `client_counsel` — не отображались в него **никуда**: действие такой роли
-- записать было нечем, а актор записи обязателен. Практическое следствие было
-- не крайним случаем, а обычным путём: полномочие `manage_settings` есть ровно
-- у `principal`, то есть изменение настройки владельцем не записывалось вовсе
-- (`BACKLOG.md` E16-12, `DECISIONS-REVIEW.md` §K5).
--
-- `approver` при этом покрывал **оба** уровня утверждения. `ACTORS.md` §1
-- расхождение №5 относит это к дефектам, а §5.2 — **[решение]** владельца:
-- `financial_controller` даёт уровень 1, `head_of_operations` — уровень 2, ни
-- одна роль не даёт оба. Запись «утвердил approver» не отвечает на вопрос, кто
-- утвердил, — то есть «четыре глаза» по журналу не доказываются ровно там, ради
-- чего журнал и ведётся.
--
-- ## Дописывание, а не переименование
--
-- Красная линия №11: журнал не редактируется. `ALTER TYPE ... RENAME VALUE`
-- сменил бы прочтение уже записанных строк — прежняя запись начала бы читаться
-- ролью, которой в ней не было; какой из двух уровней за ней стоял, не знает
-- никто. Поэтому `approver` **остаётся** в перечне: под ним читают прежние
-- записи и не делают новых (`RETIRED_AUDIT_ROLES`, `packages/audit`).
--
-- Метки дописываются **в конец** — `ALTER TYPE ... ADD VALUE` иначе не умеет, а
-- порядок обязан совпасть с массивом `AUDIT_ROLES` в TS: порядок меток виден в
-- `ORDER BY`, и разошедшаяся сортировка отчёта дежурному ничем себя не выдаёт.
-- Та же оговорка стоит у `application_card` в `0009` и у видов записей в `0011`.
--
-- Внутри транзакции это допустимо начиная с Postgres 12; новые метки в той же
-- транзакции не используются, поэтому «unsafe use of new value» не возникает.
--
-- ## Чего здесь нет
--
-- 1. **Ни одного `GRANT` и `REVOKE`.** Права роли приложения на журнал аудита
--    правка перечня не трогает: инвариант 21 стоит на грантах `0007` и `0013`,
--    и `sdelka_app` как не мог изменить и удалить запись, так и не может
--    (`test/int/store-grants.int.test.ts` проверяет это живой попыткой).
-- 2. **Ни одного `UPDATE`.** Строки `sdelka.audit_record` не читаются и не
--    трогаются: миграция расширяет тип, а не переписывает записанное.
-- 3. **Переименований `client → party` и `oracle → oracle_source`.** Обе метки
--    соответствие имеют, речь только об имени, и цена переименования — то же
--    переписывание прочтения прежних записей. Развилка вынесена владельцу
--    (`DECISIONS-REVIEW.md` §O1).

SET LOCAL ROLE sdelka_owner;

-- packages/audit: AUDIT_ROLES (порядком `ROLE_IDS` из `packages/auth`)
ALTER TYPE sdelka.audit_role ADD VALUE 'oracle_operator';
ALTER TYPE sdelka.audit_role ADD VALUE 'compliance_officer';
ALTER TYPE sdelka.audit_role ADD VALUE 'financial_controller';
ALTER TYPE sdelka.audit_role ADD VALUE 'head_of_operations';
ALTER TYPE sdelka.audit_role ADD VALUE 'principal';
ALTER TYPE sdelka.audit_role ADD VALUE 'auditor';
ALTER TYPE sdelka.audit_role ADD VALUE 'client_counsel';
