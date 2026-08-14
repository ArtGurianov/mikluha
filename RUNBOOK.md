# Деплой и эксплуатация — Миклуха Маклай

Технический runbook для разработчика/DevOps. Памятка для организатора — в `CONTENT-GUIDE.md`.

## Архитектура

- Публичный сайт — pure static export (`output: 'export'`), обслуживается Nginx из `/out`.
- Sanity (Content Lake + Studio) — источник контента только во время сборки. Runtime публичного сайта от Sanity не зависит.
- Один Coolify application: `miklukha-web`, `Dockerfile` в корне репозитория (multi-stage: deps → build → nginx runtime).

## Переменные окружения (build-time only)

Задаются в Coolify как build ARGs / secrets, не должны попадать в рантайм-образ:

| Переменная | Назначение |
|---|---|
| `SANITY_PROJECT_ID`, `SANITY_DATASET` | какой Sanity-проект/датасет использовать |
| `SANITY_API_TOKEN` | read-токен для build-time чтения published-контента |
| `SANITY_API_VERSION` | версия Sanity API (см. `.env.example`) |
| `DEPLOY_ENV` | `production` или `staging` — управляет индексируемостью (см. PRD §44) |

Если `SANITY_PROJECT_ID`/`SANITY_DATASET` не заданы, сборка идёт на локальных mock-данных из `lib/cms/fixtures/` — удобно для preview-сборок без доступа к реальному проекту.

## Локальная разработка

```bash
pnpm install
pnpm dev   # predev сам прогонит sync:cms + materialize:assets на фикстурах
```

## Production build pipeline (PRD §34.2)

```bash
pnpm run build:production
# = clean && sync:cms && materialize:assets && validate:content && build && validate:out
```

Любая ошибка на любом шаге должна ломать именно этот build, не трогая уже работающий production-релиз — это обеспечивается тем, что Docker build стадии независимы, и `docker build` просто падает, не подменяя текущий запущенный container.

## Sanity webhook → rebuild

1. В Sanity создать webhook: on publish/unpublish (или любой mutation) → HTTP POST на Coolify deploy webhook URL.
2. В заголовке `Authorization: Bearer <Coolify deploy token>` — токен хранится только в конфигурации webhook в Sanity, не в репозитории.

## Плановый ежедневный rebuild

`nextDeparture`/`nextBookableDeparture` вычисляются во время сборки (PRD §30) — без планового rebuild прошедшие даты не «протухнут» сами.

Пример host `cron`/systemd timer на VPS (не на самом сайте, credential не должен попадать в публичный образ):

```cron
# каждый день в 00:15 по таймзоне siteSettings.timezone
15 0 * * * curl -fsS -X POST -H "Authorization: Bearer $(cat /root/.secrets/coolify-deploy-token)" https://<coolify-host>/api/v1/deploy?uuid=<app-uuid>
```

`coolify-deploy-token` файл — `root`-only права, вне git и вне Docker build context.

## Staging

Собирать с `DEPLOY_ENV=staging` — сайт получит `robots.txt: Disallow: /`, `noindex,nofollow` и canonical/OG-теги на нейтральном `https://staging.invalid` (или на `SITE_URL`, если задан), а не на боевом домене. Использовать отдельный Sanity dataset (`staging`) при необходимости.

**Важно:** `pnpm run build:production` без `DEPLOY_ENV=staging` требует `siteSettings.launchReady = true` и упадёт с ошибкой на демо-контенте (это осознанный gate, PRD §29/§49 — «production build MUST блокироваться, если launchReady != true»). Локальные/preview-сборки на фикстурах или недоготовленном контенте всегда нужно гнать как `DEPLOY_ENV=staging pnpm run build:production`.

## Candidate HTTP healthcheck (PRD §34.3)

После `build:production` и до переключения трафика — поднять candidate-контейнер и прогнать:

```bash
HEALTHCHECK_BASE_URL=http://localhost:8080 pnpm run healthcheck
```

Проверяет `/`, `/robots.txt`, `/sitemap.xml`, один опубликованный `/tours/<slug>/`, один `/reports/<slug>/` (если есть), один локальный CMS-asset и что неизвестный URL отдаёт `404` с брендированной страницей. Ненулевой exit code — кандидат не должен становиться production.

## Pre-launch checklist

См. PRD §54.1 — коротко: реальные реквизиты/контакты/QR, `isDemo=false` везде, `siteSettings.launchReady=true`, чистый `build:production` без ошибок валидации.

## Ручной seed mock-данных (только для dev/staging датасета)

```bash
SANITY_PROJECT_ID=... SANITY_DATASET=staging SANITY_API_TOKEN=<write token> pnpm run seed:mock
```

Скрипт отказывается работать с датасетом, не похожим на dev/staging/test, без флага `--allow-production`.
