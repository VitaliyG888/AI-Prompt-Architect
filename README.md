# AI Prompt Architect

Локальное приложение, которое превращает сырую идею в **профессиональный, проверенный промт**:
адаптивное интервью → исследование источников → синтез разделов → контроль качества → сборка
версии → тестирование на целевой модели.

Промт не собирается по шаблону. Каждый раздел синтезируется моделью из трёх оснований:

| Основание | Что это |
|---|---|
| **A** | Требования пользователя, собранные интервью (ответы, ограничения, решения) |
| **B** | Находки исследования: источники, сильные и слабые практики, что избегать |
| **C** | Собственный профессиональный вариант модели для этой роли |

Результат — не «заполненный бланк», а текст, в котором видно, откуда взялось каждое требование
и что было отброшено.

---

## Быстрый старт

Требуется **Node.js ≥ 22.18** (проект запускается на 26.x). Зависимостей нет:
`.ts` исполняется напрямую через встроенное снятие типов, HTTP — на `node:http`,
хранилище — на `node:sqlite`.

```bash
npm install          # только типы для проверки: @types/node, typescript
npm start            # http://127.0.0.1:4319
```

Режим разработки с автоперезагрузкой:

```bash
npm run dev
```

Проверки:

```bash
npm test             # 110 тестов: ядро, репозитории, адаптеры, конвейер, HTTP API
npm run typecheck    # tsc --noEmit
```

При первом запуске создаётся `data/app.db` (SQLite, схема v1), `data/master.key` и
11 маршрутов операций с пустыми провайдерами — приложение открывается и работает
без единой настройки, честно сообщая, что модель не подключена.

---

## Настройка модели

Модель и провайдер выбираются **в интерфейсе**, без правки исходного кода.
Поддерживается любой сервис с одним из четырёх протоколов:

| Протокол | Для чего |
|---|---|
| `openai-chat` | OpenAI, OpenRouter, OmniRoute, vLLM, LM Studio, Ollama, любые OpenAI-совместимые |
| `openai-responses` | Responses API (OpenAI) |
| `anthropic-messages` | Anthropic Claude |
| `gemini` | Google Gemini |

Порядок: **Settings → Providers** → добавить провайдера (Base URL, протокол, API-ключ,
Model ID) → «Проверить подключение». Кнопка проверки работает и для черновика до сохранения.
Список моделей подтягивается, если протокол его поддерживает; ручной ввод Model ID доступен всегда.

Затем **Settings → Routes**: каждая из 11 операций (`interview`, `question_planning`,
`section_synthesis`, `quality_check`, `final_assembly`, `test_evaluation` и др.) может идти
на свою модель. Маршрут поддерживает резервного провайдера и модель — переключение происходит
только на ошибках, которые действительно оправдывают fallback (`PROVIDER_UNAVAILABLE`,
`RATE_LIMITED`, `REQUEST_TIMEOUT`, `UPSTREAM_ERROR`, `MODEL_NOT_FOUND`), но не на `401`.

Дешёвую модель удобно ставить на интервью и генерацию тестов, сильную — на `section_synthesis`
и `final_assembly`.

### Поиск для исследования

Research работает независимо от LLM. Поддерживаются `tavily`, `brave`, `serpapi`,
`google-cse`, `searxng` (свой инстанс) и `custom` (любой JSON API по шаблону).
Настраивается в **Settings → Search Providers**, там же есть пробный запрос,
показывающий реальные результаты или честную ошибку.

---

## Режимы работы

| | Quick | Professional | Expert |
|---|---|---|---|
| Вопросов на раздел | 2 | 4 | 6 |
| Исследование раздела | — | включено | включено |
| Источников на раздел | 0 | 4 | 6 |
| Альтернатив раздела | 1 | 2 | 3 |
| Итераций доработки | 1 | 2 | 3 |
| Строгая оценка качества | — | да | да |
| Тестирование на целевой модели | — | по запросу | включено |

Режим задаётся при создании проекта и меняется на лету — политика видна в шапке workspace
(`modeNotice`), чтобы не было сюрпризов в количестве запросов к модели.

---

## Конвейер

```
intake → plan → interview → synthesis → assembly → review → testing → done
```

1. **Planning.** Модель определяет архетип задачи и составляет план разделов и вопросов.
   Критические для архетипа разделы добавляются принудительно, даже если модель про них забыла.
2. **Interview.** Адаптивные вопросы по разделам; ответы разбираются на требования,
   предположения и пробелы. При нехватке данных раздел уходит в `needs_clarification`
   с уточняющими вопросами.
3. **Research.** Поисковые запросы под раздел, отбор источников, анализ сильных и слабых
   практик и того, чего избегать.
4. **Synthesis.** Раздел собирается из A + B + C. Модель возвращает также альтернативный
   вариант, список отброшенного и открытые вопросы.
5. **Quality.** Оценка по взвешенным критериям с вердиктом `pass` / `revise`.
6. **Assembly.** Сборка версии: назначение, инструкции по применению, допущения,
   ограничения, разрешённые конфликты между разделами, источники.
7. **Testing.** Промт прогоняется на целевой модели на подготовленных кейсах; ответы
   оцениваются, сохраняется вердикт.

**Граф зависимостей разделов.** Изменение `role` помечает `expertise`, `methodology`,
`workflow`, `constraints` как `needs_revision` — правка одного раздела не оставляет
несогласованными зависимые.

**Версии.** Каждая сборка — отдельная версия с оценкой качества и метаданными.
Доступны сравнение версий (`/diff`) и экспорт в Markdown, TXT и JSON.

---

## Честная деградация

Ключевой принцип: приложение **никогда не выдумывает** результат, которого не получило.

| Ситуация | Поведение |
|---|---|
| Провайдер не настроен / недоступен | Раздел собирается детерминированно из требований, статус `needs_revision`, в тексте указан код ошибки |
| Поиск не настроен | Research получает статус `unavailable` с объяснением, источники не создаются |
| Модель вернула неполный план | Недостающие критические разделы добавляются, факт фиксируется в истории |
| Оценка без модели | Взвешенный балл считается эвристикой и помечается `heuristic: true` |
| Тест не дошёл до модели | Вердикт `not_run`, а не фиктивный результат |

Каждый такой случай пишется в историю проекта событием — пользователь видит, что именно
произошло, а не пустой экран.

---

## Безопасность

- **Шифрование ключей.** API-ключи хранятся только как AES-256-GCM шифртекст
  (`v1:<iv>:<tag>:<data>`). Мастер-ключ берётся из `APP_MASTER_KEY` либо генерируется
  в `data/master.key` с правами `0600`.
- **Ключи не покидают сервер.** API возвращает только `hasApiKey` и маску (`••••1234`).
  Ключи не попадают в логи, ошибки и экспорт.
- **Защита от SSRF.** Base URL проверяется: только `http`/`https`, без учётных данных в URL;
  loopback, приватные, link-local, CGNAT и metadata-адреса (`169.254.169.254`) блокируются,
  включая проверку всех DNS-адресов (защита от rebinding). Локальные шлюзы (Ollama, LM Studio,
  OmniRoute) разрешаются только при `ALLOW_PRIVATE_PROVIDERS=1`.
- **Фильтрация заголовков.** Из custom headers выбрасываются критически важные заголовки
  и всё, что похоже на попытку инъекции.
- **Доступ.** По умолчанию сервер слушает только `127.0.0.1`. Для доступа извне задайте
  `APP_TOKEN` — тогда каждый API-запрос требует `x-app-token` или `Authorization: Bearer`.
- **Интерфейс.** CSP без инлайн-скриптов, вся логика в `web/js/**`.

> Приложение рассчитано на локальную работу одного пользователя. Ролевой модели и
> мультиарендности нет: не выставляйте его в публичный доступ без собственного
> прокси с аутентификацией.

---

## Переменные окружения

Все опциональны. Файл `.env` читается автоматически (шаблон — `.env.example`).

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `4319` | Порт HTTP-сервера |
| `HOST` | `127.0.0.1` | Адрес прослушивания |
| `APP_DATA_DIR` | `./data` | Каталог SQLite и мастер-ключа |
| `APP_MASTER_KEY` | — | Мастер-ключ: hex (64 символа), base64 (32 байта) или строка ≥ 24 символов |
| `ALLOW_PRIVATE_PROVIDERS` | `0` | Разрешить loopback/приватные адреса провайдеров |
| `APP_TOKEN` | — | Токен доступа; нужен при работе не только с localhost |
| `MAX_CONTEXT_CHARS` | `24000` | Ограничение контекста, передаваемого модели |

---

## API

Потоковый прогресс конвейера отдаётся как NDJSON (`application/x-ndjson`):
`start` → `step` → `research` → `section` → `done`, ошибка шага приходит событием
`error` с кодом, а не молчаливым обрывом.

<details>
<summary>Основные маршруты</summary>

**Диагностика и каталог**
```
GET    /api/health
GET    /api/meta
GET    /api/config/catalog
```

**Проекты**
```
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id
POST   /api/projects/:id/initialize
GET    /api/projects/:id/messages
```

**Разделы**
```
POST   /api/projects/:id/sections/:key/questions
POST   /api/projects/:id/sections/:key/answers
PATCH  /api/projects/:id/sections/:key
POST   /api/projects/:id/sections/:key/research
POST   /api/projects/:id/sections/:key/synthesize
POST   /api/projects/:id/sections/:key/pipeline     # NDJSON
POST   /api/projects/:id/sections/:key/alternatives/:index/accept
```

**Сборка, тесты, версии, экспорт**
```
POST   /api/projects/:id/assemble
POST   /api/projects/:id/test
GET    /api/projects/:id/versions
GET    /api/projects/:id/versions/:versionId
GET    /api/projects/:id/diff
GET    /api/projects/:id/export?format=md|txt|json
GET    /api/projects/:id/sources
GET    /api/projects/:id/tests
GET    /api/projects/:id/search-status
```

**Конфигурация**
```
GET|POST         /api/providers
PATCH|DELETE     /api/providers/:id
POST             /api/providers/:id/default
POST             /api/providers/:id/test
POST             /api/providers/test
GET              /api/providers/:id/models
GET              /api/routes
PUT|DELETE       /api/routes/:operation
GET|POST         /api/search-providers
PATCH|DELETE     /api/search-providers/:id
POST             /api/search-providers/:id/test
GET              /api/settings
PUT              /api/settings/defaults
GET              /api/usage
```
</details>

Ошибки всегда структурированы: `{ "error": { "code": "CONFLICT", "message": "…" } }`.
Коды машинные (`VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `PROVIDER_AUTH_FAILED`,
`PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `BLOCKED_URL`, `SEARCH_NOT_CONFIGURED`),
статусы HTTP соответствуют коду.

---

## Архетипы

Архетип определяет набор обязательных разделов и шаблоны поисковых запросов:
`ai_programmer`, `financial_analyst`, `research_agent`, `marketing_expert`,
`image_generator`, `business_consultant`, `generic`. Архетип определяется по идее проекта
и может быть уточнён в интервью.

Разделы промта: `role`, `context`, `objective`, `expertise`, `methodology`, `workflow`,
`tools`, `constraints`, `output_format`, `quality_criteria`, `error_handling`, `specialized`.

---

## Структура проекта

```
src/server/
  core/       ошибки, логи, шифрование, SSRF, валидация, кэш URL
  db/         схема SQLite (v1) и репозитории
  llm/        4 адаптера протоколов, реестр, роутер, клиент, проверка подключения
  search/     поисковые адаптеры и движок (независим от LLM)
  domain/     типы, архетипы, промты, критерии качества
  engines/    interview, research, section-architect, assembler, tester, orchestrator, exporter
  http/       роутер, ответы (JSON/NDJSON), статика
  api/        projects, config
web/
  index.html, css/styles.css
  js/         api.js, ui.js, main.js (hash-роутер), views/{home,new,workspace,settings}.js
tests/        core, repositories, adapters, pipeline, api
```

Интерфейс собирается без сборщика: `h()`-гиперскрипт, hash-роутер, рукописный CSS.
Темы, адаптив (1280/1080/860/520) и `prefers-reduced-motion` учтены.

---

## Тесты

110 тестов на `node --test`, без моков сети — адаптеры проверяются против реальных
локальных HTTP-серверов (и тело запроса, и разбор ответа, и классификация ошибок).

| Файл | Что покрывает |
|---|---|
| `core.test.ts` | шифрование, SSRF, валидация, утилиты, кэш |
| `repositories.test.ts` | репозитории, порядок версий, каскадное удаление, маскирование ключей |
| `adapters.test.ts` | 4 LLM-протокола + 6 поисковых адаптеров, retry/fallback/без-retry-на-401 |
| `pipeline.test.ts` | стадии конвейера, переходы состояний, граф зависимостей, деградация |
| `api.test.ts` | HTTP-контракты, маскирование секретов, экспорт, NDJSON-поток, 404/405/422 |

---

## Ограничения

- Один пользователь, без ролей и мультиарендности.
- SQLite в режиме одного процесса: горизонтального масштабирования нет.
- Проверка подключения провайдера — реальный запрос; при ошибке пользователь видит
  код и сообщение, но не тело ответа провайдера (чтобы не утекали детали).
- Экспорт JSON — самодостаточный документ, но без служебных метаданных провайдеров:
  секреты и custom headers в него не попадают по построению.
