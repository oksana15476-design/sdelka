# Карта скиллов проекта

**Дата:** 2026-08-31

В наборе 123 скилла. Прогонять все — не работа, а шум: там регуляторика
медизделий, заявки в FDA и реклама под российский рынок. Ниже — что применимо к
грузинскому финтеху, на каком этапе и что уже отработано.

## Отработано

| Скилл | Где | Что дал |
|---|---|---|
| `brainstorming` | С начала проекта | Флоу от идеи к спеке, гейт «не писать код без принятого дизайна» |
| `state-machine` | `docs/product/STATE-MACHINES.md` | Метод: состояния → события → переходы → **невозможные состояния** → guards. Плюс правило «у каждого состояния есть выход» — прогнали три машины на тупики |

## Due сейчас

| Скилл | Зачем | Кто применяет |
|---|---|---|
| `writing-plans` | План реализации первого слайса — терминальный шаг брейншторминга | я |
| `wireframe-spec`, `component-spec`, `form-design`, `error-handling-ux`, `loading-states`, `responsive-design`, `accessibility-review` | Детальные спеки экранов трёх кабинетов | дизайн-агент, в работе |
| `ux-copy`, `brand-voice`, `brand-review` | Микрокопи кабинетов: связка копирайтер → главред по правилам проекта | копирайтер и главред |
| `naming-convention` | Единые имена сущностей, состояний и токенов до первого кода | я |

## Когда начнём писать код

`test-driven-development` — обязателен для денежного домена: стейт-машина и учёт
тестируются без сети. `executing-plans` — исполнение по плану с чекпоинтами.
`systematic-debugging` — при первом же неожиданном поведении. `requesting-code-review`
и `receiving-code-review` — на каждом батче. `verification-before-completion` —
перед заявлением о готовности. `using-git-worktrees` — при параллельных ветках.
`subagent-driven-development` и `dispatching-parallel-agents` — когда задачи
независимы.

## Когда появится дизайн-система

`design-system`, `design-token`, `color-system`, `typography-scale`,
`spacing-system`, `layout-grid`, `icon-system`, `motion-system`,
`theming-system`, `dark-mode-design`, `pattern-library`,
`documentation-template`, `design-handoff`, `design-qa-checklist`.

Критики применяем к готовым экранам: `design-critique`, `heuristic-evaluation`,
`critique-visual-hierarchy`, `critique-information-density`,
`critique-affordance`, `critique-composition`, `critique-color`,
`critique-typography`, `design-debt-audit`.

Законы UX — точечно, где решают конкретную задачу: `fitts-law` для мобильных
целей нажатия, `hicks-law` для сокращения выборов в онбординге, `millers-law` для
группировки в консоли операций, `doherty-threshold` для отклика,
`von-restorff-effect` для выделения главного действия, `law-of-proximity` и
`law-of-common-region` для группировки в плотных таблицах.

## Когда пойдём в маркетинг

`content-strategy`, `content-brief`, `content-creation`, `draft-content` —
контент на трёх языках. `seo-audit`, `technical-seo`, `on-page-seo`,
`keyword-clustering`, `internal-linking`, `schema-markup`, `broken-links` — под
поиск на русском, английском и иврите. `ai-visibility` — как продукт выглядит в
ответах ассистентов. `crawl4ai-seo` — краулинг конкурентов.

## Когда дойдём до безопасности и комплаенса

`gdpr-dsgvo-expert` и `gdpr-audit-prep` — как метод; норму читаем по грузинскому
закону о персональных данных, а не по европейскому регламенту.
`information-security-manager-iso27001`, `isms-audit-expert`,
`iso27001-audit-prep` — практики безопасности, полезны при переговорах с банком.
`soc2-compliance`, `soc2-audit-prep` — если понадобится корпоративным клиентам.
`compliance-os`, `compliance-readiness` — оркестрация, если фреймворков станет
несколько.

## Не применимо

**Медтех и регуляторика изделий:** `capa-officer`, `qms-audit-expert`,
`quality-documentation-manager`, `quality-manager-qmr`, `regulatory-affairs-head`,
`risk-management-specialist`, `ra-qm-skills`.

**Регулирование ИИ:** `eu-ai-act-specialist`, `iso42001-specialist`,
`aims-audit`, `ai-act-readiness`, `agent-decision-receipts` — мы не строим
высокорисковую систему ИИ.

**Российский рекламный стек:** `yandex-direct`, `yandex-metrika`,
`yandex-webmaster`, `yandex-wordstat`, `yandex-search-api` — юрисдикция и
аудитория другие.

**Право РФ:** `legal-compliance-ru` — юрисдикция Грузия. Метод разбора применим,
нормы нет.

**Прочее не по профилю:** `taste` (клипы), `gstack`, `stitch-design-taste`,
`design-taste-frontend`, `high-end-visual-design`, `minimalist-ui`,
`redesign-existing-projects` — визуальные направления для лендингов и портфолио,
не для операционного финтех-интерфейса.
