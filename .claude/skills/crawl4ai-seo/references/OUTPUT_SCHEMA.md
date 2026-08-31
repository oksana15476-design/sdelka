# Output Schema

## Cache Layout

```text
cache/jobs/<job_id>/
  launch_params.json      # raw launch params этого запуска
  resolved_config.json    # effective config (defaults + params merge)
  manifest.json           # operational state и artifact paths
  seed.json               # seed URLs и метаданные discovery
  pages.ndjson            # одна JSON-строка на страницу
  links.ndjson            # одна JSON-строка на link edge
  summary.json            # компактная сводка crawl run
  markdown/               # saved page content in markdown

cache/sites/<site_slug>/jobs/<job_id>.json   # site index pointer
```

## pages.ndjson

Одна JSON-строка на crawled страницу. Поля:

| Поле | Тип | Описание |
|------|-----|----------|
| `url` | string | Нормализованный URL страницы |
| `domain` | string | Домен |
| `path_depth` | int | Глубина URL (число сегментов пути) |
| `success` | bool | Успешно ли прошёл crawl |
| `status_code` | int | HTTP status code |
| `title` | string | `<title>` tag |
| `description` | string | `<meta name="description">` |
| `canonical` | string | `<link rel="canonical">` |
| `keywords` | string | `<meta name="keywords">` |
| `robots` | string | `<meta name="robots">` |
| `og_title` | string | `og:title` |
| `og_description` | string | `og:description` |
| `og_image` | string | `og:image` |
| `h1` | string | Первый H1 на странице |
| `headings` | list | Все заголовки H1-H6 |
| `word_count` | int | Количество слов контента |
| `has_breadcrumbs` | bool | Есть ли breadcrumb-блок |
| `breadcrumb_texts` | list | Тексты breadcrumb звеньев |
| `breadcrumb_urls` | list | URL breadcrumb звеньев |
| `nav_block_count` | int | Количество nav-блоков |
| `nav_link_count` | int | Количество ссылок в nav-блоках |
| `nav_urls_sample` | list | Sample внутренних URL из nav |
| `nav_texts_sample` | list | Sample текстов nav-ссылок |
| `internal_links_count` | int | Исходящие внутренние ссылки |
| `external_links_count` | int | Исходящие внешние ссылки |
| `markdown_path` | string | Путь к сохранённому markdown |
| `fit_markdown_path` | string | Путь к fit markdown |
| `run_id` | string | ID запуска (= job_id) |

Не все поля гарантированы. Если crawl4ai не вернул значение — `null`.

## links.ndjson

Одна JSON-строка на link edge.

| Поле | Тип | Описание |
|------|-----|----------|
| `source_url` | string | Страница-источник ссылки |
| `target_url` | string | Целевой URL |
| `target_domain` | string | Домен целевого URL |
| `kind` | string | `internal` / `external` |
| `anchor_text` | string | Текст ссылки |
| `nofollow` | bool | Есть ли rel="nofollow" |
| `same_domain` | bool | Совпадает ли домен source и target |
| `run_id` | string | ID запуска |

## summary.json

| Поле | Описание |
|------|----------|
| `job_id` | ID запуска |
| `domain` | Домен |
| `requested_urls` | Сколько URL было запрошено |
| `crawled_ok` | Успешно crawled |
| `crawled_failed` | Не удалось crawl |
| `internal_links` | Всего internal link edges |
| `external_links` | Всего external link edges |

## seed.json

| Поле | Описание |
|------|----------|
| `job_id` | ID запуска |
| `domain` | Домен |
| `sources` | Откуда собраны URL (robots.txt, sitemap.xml, файл) |
| `url_count` | Количество seed URL |
| `urls` | Список URL |

## Output Hygiene

- stdout: только preview и пути к файлам
- Полные данные: только в job files
- HTML по умолчанию не хранится
- Markdown хранится если `output.store_markdown: true`
