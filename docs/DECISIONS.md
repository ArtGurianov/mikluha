# Архитектурные решения Mikluha

## Актуальная архитектура — 2026-11-01

Эта сводка заменяет противоречащие ей legacy-разделы ниже.

- Публичное целевое приложение — Next.js SSR: Commerce public projection при запросе,
  HTML/API `no-store`. Sveltia, YAML как источник публикации и static-export runtime
  выведены из эксплуатации clean-slate решением; возврата на них нет.
- Phase A working работает приватно с минимальным OWNER-only доступом. Public ingress,
  продажи и Phase B остаются закрытыми. Acceptance и working — разные БД и поколения ключей.
- Изображения: TOUR-63 Stage 1 — приватный S3 original → изолированный decoder/worker →
  публичные content-addressed WebP 480/960/1600 → direct HTTPS Cloud.ru S3.
  Source/acceptance media pipeline проверен; working Phase A не включает media worker и
  не допускает реальный сторонний контент. Это не CDN-переключение.
- **TurboFlare отменён.** VPS-17 — общий отдельный NGINX/njs cache за Traefik
  (`assets.refref.ru`), подключаемый потребителями явно. Ни одного автоматического
  перехвата сайтов/API нет. Старый cache manifest не является допуском новых S3-вариантов.
  Изображения и build JS/CSS/fonts подключаются разными процедурами; `assetPrefix`
  не меняет URL фотографий. См. [контракт подключения и тестов](plans/2026-11-01-cdn-vps17-consumer-design.md).
- Control Room не получает root-доступ, SSH или infrastructure publisher credentials.
  Для будущих фото нужен ограниченный автоматический серверный admission/withdrawal
  контракт. Ручной Git/root publish каждого фото не является принятой архитектурой;
  текущий VPS-17 controller такого consumer-контракта не реализует.
- JS/CSS/fonts пока остаются на origin сайта: cache на том же VPS не сокращает
  географический путь и добавляет proxy-hop. Включение требует самостоятельного
  измеримого обоснования, а не общего решения «CDN для всех assets».
- CDN Stage 2 требует exact allowlist/SHA/MIME/size, withdrawal до выдачи старого HIT,
  реального consumer E2E и отдельного read-back. Direct S3 остаётся независимым режимом;
  автоматический browser fallback при недоступном cache не заявлен.
  Review.3 описывает прямые HTTPS Cloud.ru; переключение на assets.refref.ru
  требует новой точной редакции privacy, нового SHA/OWNER approval и отдельного
  допуска публикации. Нынешние утверждённые тексты не изменяются.
  Эти условия не блокируют минимальный OWNER-only Phase A.
- Новые локальные календарные даты — **Asia/Krasnoyarsk** (OWNER 2026-11-01), включая
  legal effectiveOn и будущие S5. Исторические snapshot/UTC instants не переписываются.
  [Решение и фактический rollout](decisions/2026-11-01-local-calendar-and-cdn.md).
- Единственный автоматический DB backup Phase A — encrypted hourly VPS → Cloud.ru,
  provider versioning и lifecycle current 7d/noncurrent 7d; постоянного VPS/Mac DB cache,
  Mac scheduler и backup-pins в Git нет. Mac + внешний диск содержат encrypted custody
  ключей/конфигурации, а Mac используется для ручного изолированного restore.
  [Текущий runbook](runbooks/phase-a-operations.md), [clean-slate решение](decisions/2026-10-30-clean-slate-owner-decision.md).

## История

Прежние SSG/Sveltia/Git-YAML/publish.yml и PITR/retention решения перенесены
в [отдельный исторический архив](DECISIONS-LEGACY.md). Они не являются
инструкциями для текущего SSR/Admin.
