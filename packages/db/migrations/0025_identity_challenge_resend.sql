-- 0025 — отметка доставки двигается: одна отправка на учётную запись за окно.
--
-- ## Что здесь меняется и почему это миграция, а не правка кода
--
-- `0024` оставил поток запросов «пришлите код» открытым и назвал это прямо:
-- «ограничения частоты выдачи здесь нет, развилка вынесена в
-- `DECISIONS-REVIEW.md` §Z2». Развилка решена вариантом Б — ограничение в
-- домене, не более одного живого вызова на учётную запись, состояние в самой
-- записи вызова (`auth/src/code-request.ts`). Своей таблицы у ограничения нет и
-- не заводится: считать окно есть по чему — по `delivered_at`.
--
-- Считать по нему мешало ровно одно правило, и оно жило здесь, в триггере:
-- **отметка доставки ставилась один раз**. Довод `0024` был «переписанная
-- отметка врёт о том, когда человеку сообщили», и он верен для вопроса
-- «доставляли ли вообще». Но окно повторной отправки спрашивает другое —
-- «когда сообщили **последний** раз», — и по неподвижной отметке ответ на него
-- неверен: разница с ней только растёт, то есть окно открывается один раз и
-- больше не закрывается никогда. Ограничение, посчитанное так, не ограничивает
-- ничего, и хуже того — выглядит работающим.
--
-- Поэтому отметка становится **монотонной**: двигается только вперёд и не
-- снимается. Прежний довод при этом сохраняется целиком — переписать её назад
-- или стереть по-прежнему нельзя, и «код уходил в канал не раньше, чем сказано»
-- остаётся правдой. Меняется только смысл: не «первая доставка», а «последняя».
--
-- ## Чего здесь нет
--
-- **Нового индекса.** Ограничению нужен самый свежий вызов записи —
-- `WHERE account_id = $1 ORDER BY issued_at DESC LIMIT 1`, — и его обслуживает
-- `identity_challenge_account (account_id, issued_at)` из `0024` обратным
-- проходом по дереву. Второй индекс той же пары колонок в обратном порядке
-- ничего бы не ускорил и стоил бы записи на каждой вставке.
--
-- **Счётчика отправок.** Число окна — временное и живёт в коде
-- (`PROVISIONAL_CODE_REQUEST_CLOCK`, §Z2 **[открыто]**). Зашитое в схему, оно
-- потребовало бы миграции на каждый ответ владельца.

SET LOCAL ROLE sdelka_owner;

CREATE OR REPLACE FUNCTION sdelka.assert_identity_challenge_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Принятый код второй раз не принимается: после отметки строка не меняется
  -- вовсе. Иначе «однократность» была бы полем, которое кто-то перепишет назад.
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'auth.identity.challenge_consumed'
      USING ERRCODE = '23514', DETAIL = format('challenge_id=%s', OLD.challenge_id);
  END IF;

  IF NEW.challenge_id IS DISTINCT FROM OLD.challenge_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     -- Срок продлению не подлежит: продлеваемый срок — не срок. Повторная
     -- отправка того же кода срока не двигает: это та же строка, а не новая.
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts THEN
    RAISE EXCEPTION 'db.auth.challenge_immutable'
      USING ERRCODE = '23514', DETAIL = format('challenge_id=%s', OLD.challenge_id);
  END IF;

  -- Счётчик попыток идёт только вперёд. Обнуление — это снятие ограничения
  -- подбора одним `UPDATE`, и заметить его потом было бы нечем. Повторный
  -- запрос кода тем более его не возвращает: он не обновляет строку вовсе.
  IF NEW.attempts_used < OLD.attempts_used THEN
    RAISE EXCEPTION 'db.auth.challenge_attempts_regression'
      USING ERRCODE = '23514', DETAIL = format('challenge_id=%s', OLD.challenge_id);
  END IF;

  -- Отметка доставки идёт только вперёд и не снимается. Назад — это ложь о
  -- том, когда человеку сообщили; в `NULL` — стирание следа отправки, за
  -- которую мы заплатили. Вперёд — повторная отправка того же кода, и окно
  -- считается от неё.
  IF OLD.delivered_at IS NOT NULL
     AND (NEW.delivered_at IS NULL OR NEW.delivered_at < OLD.delivered_at) THEN
    RAISE EXCEPTION 'db.auth.challenge_immutable'
      USING ERRCODE = '23514', DETAIL = format('challenge_id=%s', OLD.challenge_id);
  END IF;

  RETURN NEW;
END
$$;
