#!/usr/bin/env bash
# Локальный кластер для интеграционных тестов.
#
# Секретов здесь нет и быть не может (красная линия №12): пароль логин-роли
# берётся из окружения (`SDELKA_DB_PASSWORD`), а если его не задали — роль
# создаётся под peer-аутентификацию по имени пользователя ОС.
#
# Что делает:
#   1. поднимает кластер, если он не поднят;
#   2. заводит групповые роли `sdelka_owner` и `sdelka_app` (без входа, без пароля);
#   3. заводит логин-роль `sdelka_dev` и включает её в обе групповые;
#   4. создаёт базу `sdelka_dev`;
#   5. печатает строку подключения, которую надо положить в SDELKA_DATABASE_URL.
#
# Роль приложения намеренно **не** член роли владельца: на этом стоит инвариант
# 21 (`FUNCTIONAL.md` §2). Логин-роль член обеих, потому что она и применяет
# миграции (как владелец), и играет приложение в тестах (`SET ROLE sdelka_app`).
set -euo pipefail

DB_NAME="${SDELKA_DB_NAME:-sdelka_dev}"
DB_USER="${SDELKA_DB_USER:-sdelka_dev}"
DB_HOST="${SDELKA_DB_HOST:-127.0.0.1}"
DB_PORT="${SDELKA_DB_PORT:-5432}"
CLUSTER="${SDELKA_PG_CLUSTER:-16 main}"

if ! pg_isready -q; then
  # shellcheck disable=SC2086
  pg_ctlcluster ${CLUSTER} start
fi

psql_super() { su postgres -c "psql -v ON_ERROR_STOP=1 -qAt -c \"$1\""; }

psql_super "DO \\\$\\\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sdelka_owner') THEN CREATE ROLE sdelka_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sdelka_app') THEN CREATE ROLE sdelka_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN CREATE ROLE ${DB_USER} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF;
END \\\$\\\$;"

if [ -n "${SDELKA_DB_PASSWORD:-}" ]; then
  psql_super "ALTER ROLE ${DB_USER} PASSWORD '${SDELKA_DB_PASSWORD}'"
fi

psql_super "GRANT sdelka_owner TO ${DB_USER}"
psql_super "GRANT sdelka_app TO ${DB_USER}"

# Право заводить базы — для набора миграций (`test/int/migrate.int.test.ts`).
# Накат нельзя проверить на общей базе: «чистая база накатывается целиком» и
# «частично накаченная продолжает с нужного места» требуют базы, которую можно
# привести в нужное состояние и выбросить. Схема в миграциях названа поимённо
# (`sdelka.`), поэтому изоляция схемой не годится — только отдельной базой.
#
# Роли приложения это не касается ничем: право у **логин-роли локального
# кластера**, `sdelka_app` остаётся без входа, без владения и без прав на
# журналы (инвариант 21). На стенде и в проде эта строка не выполняется — там
# нет ни этого скрипта, ни этой роли.
psql_super "ALTER ROLE ${DB_USER} CREATEDB"

if [ "$(su postgres -c "psql -qAt -c \"SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'\"")" != "1" ]; then
  psql_super "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}"
fi

if [ -n "${SDELKA_DB_PASSWORD:-}" ]; then
  echo "postgresql://${DB_USER}:${SDELKA_DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
else
  echo "postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
fi
