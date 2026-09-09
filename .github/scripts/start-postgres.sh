#!/usr/bin/env bash
# Живой Postgres для интеграционных наборов непрерывной проверки.
#
# ## Почему контейнер поднимается шагом, а не блоком `services:`
#
# Красная линия №12: секретов в репозитории нет. Пароль тестовой базы обязан
# рождаться внутри прогона и умирать вместе с ним. Блок `services:` требует
# `POSTGRES_PASSWORD` **до** старта работы — то есть литералом в YAML (секрет в
# репозитории) либо значением из хранилища секретов (секрет, который кто-то
# завёл руками и который переживает прогон). Ни то, ни другое не годится для
# базы, живущей четыре минуты.
#
# Поэтому пароль порождается здесь, `openssl rand -hex` — то есть без кавычек,
# слешей и обратных слешей, которые пришлось бы экранировать в SQL и в строке
# подключения, — и сразу помечается для журнала (`::add-mask::`): даже если его
# кто-то случайно напечатает, в логе будет `***`.
#
# ## Что здесь воспроизводится
#
# Ровно раскладка ролей из `packages/db/scripts/dev-db.sh`, потому что на ней
# стоят интеграционные наборы, а не потому, что так удобнее:
#
#   * `sdelka_owner` — владелец объектов схемы, под ним идут миграции;
#   * `sdelka_app` — роль приложения, **не** член роли владельца: инвариант 21
#     («роль приложения не имеет прав на изменение и удаление журнала аудита»)
#     проверяется грантами, а не кодом, и проверить его можно только на базе,
#     где это разделение действительно есть;
#   * логин-роль — член обеих: она и применяет миграции, и играет приложение
#     через `SET ROLE`.
#
# `CREATEDB` у логин-роли нужен набору наката (`migrate.int.test.ts`): «чистая
# база накатывается целиком» проверяется на базе, которую можно создать и
# выбросить. Роли приложения это не касается ничем.
#
# Строка подключения содержит пароль и поэтому не печатается и не кладётся в
# `$GITHUB_OUTPUT` (выводы работ видны в интерфейсе). Она уходит в `$GITHUB_ENV`
# — окружение последующих шагов той же работы.
set -euo pipefail

IMAGE="${SDELKA_CI_PG_IMAGE:-postgres:16}"
CONTAINER="${SDELKA_CI_PG_CONTAINER:-sdelka-ci-postgres}"
HOST_PORT="${SDELKA_CI_PG_PORT:-5432}"
DB_NAME=sdelka_ci
DB_USER=sdelka_ci

if [ -z "${GITHUB_ENV:-}" ]; then
  echo "start-postgres: GITHUB_ENV не задан — некуда положить строку подключения." >&2
  echo "Вне GitHub Actions запускать так: GITHUB_ENV=/tmp/ci.env .github/scripts/start-postgres.sh" >&2
  exit 2
fi

# Пароль суперпользователя контейнера и пароль логин-роли — разные: наружу
# (в `SDELKA_DATABASE_URL`) уходит только вторая, а суперпользователь остаётся
# доступен лишь изнутри контейнера, через `docker exec`.
SUPER_PASSWORD="$(openssl rand -hex 24)"
APP_PASSWORD="$(openssl rand -hex 24)"
echo "::add-mask::${SUPER_PASSWORD}"
echo "::add-mask::${APP_PASSWORD}"

docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true

docker run -d \
  --name "${CONTAINER}" \
  -e POSTGRES_PASSWORD="${SUPER_PASSWORD}" \
  -p "127.0.0.1:${HOST_PORT}:5432" \
  "${IMAGE}" \
  -c fsync=off -c full_page_writes=off -c synchronous_commit=off >/dev/null
# Долговечность записи тестовой базе не нужна: контейнер живёт один прогон.
# Отключение синхронной записи экономит на наборах с сотнями транзакций больше,
# чем всё остальное в этой работе вместе взятое.

printf 'Postgres (%s) поднимается' "${IMAGE}"
ready=0
for _ in $(seq 1 60); do
  if docker exec "${CONTAINER}" pg_isready -q -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  printf '.'
  sleep 1
done
printf '\n'
if [ "${ready}" != 1 ]; then
  echo "start-postgres: контейнер не принял соединения за 60 секунд." >&2
  docker logs "${CONTAINER}" >&2 || true
  exit 1
fi

# Пароль передаётся psql переменной и подставляется через `:'pw'` — psql
# экранирует её сам. Склейка строк с паролем внутри SQL здесь не используется
# намеренно: она ломается на первом же символе кавычки.
docker exec -i \
  -e PGPASSWORD="${SUPER_PASSWORD}" \
  "${CONTAINER}" \
  psql -v ON_ERROR_STOP=1 -U postgres -q -v pw="${APP_PASSWORD}" -f - <<SQL
CREATE ROLE sdelka_owner NOLOGIN;
CREATE ROLE sdelka_app NOLOGIN;
CREATE ROLE ${DB_USER} LOGIN NOSUPERUSER NOCREATEROLE PASSWORD :'pw';
GRANT sdelka_owner TO ${DB_USER};
GRANT sdelka_app TO ${DB_USER};
ALTER ROLE ${DB_USER} CREATEDB;
CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
SQL

echo "SDELKA_DATABASE_URL=postgresql://${DB_USER}:${APP_PASSWORD}@127.0.0.1:${HOST_PORT}/${DB_NAME}" >>"${GITHUB_ENV}"
echo "Postgres готов: роли sdelka_owner/sdelka_app заведены, база ${DB_NAME} создана."
echo "Строка подключения положена в окружение работы (в журнал не печатается)."
