# Миклуха Маклай

Сайт туристического агентства «Миклуха Маклай» — каталог направлений/выездов, фотоотчёты, отзывы и информационный Booking Modal (QR + бронь + телефон организатора, без сбора пользовательских данных). Архитектурные инварианты и причины, по которым они такие — `docs/DECISIONS.md`.

Next.js App Router + TypeScript, pure static export (`output: 'export'`), shadcn/ui поверх Tailwind CSS v4. Контент — YAML-файлы в `content/` (этот репозиторий), редактируются через `/admin` (Sveltia CMS, коммитит прямо в GitHub по fine-grained PAT) или руками. И сайт, и `/admin` входят в один статический `/out`; своего application/serverless runtime нет. Медиа отдаются браузеру напрямую из Object Storage без build-time или runtime обработки.

## Быстрый старт

```bash
pnpm install
pnpm dev
```

`pnpm dev` сам прогоняет `vendor:admin` (копирует Sveltia CMS в `public/admin/`) + `sync:content`. Внешние credentials для сборки не нужны.

Committed `content/` пока содержит демо-данные (`siteSettings.launchReady = false`), поэтому `pnpm run build:production` без `DEPLOY_ENV=staging` намеренно упадёт на шаге `validate:content` (production-релиз не может собираться из демо-данных — см. «Production build» ниже и `RUNBOOK.md`). Для `pnpm dev` это не проблема — `validate:content` в dev-путь не входит.

## Структура

```text
app/            Next.js App Router (страницы, layout, robots/sitemap)
components/     UI-компоненты (components/ui — shadcn/ui примитивы)
content/        YAML-контент сайта
lib/            бизнес-логика, CMS-адаптер (lib/cms)
public/admin/   статический Sveltia CMS (index.html + config.yml; JS-бандл вендорится сборкой)
public/media/   небольшие committed demo-WebP для staging
scripts/        build-time pipeline: sync-content → validate → Next static export → validate:out
```

Favicon и Apple Touch Icon не управляются через CMS и не генерируются сборкой. Их один раз
добавляют в репозиторий как `app/favicon.ico` и `app/apple-icon.png`; Next.js автоматически
включает оба файла в статический export.

## Production build

```bash
pnpm run build:production
```

Требует `siteSettings.launchReady = true` (реальный контент в `content/`, не демо-данные). Для demo/preview-сборки без готового контента — `DEPLOY_ENV=staging pnpm run build:production`.

Подробности пайплайна, деплой на Coolify/VPS и настройка CMS-авторизации — см. `RUNBOOK.md`.
Памятка для организатора по работе с CMS — `CONTENT-GUIDE.md`.

## Стек

Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind CSS v4 · shadcn/ui (Base UI) · Sveltia CMS · Docker + Nginx.
