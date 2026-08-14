# Миклуха Маклай

Сайт туристического агентства «Миклуха Маклай» — каталог направлений/выездов, фотоотчёты, отзывы и информационный Booking Modal (QR + предоплата + телефон организатора, без сбора пользовательских данных). Архитектурные инварианты и причины, по которым они такие — `docs/DECISIONS.md`.

Next.js App Router + TypeScript, pure static export (`output: 'export'`), shadcn/ui поверх Tailwind CSS v4. Контент — Sanity (схемы в `/sanity`), но публичный рантайм от Sanity не зависит: контент и все изображения материализуются в статику во время сборки.

## Быстрый старт

```bash
pnpm install
pnpm dev
```

Без переменных `SANITY_PROJECT_ID`/`SANITY_DATASET` сборка и dev-сервер используют локальный mock-контент из `lib/cms/fixtures/` — реальный Sanity-проект для запуска не нужен. Чтобы подключить настоящий Sanity, см. `.env.example`.

Этот mock-контент имеет `siteSettings.launchReady = false`, поэтому `pnpm run build:production` без `DEPLOY_ENV=staging` намеренно упадёт на шаге `validate:content` (production-релиз не может собираться из демо-данных — см. «Production build» ниже и `RUNBOOK.md`). Для `pnpm dev` это не проблема — `validate:content` в dev-путь не входит.

## Структура

```text
app/            Next.js App Router (страницы, layout, robots/sitemap)
components/     UI-компоненты (components/ui — shadcn/ui примитивы)
lib/            бизнес-логика, CMS-адаптер (lib/cms), фикстуры моков
                lib/cms/generated/ — типы из Sanity TypeGen, руками не редактируются
sanity/         Sanity Studio: схемы, структура, конфиг (не отдельный пакет)
scripts/        build-time pipeline: sync-cms → materialize-assets → validate → validate:out
```

## Production build

```bash
pnpm run build:production
```

Требует `siteSettings.launchReady = true` (реальный контент из Sanity, не фикстуры). Для demo/preview-сборки без готового контента — `DEPLOY_ENV=staging pnpm run build:production`.

Подробности пайплайна, деплой на Coolify/VPS и плановый rebuild — см. `RUNBOOK.md`.
Памятка для организатора по работе с Sanity Studio — `CONTENT-GUIDE.md`.

## Стек

Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind CSS v4 · shadcn/ui (Base UI) · Sanity · Sharp · Docker + Nginx.
