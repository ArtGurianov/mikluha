# Деплой и эксплуатация — Миклуха Маклай

Технический runbook для разработчика/DevOps. Памятка для организатора — в `CONTENT-GUIDE.md`.

## Архитектура

- Публичный сайт — pure static export (`output: 'export'`), обслуживается Nginx из `/out`.
- Контент — YAML-файлы в `content/`, часть этого репозитория. Редактируется через `/admin`
  (Sveltia CMS: статический JS-бандл, коммитит прямо в GitHub) или руками. И сайт, и CMS
  входят в статический `/out`; браузер получает WebP/WebM напрямую из cloud.ru Object Storage.
  Сборка не скачивает и не преобразует медиа.
- Один Coolify application `miklukha`: сайт и `/admin` собираются одним `Dockerfile`
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
   preflight. **Важно:** cloud.ru Evolution Object Storage отвечает на CORS preflight только на
   domain-style хосте бакета (`https://<bucket>.s3.cloud.ru`), а не на общем API-хосте
   (`https://s3.cloud.ru/<bucket>/...`) — там preflight падает с `403 AccessDenied` независимо от
   настроек CORS. Поэтому `media_libraries.aws_s3.endpoint` должен указывать на domain-style
   хост (см. п. 4), а не на `https://s3.cloud.ru`.
3. Выдать редакторам scoped-ключ с `ListBucket` на bucket (ограничив список префиксом `cms/`) и
   `GetObject`/`PutObject` только на `cms/*`, без `DeleteObject`. Sveltia сначала запрашивает
   список объектов медиатеки, поэтому ключ только с `PutObject` не работает.
4. В `public/admin/config.yml` → `media_libraries.aws_s3` указать `access_key_id` в формате
   cloud.ru `<tenant_id>:<key_id>` (не секретный), `bucket`, а `endpoint` — domain-style хост
   бакета (`https://<bucket-domain>.s3.cloud.ru`, **не** `https://s3.cloud.ru`) вместе с
   `force_path_style: false`. **Secret access key в конфиг не пишется** — каждый редактор вводит
   его один раз в интерфейсе Sveltia при первой загрузке файла; хранится только в его браузере.

   Sveltia CMS 0.191.1 из коробки не поддерживает `force_path_style: false` вместе с кастомным
   `endpoint` — при заданном `endpoint` она всегда строит path-style URL
   (`${endpoint}/${bucket}/${key}`), что и приводит к `403` на cloud.ru. Это исправлено через
   `pnpm patch` в `patches/@sveltia__cms@0.191.1.patch` (регистрируется в
   `pnpm-workspace.yaml`, переживает `pnpm install`): при `force_path_style: false` и заданном
   `endpoint` Sveltia теперь считает `endpoint` уже готовым host'ом бакета
   (`${endpoint}/${key}`, без сегмента `bucket`) — как для LIST (`ListObjectsV2`), так и для
   `PUT`-загрузки. Тот же патч также ослабляет AWS-специфичную проверку формата Secret Access
   Key (`apiKeyPattern`) до любого непустого значения, поскольку cloud.ru не обязан
   соответствовать историческому 40-символьному AWS-формату.

   **Technical debt:** оба фикса завязаны на конкретную реализацию 0.191.1, а не на публичный
   API Sveltia. При обновлении `@sveltia/cms` до новой версии **нельзя** просто переносить патч
   механически (`pnpm patch @sveltia/cms@<new-version>` возьмёт новый код, но правки внутри —
   это ручной diff по старым именам/веткам условий) — сначала проверить апстрим:
   - `services/integrations/media-libraries/cloud/s3/aws-s3.js` → `apiKeyPattern` для `aws_s3`;
   - `services/integrations/media-libraries/cloud/s3/core.js` → `buildObjectUrl`,
     `listS3Objects`, `uploadToS3` (учитывают ли они `force_path_style` при заданном `endpoint`).

   Если апстрим уже решил любую из этих двух проблем (снял AWS-специфичный regex secret'а,
   поддержал virtual-hosted-style для кастомного `endpoint`) — соответствующий кусок патча нужно
   **удалить**, а не переносить поверх нового кода: иначе патч либо перестанет применяться
   (`pnpm install` упадёт на конфликте), либо, что хуже, тихо задублирует/переопределит уже
   рабочую логику апстрима. Проверять по исходникам новой версии (`sourcesContent` в
   `dist/sveltia-cms.js.map`, как в этом расследовании), не только по CHANGELOG.

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

## Локальный Git при двух писателях в `main`

Sveltia коммитит контент прямо в `main` через GitHub API, поэтому local `main` регулярно
отстаёт от remote — это ожидаемо, не признак конфликта. `git pull` (merge) в такой ситуации
плодит лишние merge-коммиты; **`git push --force`/`-f` опасен** — может стереть content-коммиты,
которые Sveltia сделала после последнего pull. Правильная операция — rebase, не merge и не force.

Разово для этого репозитория:

```bash
git config pull.rebase true
```

после этого `git pull` сам делает rebase вместо merge-коммита.

Обычный workflow редактирования кода при работающем `/admin`:

```bash
git pull --rebase          # подтянуть коммиты, которые могла сделать Sveltia
# ...работа, git add -A, git commit...
git pull --rebase          # ещё раз: Sveltia могла закоммитить, пока шла работа
git push
```

`git add -A`, не `git add *` — `*` раскрывается шеллом до путей в `.gitignore` (`node_modules`,
`out`, `next-env.d.ts`, `tsconfig.tsbuildinfo`) и Git будет ругаться на игнорируемые файлы;
`-A` учитывает `.gitignore` и стейджит добавления/изменения/удаления разом.

При конфликте во время rebase: исправить конфликтующие файлы → `git add <файлы>` →
`git rebase --continue` → затем обычный `git push`.

Если force push всё же нужен (осознанный переписанный history, не обычная работа) — только
`git push --force-with-lease`, никогда голый `--force`: `--force-with-lease` откажется
перезаписать remote, если там появились чужие (Sveltia-) коммиты, которых нет в локальной копии.

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
