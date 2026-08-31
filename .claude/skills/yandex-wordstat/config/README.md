# Настройка скилла Yandex Wordstat

Скилл поддерживает **два бэкенда**:

| Бэкенд    | Endpoint                                       | Авторизация               | Статус |
|-----------|------------------------------------------------|---------------------------|--------|
| `cloud`   | `searchapi.api.cloud.yandex.net/v2/wordstat/*` | IAM token (Service Account JWT) | Preview, актуальный |
| `legacy`  | `api.wordstat.yandex.net/v1/*`                 | OAuth Bearer              | Deprecated, новых пользователей не подключают |

С 2026 года Яндекс перестал выдавать новые токены для legacy. Старые токены всё ещё работают (бесплатно), но новые установки скилла должны использовать `cloud`.

---

## Cloud mode (рекомендуется для новых установок)

Нужен сервисный аккаунт в Яндекс.Облаке.

### Шаг 1: Создайте каталог в Яндекс.Облаке
1. Откройте https://console.yandex.cloud/
2. Зарегистрируйтесь (нужен Яндекс ID), если ещё нет аккаунта
3. Создайте **каталог** или используйте существующий
4. Скопируйте **ID каталога** (`b1g...`) — он понадобится дальше

### Шаг 2: Создайте сервисный аккаунт
1. В консоли откройте ваш каталог
2. Слева выберите **Сервисные аккаунты** (раздел IAM)
3. Нажмите **Создать сервисный аккаунт**
4. Имя: `wordstat-sa` (или любое)
5. Нажмите **Создать**

### Шаг 3: Назначьте роль
1. Откройте созданный сервисный аккаунт
2. Назначьте роль `search-api.webSearch.user` (та же роль используется для Yandex Search API — см. yandex-search-api скилл)

### Шаг 4: Создайте ключ авторизации
1. В сервисном аккаунте → **Авторизованные ключи** → **Создать**
2. Скачайте JSON-файл
3. Переименуйте в `service_account_key.json`
4. Положите в `config/` (рядом с этим README)

> Файл секретный — он уже в `.gitignore`.

### Шаг 5: Создайте config.json
```bash
cp config/config.example.json config/config.json
```

Откройте `config.json` и подставьте ваш `yandex_cloud_folder_id`:
```json
{
  "yandex_cloud_folder_id": "b1g_ваш_id_каталога",
  "auth": {
    "service_account_key_file": "config/service_account_key.json",
    "openssl_bin": "openssl"
  }
}
```

`auth.service_account_key_file` — путь к ключу. Относительные пути резолвятся от корня скилла, не от `config/`. Можно указать абсолютный путь.

### Шаг 6: Проверьте
```bash
sh scripts/quota.sh
```
Должно вывести `Backend: cloud (auto: config.json present)` и список endpoints.

### Если используете уже настроенный yandex-search-api
Если у вас уже есть `service_account_key.json` для скилла `yandex-search-api`, схема `config.json` идентична — можно скопировать оба файла:
```bash
cp ../yandex-search-api/skills/yandex-search-api/config/service_account_key.json config/
cp ../yandex-search-api/skills/yandex-search-api/config/config.json config/
```
(Скиллы независимы — никакой filesystem-зависимости между ними нет, просто схема одинаковая.)

---

## Legacy mode (deprecated, free)

Работает только для тех, кто получил OAuth-токен ДО депрекейта. Новые пользователи перейти не могут.

### Шаг 1: Получите OAuth токен
Если у вас уже есть зарегистрированный OAuth client_id:
```bash
bash scripts/get_token.sh --client-id ВАШ_CLIENT_ID
```
Скрипт выведет URL для авторизации в браузере, попросит вставить токен из URL после редиректа, и сохранит его в `config/.env`.

Альтернативно — вручную:
```bash
cp config/.env.example config/.env
# отредактируйте .env, вставьте YANDEX_WORDSTAT_TOKEN
```

### Шаг 2: Проверьте
```bash
sh scripts/quota.sh
```
Должно вывести `Backend: legacy (...)` и список v1 endpoints + лимиты (1000/день, 10/сек).

### Срок жизни токена
Токен действует **1 год**. После истечения нужно получить новый.

---

## Как скилл выбирает бэкенд

Логика в `load_config` (`scripts/common.sh`):

1. **Явный override** — `YANDEX_WORDSTAT_BACKEND=legacy|cloud` в `config/.env` или env shell.
2. **Cloud structurally configured** → `cloud`. Это значит:
   - `config/config.json` существует и валидно парсится
   - `yandex_cloud_folder_id` непустой
   - `auth.service_account_key_file` резолвится в существующий читаемый файл
3. **`YANDEX_WORDSTAT_TOKEN` задан** → `legacy`
4. **Ничего не задано** → ошибка с ссылкой на этот README

**Cloud wins on tie**: если заданы и legacy, и cloud — используется cloud. Чтобы остаться на legacy явно, добавьте в `config/.env`:
```
YANDEX_WORDSTAT_BACKEND=legacy
```

**Selector делает только структурную проверку** — никаких сетевых запросов, никакой проверки IAM. Если SA-ключ битый или роль не назначена, ошибка появится при первом реальном API-запросе.

---

## Dynamics: ограничение оператора в cloud режиме

В cloud-бэкенде метод `dynamics` (`scripts/dynamics.sh`) поддерживает все [операторы поиска Wordstat](https://yandex.ru/support/direct/keywords/symbols-and-operators.html) **только при детализации `daily`**. При `weekly` и `monthly` доступен **только оператор `+`**.

Это ограничение на стороне Yandex Cloud Search API — задокументировано в [официальной документации](https://aistudio.yandex.ru/docs/ru/search-api/operations/wordstat-getdynamics.html).

Скилл делает preflight-проверку: если вы запустите `dynamics.sh --period weekly --phrase "юрист -бесплатно"`, скрипт упадёт с понятной ошибкой ДО запроса, чтобы вы не тратили запрос впустую.

| Phrase                 | period=daily | period=weekly/monthly |
|------------------------|--------------|-----------------------|
| `юрист дтп`            | ✓            | ✓                     |
| `юрист +по дтп`        | ✓            | ✓ (`+` разрешён)      |
| `юрист -бесплатно`     | ✓            | ✗ (минус-слово)       |
| `"юрист дтп"`          | ✓            | ✗ (кавычки)           |
| `(юрист\|адвокат) дтп` | ✓            | ✗ (группировка)       |
| `!юрист`               | ✓            | ✗ (точная форма)      |
| `санкт-петербург`      | ✓            | ✓ (внутрисловный дефис) |
| `б/у дымоход`          | ✓            | ✓ (слэш)              |

Legacy-бэкенд исторически принимает все операторы; preflight в legacy режиме не срабатывает.

---

## Troubleshooting

### `Wordstat API: Error` / `wordstat 401`
- **Cloud**: SA-ключ битый или истёк → пересоздайте ключ; либо роль `search-api.webSearch.user` не назначена → назначьте.
- **Legacy**: токен истёк (срок жизни 1 год) → получите новый через `get_token.sh`.

### `Wordstat 403 Forbidden`
- Роль `search-api.webSearch.user` не назначена сервисному аккаунту, либо вы пытаетесь обратиться не к тому каталогу.
- Проверьте `yandex_cloud_folder_id` в `config.json`.

### `LibreSSL detected` (macOS)
macOS по умолчанию использует LibreSSL, который не поддерживает PS256 для подписи JWT.
```bash
brew install openssl@3
```
И в `config.json`:
```json
{
  "auth": {
    "openssl_bin": "/opt/homebrew/bin/openssl"
  }
}
```
Узнать точный путь: `brew --prefix openssl`.

### `config/config.json present but invalid`
- `yandex_cloud_folder_id` пустой → заполните
- Файл ключа не найден по пути из `auth.service_account_key_file` → проверьте, что файл есть и читается. Помните: относительные пути резолвятся от корня скилла, а не от `config/`.

### Хочу переключиться на другой бэкенд
В `config/.env` добавьте:
```
YANDEX_WORDSTAT_BACKEND=cloud   # или legacy
```

### Хочу удалить cloud конфиг и вернуться на legacy
```bash
rm config/config.json
# legacy подхватится автоматически (если YANDEX_WORDSTAT_TOKEN задан)
```

---

## Дополнительно

- Wordstat Cloud API docs: https://aistudio.yandex.ru/docs/ru/search-api/concepts/wordstat.html
- Pricing: https://yandex.cloud/ru/docs/search-api/pricing
- Operators: https://yandex.ru/support/direct/keywords/symbols-and-operators.html
- Альтернативная настройка SA через CLI:
  ```bash
  yc iam service-account create --name wordstat-sa
  yc resource-manager folder add-access-binding <FOLDER_ID> \
    --role search-api.webSearch.user \
    --subject serviceAccount:<SA_ID>
  yc iam key create --service-account-name wordstat-sa \
    --output config/service_account_key.json
  ```

