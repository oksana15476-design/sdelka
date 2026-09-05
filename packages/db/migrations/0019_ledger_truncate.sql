-- 0019 — журнал не опустошается: append-only ловит и `TRUNCATE`.
--
-- `0002` ставит два контура: гранты (роль приложения не получает
-- `UPDATE`/`DELETE`) и триггер `forbid_ledger_mutation`, объявленный как
-- ловящий «и владельца, который грантом не ограничен». Второй контур этого не
-- делал: построчный триггер в PostgreSQL на `TRUNCATE` **не срабатывает** —
-- `TRUNCATE` вызывает только операторные триггеры (`FOR EACH STATEMENT`), а их
-- в схеме не было ни одного.
--
-- Следствие шире, чем «строки исчезли». `TRUNCATE` — единственный путь записи,
-- обходящий **все** отложенные проверки журнала разом: опустошить
-- `ledger_posting`, оставив `ledger_entry`, значит получить записи без
-- проводок, ни одна из которых не пройдёт через `assert_entry_balanced`, — он
-- вешается на вставку и на изменение строк, а `TRUNCATE` не является ни тем,
-- ни другим.
--
-- Функция та же (`sdelka.forbid_ledger_mutation`): ключ ошибки у нарушения
-- один, и `TG_OP` в подробностях назовёт `TRUNCATE`.
--
-- ⚠ Тот же пробел есть у `sdelka.audit_record` (`0007`), и он **не** закрыт
-- здесь намеренно: журнал аудита — предмет отдельной находки, и чинить его
-- заодно значило бы разложить одно правило по двум местам.

SET LOCAL ROLE sdelka_owner;

CREATE TRIGGER forbid_ledger_entry_truncate
  BEFORE TRUNCATE ON sdelka.ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION sdelka.forbid_ledger_mutation();

CREATE TRIGGER forbid_ledger_posting_truncate
  BEFORE TRUNCATE ON sdelka.ledger_posting
  FOR EACH STATEMENT EXECUTE FUNCTION sdelka.forbid_ledger_mutation();
