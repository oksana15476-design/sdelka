# Workflow Recipes

## 1. Site Inventory (полный аудит)

**Цель:** понять структуру сайта, типы страниц, шаблоны, масштаб.

**Когда:** первое знакомство с сайтом клиента, старт SEO-проекта.

```bash
python3 scripts/init_job.py --domain https://example.com --project client-a --label site-inventory
python3 scripts/seed_urls.py --job-id <job_id>
uv run --script scripts/crawl_batch.py --job-id <job_id>
```

**Что анализировать:**
- `pages.ndjson` — полный on-page inventory
- `links.ndjson` — граф внутренних ссылок
- `summary.json` — сводка: сколько страниц, success/fail, links

**SEO-вопросы, на которые отвечает:**
- Сколько реально живых страниц на сайте?
- Какие типы страниц существуют (категории, товары, статьи)?
- Есть ли массовые проблемы с title/H1/canonical?
- Какова средняя глубина URL?

## 2. Landing Comparison

**Цель:** сравнить shortlist страниц по on-page сигналам.

**Когда:** анализ посадочных из рекламы, сравнение своих страниц с конкурентами.

```bash
uv run --script scripts/crawl_batch.py \
  --domain https://example.com \
  --label serp-shortlist \
  --url https://example.com/page-a \
  --url https://competitor.com/page-b

python3 scripts/compare_pages.py --job-id <job_id> --top 20
```

**SEO-вопросы:**
- У кого лучше title/H1 под целевой запрос?
- Кто использует canonical корректно?
- У кого больше внутренних ссылок на страницу?
- Где больше контента (word count)?

## 3. Yandex Search API → Crawl4AI

**Цель:** взять топ выдачи и разобрать, что лежит на ранжирующихся страницах.

**Порядок:**
1. `yandex-search-api` → получи SERP shortlist по целевому запросу
2. `crawl4ai-seo` → прогони ранжирующиеся URL
3. Сравни: title patterns, content depth, internal link support, шаблоны

**SEO-вопросы:**
- Что общего у страниц в топ-10? (title формула, H1 паттерн, word count)
- Какие страницы топа поддержаны сильной перелинковкой?
- Есть ли у конкурентов breadcrumbs / schema markup?

## 4. Yandex Metrika → Crawl4AI

**Цель:** проверить on-page quality страниц, которые реально получают органический трафик.

**Порядок:**
1. `yandex-metrika` → возьми top organic landing pages
2. `crawl4ai-seo` → прогони именно эти URL
3. Сопоставь трафик/конверсии с on-page structure

**SEO-вопросы:**
- Какие трафиковые страницы слабо поддержаны перелинковкой?
- Какие low-conversion pages имеют слабый title/H1?
- Есть ли среди топ-лендингов страницы без breadcrumbs?

## 5. Yandex Webmaster → Crawl4AI

**Цель:** сравнить индексацию с реальным содержимым.

**Порядок:**
1. `yandex-webmaster` → получи indexed pages, excluded pages, search queries
2. `crawl4ai-seo` → прогони site inventory
3. Сравни: что проиндексировано vs что реально есть, что исключено и почему

**SEO-вопросы:**
- Есть ли страницы в индексе, которых нет в sitemap?
- Есть ли страницы с noindex, которые получают трафик?
- Совпадает ли crawled inventory с indexed count?

## 6. Navigation Audit (полный)

**Цель:** найти структурные проблемы навигации сайта.

**Порядок:**
1. Seed + crawl (workflows 1)
2. Navigation report:
   ```bash
   python3 scripts/build_navigation_report.py \
     --seed-job-id <seed_job_id> \
     --crawl-job-id <crawl_job_id> \
     --report-dir reports/<project>/nav-audit
   ```

**Артефакты отчёта:**
- `navigation-audit-report.md` — markdown с findings и примерами
- `issues.csv` — все найденные проблемы (orphans, weak links, breadcrumbs, junk)
- `page-inventory.csv` — полная таблица страниц с метриками
- `linked-but-not-seeded.txt` — URL, которые линкуются, но нет в sitemap

## 7. Fallback через Scrape.do

При блокировке browser crawl:
1. Зафиксируй, что crawl4ai не прошёл (status code, error в manifest)
2. Используй `scrapedo-web-scraper` для получения HTML заблокированных страниц
3. Сохрани результат в manifest как fallback-sourced

Fallback зарезервирован в архитектуре, но требует отдельной валидации.
