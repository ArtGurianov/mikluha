# Деплой и эксплуатация — Миклуха Маклай

Технический runbook для разработчика/DevOps. Памятка для организатора — в `CONTENT-GUIDE.md`.

## Архитектура

- Публичный сайт — pure static export (`output: 'export'`), обслуживается Nginx из `/out`.
- Контент — YAML-файлы в `content/`, часть этого репозитория. Редактируется через `/admin`
  (Sveltia CMS: статический JS-бандл, коммитит прямо в GitHub) или руками. И сайт, и CMS
  входят в статический `/out`; браузер получает WebP/WebM напрямую из cloud.ru Object Storage.
  Сборка не скачивает и не преобразует медиа.
- Один Coolify application `miklukha-web`: сайт и `/admin` собираются одним `Dockerfile`
  (multi-stage: deps → build → nginx runtime). Отдельного CMS/OAuth runtime нет.

## Переменные окружения (build-time only)

Задаются в Coolify как build ARGs, не должны попадать в рантайм-образ:

| Переменная | Назначение |
|---|---|
| `DEPLOY_ENV` | `production` или `staging` — управляет индексируемостью |
| `SITE_URL` | Только при `DEPLOY_ENV=staging`: canonical/OG base URL для staging-хоста |

Никаких CMS-credentials и доступности cloud.ru на этапе сборки не требуется: YAML уже лежит в
репозитории, а прямые URL проходят только синтаксическую проверку. Доступность Object Storage
нужна браузерам посетителей в runtime.

## Локальная разработка

```bash
pnpm install
pnpm dev   # predev сам прогонит vendor:admin + sync:content
```

## Production build pipeline

```bash
pnpm run build:production
# = clean && validate:cms-config && vendor:admin && lint && test
#   && sync:content && validate:content && build && validate:out
```

`vendor:admin` копирует Sveltia CMS (`node_modules/@sveltia/cms/dist/sveltia-cms.js`) в
`public/admin/` — идёт первым шагом, чтобы `/admin` всегда собирался против установленной версии
пакета (сам бандл в репозиторий не коммитится, см. `.gitignore`).

Любая ошибка на любом шаге должна ломать именно этот build, не трогая уже работающий production-релиз — это обеспечивается тем, что Docker build стадии независимы, и `docker build` просто падает, не подменяя текущий запущенный container.

## CMS: авторизация редакторов (GitHub fine-grained PAT)

Sveltia CMS хранит контент через GitHub API (`backend.name: github` в `public/admin/config.yml`)
и обращается к нему прямо из браузера. `auth_methods: [token]` отключает OAuth-кнопку и исключает
broker/client secret из архитектуры.

Разовая настройка для каждого редактора:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token.
2. В `Repository access` выбрать `Only select repositories` → `ArtGurianov/mikluha`.
3. В `Repository permissions` выдать только `Contents: Read and write`; остальные write-права
   не нужны. Установить разумный срок действия.
4. Открыть `/admin`, выбрать вход по token и вставить PAT. Sveltia хранит его только в локальном
   хранилище этого браузера и отправляет непосредственно GitHub API.

Токен нельзя писать в Git, `.env`, Coolify или передавать другому редактору. Для отзыва/ротации
удалить PAT в GitHub и создать новый; пересборка или изменение CMS-конфига не нужны. Потеря
доступа редактора к сайту также требует отозвать его PAT.

## CMS: медиатека (cloud.ru Object Storage)

Загрузка изображений через `/admin` идёт напрямую в cloud.ru Object Storage (S3-совместимое
хранилище), не в сам репозиторий — так `content/` остаётся текстовым и лёгким для просмотра
диффов.

1. Создать bucket в cloud.ru Evolution Object Storage; настроить bucket policy на публичное
   чтение (`GetObject`) объектов под префиксом `cms/`: эти URL используются прямо в статических
   страницах. Листинг публично не открывать. Оставить
   `media_libraries.aws_s3.acl: false` в CMS-конфиге: Sveltia иначе добавляет к загрузкам
   `x-amz-acl: public-read`, который bucket с отключёнными ACL отклоняет.
2. Настроить CORS bucket для каждого origin, с которого открывается `/admin`: методы `GET`, `PUT`, `HEAD`, заголовки `*`,
   `ExposeHeaders: ETag`. Без этого браузер заблокирует подписанные запросы Sveltia ещё на
   preflight.
3. Выдать редакторам scoped-ключ с `ListBucket` на bucket (ограничив список префиксом `cms/`) и
   `GetObject`/`PutObject` только на `cms/*`, без `DeleteObject`. Sveltia сначала запрашивает
   список объектов медиатеки, поэтому ключ только с `PutObject` не работает.
4. В `public/admin/config.yml` → `media_libraries.aws_s3` указать `access_key_id` в формате
   cloud.ru `<tenant_id>:<key_id>` (не секретный)
   и `bucket`. **Secret access key в конфиг не пишется** — каждый редактор вводит его один раз в
   интерфейсе Sveltia при первой загрузке файла; хранится только в его браузере.

CMS принимает только WebP-изображения до 1 МиБ и WebM-видео до 10 МиБ. В галереях тура и
отчёта максимум 10 фотографий: при заполненном списке сначала удалить существующую. Эти лимиты
применяет браузерная форма Sveltia. Ручное редактирование YAML намеренно остаётся аварийным
обходом лимита размера; сборка не делает сетевой `HEAD`/`GET` и потому не перепроверяет размер
удалённого объекта. Формат, storage-префикс и лимит количества в галерее сборка проверяет.

Фоновое видео главной страницы добавляется в «Настройки сайта» → «Главный экран (Hero)» →
«Фоновое видео WebM». Оно опционально; фоновое изображение остаётся poster/fallback, а при
включённом системном сокращении анимации видео скрывается.

Favicon и Apple Touch Icon загружаются не в CMS/Object Storage, а один раз коммитятся в
репозиторий как `app/favicon.ico` и `app/apple-icon.png`. Next.js копирует их в статический
export и добавляет metadata-теги автоматически; никакого materializer для этого нет.

## GitHub push → rebuild

Коммит в `main` (в том числе через `/admin`) → стандартный Coolify Git-deploy webhook на
`miklukha` → пересборка. Отдельного webhook-конфига в CMS настраивать не нужно — это уже
GitHub-репозиторий, который Coolify отслеживает напрямую.

## Периодичность обновлений

Отдельный rebuild по `cron`/systemd timer не используется. Контент планируется обновлять не
чаще раза в месяц, обычно раз в 2–3 месяца; каждый такой коммит в `main` уже запускает
пересборку через Coolify webhook.

`nextDeparture`/`nextBookableDeparture` вычисляются во время сборки и между публикациями
остаются снимком последнего релиза. Это принятый компромисс: перед публикацией редактор
проверяет даты и статусы выездов, а автоматическая ежедневная актуализация не требуется.

## Staging

Собирать с `DEPLOY_ENV=staging` — сайт получит `robots.txt: Disallow: /`, `noindex,nofollow` и canonical/OG-теги на нейтральном `https://staging.invalid` (или на `SITE_URL`, если задан), а не на боевом домене.

**Важно:** `pnpm run build:production` без `DEPLOY_ENV=staging` требует `siteSettings.launchReady = true` и упадёт с ошибкой на демо-контенте — это осознанный gate (см. `docs/DECISIONS.md` #4): демо-QR отправляет реальные деньги на тестовый счёт, а демо-телефон никуда не дозванивается. Локальные/preview-сборки на недоготовленном контенте всегда нужно гнать как `DEPLOY_ENV=staging pnpm run build:production`.

## Candidate HTTP healthcheck

После `build:production` и до переключения трафика — поднять candidate-контейнер и прогнать:

```bash
HEALTHCHECK_BASE_URL=http://localhost:8080 pnpm run healthcheck
```

Проверяет `/`, `/robots.txt`, `/sitemap.xml`, один опубликованный `/tours/<slug>/`, один `/reports/<slug>/` (если есть), один локальный demo-asset (если он используется) и что неизвестный URL отдаёт `404` с брендированной страницей. Удалённые медиа намеренно не запрашиваются. Ненулевой exit code — кандидат не должен становиться production.

## Pre-launch checklist

Коротко: реальные реквизиты/контакты/QR, `isDemo=false` везде, `siteSettings.launchReady=true`, чистый `build:production` без ошибок валидации. Полный список для организатора — в `CONTENT-GUIDE.md`; `validate:content` сам перечислит всё, что осталось заменить.
