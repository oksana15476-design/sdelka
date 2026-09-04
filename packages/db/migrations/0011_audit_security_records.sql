-- 0011 — виды записей о безопасности и два новых субъекта журнала.
--
-- `packages/audit` завёл четыре вида записи (`session_established`,
-- `session_denied`, `role_changed`, `setting_changed`) и два субъекта
-- (`account`, `setting`). До них двенадцать видов описывали деньги, решения и
-- просмотр персональных данных: вход, отказ во входе, смена роли и изменение
-- настройки не описывались ни одним, и события `packages/auth` ложиться в
-- журнал не могли (`auth/src/events.ts` называл это расхождение сам).
--
-- Здесь только перечни. **Метки дописываются в конец** — `ALTER TYPE ... ADD
-- VALUE` иначе не умеет, а порядок меток обязан совпасть с массивами в TS:
-- порядок виден в `ORDER BY`, и разошедшаяся сортировка отчёта дежурному ничем
-- себя не выдаёт. Та же оговорка стоит у `application_card` в `0009`.
--
-- Внутри транзакции это допустимо начиная с Postgres 12; новые метки в той же
-- транзакции не используются, поэтому «unsafe use of new value» не возникает.
--
-- **Чего здесь нет.** Проверок тела новых записей (`checkBodyInvariants`,
-- `audit/src/chain.ts`) база не повторяет: вторая реализация тех же правил на
-- PL/pgSQL — это ровно тот дрейф двух моделей, ради отказа от которого `0007`
-- не пересчитывает и `record_hash`. База держит сцепку, нумерацию, монотонность
-- времени и append-only; тело проверяет код на чтении и на записи.
--
-- Ограничения `0007` новым видам ничего не должны: `audit_record_kind_matches_body`
-- сверяет колонку с телом безотносительно вида, ветви `correction` и
-- `timestamp_token` в триггере трогают только свои виды, а `subject_scope` — это
-- сам перечень, который здесь и расширяется. Поэтому `0007` не правится: правка
-- применённой миграции расходится с тем, что стоит на проде, молча.

SET LOCAL ROLE sdelka_owner;

-- packages/audit: AUDIT_RECORD_KINDS
ALTER TYPE sdelka.audit_record_kind ADD VALUE 'session_established';
ALTER TYPE sdelka.audit_record_kind ADD VALUE 'session_denied';
ALTER TYPE sdelka.audit_record_kind ADD VALUE 'role_changed';
ALTER TYPE sdelka.audit_record_kind ADD VALUE 'setting_changed';

-- packages/audit: REF_SCOPES
--
-- `account` — учётная запись, а не `party`: сторона это участник сделки, и
-- запись «вход стороны party-3» через год прочиталась бы как действие по
-- сделке. Сотрудник стороной не бывает вовсе, а входит именно он.
ALTER TYPE sdelka.ref_scope ADD VALUE 'account';
ALTER TYPE sdelka.ref_scope ADD VALUE 'setting';
