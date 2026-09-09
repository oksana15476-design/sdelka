#!/bin/sh
# Роли локального кластера — то же, что делает `packages/db/scripts/dev-db.sh`
# для кластера на машине разработчика, но для Postgres в контейнере.
#
# Зачем это вообще нужно. Миграция `0001` заводит групповые роли `sdelka_owner`
# и `sdelka_app` через `IF NOT EXISTS` и сразу передаёт им владение схемой.
# Логин-роль, от которой идёт накат, обязана быть членом `sdelka_owner` **до**
# наката: `ALTER SCHEMA ... OWNER TO sdelka_owner` от не-члена не проходит. А
# сама логин-роль не может завести групповые роли (она `NOCREATEROLE`
# намеренно). Значит, роли заводит тот, кто заводит кластер, — этот файл.
#
# Одна логин-роль на всё — не упрощение, а решение проекта: разделение прав
# держат групповые роли (`packages/db/src/roles.ts`), а не вторая строка
# подключения, которая рано или поздно разъедется с первой (`db/src/env.ts`).
# Логин-роль `NOSUPERUSER`: суперпользователь обошёл бы гранты журнала аудита
# и превратил инвариант 21 в театр.
#
# Секретов здесь нет (красная линия №12): пароль приходит переменной окружения
# и подставляется в SQL через `:'variable'` — psql сам его закавычивает и
# никуда не печатает. В файле не остаётся ни значения, ни его эха.
#
# Выполняется **один раз** — при первом создании тома с данными. Том уже есть →
# каталог `docker-entrypoint-initdb.d` не читается вовсе (см. `docs/DEPLOY.md`,
# «Как откатиться»).
set -eu

: "${SDELKA_DB_USER:?db.init.user_missing}"
: "${SDELKA_DB_PASSWORD:?db.init.password_missing}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v role="$SDELKA_DB_USER" -v password="$SDELKA_DB_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sdelka_owner') THEN
    CREATE ROLE sdelka_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sdelka_app') THEN
    CREATE ROLE sdelka_app NOLOGIN;
  END IF;
END
$$;

CREATE ROLE :"role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'password';

GRANT sdelka_owner TO :"role";
GRANT sdelka_app   TO :"role";

-- Владение базой — чтобы накат мог создать схему `sdelka`. Право на создание
-- объектов в `public` при этом никому не выдаётся: схема у проекта своя.
ALTER DATABASE :"db" OWNER TO :"role";
SQL
