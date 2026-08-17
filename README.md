# Миклуха Маклай

Сайт туристического агентства «Миклуха Маклай» — каталог направлений/выездов, фотоотчёты, отзывы и информационный Booking Modal (QR + предоплата + телефон организатора, без сбора пользовательских данных). Архитектурные инварианты и причины, по которым они такие — `docs/DECISIONS.md`.

Next.js App Router + TypeScript, pure static export (`output: 'export'`), shadcn/ui поверх Tailwind CSS v4. Контент — YAML-файлы в `content/` (этот репозиторий), редактируются через `/admin` (Sveltia CMS, коммитит прямо в GitHub) или руками. Публичный рантайм от CMS не зависит: контент и все изображения материализуются в статику во время сборки.

## Быстрый старт

```bash
pnpm install
pnpm dev
```

`pnpm dev` сам прогоняет `vendor:admin` (копирует Sveltia CMS в `public/admin/`) + `sync:content` + `materialize:assets` по содержимому `content/` — внешние credentials для этого не нужны.

Committed `content/` пока содержит демо-данные (`siteSettings.launchReady = false`), поэтому `pnpm run build:production` без `DEPLOY_ENV=staging` намеренно упадёт на шаге `validate:content` (production-релиз не может собираться из демо-данных — см. «Production build» ниже и `RUNBOOK.md`). Для `pnpm dev` это не проблема — `validate:content` в dev-путь не входит.

## Структура

```text
app/            Next.js App Router (страницы, layout, robots/sitemap)
components/     UI-компоненты (components/ui — shadcn/ui примитивы)
content/        контент сайта (YAML) + content/assets/ — demo-изображения
lib/            бизнес-логика, CMS-адаптер (lib/cms)
oauth-broker/   отдельный сервис: GitHub OAuth token exchange для /admin (свой Dockerfile)
public/admin/   Sveltia CMS (index.html + config.yml; sveltia-cms.js вендорится сборкой)
scripts/        build-time pipeline: sync-content → validate → materialize-assets → validate:out
```

## Production build

```bash
pnpm run build:production
```

Требует `siteSettings.launchReady = true` (реальный контент в `content/`, не демо-данные). Для demo/preview-сборки без готового контента — `DEPLOY_ENV=staging pnpm run build:production`.

Подробности пайплайна, деплой на Coolify/VPS и настройка CMS-авторизации — см. `RUNBOOK.md`.
Памятка для организатора по работе с CMS — `CONTENT-GUIDE.md`.

## Стек

Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind CSS v4 · shadcn/ui (Base UI) · Sveltia CMS · Sharp · Docker + Nginx.
