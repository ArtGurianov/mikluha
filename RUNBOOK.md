# Деплой и эксплуатация — Миклуха Маклай

Технический runbook для разработчика/DevOps. Памятка для организатора — в `CONTENT-GUIDE.md`.

## Архитектура

- Публичный сайт — pure static export (`output: 'export'`), обслуживается Nginx из `/out`.
- Контент — YAML-файлы в `content/`, часть этого репозитория. Редактируется через `/admin`
  (Sveltia CMS: статический JS-бандл, коммитит прямо в GitHub) или руками. Runtime публичного
  сайта от CMS не зависит — но сама *сборка* не полностью офлайн: текстовый контент читается с
  диска, а вот картинки, загруженные через `/admin` (не `local:`-ссылки на демо-ассеты),
  `scripts/materialize-assets.ts` скачивает с cloud.ru — см. предупреждение ниже.
- Два Coolify application:
  - `miklukha-web` — сам сайт, `Dockerfile` в корне репозитория (multi-stage: deps → build →
    nginx runtime).
  - `miklukha-cms-auth` — GitHub OAuth token-exchange broker для `/admin` (см. «CMS: авторизация
    редакторов» ниже), `oauth-broker/Dockerfile`.

## Переменные окружения (build-time only)

Задаются в Coolify как build ARGs, не должны попадать в рантайм-образ:

| Переменная | Назначение |
|---|---|
| `DEPLOY_ENV` | `production` или `staging` — управляет индексируемостью |
| `SITE_URL` | Только при `DEPLOY_ENV=staging`: canonical/OG base URL для staging-хоста |

Никаких CMS-credentials на этапе сборки не требуется — контент уже лежит в собранном репозитории.
Но как только хотя бы одно изображение загружено через `/admin`, доступность cloud.ru становится
жёсткой зависимостью самой сборки (не рантайма сайта — см. `docs/DECISIONS.md` #1): `next build`
не начнётся, пока `materialize-assets` не скачает и не порежет на WEBP-варианты каждую такую
картинку. Если пересборка упала на этом шаге — сначала проверить доступность cloud.ru, а не
GitHub/Coolify.

## Локальная разработка

```bash
pnpm install
pnpm dev   # predev сам прогонит vendor:admin + sync:content + materialize:assets
```

## Production build pipeline

```bash
pnpm run build:production
# = clean && validate:cms-config && vendor:admin && lint && test && sync:content
#   && materialize:assets && validate:content && build && validate:out
```

`vendor:admin` копирует Sveltia CMS (`node_modules/@sveltia/cms/dist/sveltia-cms.js`) в
`public/admin/` — идёт первым шагом, чтобы `/admin` всегда собирался против установленной версии
пакета (сам бандл в репозиторий не коммитится, см. `.gitignore`).

Любая ошибка на любом шаге должна ломать именно этот build, не трогая уже работающий production-релиз — это обеспечивается тем, что Docker build стадии независимы, и `docker build` просто падает, не подменяя текущий запущенный container.

## CMS: авторизация редакторов (GitHub OAuth + broker)

Sveltia CMS хранит контент через GitHub API (`backend.name: github` в `public/admin/config.yml`).
GitHub требует обмена authorization code на token с client secret — это не может выполняться в
браузере, поэтому нужен маленький внешний сервис (`oauth-broker/`), который держит секрет.

Разовая настройка:

1. Создать GitHub OAuth App: Settings → Developer settings → OAuth Apps → New OAuth App.
   Authorization callback URL: `https://<cms-auth-домен>/callback`.
2. Задеплоить `oauth-broker/` как отдельное Coolify application (`oauth-broker/Dockerfile`),
   оставив build context в корне репозитория (Dockerfile сам копирует файлы из `oauth-broker/`),
   переменные окружения:

   | Переменная | Назначение |
   |---|---|
   | `GITHUB_CLIENT_ID` | Client ID созданного OAuth App |
   | `GITHUB_CLIENT_SECRET` | Client secret — существует только здесь и в GitHub, никогда не в репозитории |
   | `ALLOWED_DOMAINS` | **обязательно.** Домен(ы) сайта, которым разрешено использовать broker (через запятую, `*` как wildcard), например `miklukha-maklay.ru`. `*` разворачивается в «один и более символов» — `*.example.com` матчит `cms.example.com`, но НЕ голый `example.com`; перечисляйте оба явно, если нужны оба. Broker — сервис, держащий GitHub OAuth client secret и выдающий токены с правом записи в репозиторий, поэтому без явного allowlist он вообще отказывается запускаться. |

3. В `public/admin/config.yml` указать `backend.base_url` (origin задеплоенного broker) и
   `backend.site_domain` (продовый домен сайта).

Ротация секрета — пересоздать client secret в GitHub OAuth App, обновить `GITHUB_CLIENT_SECRET` и
передеплоить `miklukha-cms-auth`; `GITHUB_CLIENT_ID` и `public/admin/config.yml` не меняются.

## CMS: медиатека (cloud.ru Object Storage)

Загрузка изображений через `/admin` идёт напрямую в cloud.ru Object Storage (S3-совместимое
хранилище), не в сам репозиторий — так `content/` остаётся текстовым и лёгким для просмотра
диффов.

1. Создать bucket в cloud.ru Evolution Object Storage; настроить bucket policy на публичное
   чтение (`GetObject`) объектов под префиксом `cms/` — `scripts/materialize-assets.ts` скачивает
   их по прямой ссылке во время сборки. Листинг публично не открывать.
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

## GitHub push → rebuild

Коммит в `main` (в том числе через `/admin`) → стандартный Coolify Git-deploy webhook на
`miklukha-web` → пересборка. Отдельного webhook-конфига в CMS настраивать не нужно — это уже
GitHub-репозиторий, который Coolify отслеживает напрямую.

## Плановый ежедневный rebuild

`nextDeparture`/`nextBookableDeparture` вычисляются во время сборки — без нового коммита в
`content/` прошедшие даты не «протухнут» сами.

Пример host `cron`/systemd timer на VPS (не на самом сайте, credential не должен попадать в публичный образ):

```cron
# каждый день в 00:15 по таймзоне siteSettings.timezone
15 0 * * * curl -fsS -X POST -H "Authorization: Bearer $(cat /root/.secrets/coolify-deploy-token)" https://<coolify-host>/api/v1/deploy?uuid=<app-uuid>
```

`coolify-deploy-token` файл — `root`-only права, вне git и вне Docker build context.

## Staging

Собирать с `DEPLOY_ENV=staging` — сайт получит `robots.txt: Disallow: /`, `noindex,nofollow` и canonical/OG-теги на нейтральном `https://staging.invalid` (или на `SITE_URL`, если задан), а не на боевом домене.

**Важно:** `pnpm run build:production` без `DEPLOY_ENV=staging` требует `siteSettings.launchReady = true` и упадёт с ошибкой на демо-контенте — это осознанный gate (см. `docs/DECISIONS.md` #4): демо-QR отправляет реальные деньги на тестовый счёт, а демо-телефон никуда не дозванивается. Локальные/preview-сборки на недоготовленном контенте всегда нужно гнать как `DEPLOY_ENV=staging pnpm run build:production`.

## Candidate HTTP healthcheck

После `build:production` и до переключения трафика — поднять candidate-контейнер и прогнать:

```bash
HEALTHCHECK_BASE_URL=http://localhost:8080 pnpm run healthcheck
```

Проверяет `/`, `/robots.txt`, `/sitemap.xml`, один опубликованный `/tours/<slug>/`, один `/reports/<slug>/` (если есть), один локальный CMS-asset и что неизвестный URL отдаёт `404` с брендированной страницей. Ненулевой exit code — кандидат не должен становиться production.

## Pre-launch checklist

Коротко: реальные реквизиты/контакты/QR, `isDemo=false` везде, `siteSettings.launchReady=true`, чистый `build:production` без ошибок валидации. Полный список для организатора — в `CONTENT-GUIDE.md`; `validate:content` сам перечислит всё, что осталось заменить.
