# SSR/Admin: эксплуатационная приёмка перед юридической публикацией

Дата подготовки: 30.10.2026. Задачи: TOUR-67 (приёмка), TOUR-59/68 (юридическая
публикация), TOUR-63 (direct S3), TOUR-93 (первичная проверка хранения).
Статус этого документа: подготовленный порядок, revision 3: раздельный допуск служебного контура и контента;
не свидетельство установки. Снимки исходного состояния ниже относятся к подготовке
revision 1; перед исполнением их повторить.

CUSTODY_IMPACT: NO — подготовка исходного runbook и read-only проверка; хост,
ключи, БД и юридические публикации не изменены. При исполнении установка имеет
CUSTODY_IMPACT: YES с перечислением ресурсов и authority в инфраструктурном PR
и [VPS-15](https://app.plane.so/art-workspace/browse/VPS-15/).

## Проверенные исходные факты

- PR #62 открыт как draft на `ddd7f893915a7892ee62f7a6537feb5eca784848`.
  Hosted CI для этого полного HEAD: SUCCESS, run `41076288369`.
- `origin/main` на момент проверки: `68130f02ca214eb3fea7f7893b9b2cc59e10fede`.
  PR #58/59/61/60 уже merged: чистая схема, SSR/retirement, direct S3, редакторы.
  main является предком указанного HEAD #62; интеграционный merge для этих
  изменений не требуется. Это не разрешение merge или deployment PR #62.
- На VPS работает `mikluha-maintenance`; новых Mikluha PostgreSQL, Commerce,
  Admin API/UI, SSR и media-worker в `docker ps` нет. В списке ресурсов Coolify
  новых Mikluha приложений/БД нет. Новые Mikluha backup units не обнаружены.
  Наличие исторических SOPS-файлов в инфраструктурном репозитории не является
  разрешением восстанавливать удалённые credentials или legacy-инфраструктуру.
- `/` VPS: 31 GiB свободно; RAM available около 4.8 GiB. Это датированный
  read-only снимок, не обещание доступных ресурсов на дату установки.
- Обе полные UTF-8 редакции сверены с OWNER-решением, SHA256SUMS и PR #62:
  privacy `359615e732329e3f85a0807d153ff3a153bbe53a55105ae9e7610c308a5cc0e4`;
  cookies `71d4e6fbbca71d707d904fe2f370d2245a4e4faa16ecdd998f7cd0d980e2252c`.
  Статус: APPROVED BY OWNER / NOT PUBLISHED. Тела не редактируются.
- Первичное OWNER-подтверждение проверено непосредственно в исходном сообщении.
  Репозиторий Mikluha **PUBLIC**, поэтому идентификаторы чата/сообщения и его
  цитата сюда не копируются. Receipt хранится в PRIVATE инфраструктурном
  репозитории; здесь только [ссылка на точный commit и SHA-256 файла](../evidence/2026-10-30-ssr-admin-owner-approval-reference.json).
  Receipt подтверждает происхождение решения, но не заменяет Commerce approval
  или публикацию. Право прочитать публичную ссылку не даёт доступа к private repo.
  После merge private PR #20 перепроверить неизменность receipt и закрепить
  ссылку за точным merge commit в main приватного репозитория (не за плавающим
  main); SHA-256 файла должен остаться тем же.

## 0. Два разных допуска

**Phase A — приватный служебный контур и две legal редакции.** Приёмка на
синтетике, чистая рабочая БД, только действительно необходимые OWNER accounts
и публикация
только уже утверждённых privacy-policy/cookies после backup/restore и остальных
условий этого этапа. Полный сценарий удаления произвольного content payload не
является требованием Phase A; её post-backup сценарий 2.3-A использует только
существующие disable/revoke/media-withdrawal операции. Проверку роли EDITOR
проводить только на synthetic accounts одноразовой acceptance БД; реальный
EDITOR-доступ в рабочей БД не выдавать в Phase A. Его выдача — после подтверждённой
необходимости и отдельного допуска Phase B. Это планируемый ограниченный
допуск, не фактическое GO на host mutations или выполненная приёмка.

**Phase B — реальный контент с ПД третьих лиц.** Реальные организаторы, отзывы,
контакты, персональные изображения и их загрузка даже в draft запрещены до
[TOUR-94](https://app.plane.so/art-workspace/browse/TOUR-94/): штатная процедура
прекращения хранения/обезличивания revision payload и полный restore сценарий
2.3-B. Формальная точка допуска — [TOUR-95](https://app.plane.so/art-workspace/browse/TOUR-95/),
заблокированная TOUR-94 (blocks). Done prerequisite само по себе не открывает
контент. Снятие публикации прекращает выдачу, но не удаляет ПД из immutable history.
Обычный editor UI технически не вводит эту границу автоматически: при Phase A
исполнитель работает по явному allowlist (два legal slug и минимальные accounts),
проверяет отсутствие стороннего контента; общий доступ к наполнению не выдаётся.

Не объявлять Phase A обработкой «вообще без ПД»: персональные идентификаторы
администраторов и реквизиты в утверждённых legal bodies остаются данными в
реальном контуре. Использовать минимальные служебные login без лишних профилей,
не писать в audit reasons/document fields чужие телефоны, имена и произвольные ПД.
В TOUR-93 до допуска установить необходимость/основание ограниченной security
истории accounts/sessions/audit и отдельного legal evidence, доступ, сроки/holds и
действия при прекращении цели. Disable/revoke — **ограничение доступа**, не
уничтожение аккаунта, секретов или истории; append-only не основание хранить
необязательные ПД бессрочно. Если для данных самой Phase A уже требуется
удаление/минимизация, которого система не умеет выполнять, эта часть Phase A
тоже NO-GO до поддерживаемой процедуры. Разделение не отменяет утверждённую политику.

## 1. Комплект установки и полномочия

До записи на VPS подготовить и проверить конкретный инфраструктурный PR:

| Ресурс | Граница и authority |
| --- | --- |
| Две независимые PostgreSQL 16 БД/volumes | Одноразовая acceptance БД и создаваемая после PASS чистая рабочая БД; отдельные credentials/backup prefixes; полный журнал выбранного image, baseline 0001–0019; никакого demo/legacy import |
| Commerce public API и SSR | Отдельные digest-pinned images, внутренний API; SSR без DB/Admin/provider credentials |
| Admin API и Control Room | Изолированные capabilities, TOTP, приватный TLS-вход через SSH; API без собственного публичного маршрута |
| Media worker и decoder | Отдельный media DB login/S3 principal; decoder без IP-сети и credentials; direct S3, без VPS-17 |
| Новые DB/Admin/audit/TOTP/media секреты | Зарегистрировать соответствующую authority; секреты не в Git/argv/логах. Не возвращать старые env |
| Приватные Docker-сети и volumes | DB только нужным потребителям; decoder socket не хранит данные для recovery; публичных DB/API ports нет |
| Автоматический logical backup | PostgreSQL 16 dump, отдельный prefix, age public recipient; расшифровывающий ключ остаётся off-host |
| Backup timer, проверка свежести и recovery inventory | Явный cadence/retention/failure signal; существующие чужие timers/prefixes не менять |
| Isolated restore и cleanup | Отдельная временная сеть/БД; без внешнего egress, media worker и публичной маршрутизации; точные ID volumes/DB/synthetic S3 keys в отдельном GO на очистку |

Перед исполнением зафиксировать выбранный SOURCE_COMMIT и реальные registry
RepoDigests всех images. Теги/CI не заменяют digest read-back. Кандидат обязан
содержать изменения PR #62, в том числе live Commerce legal authority и renderer
`7763a775bf9fc5b484c304f80e7d72b871ae21f7` (единственный H1/таблицы). Проверить
ancestry, соответствующие source files и actual-image smoke, не только номер PR.
Предпочтительный путь — отдельно разрешённый merge #62, затем перенаправление
документационного PR #63 с ветки #62 на main и проверка оставшегося diff/CI;
после отдельно разрешённого merge #63 выбирается точный main SHA
с новой image/CI-квалификацией. Merge этим runbook не разрешён. Установка draft
HEAD `ddd7f893915a7892ee62f7a6537feb5eca784848` допустима только если он и его
digests прямо названы в отдельной OWNER-авторизации. Любое обновление кандидата
требует повторной квалификации; факт установки здесь не утверждается.

В конкретном GO перечислить новые credentials/ключи, сети/volumes, backup units,
одноразовый и рабочий контуры, isolated restore, **создание и удаление точного
набора синтетических Cloud.ru объектов** и очистку точных одноразовых DB/volumes.
Общее разрешение на приёмку, старый GO TOUR-63 или legacy hard-delete не является
стоящим разрешением на новые удаления. Не удалять immutable строки из рабочей БД.

Maintenance остаётся публичным состоянием. Приёмка использует только приватный
TLS-вход через SSH; порты VPS привязаны к 127.0.0.1. Согласовать один HTTPS origin:
сертификат/SNI, браузерный Host, Origin, ADMIN_ORIGIN и заголовок к Admin API должны
совпасть; __Host-mk_admin реально устанавливается и отправляется с Secure,
HttpOnly, SameSite=Strict, Path=/ и без Domain. Прямой HTTP не квалифицирует вход.
В текущем Nginx `proxy_set_header Host $host` не сохраняет нестандартный порт:
при таком порте требуются отдельно проверенная передача полного host:port или
origin на стандартном HTTPS-порту; проверку 421/CSRF не ослаблять. Проверить
положительный login и отрицательные Host/Origin до любых реальных credentials.
DNS, действующая маршрутизация домена и продажи остаются NO-GO. Refref,
Flexperiment и общий control plane не изменяются.

## 2. Два контура и backup/restore до реальных данных

### 2.1 Одноразовая acceptance БД

Все synthetic OWNER/EDITOR, TOTP, audit, legal publications, faulty/outage/media
проверки раздела 3 выполняются **только** в отдельной acceptance БД. До начала
зафиксировать её DB/cluster/volume ID, synthetic key generation, internal network
и backup prefix. Сервисы с этой БД никогда не переводятся в рабочие изменением
имени или флага. Append-only audit/legal history и immutable legal slug означают,
что очистка строк не превращает её в чистую рабочую БД. Запреты/триггеры не обходить.

1. Создать acceptance БД из полного immutable журнала; записать schema/source,
   проверить изоляцию logins и CLOSED. Добавить только synthetic accounts/content.
2. Тем же инструментом/config-контрактом, который будет использовать рабочая БД,
   выполнить encrypted logical dump PostgreSQL 16. Manifest связывает DB ID,
   schema/source/digest, backup time и **идентификатор поколения**, но не значения
   секретов. Затем upload в отдельный off-host acceptance prefix.
3. Независимым GET получить удалённый archive и manifest; проверить размер/хеш
   encrypted bytes. Локальный cached archive не является provider proof.
4. В отдельном restore-контуре без внешних действий расшифровать и восстановить
   dump; выполнить критерии 2.2 и post-backup reconciliation 2.3-A; 2.3-B требуется для Phase B.
5. Проверить автоматический запуск, freshness/failure signal и фактическую
   retention-очистку только согласованных тестовых артефактов. Сохранить exact
   receipt; отсутствие decrypt key или невозможность исполнить операции
   **заявленной фазы** не является PASS. 2.3-B не объявлять исполненным в Phase A.

### 2.2 Работоспособность и криптографическая целостность Admin

Один pg_dump не сохраняет глобальные PostgreSQL-роли. Инфраструктурный комплект
должен воспроизводимо создавать **только Mikluha** roles/logins/memberships,
object owners, grants/default privileges из проверенного scoped manifest.
Не импортировать все роли shared VPS или password hashes через pg_dumpall.
Пароли/ключи восстанавливаются отдельной разрешённой secret authority, а не из
plaintext SQL или обычного dump. Сопоставить owners/ACL с исходным manifest.

PASS включает положительные и отрицательные capability-пробы каждого созданного
service/operator login: отсутствие superuser/BYPASSRLS/DDL/чужих memberships,
Admin без коммерческих ПД/финансов и прямой публикации, publisher без draft/login,
media без Admin/платежей, операторские полномочия не у сервисов. Учитывать только
явно созданные login-роли и все предусмотренные миграциями NOLOGIN-роли.

Независимо получить из согласованного off-host secret-хранилища соответствующий
поколению `ADMIN_TOTP_KEY`, текущий и нужные historical audit keys/key IDs,
restore/decrypt authority и необходимые scoped DB credentials. Доступность
исходного VPS env не считается off-host proof. Ключи, их хэши, токены, seeds и
credential values не попадают в Git, dump или отчёты; достаточно key IDs и PASS.
Session/throttle keys **производятся HKDF из ADMIN_TOTP_KEY**, отдельного session
key env нет. TOTP ciphertext v1 не содержит key ID: generation manifest должен
однозначно связывать его с нужным ключом; штатную ротацию/версионирование TOTP
этим документом не предполагаем.

На восстановленных synthetic rows проверить:

- auditEvidence/verifyAttestation: исходные API-аудит и AUTH.LOGIN → publication
  chain остаются ATTESTED под правильными audit key IDs; tampering — FORGED,
  отсутствие historical key — UNVERIFIABLE и NO-GO для требующей его истории;
- decryptSeed с соответствующим TOTP key и account AAD возвращает исходный
  synthetic seed/валидный TOTP; неправильный ключ и account ID отвергаются;
- производный session MAC воспроизводим в тесте, а восстановленные до-backup
  сессии **не допускаются к реальным сервисам**: отзыв и re-auth по 2.3-A обязательны.

Это критерии будущего isolated restore, не заявление, что имеющиеся unit-тесты
уже квалифицировали эксплуатационное восстановление.

### 2.3 Не возвращать отозванные полномочия и удалённые данные

Вне зависимости от фазы до допуска любой восстановленной БД сверить backup time
с независимыми актуальными доказательствами последующих restrictions/deletions.
В инфраструктурном PR определить внешний источник/authority, актуальность,
минимальные поля и безопасный replay. Ledger из старого dump — не независимое
последнее состояние; ledger не должен стать вторым архивом удалённых payloads.
До сверки заблокированы ingress, Admin login и media worker. Нет актуальной
достоверной authority/нельзя применить существующее ограничение — NO-GO.

**2.3-A — обязательный сценарий Phase A на существующих операциях.** На одноразовой
БД создать synthetic account/session и согласованный synthetic media asset;
backup T0 → `setDisabled`/`revokeSessions` и media revoke T1 → независимая запись
актуальных ограничений → restore T0 в изоляции → повторное применение T1 →
disabled login и прежний token отвергнуты, public media eligibility отсутствует,
согласованные S3 keys отсутствуют по authenticated 404/anonymous denial и worker
не может восстановить отозванный asset. Все восстановленные сессии отозвать до
re-auth. Проверять фактический revoke, а не одно лишь истечение TTL. Удаления
синтетических S3 keys входят в конкретный OWNER GO по §1.

Этот PASS означает восстановление **ограничений доступа и media withdrawal**,
а не общую процедуру уничтожения ПД. Optional TOTP reset допускается только по
существующей audited operator процедуре и отдельной авторизации; его удаление
seed не является обезличиванием accounts/audit или контента. Реальный сторонний
контент и synthetic payload-deletion требования 2.3-B в Phase A не подменяются
несуществующим SQL/API или фиктивным PASS.

**2.3-B — отдельный обязательный gate до Phase B / TOUR-94.** Сейчас штатной общей
операции удаления/обезличивания content payload нет: content_item_revision,
editorial_audit/legal_publication immutable, published item защищён от удаления.
Не обходить триггеры и не править старые миграции. Требуется спроектировать и
проверить forward-only контракт: снять публичную выдачу и прекратить хранение
payload в draft/current/history/export, когда необходимость отпала, с отдельными
lawful holds и минимальными доказательствами события/полномочий. Сохранение старого
hash само по себе не доказывает обезличивание или корректную audit-аттестацию.

После реализации выполнить synthetic backup T0 → настоящее поддерживаемое
удаление/минимизация payload T1 → независимая актуальная запись решения → restore
T0 → replay T1 до ingress/worker → payload отсутствует в read/history/export путях
и не восстанавливается в S3. Невыполнимая процедура/неполная сверка — Phase B NO-GO.
Для accounts/sessions также квалифицировать прекращение хранения после отпадения
цели, а не только действие login disable. Ни legacy/demo, ни отозванный payload
не возвращаются. Утверждённые legal/payment доказательства не удаляются generic purge.

### 2.4 Чистая рабочая БД после Phase A acceptance PASS

После Phase A PASS создать **другую**, чистую рабочую БД из тех же qualified image digests
и полного журнала. В рабочей Phase A создавать только необходимые OWNER accounts;
EDITOR остаётся проверкой одноразовой БД. Не копировать acceptance dump, accounts, audit, legal history
или synthetic media. Её собственные credentials/keys и независимый prefix
зарегистрировать в authority; повторить schema/role/config/readiness пробы без
synthetic пользователей или публикаций. Первоначально legal_publication,
прикладные admin_user/admin_audit и media_asset пусты; допускается только baseline
миграций/системных записей. Зафиксировать агрегаты без ПД. Первые реальные privacy
и cookies при этих условиях получают version 1; иначе остановиться и расследовать.

Для **этой** БД проверить автоматический backup timer с её DB ID/prefix/key
references и получить первый encrypted off-host dump независимым GET. Восстановить
его в ещё один изолированный контур и повторить schema/roles/counts/secret-authority
проверки; synthetic crypto/negative fixtures туда не добавлять. Криптографические
data-dependent пробы выполнены на acceptance, а проверка working-generation keys
из независимой authority обязательна отдельно. Так synthetic restore не выдаётся
за backup другой БД. После реального входа/публикаций продолжить автоматические
копии и повторять data-dependent restore в изоляции по согласованному регламенту.

В инфраструктурном PR **до исполнения** зафиксировать конкретные cadence,
maximum backup age/failure alert, local/off-host retention в числах, versioning/
replication/lifecycle и способ удаления просроченных копий с проверкой read-back.
Ни пустые TBD, ни скрытое бесконечное хранение не допускаются. Сроки здесь не
назначаются от имени OWNER. Установить предел сохранения удалённого payload в
старых encrypted backups, lawful holds отдельно и обязательную сверку 2.3-A и применимую 2.3-B при
любом restore. Не обещать немедленное стирание каждого backup после live deletion.
Перед execution GO эти параметры и cleanup точных temporary resources должны быть
конкретны и проверены; общей фразы «backup настроен» недостаточно.

После этих PASS и условий §0 разрешать только ограниченный Phase A
Admin/legal entry; реальный сторонний content entry остаётся Phase B NO-GO. Full PITR/whole-host drift/external-device qualification
не добавляются как gates этого этапа; пред-продажные gates остаются отдельно.

## 3. Приёмка фактического SSR/Admin

В одноразовом acceptance-контуре 2.1 синтетическими данными проверить
OWNER/EDITOR, TOTP/session expiry/revocation,
защиту private API, запрет логирования credentials/тел/изображений и реальные
параметры proxy/container log rotation. Отдельно квалифицировать поддерживаемое
существующее ограничение доступа и media withdrawal (2.3-A), а также
первоначальную проверку TOUR-93 применительно к Phase A. Общая процедура
прекращения хранения payload — отдельная TOUR-94 / Phase B, ещё не PASS.
Не выдавать FK/append-only запрет DELETE за выполненное уничтожение.

Проверить Control Room upload → worker → Cloud.ru → published catalog → SSR
без rebuild: приватный original, три WebP, права/метаданные, CORS/cache/hash,
немедленное снятие eligibility при revoke и подтверждённое удаление. Использовать
только вновь согласованные synthetic keys и отдельный живой service principal;
удалённый qualification key TOUR-63 не восстанавливается.

Проверить outage Commerce/неэффективную публикацию/неверный hash: legal/catalog
fail closed, noindex/no-store, без старого baked fallback. Retired payment
routes не инициируют операций; глобальный CLOSED не меняется. Отказ одного
сервиса и rollback проверяются в приватном контуре. Разрешён только заранее
qualified SSR digest, совместимый с текущими Commerce API, schema и **live legal
authority**, содержащий исправления TOUR-59/renderer; проверить историю/образ и
runtime fail-closed smoke. Произвольный «предыдущий digest» не допустим. Если
такого кандидата нет — maintenance, без старого static/Sveltia и baked legal.

В итоговом акте разделять source/CI, установленный digest/transport, provider,
backup/restore и организационные подтверждения. Не ставить PASS на основании
описания теста или предыдущего image.

## 4. Публикация юридических документов после приёмки

Дополнительно подтвердить применимые RKN/provider условия и полномочия
служебных accounts/утверждённых legal bodies в Phase A; завершение
первоначальной проверки TOUR-93 в этом scope и
создание её датированного преемника до закрытия. Не подменять эти факты OWNER
утверждением текста или полным будущим sales-legal пакетом.

Проверить provenance OWNER-решения по private receipt/reference выше и неизменность двух
полных файлов. ОГРН Cloud.ru `5167746080057` совпадает с официальной офертой
поставщика: [PDF source](https://cdn.cloud.ru/docs/legal/contracts/offer/future-version/offer-service-provision.pdf),
[identity receipt](../evidence/2026-10-30-cloudru-provider-identity.json). Это не
подтверждение применимости оферты/условий поручения к конкретному аккаунту; его
проверка остаётся отдельной. Если реальные реквизиты/потоки требуют изменения
публичного текста — новая редакция и новое OWNER-утверждение, не молчаливая правка.

В чистой рабочей БД действующий OWNER сначала создаёт два документа через
`POST /api/content` (`kind: "legal"`, slug ниже), сохраняет возвращённые IDs и
читает текущее состояние. Не повторять create после сетевой неопределённости
вслепую: сначала найти запись по slug. Затем `PUT /api/content/<id>/draft` с
`expectedRevision` из read-back и `document: {slug,title,content:{body}}`.
Для новой записи ожидается initial revision 0; ответ даёт новую revision.

| slug | Точный title вне body hash | Ожидаемый textSha256 |
| --- | --- | --- |
| `privacy-policy` | `Политика обработки персональных данных` | `sha256:359615e732329e3f85a0807d153ff3a153bbe53a55105ae9e7610c308a5cc0e4` |
| `cookies` | `Использование cookies` | `sha256:71d4e6fbbca71d707d904fe2f370d2245a4e4faa16ecdd998f7cd0d980e2252c` |

`content.body` — **полный** UTF-8 файл, включая H1 и завершающий LF; никаких
trim/пересборки Markdown. Title/slug проверяются отдельно: title влияет на
metadata/navigation, но не входит в SHA тела. JSON serialization допустима,
если после decoding тело остаётся побайтно тем же; проверить draft read-back.

Только затем OWNER вызывает `POST /api/content/<id>/publish-legal` с точными
`expectedDraftRevision`, `expectedPublishedVersion`, `effectiveOn`, `approval`.
Versions брать из текущего read-back, для первого publish publishedVersion=0;
не подставлять устаревший токен или утверждать version 1 без проверки. Approval
до 2000 символов ссылается на `2026-10-30.ssr-admin.review.3`, OWNER-решение и
private receipt/reference; исходные chat/message IDs в публичные metadata не переносить. Не использовать general publish как замену legal operation.
После неопределённого ответа сначала прочитать history, а не создавать новую
публикацию повторно. Существующую immutable историю не удалять/переписывать.

`effectiveOn` — московская календарная дата **фактической** публикации.
Вычислить непосредственно перед операцией в `Europe/Moscow`; при переходе даты
перепроверить. Дата runbook/GO не подставляется; прошлую дату БД отвергает.

После каждой операции прочитать immutable history, version/effectiveOn,
`textSha256` и `documentSha256`, public legalPages и SSR HTML:

- **textSha256 обязан точно совпасть с sha256: + SHA полного Markdown-файла**
  из таблицы. Проверить исходное тело history/public feed отдельно от HTML.
- **documentSha256 — hash всего Commerce JSON-документа**, не hash Markdown;
  сверять по штатному Commerce JSONB hash-контракту, не с file SHA. Canonical
  document metadata входит в эту отдельную проверку.
- Проверить точные slug/title, mobile tables, единственный H1 и отсутствие
  private approval note в публичном ответе.

В акте перечислить статусы **всех семи** legal routes. В закрытом SSR/Admin после
этой публикации только privacy-policy/cookies квалифицированы по review.3.
`oferta`, `turoperator`, `soglasie-pd`, `pravila-oplaty`, `otkaz-i-vozvrat` остаются
NOT PUBLISHED: ожидается «Документ временно недоступен», noindex/no-store, без
ссылки в футере и без старого fallback. Если фактический статус отличается,
записать его и выяснить источник; не считать пять документов автоматически
принятыми и не требовать их будущий sales-пакет для закрытого контура.

Частичный успех пары документов записывать отдельно; каждая редакция остаётся
NOT PUBLISHED до собственного успешного read-back. Итог: две review.3 редакции
PUBLISHED только после выполнения выше; sales legal package NOT ACCEPTED,
**sales CLOSED, domain NO-GO**. Публикация не закрывает автоматически все TOUR.
