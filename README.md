# Миклуха Маклай

## Трекинг задач — только Plane

Агенты и разработчики ведут задачи **исключительно в [Plane](https://app.plane.so/art-workspace)**:
workspace `art-workspace`, проект `TOUR`.
**Использование Linear запрещено**: нельзя читать там текущие задачи и статусы,
создавать или изменять карточки, комментарии и связи, вести параллельный трекер
или синхронизацию через UI, коннектор, API, CLI, интеграции и скрипты.
Если Plane недоступен, сообщите о блокировке; не возвращайтесь к Linear.
Старые ссылки и номера `ART-…` — исторические обозначения; ищите их в Plane
или сохранённых выгрузках. Обязательные правила: [AGENTS.md](AGENTS.md).

Текущий публичный сайт — статический экспорт. Принятый переход на SSR и единый
PostgreSQL описан в [ADR v2.3](docs/adr/2026-10-18-ssr-flexible-offers-immutable-contracts.md);
исходники Admin/Commerce не означают выполненный cutover. SSR-сборка
(`pnpm run build:ssr`, `Dockerfile.ssr`, релиз по digest) существует рядом со
статической и описана в [TOUR-60](docs/plans/2026-10-29-tour-60-ssr-source-ready.md);
исторический PoC TurboFlare — в [TOUR-56](docs/plans/2026-10-29-tour-56-turboflare-poc.md),
а актуальное решение — в [docs/DECISIONS.md](docs/DECISIONS.md): TurboFlare
окончательно отменён; обработанные изображения Control Room сначала идут
напрямую через cloud.ru S3. Подключение фотографий Control Room к Shared Asset Cache
(`assets.refref.ru`, VPS-17) отложено до отдельной технической и юридической
приёмки в будущей TOUR-задаче. Для SSR hard cut обязательны только этап 1
TOUR-63 (прямой S3) и общий privacy/legal release TOUR-68; VPS-17 их не
блокирует. Граница действующего
платёжного контракта и целевого Refref v9 — в
[статусе TOUR-интеграции](docs/refref-v9-contract-status.md).

Проект самостоятельного перехода Mikluha на merchant-native Refref v10, включая
обязательные предоплаты и доплаты, — [Commerce vNext](docs/refref-v10/README.md).
Это документационный draft: действующий код, договоры и допуск продаж не меняются.

Сайт туристического агентства «Миклуха Маклай» — каталог направлений/выездов, фотоотчёты, отзывы и информационный Booking Modal (QR + бронь + телефон организатора, без сбора пользовательских данных). Архитектурные инварианты и причины, по которым они такие — `docs/DECISIONS.md`.

Сейчас работает legacy Sveltia/SSG, но целевая архитектура — самописный
Control Room + SSR; полное удаление Sveltia/Git-based publishing запланировано
в TOUR-66 при отдельно разрешённом cutover TOUR-67. Это ещё не завершено.

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
