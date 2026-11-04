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
| (строка ревизии) | `purchase_revision_line` | (`purchaseRef`, ревизия, `seatSlotRef`) | вместе с ревизией | append-only, входит в `revision_hash` через `lines_sha256` |
| `participantRef` | `seat_participant` | uuid | TOUR-100 при отправке анкеты | `ended_*` один раз (замена/выбытие) |
| `companionRef` | `companion_assignment` | `ca-` + 20 hex | покупатель внутри покупки / сотрудник между покупками | `confirmed_at`, `revoked_*` один раз |
| `invitationRef` | `seat_invitation` | `iv-` + 20 hex; токен — `sha256` | покупатель / сервер для сопровождающего | `claimed_at`, `revoked_*` один раз |
| `documentProofRef` | A2b (TOUR-101) | — | — | — |
| `exportRef` (страховка) | A2b (TOUR-103, только после TOUR-104) | — | — | — |
| `bankOperationRef` | A2b (TOUR-77) | — | — | — |

Ни одна таблица 0021 не содержит ПД туристов. ПД анкет — отдельная таблица A2b по запросу TOUR-100
после правовой карты TOUR-35/84.

## 3. Состояния места (`seat_slot.state`)

```
HELD ──(bank proof достаточен по месту)──────────────► CONFIRMED ──(TOUR-79)──► CANCELLED
 │  └─(bank proof, места нет)──► PAID_NO_SEAT_EXCEPTION ──(место назначено)──► CONFIRMED
 │                                    └──(возврат TOUR-27 исполнен)──────────► REFUND_SETTLED
 └─(hold истёк без fence / доказанный отказ банка)──► RELEASED
RELEASED ──(поздний bank proof)──► CONFIRMED (если есть место) | PAID_NO_SEAT_EXCEPTION
```

| Переход | Команда | Кто (DB login) | Условия, проверяемые БД |
|---|---|---|---|
| создание `HELD` | `fn_open_slotted_purchase` | `commerce_app` | свежий документ-заказ, `PRICED_SLOTS`, сумма строк = `amount`, правила несовершеннолетних (раздел 5) |
| fence hold | `fn_seat_slots_fence(purchaseRef)` | `commerce_app` (TOUR-77) | только `HELD`, до `hold_expires_at` (2A: попытка зафиксирована до 5 минут); после fence место не освобождается таймером |
| `HELD`/`RELEASED` → `CONFIRMED`/`PAID_NO_SEAT_EXCEPTION` | `fn_seat_slot_transition` | `commerce_app` (TOUR-77) | обязательный `bankOperationRef`; из `RELEASED` в `CONFIRMED` — только при свободном месте под lock выезда |
| → `RELEASED` | `fn_seat_slots_release_lapsed(now)` (maintain) или `fn_seat_slot_transition` с доказанным отказом | `commerce_app` | не fenced и hold истёк; либо явный отказ с `bankOperationRef` |
| `PAID_NO_SEAT_EXCEPTION` → `CONFIRMED` | `fn_seat_slot_assign_no_seat` | `admin_app` | право `paid_no_seat.resolve`, причина, свободное место под lock, нет учтённого дефицита |
| → `REFUND_SETTLED`, `CONFIRMED` → `CANCELLED` | `fn_seat_slot_transition` | `commerce_app`/`admin_app` (TOUR-27/79) | обязательная причина; для `CANCELLED` — ревизия TOUR-79 (A2b), пока разрешено только с `actor`+`reason` |

Каждый переход пишет `seat_slot_event` (append-only: прежнее/новое состояние, actor, reason,
`bankOperationRef`, время БД). Запрещённые переходы — `SEAT_SLOT_TRANSITION_INVALID`.

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
| Привязанная покупка по ссылке менеджера (C/TOUR-90) | тот же вход + `groupLink {token, idempotencyKey}`; `fn_group_link_replay` до создания заказа | `GROUP_LINK_INVALID` (нет/отозвана/израсходована другим ключом), `GROUP_LINK_DEPARTURE_MISMATCH`, `MINORS_WITHOUT_ADULT` (нет `CONFIRMED` 18+ в группе); повтор тем же ключом возвращает ту же покупку |
| Выдать/отозвать ссылку группы (E/TOUR-90 CR) | `fn_group_link_issue`, `fn_group_link_revoke` | `STAFF_FORBIDDEN`, `PURCHASE_GROUP_UNKNOWN`, `GROUP_LINK_ALREADY_FINAL` |
| Fence/подтверждение/исключение (B/TOUR-77/78) | `fn_seat_slots_fence`, `fn_seat_slot_transition` | `SEAT_SLOT_TRANSITION_INVALID`, `BANK_OPERATION_REQUIRED`, `NO_SEAT_AVAILABLE` |
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
| Проверка гостевого доступа на каждый запрос (C/D) | `fn_seat_invitation_active(tokenSha256)` | нет строки — нет доступа |
| Право сотрудника на каждый запрос (все CR-команды) | `fn_staff_permitted(adminId, permission)` | `false` → `STAFF_FORBIDDEN` |

Автоматика выбытия (v1.9 §3 п.5, G-GROUP-03): если место сопровождающего уходит из `CONFIRMED`
или его `participant` завершён, БД в той же транзакции отзывает назначения и приглашения
`MINOR_VIA_COMPANION`; `fn_seat_invitation_active` по ним сразу ничего не возвращает. Покупка ребёнка
не отменяется; задачу менеджеру (TOUR-102) строит проекция готовности.

## 6. Правила несовершеннолетних на checkout (v1.8.2 §2.1, v1.9 §3)

1. `minors > 0` требует `departure.minors_allowed` и отсутствия паузы детских продаж.
2. `departure.minor_min_age ≥ 14` исключает `AGE_0_13`.
3. Без привязки к группе: `minors > 0` требует `adults ≥ 1` в той же покупке.
4. С привязкой: допустима покупка только детских мест, если в группе есть место 18+ в `CONFIRMED`
   на том же текущем выезде (не `PAID_NO_SEAT_EXCEPTION`, не `CANCELLED`, не `HELD`).
5. Цена: `18+` и `14–17` — взрослая цена ревизии; `0–13` — `child_price_kopecks`, если задана, иначе
   взрослая. Цена фиксируется в `pricing_basis` при создании hold и далее не пересчитывается (G-09a,
   G-AGE-04: дата цены — `price_departure_on`, исходная локальная дата начала).

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
| `departure.quota.exception` | ✔ | | | | v1.9 §9 — **PROPOSED**: «уполномоченный сотрудник» = OWNER |
| `departure.minor_settings` (minorsAllowed, мин. возраст, детская цена) | ✔ | | | | v1.8.2 §1 (администратор редактирует выезды) |
| `minor_sales.pause` | ✔ | ✔ | | | **PROPOSED**: защитное действие доступно дежурному менеджеру |
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
| `paid_no_seat.resolve` (назначить место исключению) | ✔ | ✔ | | | **PROPOSED** (v1.9 §5 п.4 — ручное урегулирование) |
| `group_link.issue` / `group_link.revoke` | ✔ | ✔ | | | v1.9 §2 п.1 («менеджер») |
| `companion.assign` (между покупками) | ✔ | ✔ | | | v1.9 §3 п.3 («уполномоченный сотрудник CR») |
| `invitations.support_reissue` (после отправки анкеты) | ✔ | ✔ | | | v1.8.2 §3 п.6 |
| `insurance.export` | ✔ | ✔ | | | v1.8.2 §1 («все менеджеры CR») |
| `documents.read`, `documents.verify` | | | | `MODERATOR_CABINET` | OWNER 03.11 (TOUR-101): все сотрудники кабинета модератора; оба права уходят вместе с доступом |
| `legal_hold.manage` | | | | `LEGAL_HOLD` | v1.8.2 §1, §4: отдельное право, основание, аудит |

`documents.verify` не даёт `legal_hold.manage`, `participants.pd.correct` и финансовых прав;
`OWNER` не получает `MODERATOR_CABINET`/`LEGAL_HOLD` автоматически — только явной выдачей.
Строки **PROPOSED** не являются решением OWNER: до подтверждения OWNER они действуют только в
синтетических тестах; изменение — одна правка SQL-матрицы и TS-карты в новой миграции.

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

## 11. Свидетельства A2 (исходники, синтетика; не deploy)

Локально, PostgreSQL 16, ветка `claude/track-a-tour-76-schema-roles`:

- `commerce`: `tsc --noEmit` PASS; `pnpm test` **437/437** (включая новый `test/seat-slots.test.ts` 16/16);
  `test:sabotage` **28/28** (ART-327); `check-migration-history` PASS; Control Room `tsc` и тест PASS.
- Согласованные «снимки» привилегий: `admin_app` получает только staff-команды с проверкой
  `fn_staff_permitted` (список в `admin-privileges.test.ts`); `fn_departure_taken_seats` по-прежнему
  не исполняется `admin_app` — счётчик для CR считается в `departure_seat_projection` и сверяется с
  функцией тестом. `TRUNCATE` истории покупок по-прежнему отклоняется (триггер или FK).
- **NOT_RUN:** образная квалификация `qualify-schema-image.ts` (Docker; обновлён probe: bundled=21,
  forward=22, native-вход с ценой места) — выполняется CI; новые sabotage-мутанты для 0021 —
  предложено TOUR-51; обновление `native-privilege-matrix.json` — после merge PR #74.
- Миграция 0021 не применена ни к одной рабочей БД; продажи CLOSED; `CUSTODY_IMPACT: NO`.
