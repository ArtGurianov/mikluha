# Трек A · TOUR-76/78/79 — контракт DB/API, матрица ролей и проекция мест/групп

**Статус:** Stage 1 (A1) — предложенный контракт для приёмки ревьюерами и OWNER; Stage 2 (A2) — первая
forward-миграция `0021_priced_seat_slots_groups_and_staff_roles.sql` по этому контракту.
**Основание:** [v1.8.2-RC](../decisions/2026-11-03-owner-decisions-tour-89-90-v1.8.2-rc.md) +
[v1.9.0-RC](../decisions/2026-11-04-owner-decisions-v1.9.0-rc.md) (при расхождении — v1.9.0), Plane
TOUR-76 (In Progress), TOUR-78/79 (Backlog), эпик TOUR-98 «треки A–G», исходники `main @ 169a404`.
**Не разрешает:** merge, deploy, установку миграции в любую БД, банковские операции, реальные ПД,
открытие продаж, смену статусов/связей в Plane. `CUSTODY_IMPACT: NO` — исходники, не развёрнуто.

## 0. Границы трека

| Вопрос | Решение |
|---|---|
| Владелец DDL | Только трек A. Треки B–E запрашивают DDL у A (раздел 9 — очередь A2b) и не пишут миграции сами. |
| Номер миграции | Первый свободный после HEAD: `0021`. Миграции `0001–0020` не меняются (hash-lock, `check-migration-history`). |
| Что делает A | Схема, инварианты в БД, единая проекция занятости/групп, матрица ролей, точка входа native-checkout без ПД туристов, снятие лимита 6. |
| Что делают другие | B — платёжные операции/депозит/баланс (TOUR-77/78/27/9); C — checkout UI, ссылки/приглашения (TOUR-28/90/99); D — анкеты/документы (TOUR-100/101); E — поправки/переносы/квота/TOUR-89 (TOUR-79/92/65/64). Они вызывают команды этого контракта. |
| TOUR-78 | Формально заблокирована TOUR-77 (Backlog). A даёт фундамент: поштучные цены в копейках, `total ≠ unit × seats`, `PAID_NO_SEAT_EXCEPTION`, счётчики «оплаченные места / онлайн-квота». Денежный реестр (allocation) — A2b после появления `bank_operation` TOUR-77. |
| TOUR-79 | Фундамент: стабильный `seatSlotRef`, строки цены на ревизию, занятость по департаменту **текущей** ревизии (перенос = новая ревизия), состояния места с `CANCELLED`. Команды поправок — A2b по запросу трека E (раздел 9). |

## 1. Ключевая модель

Покупается **N оценённых мест** (`seatSlotRef`) трёх типов `AGE_0_13`, `AGE_14_17`, `AGE_18_PLUS`.
Покупатель вводит только собственные данные и подтверждение возрастных условий. Туристы появляются
позже, по приглашениям, как `participantRef` конкретного места. Число мест покупки ограничено только
квотой выезда и техническим пределом запроса **500** (anti-abuse/нагрузка, не продуктовый лимит).

Документ-заказ (`orders`) остаётся носителем принятых байтов (оферта, согласие, `contract_snapshot`) и
контакта покупателя, как в 0017. Новый признак `orders.seat_model`:

| `seat_model` | Кто | Смысл |
|---|---|---|
| `UNIFORM` | все заказы до 0021 и исторический путь 0017 | `amount = unit × seats`, турист №1 = покупатель, паспорта в заказе, только взрослые. Данные и хэши не переписываются. |
| `PRICED_SLOTS` | новые native-покупки | `unit_price_kopecks` = взрослая цена опубликованной ревизии (её проверяет `contract_snapshot`), `amount` = сумма строк мест; `order_passenger` запрещён; `adults_only_confirmed=false`, `age_terms_confirmed=true`. |

## 2. Сущности и ссылки (DB ↔ API)

| Ссылка API | Таблица (0021, если не указано) | Формат | Создаёт | Изменяемость |
|---|---|---|---|---|
| `purchaseRef` | `purchase` (0017) | `mp-` + 20 hex | `fn_open_slotted_purchase` | профиль `NATIVE_NO_REFERRAL`/`MIKLUHA_NATIVE` неизменяем |
| `purchaseGroupRef` | `purchase_group`, `purchase_group_member` | `mg-` + 20 hex | первая покупка группы (`ORIGIN`) | неизменяема; членство только добавляется |
| `groupLinkRef` | `purchase_group_link` | `gl-` + 20 hex; токен хранится только как `sha256` | менеджер (`group_link.issue`) | одноразовая: `consumed_*` или `revoked_*` один раз |
| `pricingBasisRef` | `pricing_basis` | `pb-` + 20 hex | при создании мест | полностью неизменяема |
| `seatSlotRef` | `seat_slot` + журнал `seat_slot_event` | `ss-` + 20 hex | при создании покупки | меняются только `state`, защита hold — через функции |
| `holdRef`, `attemptRef` | `seat_hold` | `sh-` + 20 hex; попытка — идентификатор TOUR-77 | цикл 1 — при создании покупки, следующие — `fn_purchase_rehold` | `fenced_at`/`attempt_ref` один раз, закрытие (`PAID`/`PAYMENT_FAILED`/`LAPSED`) один раз |
| (строка ревизии) | `purchase_revision_line` | (`purchaseRef`, ревизия, `seatSlotRef`) | вместе с ревизией | append-only, входит в `revision_hash` через `lines_sha256` |
| `participantRef` | `seat_participant` | uuid | TOUR-100 при отправке анкеты | `ended_*` один раз (замена/выбытие) |
| `companionRef` | `companion_assignment` | `ca-` + 20 hex | покупатель внутри покупки / сотрудник между покупками | `confirmed_at`, `revoked_*` один раз |
| `invitationRef` | `seat_invitation` | `iv-` + 20 hex; токен — `sha256` | покупатель / сервер для сопровождающего | `claimed_at`, `revoked_*` один раз |
| `documentProofRef` | A2b (TOUR-101) | — | — | — |
| `exportRef` (страховка) | A2b (TOUR-103, только после TOUR-104) | — | — | — |
| `bankOperationRef` | A2b (TOUR-77) | — | — | — |

Ни одна таблица 0021 не содержит ПД туристов. ПД анкет — отдельная таблица A2b по запросу TOUR-100
после правовой карты TOUR-35/84.

## 3. Места и платёжные циклы (`seat_slot`, `seat_hold`)

Идентичность места (`seat_slot`) отделена от платёжного цикла (`seat_hold`) и от попытки оплаты
(`attempt_ref`, будущий `bankOperationRef` TOUR-77). У покупки в каждый момент не больше одного
открытого цикла; новый цикл возможен только после закрытия предыдущего без оплаты.

```
seat_hold:  OPEN ──(попытка записана до истечения 5 мин)──► FENCED ──► PAID | PAYMENT_FAILED
              └──(истёк без попытки, maintain)──────────────────────────► LAPSED
            после PAYMENT_FAILED или LAPSED → новый цикл той же покупки (fn_purchase_rehold)

seat_slot:  HELD ──(цикл закрыт PAID)──────────────────► CONFIRMED ──(только ревизия TOUR-79)──► CANCELLED
              └──(цикл закрыт PAYMENT_FAILED/LAPSED)──► RELEASED ──(новый открытый цикл)──► HELD
            RELEASED ──(поздний успех той же попытки)──► CONFIRMED, если есть место | PAID_NO_SEAT_EXCEPTION
            PAID_NO_SEAT_EXCEPTION ──(OWNER назначил место)──► CONFIRMED | ──(возврат TOUR-27)──► REFUND_SETTLED
```

| Команда | Кто (DB login) | Что проверяет БД |
|---|---|---|
| `fn_open_slotted_purchase` | `commerce_app` | свежий документ-заказ `PRICED_SLOTS`; сумма строк = `amount`; правила несовершеннолетних (раздел 6); цикл 1 со сроком hold |
| `fn_purchase_hold_fence(purchaseRef, attemptRef)` | `commerce_app` (TOUR-77) | открытый цикл не истёк по часам БД (2A); одна попытка на цикл; повтор той же попытки идемпотентен |
| `fn_purchase_payment_confirmed(purchaseRef, attemptRef)` | `commerce_app` (TOUR-77) | попытка записана на цикле этой покупки. Открытый цикл → `PAID`, места `CONFIRMED` (они были защищены). Цикл уже `PAYMENT_FAILED` (поздний успех) → под lock выезда каждое место `CONFIRMED` при наличии места, иначе `PAID_NO_SEAT_EXCEPTION`; решает БД, а не вызывающий. Есть более новый цикл → `NEWER_CYCLE_EXISTS` (двойное списание, ручная сверка). Повтор ничего не меняет |
| `fn_purchase_payment_failed(purchaseRef, attemptRef)` | `commerce_app` (TOUR-77) | только исход записанной попытки открытого цикла; места `RELEASED` |
| `fn_seat_holds_close_lapsed(now)` (maintain) | `commerce_app` | только нефенсированные циклы, истёкшие к `now`; fenced (UNKNOWN) не истекает |
| `fn_purchase_rehold(purchaseRef, expiresAt)` через `retryNativePurchasePayment` | `commerce_app` | прошлый цикл закрыт без оплаты; все места `RELEASED`; документ-заказ не закрыт; hold ≤ 5 минут; квота, пауза, допуск несовершеннолетних, взрослый группы для детской покупки; TS — продажи открыты, T−24, выезд продаётся |
| `fn_seat_slot_assign_no_seat` | `admin_app` | право `paid_no_seat.resolve` (сейчас только OWNER), причина, свободное место под lock выезда |
| `fn_seat_slot_refund_settled(slotRef, refundRef)` | `commerce_app` (TOUR-27) | только `PAID_NO_SEAT_EXCEPTION` |
| `CONFIRMED → CANCELLED` | — | функции нет ни у одного сервисного логина: только будущая ревизия поправки TOUR-79 (A2b-3) |

Триггер `seat_slot` проверяет те же правила для DML любого логина: `HELD → CONFIRMED` только при цикле
`PAID`; `HELD → RELEASED` только после закрытия цикла без оплаты; `RELEASED → HELD` только при новом
открытом цикле. Каждый переход пишет `seat_slot_event` с циклом и попыткой.

**Граница с TOUR-77.** БД связывает каждый денежный исход с попыткой, записанной на цикле, и сама
решает между `CONFIRMED` и `PAID_NO_SEAT_EXCEPTION`. Подлинность ответа банка (провайдер, сумма,
валюта, read-back) проверяет `bank_operation` TOUR-77 (A2b-1). До его интеграции эти функции —
исходники и синтетика, не квалифицированы для реальных денег.

**PROPOSED-параметр:** окно повторной оплаты — 24 часа после закрытия последнего цикла. После него
`maintain()` закрывает документ-заказ (`EXPIRED`), и далее действует удаление данных неоплаченного
заказа. Нужно подтверждение OWNER/TOUR-77.

## 4. Проекция занятости и счётчики (одна для TOUR-28/64/65/78/102)

`fn_departure_taken_seats(slug, now)` (заменяется в 0021, сигнатура прежняя) =
`UNIFORM`-заказы как в 0017 **+** места `PRICED_SLOTS`, у которых департамент **текущей ревизии**
покупки равен выезду и `state = CONFIRMED` или (`state = HELD` и (`payment_fenced` или
`hold_expires_at > now`)). Документ-заказ `PRICED_SLOTS` сам места не считает — двойного учёта нет.

Представление `departure_seat_projection` (без ПД), по выезду:

| Поле | Определение |
|---|---|
| `online_quota` | `departure.capacity` (онлайн-квота, TOUR-65) |
| `confirmed_seats` | `CONFIRMED` |
| `protected_holds` | `HELD` и (fenced или не истёк) |
| `paid_no_seat` | `PAID_NO_SEAT_EXCEPTION` — показывается всегда (3A) |
| `paid_seat_claims` | `CONFIRMED + PAID_NO_SEAT_EXCEPTION` — требования мест, не транзакции: депозит и доплата одного места считаются один раз |
| `over_quota` | `paid_seat_claims > online_quota` — красный 31/30; знаменатель — онлайн-квота (OWNER 04.11) |
| `online_minors_slots` | места `AGE_0_13`+`AGE_14_17` в текущих ревизиях (`CONFIRMED`/защищённые `HELD`), каждое ровно раз. Места 18+ с DOB < 18 добавит TOUR-100 (флаг анкеты, A2b) |

Инвариант штатного режима: `confirmed_seats + protected_holds ≤ online_quota`. Исключение со
«учтённым дефицитом» (v1.9 §9) — A2b для TOUR-65.

`purchase_group_projection` — по группе: выезд, покупки группы, места по типам/состояниям,
`has_active_adult` (есть `CONFIRMED` 18+). Страница покупателя видит только свою покупку.

## 5. Команды и отказы (API ↔ DB)

| API (владелец) | DB-команда | Отказы |
|---|---|---|
| Native checkout — первичная покупка (C/TOUR-28) | `reserveNativePurchase` (читает `departure.child_price_kopecks` под lock выезда) → `fn_open_slotted_purchase` | `TERMS_NOT_CURRENT`, `PD_CONSENT_*`, `AGE_TERMS_NOT_CONFIRMED`, `SEATS_INVALID` (0 или > 500, неизвестный тип), `CONTACT_*`, `NOT_ENOUGH_SEATS`, `BOOKING_CUTOFF_REACHED`, `MINORS_NOT_ALLOWED`, `MINOR_SALES_PAUSED`, `TICKET_TYPE_NOT_ALLOWED` (минимальный возраст ≥ 14 исключает `0–13`), `MINORS_WITHOUT_ADULT`, `SALES_CLOSED` |
| Привязанная покупка по ссылке менеджера (C/TOUR-90) | тот же вход + `groupLink {token, idempotencyKey}`; `fn_group_link_replay` до создания заказа | `GROUP_LINK_INVALID` (нет/отозвана/израсходована другим ключом), `GROUP_LINK_DEPARTURE_MISMATCH`, `GROUP_LINK_TICKETS_MISMATCH` (не тот состав, что выбрал менеджер), `MINORS_WITHOUT_ADULT` (нет `CONFIRMED` 18+ в группе); повтор тем же ключом и тем же запросом возвращает ту же покупку, в том числе после закрытия продаж; тот же ключ с другим запросом — `IDEMPOTENCY_CONFLICT` |
| Выдать/отозвать ссылку группы (E/TOUR-90 CR) | `fn_group_link_issue(admin, group, tokenSha256, adults, teens, children)` — ссылка хранит выбранный менеджером состав, `fn_group_link_revoke` | `STAFF_FORBIDDEN`, `PURCHASE_GROUP_UNKNOWN`, `SEATS_INVALID`, `GROUP_LINK_ALREADY_FINAL` |
| Попытка, исходы оплаты, повторный цикл (B/TOUR-77/78) | раздел 3 | `HOLD_EXPIRED`, `HOLD_ALREADY_FENCED`, `ATTEMPT_UNKNOWN`, `NEWER_CYCLE_EXISTS`, `REHOLD_NOT_ALLOWED`, `PURCHASE_CLOSED`, `NOT_ENOUGH_SEATS` |
| Назначить место исключению (E/TOUR-65) | `fn_seat_slot_assign_no_seat` | `STAFF_FORBIDDEN`, `NO_SEAT_AVAILABLE` |
| Персонализация (D/TOUR-100) | `fn_seat_participant_open`, `fn_seat_participant_end` | `SEAT_SLOT_NOT_CONFIRMED`, `PARTICIPANT_ALREADY_ACTIVE` |
| Привязка ребёнка к 18+ своей покупки (C/TOUR-99) | `fn_companion_assign_in_purchase` | `COMPANION_INVALID` (не 18+, не та покупка, не `CONFIRMED`), `MINOR_SLOT_INVALID` |
| Назначить сопровождающего из другой покупки (E/TOUR-100 CR) | `fn_companion_assign_staff` | `STAFF_FORBIDDEN`, `COMPANION_INVALID` (не участник 18+ той же группы и того же текущего выезда), `MINOR_SLOT_INVALID` |
| Сопровождающий подтверждает назначение (D) | `fn_companion_confirm` | `COMPANION_NOT_ACTIVE` |
| Снять назначение | `fn_companion_revoke` (покупатель — только свои `BUYER`), `fn_companion_revoke_staff` (`companion.assign`) | `COMPANION_NOT_ACTIVE` |
| Настройки несовершеннолетних / пауза (E/TOUR-65) | `fn_admin_departure_minor_settings`, `fn_admin_minor_sales_pause` (CAS `minor_settings_version`, причина, журнал `departure_minor_event`) | `STAFF_FORBIDDEN`, `DEPARTURE_MINOR_CONFLICT` |
| Выдать приглашение (C/TOUR-99) | `fn_seat_invitation_issue` | `SEAT_SLOT_NOT_CONFIRMED`, `INVITATION_PURPOSE_INVALID`, `INVITATION_ACTIVE` |
| Отозвать/перевыпустить (C/D) | `fn_seat_invitation_revoke` | `INVITATION_NOT_ACTIVE` |
| Атомарный claim (C/TOUR-99) | `fn_seat_invitation_claim(tokenSha256)` | `INVITATION_NOT_ACTIVE` (повторный claim) |
| Гостевой доступ (C/D) | `fn_seat_invitation_claimable(tokenSha256)` — bearer-токен находит только ещё не принятое приглашение; после claim сессия OTP (TOUR-99) проверяет `fn_seat_invitation_live(invitationRef)` на каждый запрос | нет строки / `false` — нет доступа |
| Право сотрудника на каждый запрос (все CR-команды) | `fn_staff_permitted(adminId, permission)` | `false` → `STAFF_FORBIDDEN` |

Автоматика выбытия (v1.9 §3 п.5, G-GROUP-03): если место сопровождающего уходит из `CONFIRMED`
или его `participant` завершён, БД в той же транзакции отзывает назначения и приглашения
`MINOR_VIA_COMPANION`; `fn_seat_invitation_live` по ним сразу возвращает `false`. Покупка ребёнка
не отменяется; задачу менеджеру (TOUR-102) строит проекция готовности.

## 6. Правила несовершеннолетних на checkout (v1.8.2 §2.1, v1.9 §3)

1. `minors > 0` требует `departure.minors_allowed` и отсутствия паузы детских продаж.
2. `departure.minor_min_age ≥ 14` исключает `AGE_0_13`.
3. Без привязки к группе: `minors > 0` требует `adults ≥ 1` в той же покупке.
4. С привязкой: допустима покупка только детских мест, если в группе есть место 18+ в `CONFIRMED`
   на том же текущем выезде (не `PAID_NO_SEAT_EXCEPTION`, не `CANCELLED`, не `HELD`).
5. Цена: `18+` и `14–17` — взрослая цена ревизии; `0–13` — `child_price_kopecks`, если задана, иначе
   взрослая. Цена фиксируется в `pricing_basis` при создании hold и далее не пересчитывается (G-09a,
   G-AGE-04: дата цены — `price_departure_on`, исходная локальная дата начала). `pricing_basis`
   хранит `minor_settings_version` — версию аудируемого события `departure_minor_event`, чью детскую
   цену он заморозил; БД проверяет её при создании.

## 7. Матрица ролей Control Room

Роли аккаунта: `OWNER` (уполномоченный администратор), `MANAGER` (оператор/менеджер, **новая**),
`EDITOR` (контент). Возможности, выдаваемые отдельно (`admin_capability_grant`, через SSH-оператора
`admin_operator`, с причиной; отзыв одной записью прекращает все её права): `MODERATOR_CABINET`,
`LEGAL_HOLD`. Отключённый аккаунт не имеет прав. Проверка — `fn_staff_permitted` в каждой
CR-команде БД; TS-карта `PERMISSIONS` равна SQL-матрице (тест сверяет все пары).

| Право | OWNER | MANAGER | EDITOR | Возможность | Основание |
|---|:-:|:-:|:-:|---|---|
| `editorial.read` | ✔ | ✔ | ✔ | | 0011; MANAGER — чтение выездов |
| `editorial.draft` | ✔ | | ✔ | | 0011 |
| `editorial.publish`, `legal.publish`, `audit.read` | ✔ | | | | 0011 |
| `departure.controls` (квота штатно, статус) | ✔ | | | | 0019, v1.8.2 §1 |
| `departure.quota.exception` | ✔ | | | | v1.9 §9 — **PROPOSED**: только OWNER |
| `departure.minor_settings` (minorsAllowed, мин. возраст, детская цена) | ✔ | | | | v1.8.2 §1 (администратор редактирует выезды) |
| `minor_sales.pause` | ✔ | | | | **PROPOSED**: только OWNER; расширение до MANAGER — решение OWNER |
| `minor_sales.resume` | ✔ | | | | **PROPOSED** |
| `departure.change.classify` (TOUR-89: поля, уведомления, несущественность) | ✔ | | | | v1.8.2 §1, §7 |
| `transfer.discount` | ✔ | | | | v1.8.2 §1, §7 п.9 |
| `purchases.read` (покупки, статусы, деньги, без ПД) | ✔ | ✔ | | | v1.8.2 §1 |
| `readiness.view` (T−24, рабочий список) | ✔ | ✔ | | | v1.8.2 §5 |
| `participants.pd.read` (только поля, нужные для исправления/ЕИС) | ✔ | ✔ | | | v1.8.2 §1; объём полей — TOUR-35/80 до live |
| `participants.pd.correct` (с основанием и аудитом) | ✔ | ✔ | | | v1.8.2 §1, §2.3 |
| `amendment.record` (TOUR-79: исправление категории, частичная/полная отмена) | ✔ | ✔ | | | v1.8.2 §2.3 |
| `settlement.request` (заявка на расчёт/возврат) | ✔ | ✔ | | | v1.8.2 §2.3 |
| `refund.execute` (TOUR-27) | ✔ | | | | **PROPOSED** |
| `paid_no_seat.resolve` (назначить место исключению) | ✔ | | | | **PROPOSED**: только OWNER; расширение до MANAGER — решение OWNER (v1.9 §5 п.4) |
| `group_link.issue` / `group_link.revoke` | ✔ | ✔ | | | v1.9 §2 п.1 («менеджер») |
| `companion.assign` (между покупками) | ✔ | ✔ | | | v1.9 §3 п.3 («уполномоченный сотрудник CR») |
| `invitations.support_reissue` (после отправки анкеты) | ✔ | ✔ | | | v1.8.2 §3 п.6 |
| `insurance.export` | ✔ | ✔ | | | v1.8.2 §1 («все менеджеры CR») |
| `documents.read`, `documents.verify` | | | | `MODERATOR_CABINET` | OWNER 03.11 (TOUR-101): все сотрудники кабинета модератора; оба права уходят вместе с доступом |
| `legal_hold.manage` | | | | `LEGAL_HOLD` | v1.8.2 §1, §4: отдельное право, основание, аудит |

`documents.verify` не даёт `legal_hold.manage`, `participants.pd.correct` и финансовых прав;
`OWNER` не получает `MODERATOR_CABINET`/`LEGAL_HOLD` автоматически — только явной выдачей.
Строки **PROPOSED** не являются решением OWNER, поэтому до его решения действуют в самом узком
варианте — только OWNER (уполномоченный администратор); MANAGER их не получает. Расширение — одна
правка SQL-матрицы и TS-карты в новой миграции. `fn_staff_require` берёт строку аккаунта `FOR SHARE`:
отзыв возможности или отключение аккаунта (они берут её `FOR UPDATE`) либо фиксируются до проверки
права и тогда видны ей, либо ждут завершения команды.

Сверка фактических привилегий DB-логинов — TOUR-51 и PR #74 (матрица `native-privilege-matrix.json`
должна быть обновлена этим или следующим PR после merge #74).

## 8. Снятие лимита 6 (G-13)

| Место | Было | Стало (0021 / код) |
|---|---|---|
| `commerce/src/orders.ts:26,186` | `MAX_SEATS_PER_ORDER = 6` | удалено; `MAX_SEATS_PER_REQUEST = 500` — технический предел размера запроса |
| `orders_seats_check` (0001) | `1..6` | `1..500` |
| `order_passenger_position_check` (0001) | `1..6` | `1..500` |
| `purchase_revision_seats_check` (0017) | `1..6` | `1..500` |
| `purchase_revision_participant_*position_check` (0017) | `1..6` | `1..500` |

Исторические файлы 0001/0017 не меняются: ограничения заменяются `ALTER TABLE … DROP/ADD CONSTRAINT`
в 0021. Квота, конкурентная проверка вместимости и throttling публичного checkout сохраняются.

## 9. Очередь DDL A2b (по запросам треков; не в 0021)

| ID | Для | Содержание |
|---|---|---|
| A2b-1 | B / TOUR-77 | `bank_operation` (идентичность операции, fence, UNKNOWN, read-back), FK из `seat_slot_event.bank_operation_ref` |
| A2b-2 | B / TOUR-78 | реестр распределений поступлений/возвратов по строкам места; депозит ≤ цена места; график по `pricingBasisRef`; без двойного учёта при replay |
| A2b-3 | E / TOUR-79 | ревизии поправок: базисы `TICKET_TYPE_CORRECTION`, `PARTIAL_CANCELLATION`, `FULL_TERMINATION`, `PARTICIPANT_REPLACEMENT`, `DEPARTURE_TRANSFER`; документ поправки и согласие по хэшу; CAS по текущей ревизии; детерминированный порядок блокировок выездов |
| A2b-4 | E / TOUR-65 | исключительное снижение квоты: причина, аудит, CAS, «учтённый дефицит», блок новых продаж |
| A2b-5 | D / TOUR-100 | ПД анкеты (после TOUR-35/84), флаг «18+ оказался несовершеннолетним» для счётчика |
| A2b-6 | D / TOUR-101 | `document_proof` (версии, `verification_result`, `DELETED_BY_RETENTION`/`MISSING`, legalHold) |
| A2b-7 | F / TOUR-103 | журнал выгрузок страховщику — только после TOUR-104 |
| A2b-8 | C / TOUR-28/35 | `contract_snapshot` v2 с полной ценовой сеткой (взрослая/детская) |
| A2b-9 | A | удаление путей `UNIFORM` (`reserve()`, `fn_open_native_purchase`) из кода после переключения B/C; физическое удаление customer-таблиц — только `CUSTODY_IMPACT: YES` и точечный GO OWNER |

## 10. Приёмка A2 (синтетика)

- 0021 применяется поверх 0020; байты и checksum 0001–0020 неизменны; `revision_hash` прежних
  `UNIFORM`-ревизий пересчитывается в тот же результат.
- G-01/G-13: покупка 5×18+, 1×0–13, 1×14–17 = 7 мест с правильными ценами одной покупкой; 12 мест
  проходят; 501 отклоняется; квота ограничивает.
- Нет ПД туристов в `PRICED_SLOTS`: вставка `order_passenger` отклоняется.
- Несовершеннолетние: отказ без взрослого; отказ при `minors_allowed=false`, паузе, мин. возрасте;
  child-only по ссылке группы — отказ без `CONFIRMED` 18+, допуск при наличии (G-GROUP-02 частично).
- Ссылка группы: чужой выезд, отозванная, израсходованная — отказ; повтор тем же ключом — та же
  покупка (G-GROUP-01 частично).
- Занятость: истёкший нефенсированный hold не считается; fenced — считается; `PAID_NO_SEAT_EXCEPTION`
  не считается, но входит в `paid_seat_claims` (31/30).
- Сопровождающий: самоназначение невозможно (только сотрудник с правом); выбытие места
  сопровождающего отзывает назначения и приглашения (G-GROUP-03 на уровне БД).
- Роли: TS = SQL-матрица; `documents.verify` только при `MODERATOR_CABINET`; отзыв возможности и
  отключение аккаунта сразу снимают права.
- Неизменяемость: `pricing_basis`, строки ревизий, журналы — UPDATE/DELETE/TRUNCATE отклоняются.
- Ревью PR #86: истёкший hold не подтверждается; новый платёжный цикл той же покупки; состав ссылки;
  исход оплаты только для записанной попытки, UNKNOWN не освобождается; отмены нет у сервисов;
  конфликт ключа идемпотентности; replay после закрытия продаж; одноразовый bearer-токен; сериализация
  отзыва права и staff-команды (раздел 12).

## 11. Свидетельства A2 (исходники, синтетика; не deploy)

Локально, PostgreSQL 16, ветка `claude/track-a-tour-76-schema-roles`, после исправлений по ревью PR #86:

- `commerce`: `tsc --noEmit` PASS; `pnpm test` **442/442** (включая `test/seat-slots.test.ts` 21/21, три
  прогона подряд стабильно); `test:sabotage` **28/28** (ART-327); `check-migration-history` PASS;
  Control Room `tsc` PASS.
- Согласованные «снимки» привилегий: `admin_app` получает только staff-команды с проверкой
  `fn_staff_permitted` (список в `admin-privileges.test.ts`); `fn_departure_taken_seats` по-прежнему
  не исполняется `admin_app` — счётчик для CR считается в `departure_seat_projection` и сверяется с
  функцией тестом. `TRUNCATE` истории покупок по-прежнему отклоняется (триггер или FK).
- **NOT_RUN:** образная квалификация `qualify-schema-image.ts` (Docker; probe обновлён: bundled=21,
  forward=22, native-вход с ценой места) — выполняет CI; новые sabotage-мутанты для 0021 — TOUR-51;
  обновление `native-privilege-matrix.json` — после merge PR #74 (его снимок снят на схеме 0019).
- Миграция 0021 не применена ни к одной рабочей БД; продажи CLOSED; `CUSTODY_IMPACT: NO`.

## 12. Разбор ревью PR #86 (GPT, на `411218c`)

`411218c` не был слит и не применялся ни к одной БД. Поэтому исправленная 0021 заменяет его в ветке
(CI проверяет append-only на каждом промежуточном коммите, а правка 0021 новым коммитом поверх
`411218c` эту проверку бы нарушила). Ревью-SHA `411218c` остаётся в истории PR.

| Замечание | Вердикт | Что сделано | Тест (`seat-slots.test.ts`) |
|---|---|---|---|
| P1-1 истёкший `HELD` → `CONFIRMED` без вместимости | верно | Подтверждение только через цикл `PAID`, а цикл можно оплатить лишь после попытки, записанной до истечения hold по часам БД. Триггер запрещает `HELD → CONFIRMED` без такого цикла для DML любого логина | «an expired, unfenced hold is never confirmed…» |
| P1-2 нет нового платёжного цикла | верно | `seat_hold` отделён от места; `fn_purchase_rehold` / `retryNativePurchasePayment` — новый цикл той же покупки по общим правилам; история циклов сохраняется | «after a proven failure the same purchase starts a new payment cycle» |
| P1-3 ссылка не фиксирует состав | верно | `purchase_group_link.adults/teens/children`; точное совпадение при погашении (`GROUP_LINK_TICKETS_MISMATCH`) | «the link fixes the manager's tickets…» |
| P1-4 произвольный `bankOperationRef` | верно частично | Исправлено то, что БД может обеспечить: исход принимается только для попытки, записанной на цикле; fenced (UNKNOWN) нельзя освободить без её исхода; `PAID_NO_SEAT_EXCEPTION` выбирает БД по вместимости, а не вызывающий. Подлинность ответа банка — `bank_operation` TOUR-77 (A2b-1); до интеграции функции помечены как неквалифицированные | «outcomes bind to the recorded attempt…» |
| P1-5 отмена без поправки | верно | Функции отмены нет ни у одного сервисного логина (проверено перебором исполняемых SECURITY DEFINER) | «a confirmed seat cannot be cancelled…» |
| PROPOSED-права уже действуют | верно | До решения OWNER все PROPOSED-строки — только OWNER | матрица ролей |
| P2 fingerprint повтора | верно | `consumed_request_sha256` (выезд, состав, хэши условий; без ПД); тот же ключ с другим запросом → `IDEMPOTENCY_CONFLICT` | «…a repeated key replays only the same request…» |
| P2 `SALES_CLOSED` до replay | верно | Replay читает результат до проверки продаж и не создаёт мест | там же |
| P2 детская цена из изменяемой колонки | верно частично | Ложно, что оплачиваемая цена изменяема: цена каждого места замораживается при hold в `pricing_basis` и строках, которые входят в `revision_hash`; изменения детской цены — CAS и журнал, а basis теперь хранит `minor_settings_version`, и БД его проверяет. Верно, что в принятых байтах договора (`contract_snapshot`) детской цены нет: это A2b-8, условие до продаж, а не дефект схемы A2 | «the pause and resume are the owner's…» |
| P2 токен действует после claim | верно | Bearer-токен одноразовый (`fn_seat_invitation_claimable`); далее — `fn_seat_invitation_live(invitationRef)` для OTP-сессии TOUR-99 | «invitations open only on confirmed seats…» |
| P2 заголовок/описание PR | верно | Обновлены | — |
| Отзыв права во время операции | добавлено | `fn_staff_require` блокирует строку аккаунта `FOR SHARE`, так что отзыв и команда сериализуются | «a staff command and a revocation are serialized…» |
| PR #74 / матрица привилегий | порядок работ | Снимок #74 снят на схеме 0019; пересобрать после merge одного из PR | — |
| `fn_purchase_revision_slot_model` только `INITIAL` | принято, не дефект | Поправки TOUR-79 — отдельная миграция A2b-3 | — |

Тесты нашли и одну собственную ошибку переработки: при отсутствии цикла условие триггера места
давало `NULL` и пропускало переход. Исправлено (`IS NOT TRUE`).
