# Alice efficiency / Share of Voice

Раздел Webmaster «Эффективность → Алиса (нейросетевой поиск)»: показывает долю
показов сайта в ответах Алисы (Share of Voice), список конкурентов в нише,
а также примеры запросов — где наш сайт присутствует и где отсутствует.

## Особенность: нет публичного API

Endpoint'ов в Webmaster API v4 для этих данных **нет** (проверено: `/v4/...`,
`/gate/alice/`, `/gate/sov/` — все 404 либо отсутствуют в схеме).

Данные приходят **только при SSR-рендере** HTML-страницы:

```
https://webmaster.yandex.ru/site/{host_id}/efficiency/alice/
```

В HTML встроен `<script>window._initData = {...}</script>` — там лежит весь
объект `alice` целиком. Параметры query (`tab`, `tableType`, `onlyWithMySites`)
управляют только клиентским отображением — переключение вкладок не делает
дополнительных запросов. Поэтому **одного fetch'а достаточно**, дальше парсим
четыре среза локально.

## Авторизация

Через cookie `Session_id` обычной браузерной сессии Яндекса. См. установку
в [config/README.md](../config/README.md). OAuth-токен Webmaster для Alice
не подходит.

## Использование

```bash
# Короткая сводка (по умолчанию)
bash scripts/alice.sh --host metallik.ru

# Share of Voice — 12 недельных точек
bash scripts/alice.sh --host metallik.ru --action sov

# Топ сайтов в нише по версии Алисы
bash scripts/alice.sh --host metallik.ru --action competitors

# Запросы где наш сайт встречается в ответах
bash scripts/alice.sh --host metallik.ru --action with-site

# Запросы где наш сайт НЕ встречается (= упущенный спрос)
bash scripts/alice.sh --host metallik.ru --action without-site

# Принудительно перекачать страницу (минуя кеш)
bash scripts/alice.sh --host metallik.ru --action fetch
bash scripts/alice.sh --host metallik.ru --action sov --no-cache
```

Принимает либо `--host <domain>` (поиск по `cache/hosts.tsv`), либо
`--host-id <id>` (формат `https:metallik.ru:443`). Если используете `--host` —
сначала выполните `bash scripts/hosts.sh` хотя бы один раз, чтобы наполнился
hosts кеш.

## Кеш

Скрипт делает **один сетевой запрос** на хост и сохраняет распарсенный
объект `alice` в:

```
cache/host_<host_id>/alice/init.json
```

Все последующие действия (`sov`, `competitors`, `with-site`, `without-site`,
`summary`) читают из кеша. Чтобы перекачать — добавь `--no-cache` или вызови
`--action fetch`.

TSV-файлы (генерируются по запросу действия):
- `sov.tsv` — `date_from / date_to / share / share_pct`
- `competitors.tsv` — `rank / url`
- `with_site.tsv` — `query / rank / host / url / title`
- `without_site.tsv` — `query / rank / host / url / title`

## Структура `_initData.alice`

```jsonc
{
  "viewModel": { "tableType": "EXAMPLES", "onlyWithMySites": "ON" },
  "alertType": "TOP3",                       // тип бейджа
  "sov": [
    {
      "dateFrom": "2026-01-12",
      "dateTo":   "2026-01-18",
      "sharePercent": 0.6659699980555219      // доля 0..1
    }
    // ... 12 недельных точек, ~3 месяца
  ],
  "queries": {
    "GENERAL": [                              // топ-10 сайтов в нише
      { "url": "https://www.ivd.ru", "favicon": "..." }
    ],
    "EXAMPLES": {
      "hasOwnExamples": [                     // запросы где есть наш сайт
        {
          "query": "шибер это что",
          "urls": [
            {
              "url":   "https://metallik.ru/articles/...",
              "title": "Шибер для дымохода ...",
              "host":  "https://metallik.ru",
              "favicon": "..."
            }
          ]
        }
      ],
      "noOwnExamples": [ /* такая же форма */ ]
    }
  }
}
```

## Что считать ошибкой

| Симптом | Причина |
|---------|---------|
| `Error: HTTP 4xx ...` от `urlopen` | network/proxy/DNS |
| `userIsAuth=false ...` | Session_id протух — обновить из браузера |
| `init._initData.alice missing — page changed or wrong host` | host_id не существует, либо у сайта нет данных Alice (новый сайт), либо вёрстка изменилась |
| `window._initData not found` | сильное изменение HTML или антибот-страница |

## Хрупкость и план миграции

Это **scraping** SSR-страницы, не API. Любое изменение вёрстки Webmaster
ломает парсер. Для повышения надёжности нужно: повторные попытки с jitter,
обработка антибот-капчи, сохранение сырого HTML рядом с JSON для отладки,
а в перспективе — переезд на тот же `webmaster_raw_get` стиль (curl + temp file
+ retry на 429), как сделано для остальных скриптов скилла. Issue по миграции
заведено в репозитории.
