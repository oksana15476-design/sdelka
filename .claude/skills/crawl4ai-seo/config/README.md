# Config

## Global defaults

Базовый файл: `config/defaults.example.json`.

Локальный override (только если нужны изменения на этой машине):

```bash
cp config/defaults.example.json config/defaults.json
```

Не клади в defaults домен, seed URL, project клиента. Это идёт через launch params.

## Launch params

Минимальный пример:

```json
{
  "target": { "domain": "https://example.com" },
  "job": { "project": "client-a", "label": "site-inventory" },
  "seed": { "limit": 150 },
  "crawl": { "max_urls": 60 }
}
```

Передаются через `--params` в `init_job.py`, `seed_urls.py`, `crawl_batch.py`.

## Проверка окружения

```bash
python3 scripts/doctor.py
```

Проверяет: uv, Python 3.10+, crawl4ai, playwright, chromium runtime, config.

## Установка runtime

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python "crawl4ai>=0.8,<0.9" playwright beautifulsoup4
.venv/bin/python -m playwright install chromium
python3 scripts/doctor.py
```

## Scrape.do fallback

В defaults по умолчанию выключен. Включать при необходимости:

```json
{
  "scrapedo": {
    "enabled": true,
    "token_file": "../scrapedo-web-scraper/config/token.txt"
  }
}
```
