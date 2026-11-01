# Новые локальные даты и CDN — OWNER 2026-11-01

OWNER подтвердил: новые локальные календарные даты, включая legal `effectiveOn`
и будущие Refref S5, используют **Asia/Krasnoyarsk**. Это новая календарная
политика; host-wide TZ не меняет правила приложения сам по себе.

Машинные UTC timestamps, явно UTC systemd timers, elapsed-hour интервалы,
ранее принятые timezone/даты/дедлайны и контрольные суммы остаются исходными.
В частности, новый default не переинтерпретирует старый Moscow-policy snapshot.
Новые Refref policy/profile refs и граничные тесты должны быть квалифицированы
отдельно (REFREF-126); старый идентификатор политики нельзя выдать за новую семантику.

## Source и фактическая установка

- TOUR-96: migration 0020 добавляет общий DB local-date helper, обновляет
  legal publish guard и public_legal; до миграции подтверждена пустая legal-история, поэтому
  дополнительная колонка зоны не нужна. При любой существующей legal-публикации
  migration отказывает с LEGAL_CALENDAR_HISTORY_REQUIRES_REVIEW. Helper STABLE
  учитывает зависимость именованной зоны от tzdata. SSR projection и Admin date input следуют
  той же зоне. Миграции 0001–0019 и опубликованная история не изменяются.
- Каталог: отдельный PR #69 / TOUR-78 исправляет defaults/validation. Эта работа
  не дублирует его изменения и не объявляет его merged.
- На read-back 2026-11-01 VPS сообщает **Etc/UTC**. Это намеренное и целевое состояние хоста (VPS-25), а не незавершённый rollout.
  После отдельного OWNER GO установлены новые Commerce/SSR/Admin images и schema20;
  приложение использует Asia/Krasnoyarsk. [Фактическое свидетельство](../evidence/2026-11-01-working-schema20-legal-publication.json)
  отдельно от source approval подтверждает runtime и cloud restore.
- Перед выполненной legal publication квалифицированы согласованные новые Commerce/SSR/Admin images,
  forward migration 0020, новые privileges_sha256 и schema_journal_sha256 в descriptor,
  backup/restore новой схемы 20 с проверкой реальных TOTP/audit и ключей из внешней копии.
  Произвольный старый image не является совместимым rollback; safe state — maintenance.

Тела двух утверждённых документов и SHA-256 сохраняются. Новый календарь не
устанавливает дату публикации, не публикует документы и не открывает продажи.

## Сверка документов по проектам

| Проект | Новое правило и оставшаяся история |
| --- | --- |
| Mikluha | Legal runbooks/README, будущие S5 и актуальная сводка DECISIONS используют Красноярск. Датированные review receipts сохраняют прежнюю проверенную Москву с явной historical-оговоркой. |
| Refref | Активные главы, индексы и L2 runbook ссылаются на новое правило. Старый v9 `Europe-Moscow/1`, SQL, принятые legal-редакции и рабочие календари остаются versioned history; новая реализация — REFREF-126. Generated specs пересобираются из глав. |
| Flexperiment | Найденные Markdown-упоминания относятся к почтовым адресам/географии и архивному SEO-разбору расписания Петербурга. Они не задают новый VPS-wide calendar default и не заменяются Красноярском. |
| Shared VPS | Хост намеренно остаётся в Etc/UTC; бизнес-календари явно используют Asia/Krasnoyarsk в приложениях/SQL. VPS-25 закрывает сверку, без host rollout. UTC publication/retirement/cache ages и backup timers сохраняются. |

## CDN

Shared cache VPS-17 установлен отдельно от Mikluha. На read-back 2026-11-01
его runtime source — `6ac95ed6942b3f05add7153d558570e4a7ae977a`.
Текущий bootstrap manifest содержит прежние origins/объекты; это не enrollment
нового direct-S3 pipeline. Working Phase A не подключён к нему.
Runtime health при этом healthy, но Mikluha warmup degraded/failed из-за старых
недоступных site-assets. Успешный smoke двух доступных старых фото и шрифта
не заменяет полный inventory/new-consumer admission и не доказывает ускорение.

Direct S3 остаётся текущим режимом TOUR-63. TurboFlare исключён. Следующий этап —
[явное подключение и приёмка consumer](../plans/2026-11-01-cdn-vps17-consumer-design.md),
с отдельными контрактами для фотографий и Next.js build assets.

CUSTODY_IMPACT: NO — source/документация и read-only проверки; host, DB,
provider policies/objects, env и действующая маршрутизация не менялись.


Исполнение 01.11.2026: CUSTODY_IMPACT:YES — только working project refs, schema20,
backup module/descriptor/status и encrypted custody (VPS-15). Host timezone, shared
proxy и provider permissions не менялись; source-only NO выше относится к подготовке.
