По текущему описанию это лучше строить не как «сайт с двумя захардкоженными турами», а как небольшой **CMS-driven каталог направлений + поездок + отчётов**. Публичная часть при этом должна оставаться полностью статической: Sanity используется только как источник контента на этапе сборки, а готовый сайт не зависит от CMS во время пользовательских запросов. Тогда сейчас в интерфейсе будут только Алтай и Красноярские Столбы, но добавление третьего направления не потребует разработки.

Ключевое архитектурное решение — разделить **направление** и **конкретный выезд**. Например, «Горный Алтай» — это `Tour`, а «12–16 сентября 2026» — `Departure`. На карточке направления автоматически показывается ближайший будущий выезд и его статус. Для MVP статус набора меняется вручную в Sanity, а дата ближайшего выезда рассчитывается во время SSG-сборки.

Второй важный момент — QR-предоплата сама по себе не является системой бронирования: сайт не узнает, оплатил человек или нет. Поэтому в MVP я бы явно определил: **сайт инициирует бронирование, но окончательно место подтверждает организатор**. Полноценный платежный/booking backend сейчас не нужен.

**Изменения, добавленные в Revision 5:** упрощена структура исходного кода и deployment-модель: monorepo/workspaces/Turborepo и shared packages исключены из MVP. Проект ведётся как один Next.js application repository с одним `package.json` и lockfile. Sanity schemas/config и build-time CMS integration находятся внутри того же репозитория в каталоге `/sanity`, а скрипты materialization/validation — в `/scripts`. На Coolify разворачивается одно приложение `miklukha-web`. Sanity Studio остаётся внешним SaaS-интерфейсом/статически размещаемой админкой и не является отдельным приложением проекта на VPS. Все требования Revision 4 по отсутствию сбора пользовательских данных, pure SSG, local asset materialization, clean build, fail-safe release и scheduled rebuild сохраняются.

# Техническое задание

## Сайт туристического агентства «Миклуха Маклай»

**Версия:** MVP 1.0 / Revision 5
**Тип продукта:** публичный туристический сайт / каталог поездок
**Бренд:** Миклуха Маклай
**Логотип:** `logo.webp` (предоставлен заказчиком, используется как основной бренд-актив в Header, Footer, favicon и OG-изображении по умолчанию)
**Frontend:** Next.js App Router, TypeScript, pure SSG/static export (`output: 'export'`)
**UI-кит:** shadcn/ui (поверх Tailwind CSS)
**Локализация:** только русский язык, английской версии нет
**CMS:** Sanity Cloud (Content Lake + Sanity Studio)
**Hosting:** self-hosted через Coolify на российском VPS
**Production runtime:** только Nginx/static container; Node.js backend и база данных на VPS отсутствуют
**CMS dependency:** только build-time; runtime-зависимость публичного сайта от Sanity запрещена
**Repository:** single application repository; один `package.json`, один lockfile, без monorepo/workspaces/Turborepo

**Данные на старте:** контент (тексты, фото, контакты, реквизиты, QR) заполняется тестовыми/mock-значениями на этапе разработки. После сдачи проекта организатор самостоятельно заменяет их на реальные через Sanity Studio без участия разработчика.

---

# 0. Нормативные уровни требований

В документе используются следующие уровни обязательности:

* **MUST / ОБЯЗАТЕЛЬНО** — входит в MVP и критерии приёмки. Невыполнение блокирует production release или приёмку соответствующей функции.
* **SHOULD / РЕКОМЕНДУЕТСЯ** — должно быть реализовано, если нет документированной технической/продуктовой причины отказаться.
* **MAY / ОПЦИОНАЛЬНО** — допустимое расширение или дизайнерское решение; отсутствие не блокирует MVP.

Слова «желательно», «можно», «допускается» без явной маркировки не должны использоваться для требований, которые влияют на приёмку.

---

# 1. Цель продукта

Создать быстрый визуальный сайт организатора небольших групповых туристических поездок.

Основные задачи сайта:

1. Показать доступные направления.
2. Показать дату ближайшей поездки.
3. Сразу дать понять, открыт или закрыт набор.
4. Познакомить пользователя с атмосферой предыдущих поездок через фотоотчёты.
5. Повысить доверие через информацию об организаторе и отзывы.
6. Дать пользователю минимальный способ внести предоплату и самостоятельно связаться с организатором после оплаты.
7. Позволить организатору самостоятельно обновлять туры, даты, отчёты, отзывы, QR-коды, суммы предоплаты и контактный телефон через Sanity без изменения кода.

## 1.1 Принцип отсутствия сбора пользовательских данных

**MUST:** публичный сайт не собирает и не принимает данные пользователя.

В MVP отсутствуют:

* формы;
* поля ввода имени, телефона, email или иных данных пользователя;
* регистрация и пользовательские аккаунты;
* отправка заявок на backend;
* cookies;
* analytics/tracking SDK;
* UTM/session tracking;
* `localStorage`/`sessionStorage` для идентификации или аналитики;
* browser fingerprinting;
* банковские webhooks;
* сохранение информации о факте оплаты;
* собственная CRM/booking database.

Публичный сайт только отображает заранее опубликованный контент и предоставляет пользователю:

```text
QR для предоплаты
+ сумма предоплаты
+ телефон организатора
```

После оплаты пользователь самостоятельно сообщает о ней организатору по указанному телефону. Сайт не получает сведения о том, кто оплатил, какую сумму фактически перевёл пользователь и состоялось ли подтверждение бронирования.

Основное целевое действие:

**«Забронировать место»**

---

# 2. MVP

В первой версии поддерживаются два направления:

### Горный Алтай

Отображается:

* название;
* обложка;
* краткое описание;
* дата ближайшего тура;
* статус набора:

  * «Набор открыт»;
  * «Набор закрыт»;
* CTA «Забронировать место».

### Красноярские Столбы

Отображается:

* название;
* обложка;
* краткое описание;
* дата ближайшего тура;
* статус набора:

  * «Набор открыт»;
  * «Набор закрыт»;
* CTA «Забронировать место».

Архитектура сайта не должна быть ограничена двумя направлениями.

Добавление нового направления производится через Sanity Studio.

---

# 3. Основная информационная архитектура

Предлагаемая структура:

```text
/
├── Header (лого + название «Миклуха Маклай»)
├── Hero
├── Ближайшие поездки
│   ├── Горный Алтай
│   └── Красноярские Столбы
├── Отчёты о поездках
├── Организатор
├── Отзывы
├── CTA / Забронировать место
└── Footer

/tours/[slug]
└── Страница направления

/reports/[slug]
└── Фотоотчёт конкретной поездки

/privacy-policy
└── Политика конфиденциальности

/booking-terms
└── Условия бронирования
```

Допускается MVP, в котором основная информация находится только на главной странице, однако модели CMS должны сразу поддерживать отдельные страницы направлений и отчётов.

---

# 3.1 Header / Навигация

Постоянный элемент на всех страницах.

Состав:

* логотип (`logo.webp`), кликабельный, ведёт на главную;
* название бренда «Миклуха Маклай» рядом с логотипом или в его составе;
* якорные ссылки на секции главной страницы (Туры, Отчёты, Отзывы, Контакты) — можно скрывать на `/tours/[slug]` и `/reports/[slug]`;
* CTA «Забронировать место» — как компактная кнопка в Header, желательно sticky при скролле вниз.

На mobile:

* логотип + бренд остаются видимыми;
* навигационные ссылки допустимо убрать или свернуть в простое меню — насыщенного multi-level меню в MVP не требуется;
* Header не должен перекрывать контент и не должен провоцировать layout shift при подгрузке шрифта/лого.

Логотип и название берутся из singleton-документа `siteSettings` в Sanity (см. раздел 29), не хардкодятся в коде.

---

# 4. Главная страница

## 4.1 Hero

Первый экран должен быстро объяснять:

* что это за проект;
* куда организуются поездки;
* что сейчас можно забронировать.

Состав:

* название бренда «Миклуха Маклай» (через логотип в Header и/или в заголовке Hero);
* главный заголовок;
* короткий подзаголовок;
* атмосферное фото или видео;
* CTA «Смотреть ближайшие туры» или «Забронировать место».

CTA прокручивает пользователя до блока актуальных поездок либо открывает booking modal, если это соответствует итоговому дизайну.

---

# 5. Блок «Ближайшие поездки»

Отображается список активных направлений.

Каждая карточка содержит:

* изображение;
* название;
* короткое описание;
* дату ближайшего выезда;
* статус;
* кнопку «Подробнее»;
* кнопку «Забронировать место».

Пример:

```text
Горный Алтай

Следующий тур
12–16 сентября 2026

● Набор открыт

[ Подробнее ]
[ Забронировать место ]
```

---

# 6. Статусы набора

`Departure.bookingStatus` MUST поддерживать три состояния:

```text
OPEN
CLOSED
CANCELLED
```

**OPEN**

> Набор открыт

CTA бронирования активна.

**CLOSED**

> Набор закрыт

Выезд остаётся существующим и может отображаться как ближайший фактический выезд, но основной CTA бронирования не должен вести к оплате этого Departure. Если существует следующий `OPEN` Departure, интерфейс SHOULD предложить его.

**CANCELLED**

> Поездка отменена

Отменённый Departure MUST:

* исключаться из `nextDeparture` и `nextBookableDeparture`;
* не показывать CTA оплаты/бронирования;
* сохраняться в CMS и связях с историческими данными;
* MAY отображаться на ранее опубликованной странице/в истории с явной пометкой «Поездка отменена», если это необходимо продукту.

`isListed` не используется как замена `CANCELLED`: это разные состояния. `isListed` управляет публичной видимостью, `bookingStatus` — бизнес-состоянием конкретного выезда.

---

# 7. Направление и конкретный тур

Необходимо разделить две сущности.

## Tour

Постоянное направление.

Примеры:

* Горный Алтай;
* Красноярские Столбы.

## Departure

Конкретная поездка с датами.

Например:

```text
Tour:
Горный Алтай

Departure:
12 сентября 2026 — 16 сентября 2026
Набор открыт
```

Один `Tour` может иметь неограниченное количество `Departure`.

Это позволит хранить историю:

```text
Горный Алтай
├── 15–19 июня
├── 10–14 июля
├── 20–24 августа
└── 12–16 сентября
```

На публичном сайте автоматически определяется ближайший актуальный выезд.

---

# 8. Страница направления

URL:

```text
/tours/[slug]
```

Например:

```text
/tours/altai
/tours/krasnoyarsk-stolby
```

Страница может содержать:

* название;
* hero-фото;
* описание;
* ближайший тур;
* даты;
* статус набора;
* продолжительность;
* короткую программу;
* фотографии;
* связанные отчёты;
* отзывы;
* CTA бронирования.

Не все поля обязательны для MVP, но структура CMS должна позволять постепенно расширять страницу.

---

# 9. Отчёты о поездках

Отдельная секция главной страницы.

Отчёт — это публикация о прошедшей поездке.

Основные данные:

* дата;
* направление;
* название;
* обложка;
* галерея;
* необязательное описание.

Пример:

```text
Август 2026

Горный Алтай

[ image ] [ image ] [ image ] [ image ] →
```

---

# 10. Галерея отчётов

На desktop и mobile фотографии выводятся горизонтальной лентой.

Основное взаимодействие:

```text
← горизонтальный scroll →
```

Требования:

* drag мышью;
* touch swipe на мобильных устройствах;
* обычный horizontal scroll;
* scroll snap;
* изображения не должны растягиваться;
* lazy loading;
* оптимизация через Next/Image, если выбранная схема сборки это позволяет.

На desktop допускаются стрелки навигации.

---

# 11. Предпросмотр изображений

При клике на фотографию открывается полноэкранный lightbox.

Lightbox должен поддерживать:

* увеличенное изображение;
* предыдущую фотографию;
* следующую фотографию;
* swipe;
* клавиши ← / →;
* Escape для закрытия;
* кнопку закрытия;
* отображение номера фотографии:

```text
3 / 18
```

На мобильных устройствах должна работать touch-навигация.

Фон страницы при открытом lightbox не скроллится.

---

# 12. Страница отчёта

URL:

```text
/reports/[slug]
```

Например:

```text
/reports/altai-august-2026
```

Страница содержит:

* направление;
* дату;
* название поездки;
* короткое описание, если имеется;
* фотогалерею;
* CTA на следующую поездку этого направления.

Например:

```text
Понравилось?

Следующая поездка на Алтай —
12 сентября 2026

[ Забронировать место ]
```

---

# 13. Организатор

Отдельный блок доверия.

Содержит:

* фотографию организатора;
* имя;
* короткую биографию;
* описание опыта;
* философию поездок;
* контактные данные или ссылку на контакт.

Контент полностью редактируется через Sanity Studio.

CMS должна позволять добавить более одного организатора в будущем.

`Organizer` — это публичная карточка на сайте (имя, фото, контакты), а не учётная запись для входа в CMS. Доступ к Sanity Studio и проекту регулируется аккаунтами/правами Sanity и не является частью публичной контентной модели. Если для администратора доступ к Sanity требует VPN, это допустимо: публичные пользователи к Sanity напрямую не обращаются.

На старте `Organizer` заполняется mock-данными (например, «Алексей», тестовый телефон/MAX) — это плейсхолдер, который организатор обязан заменить на свои реальные контакты перед публичным запуском (см. раздел 34.1).

---

# 14. Отзывы

Отзывы предоставляются преимущественно в виде скриншотов переписки.

В секции отображаются:

* изображения отзывов;
* горизонтальная карусель либо masonry/grid;
* увеличение изображения по клику.

Изображения отзывов также должны открываться через lightbox.

CMS должна поддерживать:

* изображение;
* имя автора — optional;
* связанный тур — optional;
* sort order;
* enabled/disabled.

---

# 15. CTA «Забронировать место»

CTA должна повторяться минимум:

* в блоке актуального тура;
* на странице тура;
* после фотоотчётов;
* ближе к нижней части главной страницы.

При нажатии открывается modal.

---

# 16. Booking Modal

В первой версии форма бронирования отсутствует.

Booking Modal — **информационный modal без полей ввода и без передачи данных пользователя**.

Заголовок:

```text
Забронировать место
```

Если CTA была открыта с конкретного тура, modal MUST знать выбранный `Departure` и показывать его название/даты.

Например:

```text
Горный Алтай
12–16 сентября
```

Открытие modal не отправляет никаких пользовательских данных на сервер и не создаёт booking record.

---

# 17. Содержимое Booking Modal

Booking Modal MUST быть минималистичным и содержать только данные, необходимые для ручной предоплаты и последующего контакта.

## 17.1 Сумма предоплаты

Показывается фиксированная сумма для выбранного `Departure`:

```text
Предоплата — 5 000 ₽
```

Значение берётся из `Departure.prepaymentAmount` либо из глобального fallback, если такой fallback предусмотрен в `siteSettings`.

## 17.2 QR-код предоплаты

Показывается QR-код, назначенный конкретному `Departure` либо глобальный QR по fallback-правилу.

Пример:

```text
Предоплата — 5 000 ₽

[ QR ]
```

QR является только визуальным способом инициировать перевод. Сайт:

* не получает callback после сканирования;
* не получает банковский webhook;
* не знает, был ли выполнен перевод;
* не сохраняет сведения о плательщике.

`paymentUrl`, deeplink, реквизиты текстом и кнопка «Скопировать реквизиты» **не входят в MVP**.

## 17.3 Сообщить о предоплате

Под QR MUST отображаться короткая инструкция и телефон организатора:

```text
После предоплаты сообщите организатору:
+7 XXX XXX-XX-XX
```

Телефон SHOULD быть кликабельным через `tel:` на поддерживаемых устройствах.

Допускается отдельная кнопка:

```text
[ Позвонить организатору ]
```

которая является обычной ссылкой `tel:` и не отправляет событие на backend.

В Booking Modal отсутствуют:

* формы;
* кнопка «Отправить заявку»;
* Telegram/MAX/мессенджер как обязательная часть booking flow;
* email пользователя;
* номер телефона пользователя;
* комментарий пользователя;
* загрузка чека;
* загрузка файлов;
* client-side tracking действий пользователя.

MAX-канал проекта MAY существовать как отдельная информационная ссылка вне Booking Modal, например в Footer, но он не является частью процесса бронирования.

---

# 18. Логика подтверждения бронирования

В MVP сайт **не является автоматизированной системой бронирования** и не обрабатывает данные клиента.

Бизнес-логика:

```text
Пользователь
    ↓
открывает Booking Modal
    ↓
видит сумму + QR
    ↓
самостоятельно выполняет предоплату
    ↓
самостоятельно связывается с организатором по телефону
    ↓
организатор вручную подтверждает место вне сайта
```

На сайте MUST присутствовать формулировка:

> Место считается забронированным после подтверждения организатором.

Сайт не знает и не хранит:

* личность плательщика;
* номер телефона пользователя;
* факт совершения банковского перевода;
* размер фактически выполненного перевода;
* статус ручного подтверждения организатором.

---

# 19. Контакты организаторов

Для booking flow используется только публичный телефон организатора.

Пример:

```text
После предоплаты сообщите организатору:
+7 XXX XXX-XX-XX
```

В Sanity для каждого организатора MUST существовать:

* имя;
* телефон.

Дополнительные публичные данные (`photo`, `bio`) MAY использоваться в блоке «Организатор», но не обязательны для Booking Modal.

Телефон MUST выводиться из CMS и SHOULD иметь ссылку:

```text
tel:+7XXXXXXXXXX
```

Никаких контактных данных пользователя сайт не запрашивает.

---

# 20. Поведение Booking Modal

Modal MUST:

* открываться без перезагрузки страницы;
* блокировать scroll background;
* закрываться по Escape;
* закрываться по клику на overlay;
* иметь отдельную кнопку Close;
* корректно работать на mobile;
* помещать QR целиком в доступную область экрана;
* при необходимости иметь внутренний vertical scroll;
* не выполнять network requests при открытии/закрытии;
* не устанавливать cookies;
* не писать пользовательские данные/идентификаторы в browser storage;
* не отправлять analytics events.

Контекст выбранного тура/Departure существует только внутри уже загруженного client-side UI и не передаётся на backend.

Например:

```ts
openBookingModal({
  tourId,
  departureId,
})
```

Эти идентификаторы используются исключительно для выбора уже встроенных в static build данных.

---

# 21. Footer

Footer содержит обязательные данные организатора.

Минимально:

```text
Название / ФИО ИП

ИНН: XXXXX
ОГРН / ОГРНИП: XXXXX

Телефон: +7 XXX XXX-XX-XX
```

Также рекомендуется предусмотреть:

* email;
* MAX;
* ссылку на политику конфиденциальности;
* ссылку на условия бронирования;
* copyright.

Все реквизиты хранятся в singleton-документе `siteSettings` в Sanity.

---

# 21.1 Правовые страницы (Pages)

Правовые страницы MUST соответствовать фактическому поведению продукта и не описывать несуществующий сбор данных.

Для MVP достаточно отдельного Sanity document type:

```ts
LegalPage {
  id
  title
  slug
  content     // Portable Text
  updatedAt
}
```

Минимально предусматриваются условия бронирования. Страница `/privacy-policy` MAY быть оставлена, если она требуется владельцу проекта или по результатам отдельной юридической проверки.

Если privacy page существует, её текст MUST явно соответствовать архитектуре MVP:

* сайт не содержит пользовательских форм;
* сайт не создаёт пользовательские аккаунты;
* сайт не использует analytics/tracking SDK в MVP;
* сайт не получает информацию о банковском переводе;
* сайт не получает и не сохраняет номер телефона посетителя;
* сайт не использует cookies для аналитики/маркетинга.

Шаблонный privacy-текст, утверждающий наличие форм, cookies, CRM, аналитики или сбора ФИО/телефонов, использовать нельзя.

URL при наличии соответствующих страниц:

```text
/booking-terms
/privacy-policy   // optional, по отдельному legal decision
```

Контент редактируется через Sanity Studio.

---

# 22. Sanity CMS

Sanity используется как внешний SaaS headless CMS и является **источником контента**, но не частью production runtime публичного сайта.

Компоненты:

```text
Sanity Studio
    ↓
Sanity Content Lake
    ↓
Content API / Asset CDN
    ↓
только во время SSG build
```

На собственном VPS не разворачиваются:

* CMS backend;
* PostgreSQL;
* media storage для CMS;
* runtime API для публичного сайта.

Публичный сайт после успешной сборки должен продолжать работать, даже если Sanity API, Sanity CDN или Sanity Studio полностью недоступны.

Администратор/менеджер может использовать VPN для доступа к Sanity Studio — это допустимое операционное требование и не влияет на пользовательский experience.

## 22.1 Admin UX для организатора

Организатор — нетехнический пользователь, поэтому Sanity Studio должна быть настроена как простой контентный backoffice, а не как универсальный developer-интерфейс.

Требования:

* названия document types, групп, полей, descriptions и validation messages — на русском языке;
* структура Studio группируется по понятным разделам: «Туры», «Выезды», «Отчёты», «Отзывы», «Организаторы», «Настройки сайта», «Правовые страницы»;
* технические поля (`slug`, `sortOrder`, внутренние reference) по возможности автогенерируются или размещаются отдельно от основных редакторских полей;
* `slug` генерируется автоматически при создании и после первой публикации не должен случайно меняться обычным редактором;
* список `Departure` должен позволять быстро увидеть направление, даты и статус набора;
* draft/published состояние Sanity используется как редакционный статус документа;
* опубликованность документа не должна смешиваться со статусом выезда `OPEN/CLOSED/CANCELLED`;
* полная русификация системного chrome Sanity Studio не является блокером MVP, если все проектные поля и рабочие сценарии организатора понятны на русском;
* при передаче проекта организатор получает короткую памятку: как изменить дату, закрыть/открыть набор, загрузить отчёт, заменить QR и контакты.

---

# 23. Sanity Document Types / Schemas

Sanity schema должна поддерживать следующие document types.

## Tour

```ts
Tour {
  _id
  _type: "tour"

  title
  slug

  shortDescription
  description

  coverImage
  gallery[]

  isListed
  sortOrder

  seo {
    title
    description
    image
  }
}
```

`isListed` отвечает только за присутствие опубликованного направления в публичном каталоге. Draft/published состояние хранится штатными механизмами Sanity.

---

# 24. Departures

```ts
Departure {
  _id
  _type: "departure"

  tour               // reference → Tour

  startDate
  endDate

  bookingStatus:
    OPEN
    CLOSED
    CANCELLED

  price?
  prepaymentAmount

  paymentQr

  organizers[]        // reference → Organizer

  isListed
  isDemo
}
```

Связь:

```text
Departure → Tour
```

Правила:

* `bookingStatus` описывает бизнес-состояние выезда;
* draft/published Sanity описывает редакционное состояние;
* `isListed` управляет публичной видимостью и не заменяет `CANCELLED`;
* `CANCELLED` исключается из поиска ближайших будущих выездов;
* при `bookingStatus = OPEN` после fallback MUST существовать `prepaymentAmount`, QR и Organizer с валидным телефоном;
* `isDemo = true` MUST блокировать production release, если Departure попадает в публичный dependency set и `siteSettings.launchReady = true`;
* денежные значения хранятся в одной заранее зафиксированной единице, например целых рублях.

В `Departure` намеренно отсутствуют:

* `paymentUrl`;
* текстовые банковские реквизиты;
* пользовательские booking records;
* поля для данных клиента.

---

# 25. Reports

```ts
Report {
  _id
  _type: "report"

  title
  slug

  tour                 // reference → Tour
  departure?           // reference → Departure

  date?                // используется только если нет Departure

  coverImage
  gallery[]

  description?
  sortOrder?
}
```

Если `departure` задан, дата отчёта должна выводиться из связанного Departure и не дублироваться вручную. `date` используется только для исторического отчёта, который невозможно связать с конкретным Departure.

Отдельное поле `published` не используется: публикация определяется draft/published состоянием Sanity.

---

# 26. Reviews

```ts
Review {
  _id
  _type: "review"

  image
  authorName?

  tour?               // reference → Tour
  description?

  sortOrder
  isListed
  isDemo              // true у mock-отзывов
}
```

Отзывы в MVP преимущественно представлены изображениями/скриншотами.

Production build MUST отклонять публичный mock-отзыв с `isDemo = true`, если `siteSettings.launchReady = true`.

---

# 27. Organizers

```ts
Organizer {
  _id
  _type: "organizer"

  name
  phone

  photo?
  bio?

  isListed
  isDemo
}
```

Публичный `Organizer` не связан с учётной записью Sanity.

Для booking flow используется только `phone`. `photo` и `bio` относятся исключительно к публичному информационному блоку об организаторе.

Production build MUST отклонять публичного организатора с `isDemo = true`, если `siteSettings.launchReady = true`.

---

# 28. Media / Assets

Sanity Asset CDN является **source storage**, но публичный сайт не должен ссылаться на него во время runtime.

CMS может хранить:

* JPEG;
* PNG;
* WebP;
* изображения QR;
* другие поддерживаемые графические assets.

Для каждого изображения в контентной модели необходимо иметь понятный `alt` или возможность задать его рядом с asset reference.

Во время production build все assets, используемые опубликованным публичным контентом, должны быть скачаны с Sanity и материализованы локально.

Пример:

```text
Sanity asset
cdn.sanity.io/.../altai.jpg
        ↓ build-time download
public/generated/cms/<asset-hash>/gallery.webp
        ↓ next export
out/generated/cms/<asset-hash>/gallery.webp
```

Публичный HTML/JS должен использовать только локальные пути:

```html
<img src="/generated/cms/.../gallery.webp" />
```

а не `https://cdn.sanity.io/...`.

Для производных бренд-активов необходимо подготовить:

* `favicon.ico` / `favicon.png`;
* `apple-touch-icon.png`;
* локальную версию логотипа для Header/Footer;
* дефолтное OG-изображение.

---

# 29. Global Site Settings

В Sanity используется singleton-документ `siteSettings`:

```ts
SiteSettings {
  _id: "siteSettings"
  _type: "siteSettings"

  siteName
  siteUrl
  timezone

  launchReady: boolean

  logo
  favicon

  hero {
    title
    subtitle
    image
  }

  booking {
    defaultQr?
    defaultPrepaymentAmount?
    defaultOrganizer?  // reference → Organizer
    isDemo
  }

  socials {
    maxChannelUrl?     // optional, вне Booking Modal
  }

  company {
    legalName
    inn
    ogrn
    phone
    email?
    isDemo
  }

  seo {
    title
    description
    ogImage
  }
}
```

Fallback-правила MUST быть однозначными:

```text
Departure.paymentQr
  ?? SiteSettings.booking.defaultQr

Departure.prepaymentAmount
  ?? SiteSettings.booking.defaultPrepaymentAmount

Departure.organizers[0]
  ?? SiteSettings.booking.defaultOrganizer
```

## Production readiness gate

Production release MUST выполняться только если:

```text
siteSettings.launchReady = true
```

и одновременно:

* `siteSettings.booking.isDemo != true`;
* `siteSettings.company.isDemo != true`;
* ни один публично используемый `Departure`, `Review` или `Organizer` не имеет `isDemo = true`;
* у каждого `OPEN` Departure после fallback существуют `prepaymentAmount`, QR и Organizer с валидным телефоном;
* обязательные legal/company/booking поля заполнены и проходят schema/build validation.

---

# 30. Получение ближайшего тура

Frontend определяет ближайший подходящий `Departure` во время SSG-сборки.

В выборку попадают только документы, которые:

```text
Sanity state = published
isListed = true
startDate >= currentProjectDate
```

`currentProjectDate` рассчитывается в `SiteSettings.timezone`, чтобы переход между календарными датами не зависел от timezone build-контейнера.

После этого:

```text
ORDER BY startDate ASC
LIMIT 1
```

Это `nextDeparture` — ближайший фактический будущий выезд независимо от того, открыт набор или закрыт.

При необходимости CTA может отдельно использовать `nextBookableDeparture`:

```text
published
isListed = true
bookingStatus = OPEN
startDate >= currentProjectDate
ORDER BY startDate ASC
LIMIT 1
```

Таким образом можно корректно обработать сценарий, когда ближайший выезд уже закрыт для набора, но следующий выезд открыт.

Поскольку сайт является pure SSG, вычисленное значение само по себе не изменится после наступления новой даты. Поэтому кроме rebuild по CMS webhook должен существовать **плановый rebuild минимум один раз в сутки**, чтобы прошедшие Departure автоматически переставали считаться ближайшими даже без ручной публикации контента.

---

# 31. Что происходит после завершения тура

Прошедший `Departure` не удаляется.

Он остаётся в CMS и может:

* использоваться для истории;
* связываться с Report;
* связываться с отзывами;
* использоваться для аналитики в будущем.

На сайте ближайшим автоматически становится следующий будущий выезд.

---

# 32. Pure SSG / Static Export

Frontend реализуется через Next.js App Router и MUST собираться как pure static export.

Минимальный `next.config.ts` contract:

```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: {
    // CMS images уже материализованы/оптимизированы build pipeline.
    // Runtime Next Image Optimization API отсутствует.
    unoptimized: true,
  },
}

export default nextConfig
```

Вместо `images.unoptimized: true` MAY использоваться собственный static custom loader, но он MUST возвращать только локальные production URL и не создавать runtime-зависимость от внешнего image CDN.

Во время `next build` frontend:

1. получает только опубликованный публичный контент из Sanity;
2. валидирует production readiness;
3. собирает список всех используемых CMS-assets;
4. скачивает и материализует их локально;
5. генерирует статические страницы и маршруты;
6. создаёт свежий каталог `/out`.

После build public runtime содержит только Nginx + `/out`.

Публичные страницы MUST NOT использовать SSR, ISR, runtime Server Actions/Route Handlers для CMS-контента, client-side fetch к Sanity или стандартный runtime Next Image Optimization API.

Dynamic routes (`/tours/[slug]`, `/reports/[slug]`) полностью перечисляются и генерируются во время build.

---

# 33. Обновление контента при SSG

Изменение контента не обновляет уже опубликованный static artifact автоматически.

Основной MVP pipeline:

```text
Sanity publish / unpublish
        ↓
Sanity webhook
        ↓
Coolify deploy webhook frontend-приложения
(Authorization: Bearer <Coolify deploy token>)
        ↓
чистая build-среда на российском VPS
        ↓
preflight Sanity API/CDN connectivity
        ↓
fetch Sanity content + current assets
        ↓
next build / output: export
        ↓
validate candidate artifact
        ↓
build candidate Nginx image/container
        ↓
static healthcheck
        ↓
production switch
```

Sanity webhook MUST использовать отдельный Coolify deploy token через HTTP `Authorization` header; credential хранится только в webhook configuration и не попадает в frontend/static artifact.

### Build-time dependency boundary

Требование MVP — **runtime-независимость публичного пользователя от Sanity**, а не полное отсутствие Sanity во всём deployment pipeline.

Поэтому основной build MAY выполняться на российском VPS, пока production build environment имеет стабильный доступ к Sanity Content API и Asset CDN. Это уже проверяется отдельным preflight и acceptance test.

Если Sanity временно недоступен build-среде:

* новый release MUST не публиковаться;
* предыдущий static release MUST продолжать обслуживать пользователей без изменений;
* неуспешная публикация MUST быть видна в deployment logs/notifications.

Внешний CI/build environment вне РФ MAY быть настроен как аварийный fallback для публикаций. Он не является обязательной частью MVP, чтобы не превращать GitHub Actions/внешний registry в новую постоянную критическую зависимость. Если fallback используется, на VPS должен доставляться уже собранный validated static artifact или immutable image; публичный runtime всё равно остаётся автономным.

### Scheduled daily rebuild

Ежедневный rebuild MUST иметь конкретный trigger, потому что `nextDeparture` зависит от календарной даты.

Для MVP предпочтительно:

```text
host cron / systemd timer на VPS
        ↓
authenticated Coolify Deploy API/Webhook
        ↓
обычный production build pipeline
```

Триггер выполняется минимум один раз в сутки после смены календарной даты в `siteSettings.timezone`.

Deploy token MUST храниться вне публичного Nginx container (например, в root-only environment/credential file host timer). Не следует помещать deploy credential в static web image.

Внешний scheduled workflow MAY использоваться как альтернатива, но механизм должен быть явно задокументирован в deployment runbook.

---

# 34. Publish workflow

Workflow редактора:

```text
Редактор меняет контент в Sanity Studio
↓
Draft
↓
Preview / проверка
↓
Publish
↓
Sanity webhook
↓
Coolify rebuild frontend
↓
production build checks
↓
новая статическая версия сайта
```

Доступ редактора к Sanity через VPN допустим и не является ограничением пользовательского сайта.

## 34.1 Демо-наполнение (Seed Data)

Разработка ведётся не на пустой CMS: Sanity наполняется реалистичными mock-данными, чтобы дизайн, SSG pipeline и контентная модель проверялись на «живом» содержимом.

Предусматривается отдельный idempotent dev/import script через Sanity API, запускаемый вручную.

Он должен создавать/обновлять:

* `siteSettings`: бренд «Миклуха Маклай», mock-реквизиты, mock-телефон, mock QR и тестовые ссылки;
* `Tour`: Горный Алтай, Красноярские Столбы;
* `Departure`: прошедшие и будущие выезды, включая состояния `OPEN`, `CLOSED` и `CANCELLED`;
* `Report`: минимум 1–2 отчёта на направление;
* `Review`: 4–6 mock-отзывов;
* `Organizer`: один mock-организатор;
* `LegalPage`: тестовые заготовки правовых страниц.

Mock import не должен автоматически запускаться на production dataset. Скрипт обязан отказываться работать с production-конфигурацией без явно заданного override.

Все тестовые QR, номера, реквизиты и ссылки должны быть явно узнаваемы как тестовые и заменены перед запуском.

## 34.2 Clean build и удаление старой статики

Поскольку CMS-assets скачиваются в локальную статику, **каждая production сборка MUST начинаться с чистого состояния**.

Запрещено докачивать новые assets поверх каталога предыдущего release.

Перед получением данных из Sanity pipeline MUST удалить как минимум:

```text
.next/
out/
public/generated/cms/
```

Рекомендуемый build flow:

```text
1. clean
   rm -rf .next out public/generated/cms

2. preflight Sanity connectivity

3. fetch current published Sanity content

4. validate launchReady/isDemo/business invariants

5. derive current asset dependency set

6. download ONLY assets referenced by current public content
   → public/generated/cms/

7. generate responsive/local image variants

8. next build
   → fresh /out

9. validate /out

10. build candidate Nginx image using ONLY fresh /out

11. run static healthcheck against candidate

12. switch production only after all gates succeed
```

Обязательные правила:

* `out/` и `public/generated/cms/` не являются persistent volumes;
* final Nginx container не наследует filesystem предыдущего release;
* каждый deploy создаёт новый immutable artifact/container image;
* удалённое из Sanity изображение MUST отсутствовать в новой версии, если оно больше не входит в dependency set;
* asset filenames SHOULD быть deterministic/content-addressed;
* ошибка скачивания обязательного asset MUST ломать новый build, но не текущий production;
* Docker image/build-cache cleanup на VPS выполняется отдельно и не влияет на текущий production container.

Рекомендуемый command:

```bash
npm run clean   && npm run sync:cms   && npm run validate:content   && npm run build   && npm run validate:out
```

Пример scripts:

```json
{
  "scripts": {
    "clean": "rm -rf .next out public/generated/cms",
    "sync:cms": "node scripts/sync-sanity-content.mjs",
    "validate:content": "node scripts/validate-content.mjs",
    "build": "next build",
    "validate:out": "node scripts/validate-static-export.mjs"
  }
}
```

Production artifact MUST не содержать runtime CMS URL:

```bash
! grep -R -E "(api|apicdn|cdn)\.sanity\.io|sanity-cdn\.com" out/
```

### 34.3 Static validation / healthcheck definition

Термин `healthcheck` в этом PRD означает конкретный deployment gate для статического сайта.

**Build-time validation MUST проверить:**

* `/out/index.html` существует;
* все ожидаемые dynamic routes из build manifest существуют в `/out`;
* `sitemap.xml` и `robots.txt` существуют и соответствуют build environment;
* все локальные CMS asset references из HTML/JSON указывают на существующие файлы;
* в `/out` отсутствуют Sanity API/CDN runtime URL;
* отсутствуют production-blocking demo records и незаполненный `OPEN` booking flow.

**Candidate-container HTTP healthcheck MUST проверить до production switch:**

* `GET /` → `200`;
* `GET` хотя бы одного опубликованного `/tours/<slug>/` → `200`;
* `GET` опубликованного `/reports/<slug>/` → `200`, если reports существуют;
* `GET /robots.txt` → `200`;
* `GET /sitemap.xml` → `200`;
* запрос заведомо отсутствующего URL → `404` и отдаётся брендированный `404.html`;
* один или несколько ключевых локальных image/asset URL → `200`.

Только candidate, прошедший build validation + HTTP healthcheck, может стать production. Failed candidate MUST не заменять предыдущий release.

---

# 35. Deployment Architecture

Основная production infrastructure:

```text
External SaaS
└── Sanity Cloud
    ├── Studio
    ├── Content Lake
    └── Asset CDN

Russian VPS
└── Coolify
    └── miklukha-web
        ├── build stage: Node.js
        │   ├── clean
        │   ├── fetch/validate Sanity
        │   ├── materialize assets
        │   └── next build
        │
        └── runtime stage: Nginx
            └── fresh /out
```

Node.js используется только в ephemeral build stage. Production runtime содержит только Nginx и статические файлы.

**MUST:** на российском VPS/Coolify существует только одно application deployment для проекта — `miklukha-web`. Отдельные `web`, `studio`, `cms` или shared-service приложения не создаются. Sanity остаётся внешним SaaS.

## Nginx contract

С учётом `trailingSlash: true` Nginx SHOULD обслуживать маршруты как каталоги с `index.html`.

Минимально:

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;

    location / {
        try_files $uri $uri/ =404;
    }

    error_page 404 /404.html;

    location = /404.html {
        internal;
    }
}
```

Production Docker image MUST содержать сгенерированный Next.js `out/404.html`, чтобы пользователь получал брендированную статическую 404, а не generic Nginx error page.

## Build fallback

Если в будущем build-time доступ к Sanity с российского VPS становится ненадёжным, MAY использоваться внешний build runner/CI. Это изменение не требует менять frontend architecture: внешний runner получает Sanity content/assets, выполняет те же clean/validation/build gates и доставляет validated immutable artifact на российский VPS.

---

# 36. База данных и backend runtime

На собственной инфраструктуре проекта **нет базы данных и backend runtime**.

Контент хранится в Sanity Content Lake как управляемом SaaS.

На VPS не требуются:

```text
PostgreSQL
MongoDB
Redis
CMS runtime
custom API server
Node.js runtime для public website
```

Это уменьшает операционную нагрузку, количество сервисов, которые нужно резервировать/обновлять, и поверхность отказа публичного сайта.

---

# 37. Media Storage и локальная материализация

Sanity хранит оригинальные source assets.

Во время каждой SSG-сборки frontend скачивает только assets, реально используемые текущим опубликованным контентом.

Локальные файлы создаются в временном build-каталоге:

```text
public/generated/cms/
```

и затем попадают в:

```text
out/generated/cms/
```

Этот каталог **не переживает сборки**. Он удаляется целиком перед каждым `sync:cms`.

Нельзя использовать persistent volume для generated media публичного сайта, иначе удалённые из CMS изображения будут бесконечно накапливаться.

Production release является самодостаточным snapshot:

```text
HTML + CSS + JS + images + QR + legal content
```

После deployment сайт не должен обращаться к Sanity Asset CDN.

---

# 38. Структура репозитория

**MUST:** проект ведётся как **один application repository**, а не monorepo.

В MVP не используются:

* Turborepo;
* pnpm/npm/yarn workspaces;
* `/apps/web`;
* `/apps/studio`;
* `/packages/shared`;
* отдельные shared packages только ради типов/config;
* отдельный package lifecycle для Sanity Studio.

Рекомендуемая структура:

```text
miklukha-maklay/
├── src/
│   ├── app/
│   ├── components/
│   ├── lib/
│   │   ├── cms/
│   │   │   ├── client.ts
│   │   │   ├── queries.ts
│   │   │   ├── normalize.ts
│   │   │   └── types.ts
│   │   └── ...
│   └── ...
│
├── sanity/
│   ├── schemaTypes/
│   │   ├── tour.ts
│   │   ├── departure.ts
│   │   ├── report.ts
│   │   ├── review.ts
│   │   ├── organizer.ts
│   │   ├── legalPage.ts
│   │   └── siteSettings.ts
│   ├── structure.ts
│   └── sanity.config.ts
│
├── scripts/
│   ├── sync-sanity-content.mjs
│   ├── materialize-assets.mjs
│   ├── validate-content.mjs
│   └── validate-static-export.mjs
│
├── public/
│   ├── logo.webp
│   └── generated/
│       └── cms/          # generated, gitignored, полностью очищается перед build
│
├── next.config.ts
├── nginx.conf
├── Dockerfile
├── package.json
├── package-lock.json / pnpm-lock.yaml
└── .gitignore
```

Проект MUST иметь:

* один `package.json`;
* один lockfile;
* один dependency graph;
* один production Dockerfile;
* один Coolify application: `miklukha-web`.

Sanity schemas/config хранятся в `/sanity` этого же репозитория, потому что это часть определения контентной модели продукта. Это **не делает проект monorepo**: `/sanity` не является отдельным package/workspace.

Sanity Studio MAY быть:

1. размещена инфраструктурой Sanity; либо
2. собрана/опубликована отдельно как статическая Studio при необходимости.

В обоих случаях Studio не является production runtime публичного сайта и не требует отдельного приложения на российском VPS. Доступ администратора к Studio через VPN допустим.

`public/generated/cms/`, `.next/` и `out/` MUST быть добавлены в `.gitignore` и никогда не используются как источник следующей сборки. Перед каждой production-сборкой они удаляются целиком согласно clean-build contract.

---

# 39. TypeScript и граница CMS-интеграции

Frontend, Sanity schemas/config и build-time integration реализуются на TypeScript/JavaScript в рамках одного проекта.

**MUST:** не создавать отдельный shared package только для Sanity-типов. Контентные типы должны либо генерироваться/выводиться из Sanity schema/query layer, либо находиться в локальном модуле приложения, например `src/lib/cms/types.ts`.

Build-time CMS adapter должен быть единственной точкой, которая знает о Sanity API response shape. UI-компоненты получают нормализованные внутренние DTO и не должны напрямую зависеть от GROQ-response shape или Sanity-specific asset structures.

Рекомендуемая граница:

```text
Sanity API
   ↓
src/lib/cms/client + queries
   ↓
normalize
   ↓
internal DTO
   ↓
Next.js pages/components
```

Это сохраняет возможность в будущем заменить CMS без перехода на monorepo и без переписывания UI-компонентов.

---

# 39.1 UI-кит: shadcn/ui

Интерфейс собирается на **shadcn/ui** поверх Tailwind CSS.

Из этого следует:

* компоненты shadcn/ui копируются в проект (`/components/ui`) и кастомизируются под визуальный стиль бренда «Миклуха Маклай», а не используются как непрозрачная npm-зависимость;
* Booking Modal реализуется через `Dialog` (desktop) — при необходимости с `Sheet` (bottom sheet) на mobile, согласно разделу 41 (Mobile UX);
* Lightbox для галерей и отзывов — либо кастомный компонент на базе `Dialog`, либо совместимая с shadcn примитивом реализация (Embla carousel, на котором построен `Carousel` из shadcn, хорошо подходит и для горизонтальной ленты фотоотчётов из раздела 10);
* карточки туров, кнопки, badge статуса выезда (`OPEN`/`CLOSED`/`CANCELLED`), toast/уведомления — стандартные примитивы shadcn (`Card`, `Button`, `Badge` и т.д.), не пишутся с нуля;
* тема (цвета, radius, шрифты) настраивается через Tailwind-токены и CSS-переменные shadcn централизованно, а не точечными классами в каждом компоненте — это упрощает организатору/дизайнеру будущую правку визуального стиля без переписывания разметки;
* второй UI-библиотеки (MUI, Ant Design и т.п.) в проекте быть не должно — все интерфейсные примитивы идут через shadcn/ui, чтобы не плодить конфликтующие стили.

---

# 39.2 Локализация

Сайт — **полностью одноязычный, только русский язык**. Английской или любой другой языковой версии в MVP не предусмотрено, и архитектура не обязана закладывать под неё расширяемость.

Из этого следует:

* `<html lang="ru">` на всех страницах;
* в Next.js не используется i18n-роутинг (`/en/...`, `next-intl` и т.п.) — один набор маршрутов;
* в Sanity не создаются отдельные локализованные поля/объекты под другие языки — у каждого контентного поля одно русское значение;
* `hreflang` и мультиязычный sitemap не нужны;
* все тексты интерфейса (кнопки, статусы, лейблы форм, сообщения об ошибках) — хардкодятся на русском в компонентах, отдельный слой i18n-строк (`en.json`, `ru.json`) не создаётся, так как он не имеет практической ценности при единственном языке;
* проектные названия типов, полей, descriptions и validation messages в Sanity Studio — на русском (см. раздел 22.1); системный UI Sanity может оставаться на поддерживаемом провайдером языке и не является блокером MVP.

---

# 40. Responsive Design

Минимальные breakpoints:

* mobile;
* tablet;
* desktop.

Проектировать интерфейс необходимо mobile-first.

Особое внимание:

* галереям;
* QR;
* booking modal;
* кнопкам;
* длинным названиям поездок;
* footer.

---

# 41. Mobile UX

На смартфоне:

* CTA должна быть хорошо доступна;
* горизонтальные галереи должны иметь естественный swipe;
* элементы должны иметь touch target не менее комфортного размера;
* booking modal допускается реализовать как bottom sheet;
* QR должен помещаться целиком на экран;
* номера телефонов должны открывать dialer.

Можно рассмотреть sticky CTA:

```text
[ Забронировать место ]
```

в нижней части экрана на странице тура.

---

# 42. Image Optimization

Фотографии — одна из наиболее тяжёлых частей сайта, при этом public runtime MUST не использовать Sanity CDN или Next.js Image Optimization API.

`next.config.ts` MUST содержать `images.unoptimized: true`, если используется стандартный `next/image` без custom loader (см. раздел 32).

Оптимизация выполняется **до static export**.

Для каждого CMS image pipeline SHOULD создавать необходимые локальные варианты, например:

```text
thumbnail   ~400px
card        ~800px
gallery     ~1400px
hero        ~2200px
lightbox    large/original-limited
```

Допустимы два build-time способа:

1. запросить преобразованные варианты у Sanity Asset CDN и сохранить их локально;
2. скачать source asset и обработать локально через Sharp или эквивалентный tooling.

Итоговые URL в `/out` MUST быть локальными.

Дополнительные требования:

* WebP/AVIF SHOULD использоваться, где это оправдано;
* карточки/mobile gallery MUST не получать исходники 4000–6000 px;
* preload — только для критичного hero asset;
* остальные изображения — lazy loading;
* width/height или aspect-ratio предотвращают layout shift;
* homepage не загружает полноразмерные версии всей исторической галереи;
* lightbox MAY использовать отдельный крупный local variant;
* generated variants очищаются вместе с `public/generated/cms/` перед каждой новой сборкой.

---

# 43. Performance

Целевые показатели:

* быстрый первый экран;
* отсутствие заметного layout shift;
* плавный horizontal scroll;
* отсутствие загрузки всей полноразмерной галереи сразу.

Желательно ориентироваться на:

```text
Lighthouse Performance ≥ 90
```

на production build при адекватных исходных изображениях.

---

# 44. SEO

Каждая публичная страница направления и отчёта MUST иметь:

* `<title>`;
* meta description;
* Open Graph image;
* canonical;
* человекочитаемый slug.

`<title>` формируется по шаблону `{Название страницы} — {siteSettings.siteName}`.

Необходимо статически генерировать:

```text
sitemap.xml
robots.txt
```

## Build-time environment policy

Так как runtime отсутствует, production/staging SEO-различия MUST определяться во время build, например:

```text
DEPLOY_ENV=production
DEPLOY_ENV=staging
```

При `DEPLOY_ENV=staging` static export MUST генерировать:

```text
robots.txt → Disallow: /
<meta name="robots" content="noindex,nofollow">
```

и не должен использовать production canonical/siteUrl.

При `DEPLOY_ENV=production` индексирование разрешается согласно production SEO settings.

Нельзя рассчитывать на runtime env-переключение robots/meta после того, как `/out` уже создан.

---

# 45. Structured Data

Для улучшения поисковой индексации можно добавить JSON-LD.

Минимально:

* `Organization`;
* `Event` для конкретных будущих выездов.

Дата конкретного Departure может использоваться как дата Event.

Это не является блокером MVP.

---

# 46. Analytics

## MVP policy: analytics отсутствует

В MVP **не подключается система пользовательской аналитики**.

MUST NOT использоваться:

* Google Analytics / Яндекс Метрика / Meta Pixel и аналоги;
* собственные booking-intent events;
* `tour_view`, `report_view`, `booking_modal_open` и другие telemetry events;
* UTM persistence;
* cookies для аналитики/маркетинга;
* session identifiers;
* `localStorage`/`sessionStorage` для tracking;
* fingerprinting;
* отправка client-side telemetry на собственный backend.

Нажатия на QR, открытие Booking Modal и `tel:`-ссылку не отслеживаются.

Если аналитика понадобится в будущем, её добавление является отдельным изменением scope и требует отдельного решения по privacy/legal/consent. Текущий MVP должен оставаться полностью функциональным без analytics SDK.

---

# 47. Accessibility

Минимальные требования:

* alt для изображений;
* keyboard navigation;
* видимый focus state;
* управление lightbox с клавиатуры;
* Escape закрывает modal/lightbox;
* достаточный contrast;
* aria-label для icon buttons.

---

# 48. Ошибочные состояния

Frontend MUST корректно работать, если:

* у тура нет нового Departure;
* нет фотографий;
* отсутствуют отзывы;
* у `OPEN` Departure отсутствует QR, сумма предоплаты или телефон организатора — такой production build MUST быть отклонён;
* MAX channel URL не задан;
* отчёт снят с публикации;
* пользователь открывает неизвестный URL.

Вместо отсутствующей даты:

```text
Дата следующего тура скоро появится
```

Нельзя показывать broken image или пустые UI containers.

Если обязательный опубликованный asset отсутствует или не может быть материализован во время build, новый production release MUST завершиться ошибкой и не заменять предыдущую версию.

Неизвестный URL MUST возвращать HTTP 404 и статическую брендированную `out/404.html` через Nginx `error_page` (раздел 35).

---

# 49. Безопасность CMS и build pipeline

## 49.1 No user-data logging policy

Поскольку MVP заявлен как сайт без сбора пользовательских данных, public delivery layer MUST не вести persistent request-level analytics/logging.

Минимальные требования к Nginx/static container:

```nginx
access_log off;
```

Не подключаются внешние logging/observability SDK, которые записывают IP/User-Agent/visitor identifiers. Если инфраструктурный error logging необходим для эксплуатации, он MUST быть минимизирован и не использоваться для пользовательской аналитики или профилирования.

Это требование относится к публичному web-контейнеру и не ограничивает служебные build/deploy logs, которые не содержат пользовательских запросов.


Sanity находится за пределами public runtime сайта.

Требования:

* доступ администратора к Sanity защищается учётной записью Sanity; VPN допустим;
* Sanity write tokens MUST не попадать во frontend bundle;
* build-time read token хранится только в build/deployment secrets;
* deploy credential для scheduled rebuild MUST не находиться в public Nginx image;
* build logs MUST не выводить токены;
* `/out` MUST не содержать Sanity credentials;
* public browser MUST не делать запросы к Sanity API/CDN;
* production readiness определяется явным contract `launchReady` + `isDemo`, а не эвристикой содержимого QR;
* production build MUST блокироваться, если `launchReady != true`;
* при `launchReady = true` production build MUST блокироваться при публичном `isDemo = true`, demo booking/company settings или критически неполном `OPEN` booking flow;
* build-time connectivity failure к Sanity MUST ломать только candidate release, но не текущий production.

---

# 50. Backups / Data Portability

На VPS нет PostgreSQL и persistent CMS media, поэтому отдельный backup этих сервисов не требуется.

Необходимо резервировать/сохранять:

* Git-репозиторий проекта;
* Sanity schemas/config из каталога `/sanity` того же Git-репозитория;
* production environment/secrets безопасным способом;
* периодический export Sanity dataset — рекомендуется как защита от ошибочного удаления/проблем внешнего SaaS;
* при необходимости последний успешно собранный production Docker image/static artifact как дополнительный deploy rollback point.

Каждый production static release сам по себе является read-only snapshot опубликованного контента и локальных assets на момент сборки, но он не заменяет полноценный CMS data export, поскольку не содержит drafts и редакционные данные.

---

# 51. Что не входит в MVP

В первую версию не входят:

* пользовательские аккаунты;
* сбор пользовательских персональных данных;
* формы заявок/обратной связи;
* пользовательская аналитика и tracking;
* cookies и идентификаторы сессии для аналитики;
* хранение информации о совершённых предоплатах на сайте;
* личный кабинет туриста;
* автоматическая проверка оплаты;
* полноценный booking engine;
* seat inventory;
* автоматическое уменьшение количества свободных мест;
* интеграция с банком;
* online acquiring;
* возвраты;
* промокоды;
* автоматические email/SMS;
* CRM;
* сложная админская аналитика;
* мобильное приложение.

Эти функции могут быть добавлены позже.
---

# 52. Потенциальное расширение

Архитектура должна позволить позже добавить:

```text
Departure.capacity
Departure.bookedSeats
Departure.price
Departure.route
Departure.program
Departure.includes
Departure.excludes
Departure.meetingPoint
Departure.difficulty
Departure.requiredEquipment
```

И полноценный процесс:

```text
Выбор тура
→ данные клиента
→ оплата
→ webhook банка
→ подтверждённое бронирование
→ уведомление организатора
→ уведомление клиента
```

Но для MVP это лишняя сложность.

---

# 53. Основная пользовательская воронка

```text
Instagram / MAX / Search / Direct
                 ↓
              Website
                 ↓
        Ближайшие поездки
                 ↓
            Tour details
                 ↓
       Фотоотчёты + отзывы
                 ↓
       Забронировать место
                 ↓
           Booking Modal
                 ↓
       Сумма предоплаты + QR
                 ↓
      Пользователь оплачивает
          вне системы сайта
                 ↓
     Телефон организатора
                 ↓
   Пользователь самостоятельно
    сообщает о предоплате
                 ↓
   Организатор подтверждает место
          вне системы сайта
```

Сайт не получает данные пользователя ни на одном этапе этой воронки.

---

# 54. Критерии готовности MVP

Проект считается готовым, когда все MUST-требования выполнены, включая:

* главная и public routes адаптивны;
* отображаются published + `isListed` направления;
* `nextDeparture` и `nextBookableDeparture` работают по правилам раздела 30;
* `CANCELLED` исключается из будущих CTA/выборок;
* CTA открывает booking modal для конкретного Departure;
* Booking Modal содержит только сумму предоплаты, QR и телефон организатора;
* Booking Modal не содержит форм, `paymentUrl`, текстовых реквизитов, мессенджеров или загрузки чека;
* телефон организатора доступен как текст и `tel:`-ссылка;
* Reports/Reviews/Organizers/SiteSettings управляются через Sanity;
* исходный код организован как один application repository с одним `package.json`/lockfile; monorepo/workspaces/Turborepo отсутствуют;
* Sanity schemas/config находятся внутри `/sanity` того же репозитория и не являются отдельным package;
* frontend собирается с `output: 'export'`, `trailingSlash: true`, `images.unoptimized: true` (либо эквивалентным local custom loader);
* production runtime состоит только из Nginx/static files;
* dynamic routes полностью генерируются во время build;
* перед каждой сборкой удаляются `.next/`, `out/`, `public/generated/cms/`;
* generated static/media не используют persistent volume;
* новый build содержит только текущий CMS asset dependency set;
* удалённые Sanity assets не накапливаются между релизами;
* все public CMS assets обслуживаются с собственного origin;
* `/out` не содержит runtime-ссылок на Sanity API/CDN;
* production build gate требует `siteSettings.launchReady = true` и отсутствие public `isDemo`;
* кандидат проходит формально определённые build validation + HTTP static healthcheck из раздела 34.3;
* неизвестный route отдаёт HTTP 404 через брендированный `out/404.html`;
* failed candidate release не заменяет предыдущий production;
* Sanity webhook инициирует rebuild после publish/unpublish;
* host cron/systemd timer (или задокументированный эквивалент) инициирует rebuild минимум раз в сутки;
* scheduled deploy credential отсутствует в public web image;
* staging build создаётся с build-time `DEPLOY_ENV=staging` и `noindex,nofollow`;
* в production отсутствуют analytics/tracking SDK, telemetry events, UTM persistence, cookies и browser storage для tracking;
* публичный сайт не отправляет пользовательские данные на backend;
* после успешного build сайт полностью работает при блокировке `*.sanity.io` и `*.sanity-cdn.com`;
* production build environment проходит Sanity API/CDN preflight;
* production работает только по HTTPS;
* нет критических accessibility/performance ошибок.

## 54.1 Pre-launch checklist

Перед публичным запуском MUST быть подтверждено:

* [ ] `siteSettings.launchReady = true` выставлен только после выполнения остальных пунктов;
* [ ] реальные реквизиты компании вместо test/mock;
* [ ] `siteSettings.company.isDemo = false`;
* [ ] реальные телефон/контакты организатора, public Organizer имеет `isDemo = false`;
* [ ] реальный QR и сумма предоплаты, `siteSettings.booking.isDemo = false`;
* [ ] public Departures/Reviews не имеют `isDemo = true`;
* [ ] реальная ссылка на MAX channel либо поле сознательно оставлено пустым;
* [ ] реальные тексты/фото туров, отчётов и отзывов;
* [ ] legal pages проверены/согласованы организатором;
* [ ] выполнен финальный clean production build;
* [ ] `validate:out` не обнаружил Sanity runtime URL;
* [ ] удалённые/replaced mock assets отсутствуют в свежем `/out`;
* [ ] candidate HTTP healthcheck прошёл до production switch;
* [ ] staging/noindex и production/indexable builds проверены отдельно.

---

# 55. Рекомендуемая архитектура MVP

Основная схема:

```text
                    ┌────────────────────────┐
                    │      SANITY CLOUD      │
                    │ Studio / Content Lake  │
                    │ Asset CDN              │
                    └───────────┬────────────┘
                                │ build-time only
                                ▼
                    ┌────────────────────────┐
                    │ Russian VPS / Coolify  │
                    │ clean build workspace  │
                    │ preflight + fetch      │
                    │ materialize assets     │
                    │ validate content       │
                    │ next build -- export   │
                    └───────────┬────────────┘
                                │ fresh /out
                                ▼
                    ┌────────────────────────┐
                    │ Candidate Nginx        │
                    │ static HTTP healthcheck│
                    └───────────┬────────────┘
                                │ only on success
                                ▼
                    ┌────────────────────────┐
                    │ Production Nginx       │
                    │ HTML/CSS/JS/assets     │
                    └───────────┬────────────┘
                                ▼
                         Пользователь РФ
                         без VPN / без CMS
```

Content update:

```text
Sanity publish
      ↓
Sanity webhook
      ↓
Coolify deploy
      ↓
CLEAN
      ↓
preflight Sanity
      ↓
fetch + materialize current dependency set
      ↓
validate launchReady / isDemo / business rules
      ↓
static export
      ↓
validate /out
      ↓
candidate Nginx healthcheck
      ↓
production switch
```

Date rollover:

```text
host cron / systemd timer
      ↓
authenticated Coolify deploy trigger
      ↓
обычный clean build pipeline
      ↓
recalculate nextDeparture
```

Optional build fallback:

```text
Sanity unavailable from RU build environment
      ↓
previous production stays online
      ↓
optional external CI/build runner
      ↓
validated immutable artifact
      ↓
Russian VPS
```

Ключевое свойство:

> **Ни Sanity API, ни Sanity CDN, ни CMS login не входят в runtime delivery path публичного пользователя.**

Администратор MAY использовать VPN. Publish-time зависимость от Sanity допускается; её отказ не должен влиять на уже опубликованный static release.

---

# 56. Принцип реализации

Главный принцип проекта:

> **Контент редактируется в Sanity, но публичный production является полностью автономным static snapshot.**

Не следует захардкоживать:

* названия туров;
* даты;
* статусы;
* фотографии;
* QR;
* сумму предоплаты;
* контакты;
* отзывы;
* реквизиты;
* MAX URL;
* legal content.

В коде должны оставаться:

* layout;
* компоненты;
* правила отображения;
* выбор `nextDeparture` / `nextBookableDeparture`;
* modal/lightbox behavior;
* build-time адаптер Sanity;
* asset materialization pipeline;
* build validation;
* правила clean build.

Sanity используется исключительно как authoring/source system:

```text
Sanity → build → local static snapshot → users
```

Запрещённый runtime flow:

```text
User browser → Sanity API/CDN
```

Каждая новая сборка является независимым immutable release. Предыдущие generated assets не переиспользуются как накопительное хранилище: перед синхронизацией контента каталоги предыдущей сборки удаляются полностью, затем скачивается только актуальный dependency set текущего опубликованного контента. Production switch возможен только после content validation, static export validation и candidate HTTP healthcheck.

Это гарантирует одновременно:

1. отсутствие зависимости пользователей в России от доступности зарубежной CMS/CDN;
2. отсутствие мусора и orphan assets от предыдущих публикаций;
3. возможность безопасно оставить предыдущий release активным при проблеме очередной сборки;
4. минимальную runtime-инфраструктуру на VPS;
5. возможность в будущем заменить Sanity на другой источник контента, не меняя публичную архитектуру сайта.
