#!/usr/bin/env python3
"""Yandex Webmaster — Alice (Share of Voice) efficiency extractor.

Не имеет публичного API: данные приходят в HTML через window._initData при SSR.
Авторизация — через cookie Session_id (длинноживущая, httpOnly).

Subcommands:
  fetch       — скачать страницу, извлечь alice.* из _initData, сохранить JSON
  sov         — Share-of-Voice: 12 недельных точек, TSV
  competitors — топ-10 сайтов в Alice (queries.GENERAL), TSV
  with-site   — запросы где наш сайт присутствует (hasOwnExamples), TSV
  without-site — запросы где наш сайт НЕ присутствует (noOwnExamples), TSV
  summary     — короткая сводка alertType + средний SoV + размеры списков

Все subcommand'ы кроме fetch читают из cache JSON; если кеша нет — делают fetch.
"""
import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

# Python.org installs ship without a CA bundle. Try common system locations
# before failing back to Python defaults (which may also be empty).
_CA_CANDIDATES = [
    os.environ.get("SSL_CERT_FILE", ""),
    "/etc/ssl/cert.pem",                          # macOS, FreeBSD
    "/etc/ssl/certs/ca-certificates.crt",         # Debian/Ubuntu
    "/etc/pki/tls/certs/ca-bundle.crt",           # RHEL/CentOS
    "/opt/homebrew/etc/ca-certificates/cert.pem", # Homebrew arm64
    "/usr/local/etc/ca-certificates/cert.pem",    # Homebrew x86_64
]


def _build_ssl_context() -> ssl.SSLContext:
    for path in _CA_CANDIDATES:
        if path and os.path.isfile(path):
            return ssl.create_default_context(cafile=path)
    return ssl.create_default_context()

ALICE_URL_TEMPLATE = (
    "https://webmaster.yandex.ru/site/{host_id}/efficiency/alice/"
    "?tab=GENERAL&tableType=GENERAL&onlyWithMySites=OFF"
)


def fail(msg, code=1):
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(code)


# ---------- HTML fetch ----------

def fetch_html(host_id: str, session_id: str) -> str:
    url = ALICE_URL_TEMPLATE.format(host_id=host_id)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "ru,en;q=0.9",
            "Cookie": f"Session_id={session_id}",
        },
    )
    ctx = _build_ssl_context()
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            charset = resp.headers.get_content_charset() or "utf-8"
            return resp.read().decode(charset, errors="replace")
    except urllib.error.HTTPError as e:
        fail(f"HTTP {e.code} from {url}: {e.reason}")
    except urllib.error.URLError as e:
        fail(f"network error: {e.reason}")


# ---------- _initData extraction ----------

def extract_init_data(html: str) -> dict:
    idx = html.find("window._initData")
    if idx < 0:
        fail("window._initData not found in HTML — session likely expired")
    eq = html.find("=", idx)
    start = html.find("{", eq)
    if start < 0:
        fail("opening brace of _initData not found")

    depth = 0
    in_str = False
    esc = False
    end = -1
    for i in range(start, len(html)):
        ch = html[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
    if end < 0:
        fail("unbalanced braces in _initData")

    raw = html[start:end]
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        fail(f"failed to parse _initData JSON: {e}")


def assert_authed(init_data: dict) -> None:
    if not init_data.get("userIsAuth"):
        fail("userIsAuth=false — Session_id cookie expired or invalid")


# ---------- Cache I/O ----------

def cache_path(cache_dir: str, host_id: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", host_id)
    d = os.path.join(cache_dir, f"host_{safe}", "alice")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "init.json")


def load_or_fetch(args, force=False) -> dict:
    """Returns alice dict, using cache when fresh."""
    path = cache_path(args.cache_dir, args.host_id)
    if not force and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except json.JSONDecodeError:
            pass

    if not args.session_id:
        fail("SESSION_ID is required for fetch (set in config/.env)")

    html = fetch_html(args.host_id, args.session_id)
    init = extract_init_data(html)
    assert_authed(init)

    alice = init.get("alice")
    if not alice:
        fail("init._initData.alice missing — page changed or wrong host")

    with open(path, "w", encoding="utf-8") as f:
        json.dump(alice, f, ensure_ascii=False)
    return alice


# ---------- Output helpers ----------

def write_tsv(rows, path: str):
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            cleaned = ["" if c is None else str(c).replace("\t", " ").replace("\n", " ").replace("\r", " ")
                       for c in row]
            f.write("\t".join(cleaned) + "\n")


def emit_tsv(header, rows, out_path, head=20):
    write_tsv([header] + rows, out_path)
    print("\t".join(header))
    for r in rows[:head]:
        print("\t".join("" if c is None else str(c) for c in r))
    if len(rows) > head:
        print(f"... ({len(rows) - head} more rows, full data in: {out_path})")
    print(f"\nTotal: {len(rows)}")
    print(f"TSV: {out_path}")


# ---------- Subcommands ----------

def cmd_fetch(args):
    alice = load_or_fetch(args, force=True)
    path = cache_path(args.cache_dir, args.host_id)
    print(f"alice keys: {', '.join(alice.keys())}")
    print(f"sov points: {len(alice.get('sov', []))}")
    q = alice.get("queries", {}) or {}
    general = q.get("GENERAL") or []
    examples = q.get("EXAMPLES") or {}
    has = examples.get("hasOwnExamples") or [] if isinstance(examples, dict) else []
    no = examples.get("noOwnExamples") or [] if isinstance(examples, dict) else []
    print(f"competitors (GENERAL): {len(general)}")
    print(f"with-site (hasOwnExamples): {len(has)}")
    print(f"without-site (noOwnExamples): {len(no)}")
    print(f"alertType: {alice.get('alertType')}")
    print(f"cached: {path}")


def cmd_sov(args):
    alice = load_or_fetch(args)
    sov = alice.get("sov") or []
    rows = []
    for p in sov:
        share = p.get("sharePercent")
        rows.append([
            p.get("dateFrom", ""),
            p.get("dateTo", ""),
            f"{share:.4f}" if isinstance(share, (int, float)) else "",
            f"{share * 100:.2f}%" if isinstance(share, (int, float)) else "",
        ])
    out = os.path.join(os.path.dirname(cache_path(args.cache_dir, args.host_id)), "sov.tsv")
    emit_tsv(["date_from", "date_to", "share", "share_pct"], rows, out, head=20)


def cmd_competitors(args):
    alice = load_or_fetch(args)
    general = ((alice.get("queries") or {}).get("GENERAL")) or []
    rows = [[i + 1, item.get("url", "")] for i, item in enumerate(general)]
    out = os.path.join(os.path.dirname(cache_path(args.cache_dir, args.host_id)), "competitors.tsv")
    emit_tsv(["rank", "url"], rows, out, head=20)


def _flatten_examples(items):
    """Each item: {query, urls: [{url,title,host,favicon}]}.
    TSV: query, rank_in_query, host, url, title."""
    rows = []
    for item in items or []:
        q = item.get("query", "")
        urls = item.get("urls") or []
        for i, u in enumerate(urls, start=1):
            rows.append([
                q,
                i,
                u.get("host", ""),
                u.get("url", ""),
                u.get("title", ""),
            ])
    return rows


def cmd_with_site(args):
    alice = load_or_fetch(args)
    ex = ((alice.get("queries") or {}).get("EXAMPLES")) or {}
    items = ex.get("hasOwnExamples") or []
    rows = _flatten_examples(items)
    out = os.path.join(os.path.dirname(cache_path(args.cache_dir, args.host_id)), "with_site.tsv")
    emit_tsv(["query", "rank", "host", "url", "title"], rows, out, head=15)
    print(f"Unique queries: {len(items)}")


def cmd_without_site(args):
    alice = load_or_fetch(args)
    ex = ((alice.get("queries") or {}).get("EXAMPLES")) or {}
    items = ex.get("noOwnExamples") or []
    rows = _flatten_examples(items)
    out = os.path.join(os.path.dirname(cache_path(args.cache_dir, args.host_id)), "without_site.tsv")
    emit_tsv(["query", "rank", "host", "url", "title"], rows, out, head=15)
    print(f"Unique queries: {len(items)}")


def cmd_summary(args):
    alice = load_or_fetch(args)
    sov = alice.get("sov") or []
    shares = [p.get("sharePercent") for p in sov if isinstance(p.get("sharePercent"), (int, float))]
    avg = sum(shares) / len(shares) if shares else 0
    last = shares[-1] if shares else 0
    first = shares[0] if shares else 0
    q = alice.get("queries") or {}
    general = q.get("GENERAL") or []
    ex = q.get("EXAMPLES") or {}
    has = ex.get("hasOwnExamples") or []
    no = ex.get("noOwnExamples") or []
    print(f"alertType:        {alice.get('alertType')}")
    print(f"sov points:       {len(sov)}")
    if sov:
        print(f"sov range:        {sov[0].get('dateFrom')} → {sov[-1].get('dateTo')}")
        print(f"sov first:        {first * 100:.2f}%")
        print(f"sov last:         {last * 100:.2f}%")
        print(f"sov avg:          {avg * 100:.2f}%")
    print(f"competitors:      {len(general)}")
    print(f"with-site qs:     {len(has)}")
    print(f"without-site qs:  {len(no)}")


# ---------- CLI ----------

def build_parser():
    p = argparse.ArgumentParser(description="Yandex Webmaster Alice efficiency (SSR scraper)")
    p.add_argument("--host-id", required=True, help="Host id, e.g. https:metallik.ru:443")
    p.add_argument("--session-id", default=os.environ.get("SESSION_ID", ""),
                   help="Session_id cookie (default: $SESSION_ID)")
    p.add_argument("--cache-dir", required=True, help="Cache directory root")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch", help="force refresh + summary").set_defaults(func=cmd_fetch)
    sub.add_parser("sov", help="Share-of-Voice timeline").set_defaults(func=cmd_sov)
    sub.add_parser("competitors", help="Top sites in Alice").set_defaults(func=cmd_competitors)
    sub.add_parser("with-site", help="queries where own site appears").set_defaults(func=cmd_with_site)
    sub.add_parser("without-site", help="queries where own site is absent").set_defaults(func=cmd_without_site)
    sub.add_parser("summary", help="short summary").set_defaults(func=cmd_summary)
    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
