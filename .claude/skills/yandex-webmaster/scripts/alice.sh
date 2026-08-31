#!/bin/sh
# Yandex Webmaster — Alice (Share of Voice) efficiency
#
# Усложнение: данных по Alice нет в Webmaster API v4. Они приходят только в HTML
# через window._initData при SSR. Авторизация — через cookie Session_id.
# Cм. references/ALICE_EFFICIENCY.md.
#
# Usage:
#   alice.sh --host <domain> --action <action> [--no-cache]
#   alice.sh --host-id <id>  --action <action> [--no-cache]
#
# Actions:
#   summary       — короткая сводка (alertType, SoV, размеры списков). По умолчанию.
#   sov           — Share-of-Voice timeline (12 недель), TSV
#   competitors   — топ сайтов в Alice по теме, TSV
#   with-site     — запросы где наш сайт присутствует, TSV
#   without-site  — запросы где наш сайт отсутствует, TSV
#   fetch         — форс-обновить кеш и распечатать сводку

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"
load_config

if [ -z "$SESSION_ID" ]; then
    echo "Error: SESSION_ID not set in config/.env." >&2
    echo "Достаньте Session_id из браузера (DevTools → Application → Cookies → yandex.ru)." >&2
    echo "См. references/ALICE_EFFICIENCY.md." >&2
    exit 1
fi

parse_host_params "$@"

ACTION_DEFAULT="summary"
[ -z "$ACTION" ] && ACTION="$ACTION_DEFAULT"

# Resolve host (host search needs API call → user_id)
if [ -z "$HOST_ID" ] && [ -n "$HOST_SEARCH" ]; then
    ensure_user_id
fi
resolve_host
require_host

# Map action → python subcommand
case "$ACTION" in
    summary|sov|competitors|fetch) PY_CMD="$ACTION" ;;
    with-site)    PY_CMD="with-site" ;;
    without-site) PY_CMD="without-site" ;;
    *)
        echo "Error: unknown --action '$ACTION'" >&2
        echo "Valid: summary | sov | competitors | with-site | without-site | fetch" >&2
        exit 1
        ;;
esac

# Cache invalidation: --no-cache forces refresh
if [ -n "$NO_CACHE" ] && [ "$PY_CMD" != "fetch" ]; then
    _alice_cache="$CACHE_DIR/host_$(printf '%s' "$HOST_ID" | sed 's/[^a-zA-Z0-9._-]/_/g')/alice/init.json"
    rm -f "$_alice_cache"
fi

SESSION_ID="$SESSION_ID" exec python3 "$SCRIPT_DIR/alice_efficiency.py" \
    --host-id "$HOST_ID" \
    --cache-dir "$CACHE_DIR" \
    "$PY_CMD"
