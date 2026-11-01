# Mikluha → VPS-17: контракт подключения и тестирования

Статус: подготовка consumer; **не подключено**, не production-ускорение.
Владелец общей инфраструктуры — VPS-17; consumer и его CD — TOUR-97 в Mikluha.
TOUR-63 Stage 1 direct S3 остаётся принятой независимой цепочкой.

## Фотографии

Допускаются только опубликованные content-addressed WebP-варианты из нового
S3 pipeline. Original, private prefixes, произвольные URL/query, cookies,
Authorization, API, HTML, платежи и видео в shared cache не попадают.

Связка каждого варианта: media identity/profile + точный origin URL + размер +
SHA-256 + MIME + exact cache URL из принятого манифеста VPS-17. Одного общего
`cacheBaseUrl` недостаточно: старый bootstrap manifest не знает новые ключи.
Маппинг — часть приватного deployment descriptor, без credentials в Git.
SSR resolver выбирает direct/cache только для текущей PUBLISHED-проекции;
неизвестная/отозванная media identity даёт нейтральный placeholder.

Withdrawal: убрать фото из public projection, зафиксировать запрет старых
cache URL/digest и дождаться завершения старых workers, подтвердить 410 для
GET/HEAD/conditional, затем завершать удаление S3 worker'ом. Ошибка любого
этапа не разрешает повторную публикацию. Актуальный withdrawal ledger
применяется перед допуском восстановленного cache. Уже скачанные браузером
байты отозвать невозможно; TTL не заменяет серверный deny.

Direct — отдельный runtime resolver mode для новых SSR-запросов. Переключение
флага не переписывает уже загруженный HTML. Автоматический fallback на direct
для 403/410 запрещён; существующий браузерный fallback не заявляется.

## Автоматическая публикация и границы полномочий

Control Room не получает root, SSH и cache publisher credentials. Публикация
фото из редактора не должна требовать Git-коммита или ручного root deploy.
Нужен отдельный серверный contract: ограниченный identity только своего
namespace, точная current-publication версия, идемпотентные admission/withdrawal,
защита от повтора/устаревшей публикации и проверка результата. Текущий controller
VPS-17 — операторский инструмент; нужного app API/identity пока нет.
До реализации и квалификации этого контракта Stage 2 **BLOCKED**, direct S3
остаётся рабочим режимом. Новый универсальный root endpoint не допускается.

## JS/CSS/fonts

**Не включать в текущую интеграцию Mikluha.** Origin сайта и cache находятся
на одном VPS: географического сокращения пути нет, добавляется proxy-hop.
Общее утверждение «ничего не может ускорить» слишком сильное (например,
разгрузка другого origin — отдельный сценарий), но таких доказательств здесь
нет. Эти build-assets остаются на site origin. Если появится отдельное
измеримое основание, необходим следующий самостоятельный контракт.

Next.js `assetPrefix` задаётся **до build** и покрывает `_next/static`, но не
URL изображений из S3 и не `public/`. Нужны полный build inventory (lazy chunks
включительно), immutable versioned origin, publish/warm/verify/check перед
активацией HTML. Текущий moving `/_next/static/` не заменяет immutable origin.
Rollback — отдельно квалифицированный direct image, а не мгновенный runtime flag.

## Правовой допуск

Утверждённый review.3 privacy-policy описывает доставку по прямым HTTPS Cloud.ru.
Его approval не покрывает выдачу фотографий через assets.refref.ru. До переключения
нужны новая точная редакция, SHA-256, OWNER approval и отдельная публикация через
Commerce. Текущие privacy/cookies bytes/SHA не изменяются, CDN-legal GO не заявлен.

## Старый namespace

VPS-17 пока содержит retired `mikluha-maklai.ru/_next/static/` и
`mikluha-maklai.s3.cloud.ru/cms/`. Это cleanup gap, а не origin для новых фото.
Отключение включает **все старые ключи и digest aliases**, включая warm HIT и
conditional responses, с сохранением durable deny при restart/restore. Другие
namespace и shared route сохраняются. Удаление S3/контейнеров/производных архивов
не требуется. До подтверждённого выполнения нельзя считать namespace отключённым.

## Приёмка

1. Read-only smoke существующего VPS-17: обычный HTTPS/TLS, exact SHA/size/MIME,
   повторный HIT, cookie/auth/query/unlisted refusals; фиксировать источник.
   Такой PASS не подтверждает новый consumer, withdrawal или региональный выигрыш.
2. Подготовить ограниченный synthetic enrollment: уникальные собственные ключи,
   reviewed manifest delta, точные создаваемые/удаляемые ресурсы, rollback и
   отдельный OWNER GO на S3/host mutations. Существующие реальные фото не использовать.
3. Проверить actual SSR consumer и 480/960/1600, холодные параллельные запросы,
   соседний namespace во время публикации, отказ origin/cache, прямой режим.
4. Withdrawal → старые HIT/HEAD/conditional 410, S3 удалён; restart/isolated restore
   не возвращают выдачу. Только после этого допустимо обсуждать реальные фото,
   оставаясь в границах TOUR-94/Phase B и legal/provider admission.
5. Direct/cache paired timings без VPN, с отдельными MISS/HIT и p50/p95; LCP
   настоящей страницы. VPN и SSH-tunnel результаты не выдавать за региональные.

Включение CDN для всех сайтов, новые origins/credentials и root publisher не
следуют из health=200. Flexperiment 410 не обходить. До прохождения этих шагов
оставить direct S3 и отсутствие assetPrefix. Новая постоянная CDN-зависимость
должна войти в TOUR-68 и фактическую privacy qualification.

CUSTODY_IMPACT: NO — подготовка и read-only smoke, без enrollment/deploy.
