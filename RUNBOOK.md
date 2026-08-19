# Деплой и эксплуатация — Миклуха Маклай

Технический runbook для разработчика/DevOps. Памятка для организатора — в `CONTENT-GUIDE.md`.

## Архитектура

- Публичный сайт — pure static export (`output: 'export'`), обслуживается Nginx из `/out`.
- Контент — YAML-файлы в `content/`, часть этого репозитория. Редактируется через `/admin`
  (Sveltia CMS: статический JS-бандл, коммитит прямо в GitHub) или руками. И сайт, и CMS
  входят в статический `/out`; браузер получает WebP/WebM напрямую из cloud.ru Object Storage.
  Сборка не скачивает и не преобразует медиа.
- Один Coolify application `mikluha`: сайт и `/admin` собираются одним `Dockerfile`
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
«Фоновое видео WebM» и обязательно (сборка падает, если файл не загружен, — см.
`lib/cms/normalize.ts`). Фоновое изображение всегда используется как poster, пока видео
догружается, и как единственный fallback при отключённой анимации (`prefers-reduced-motion`,
видео тогда даже не запрашивается) или ошибке воспроизведения.

Это же видео используется вторым фоном в CTA-секции внизу главной. Два `<video>` с одним `src`
браузер **не** дедуплицирует: HTTP-кэш может схлопнуть второй запрос только если первый ответ
уже сохранён к моменту старта второго, а при одновременном старте они просто гонятся. Поэтому
нижний экземпляр рендерится с `lazy` (`components/home/hero-media.tsx`): `preload="none"`, без
`autoPlay`, загрузка стартует по IntersectionObserver, когда до секции остаётся ~200px. К этому
моменту hero-копия обычно уже скачана, и вторая берётся из кэша.

**Требуется настройка бакета, чтобы это стало гарантией, а не везением.** Сейчас cloud.ru
отдаёт объекты `cms/*` вообще без `Cache-Control` и `Expires` — только `ETag` и `Last-Modified`.
Без них Chrome применяет эвристическую свежесть (~10% возраста от `Last-Modified`): на практике
кэш срабатывает, но это догадка браузера, а не контракт, и на других движках может не сработать.
Нужно выставить на префиксе `cms/` в cloud.ru:

```
Cache-Control: public, max-age=31536000, immutable
```

Это безопасно, потому что объекты иммутабельны по построению: CMS никогда не перезаписывает
файл — новая загрузка создаёт новый ключ, а старый остаётся (у ключа редактора нет
`DeleteObject`). Помимо второй копии видео это чинит и повторные визиты: сейчас каждый заход
на сайт заново тянет все 9+ МБ медиа.

Favicon и Apple Touch Icon загружаются не в CMS/Object Storage, а один раз коммитятся в
репозиторий как `app/favicon.ico` и `app/apple-icon.png`. Next.js копирует их в статический
export и добавляет metadata-теги автоматически; никакого materializer для этого нет.

## CMS: публикация (Simple Workflow + `skip_ci`)

`/admin` работает в Sveltia Simple Workflow (никакой `publish_mode` в `public/admin/config.yml` —
Editorial Workflow с этого проекта снят, историческая запись почему — `docs/DECISIONS.md` →
«CMS publish: Simple Workflow + `skip_ci`, не Editorial Workflow»). Save коммитит прямо в
`main`, как обычно, но `backend.skip_ci: true` заставляет Sveltia добавлять к сообщению каждого
такого коммита префикс `[skip ci] ` — **кроме** удалений (Delete записи/медиа), которые Sveltia
никогда не помечает skip: это намеренно, чтобы удаление не могло незаметно зависнуть
неопубликованным (`services/backends/git/shared/commits.js` → `createCommitMessage`, проверено
по исходнику 0.193.0). GitHub push происходит при каждом Save как обычно; production build не
запускается,
только если сам Coolify умеет распознавать `[skip ci]` в commit message — см. предупреждение
ниже.

**Обязательно проверить перед тем, как полагаться на эту схему: версия Coolify ≥ 4.1.0.**
Поддержку `[skip ci]`/`[skip cd]` в webhook-деплое Coolify добавил только в v4.1.0 (18 мая 2026,
[coollabsio/coolify#9861](https://github.com/coollabsio/coolify/pull/9861)). На более старой
версии Coolify этот маркер просто игнорируется, и **каждый Save всё равно запускает build** —
вся схема ниже работает только на актуальной версии. Проверить версию — в Coolify UI (обычно
в подвале страницы или в Instance Settings) или `coolify version` на сервере; при устаревшей
версии — сначала обновить Coolify, потом полагаться на `skip_ci`.

### Кнопка «Опубликовать изменения»

Sveltia 0.193.0 показывает в главном тулбаре штатную кнопку `publish_changes`, но **только когда
`backend.skip_ci` явно задан булевым значением** в конфиге (`services/backends/git/shared/
integration.js` → `skipCIConfigured`) — то есть она уже появляется как следствие текущего
конфига, без дополнительных настроек. Официальный `ru.json` Sveltia переводит её как
**«Опубликовать изменения»** — ровно то название, что нужно; патчить UI не потребовалось,
подтверждено прямо в `locales/ru.json` установленного пакета. Показывается кнопка только в
русской локали интерфейса CMS (выбор языка — Settings редактора, `prefs`, как и всё остальное в
этом `/admin`, обычно уже русский по умолчанию для русскоязычного браузера).

**Кнопка не создаёт git-коммит.** Это принципиально другой механизм, чем «коммит без
skip-маркера», который можно было предположить заранее — проверено по
`components/global/toolbar/items/publish-button.svelte` и подтверждено официальной
документацией Sveltia (`sveltiacms.app/en/docs/deployments`):

- если у редактора в Settings → Advanced задан Deploy Hook URL — кнопка делает `POST` на этот
  URL;
- **если Deploy Hook URL не задан (наш случай, и мы намеренно его не настраиваем)** — кнопка
  вызывает GitHub `repository_dispatch` с `event_type: sveltia-cms-publish`.

Сознательно выбран второй путь, а не Deploy Hook URL в браузере: Deploy Hook требовал бы хранить
Coolify webhook URL и Bearer-токен в Settings **каждого редактора отдельно**, плюс кросс-origin
`fetch` с `/admin` на хост Coolify упирается в CORS-неопределённость (Coolify не документирует
поддержку browser-side запросов на `/api/v1/deploy`), а при отсутствии заголовка авторизации
Sveltia делает запрос в режиме `no-cors` и **считает публикацию успешной, даже если Coolify
ответил `401`** — то есть тихий false positive. `repository_dispatch` эту категорию проблем
снимает полностью: секреты Coolify живут только в GitHub repository secrets, никогда не попадают
в браузер редактора, а сам запрос — server-to-server (GitHub Actions → Coolify), без CORS.

`repository_dispatch` вызывается через тот же editor-scoped GitHub API, которым Sveltia уже
пользуется для commits — эндпоинту `POST /repos/{owner}/{repo}/dispatches` для fine-grained PAT
достаточно permission `Contents: write` ([GitHub REST reference — Permissions required for
fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)),
которая у редакторского PAT уже есть (см. «CMS: авторизация редакторов» выше) — никаких
дополнительных GitHub-прав редакторам выдавать не нужно.

Событие принимает `.github/workflows/publish.yml` (`on: repository_dispatch`, `types:
[sveltia-cms-publish]`) — единственный шаг делает `curl` на Coolify Deploy Webhook с
Bearer-токеном. Разовая настройка репозитория (не редактора):

1. В Coolify: приложение `mikluha` → Configuration → Webhooks → скопировать `Deploy Webhook
   (auth required)` URL (вид `https://<coolify-host>/api/v1/deploy?uuid=<uuid>&force=false`).
2. Там же в Coolify: Keys & Tokens → API Tokens → создать токен с правом `deploy` (без `root`,
   `write`, `read:sensitive` и т. п.).
3. В GitHub: репозиторий → Settings → Secrets and variables → Actions → добавить
   `COOLIFY_WEBHOOK` (URL из шага 1) и `COOLIFY_TOKEN` (токен из шага 2).
4. Закоммитить и запушить `.github/workflows/publish.yml` в `main` — `repository_dispatch`
   срабатывает только для workflow-файлов, уже присутствующих в default branch на момент
   события, поэтому этот шаг обязателен один раз при внедрении.

**Непроверено вживую и требует E2E-теста** (см. чеклист ниже): что `repository_dispatch`
корректно доходит до Action, что `curl` внутри неё успешно аутентифицируется на Coolify и что
это действительно запускает ровно один build. В отличие от прежнего Deploy Hook-в-браузере
варианта, здесь при сбое видна причина в логах самого GitHub Action (упавший `curl` из-за
`--fail-with-body`), а не тихий "успех" в интерфейсе Sveltia.

### Save and Publish — publish одной записи, без общей кнопки

У Sveltia также есть per-entry вариант: стрелка рядом с кнопкой Save в редакторе конкретной
записи → **Save and Publish**. Он коммитит эту одну запись **без** `[skip ci]`, то есть выкатывает
её сразу обычным push → Coolify Auto Deploy — независимо от `repository_dispatch`/Action выше.
Удобно, если нужно опубликовать одну правку немедленно, не дожидаясь конца сессии и не трогая
остальные накопленные `[skip ci]`-Save. Основной сценарий (см. цель миграции) — по-прежнему
глобальная «Опубликовать изменения» в конце сессии.

### Как это выглядит для редактора

1. Открыть запись.
2. Внести изменения.
3. Нажать Save.
4. Повторить для любых других записей.
5. Save можно нажимать сколько угодно — production build не запускается (при условии, что
   Coolify ≥ 4.1.0 — см. выше).
6. Когда вся редакторская сессия закончена — нажать «Опубликовать изменения» в тулбаре.
7. Только после этого запускается ровно один Coolify build, включающий все накопленные Save.

Save = сохранить в Git, не выкатывать production. Опубликовать изменения = выпустить весь
текущий `main`, независимо от того, в скольких разных записях были правки — это не per-entry
операция (в отличие от снятого Editorial Workflow), а site-level trigger через GitHub Action.

**Важная семантика, которую нужно понимать: `skip_ci` — это не настоящий draft-branch.** После
обычного Save изменения уже находятся в `main`, просто без build. Значит, **ручной Deploy в
Coolify UI, Save and Publish, коммит без skip-маркера (например, Delete — см. ниже) или любой
другой механизм запуска build выпустит все ранее сохранённые Save, даже если редактор не нажимал
«Опубликовать изменения»**. Это осознанный trade-off этой схемы, принятый для `mikluha` вместо
per-entry Editorial Workflow — обратное (гарантированная изоляция черновиков) стоило бы отдельных
веток/PR за каждую запись, что и было в Editorial Workflow и не подошло по UX.

> **Отдельно, жирным: удаление (Delete записи или медиа) в Sveltia никогда не получает
> `[skip ci]`** — это намеренное поведение апстрима, не баг и не то, что стоит патчить: Sveltia
> не даёт удалению остаться незамеченным CI, чтобы удалённый контент не продолжал жить
> опубликованным. Практическое следствие: `Save A → Save B → Delete C` запушит **A, B и
> удаление C** одним обычным (без `[skip ci]`) коммитом, который Coolify соберёт сразу — раньше,
> чем редактор нажмёт «Опубликовать изменения». Модель — не строгая атомарная транзакция
> «Save × N → один Publish», а «Save/update × N → batch publish, но Delete публикуется
> немедленно». Для этого проекта это разумный компромисс (удаление обычно и означает «убрать с
> сайта прямо сейчас»), патчить не планируется.

### Edge case: Publish без новых изменений

Кнопка не зависит от git state вообще (см. выше — она не создаёт коммит), поэтому сценарий «Save
A → Save B → Save C → сессия закончена → нажать Publish без дальнейших правок» работает без
специальной логики: `repository_dispatch` → Action → `curl` на Coolify Deploy Webhook запускает
build того, что сейчас лежит в `main`, вне зависимости от того, был ли только что новый Save.
Пустой git-коммит создавать не нужно и не создаётся.

### E2E-чеклист (сделать один раз после того, как secrets и workflow-файл в `main`)

| Шаг | Ожидание в GitHub | Ожидание в Coolify |
|---|---|---|
| Save записи A | новый коммит в `main`, сообщение начинается с `[skip ci]` | Deployments: ничего нового |
| Save записи B (другой) | ещё коммит в `main`, `[skip ci]` | ничего нового |
| Save записи C | ещё коммит в `main`, `[skip ci]` | ничего нового |
| Нажать «Опубликовать изменения» | Actions → появился запуск `Publish site` (событие `repository_dispatch`, тип `sveltia-cms-publish`), шаг `Trigger Coolify deployment` зелёный | Deployments → появился ровно один новый deployment, содержащий A + B + C |

Если шаг `Trigger Coolify deployment` красный — из-за `--fail-with-body` тело ответа Coolify
попадёт прямо в лог Action (обычно `401`/`403` — неверный токен или URL, значит перепроверить
`COOLIFY_WEBHOOK`/`COOLIFY_TOKEN`). Если Action вообще не запустился — проверить, что
`.github/workflows/publish.yml` действительно есть в `main` (см. шаг 4 настройки выше) и что PAT
редактора не потерял `Contents: write`.

Отдельно проверить edge case из «жирного» предупреждения выше: Save A → Save B → **Delete**
какой-нибудь записи, без нажатия «Опубликовать изменения». Ожидание: коммит удаления **без**
`[skip ci]` → Coolify build запускается сразу, ещё до Publish, и включает A и B тоже.

## GitHub push → rebuild

Каждый Save → push в `main` с `[skip ci]` в сообщении (кроме Delete) → Coolify получает
push-событие как обычно, но не запускает build, если распознаёт маркер (см. «CMS: публикация»
выше — версия Coolify критична). Отдельного webhook-конфига в CMS настраивать не нужно — это
уже GitHub-репозиторий, который Coolify отслеживает напрямую через свой push-webhook. «Опубликовать
изменения» идёт другим путём и с этим push-webhook'ом не связана вовсе — см. `repository_dispatch`
→ `.github/workflows/publish.yml` → Coolify Deploy Webhook в «CMS: публикация» выше.

## Локальный Git при двух писателях в `main`

Sveltia пишет в `main` через GitHub API на каждый Save (Simple Workflow — как и до Editorial
Workflow), поэтому local `main` может отстать от remote в любой момент — это ожидаемо, не
признак конфликта. `git pull` (merge) в такой ситуации плодит лишние merge-коммиты; **`git push
--force`/`-f` опасен** — может стереть content-коммит, который Sveltia запушила после последнего
pull. Правильная операция — rebase, не merge и не force.

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
