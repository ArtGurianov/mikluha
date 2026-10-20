# ART-308 — altai-1: accommodation evidence and unresolved supplier gate

Researched 2026-10-20. This record documents an **owner-selected property**, not a supplier contract,
a signed reservation, a completed primary-registry verification, or permission to open sales.

## Approved departure fields preserved

- Slug: `altai-1` (tour `altai`).
- New departure: **2027-01-05 00:30** to **2027-01-08 21:00**, timezone `Asia/Krasnoyarsk`.
- 4 calendar dates / **3 planned accommodation nights** (night of Jan 5, 6, 7; no room block confirmed).
- Price: **26,500 RUB per tourist**; nominal capacity **40**.
- Existing carrier identity, organizer and all other known details unchanged.
- `bookingStatus: CLOSED`, `isListed: false`, launch gate not changed.

## Selected accommodation — grounded facts

- Public name: **Мини-отель «Фараонова дача»**, село Чемал, Республика Алтай.
- Reported tourism registry number **С042024009867**:
  - Primary entry URL published by hotel directories:
    https://tourism.fsa.gov.ru/ru/resorts/hotels/6f7cd4f9-c606-11ef-92da-433c6a1ae649/about-resort
  - The primary entry **could not be opened** from this research environment on 2026-10-20.
    Third-party directory checks corroborate the number but **do not replace a verified live official record**.
  - https://mirturbaz.ru/russia/respublika-altay/faraonova-dacha
  - https://forento.ru/rent/object/174150
  - https://ostrovok.ru/hotel/russia/altai_republic_chemal/mid11273591/hotel_faraonova_dacha/
- Classification listing says type **«Гостиница», category «Нет категории»**
  (a *booking intermediary*, not the authority):
  https://farachemal.broni.travel/politika-opd-pd/
- Hotel directories describe **18 rooms** accommodating two to five persons; room type and
  allocation for our group remain unknown. This is NOT proof of 40 reserved beds:
  https://forento.ru/rent/object/174150
- Direct phone reported by local directory and partner brochure: **+7 903 919-24-25**:
  https://www.google.com/travel/hotels/entity/ChoI8fnR1pX21vWxARoNL2cvMTFnOXF0aDJ5ahAB?gl=ru&hl=ru-RU
- Check-in **14:00**, check-out **12:00** shown by most directories, but Google lists
  12:00/10:00. **Confirm with supplier** for the actual January group:
  https://forento.ru/rent/object/174150
- A common kitchen and optional breakfasts/dinners are described; no included meal plan is
  established for our tour. Do not infer meal inclusion from hotel features:
  https://forento.ru/rent/object/174150

## Conflicting or insufficient evidence — do not put into contract/ЕИС as verified yet

1. **Exact property address** is inconsistent across independent listings:
   - `с. Чемал, ул. Дворникова, д. 5`: Google, travel listings, regional partner brochure.
     https://level.travel/hotels/9112537-Faraonova_Dacha
   - `с. Чемал, ул. Дворникова, д. 7А`: Yandex Travel.
     https://travel.yandex.ru/hotels/altai-republic/faraonova-dacha/
   - `с. Чемал, ул. Дворникова, д. 9`: Forento, MirTurbaz.
     https://forento.ru/rent/object/174150
   Read the **official record's address** and obtain matching supplier confirmation before
   populating the contract `accommodation.address`.
2. **Legal supplier**: MirTurbaz calls the operator **ООО «АЖУР»** and says registry record
   valid through 2028-09-01, but its **ИНН/ОГРН, legal basis and the actual contracting party**
   could not be independently tied to the official registry. Many companies share this name.
   No `legalEntity` is asserted yet.
3. **Actual category, current registry status, and full record** require primary read-back,
   captured as dated evidence in the supplier file.
4. **Exact room type**, number of rooms/beds, **availability and group booking** for January
   5–8 2027 require written hotel confirmation.
5. **Meal plan / number of meals** (if any) and **supplier terms / contract / invoices** need
   written supplier documentation. The tour's already approved commercial inclusions must not
   be silently changed.

## Release gate

The accommodation name, user-provided registry identifier and planned three nights may be
recorded in the draft. However `address`, `roomType`, `meals`, `legalEntity` stay
`null` until verified. The departure's independent missing product/program/transport facts
also stay unchanged. No placeholder, substituted hotel or guessed vendor data can pass
contract/EIS admission. Do not open sales, publish as bookable, collect payment or file an EIS
packet until all ART-308 evidence and other launch conditions are satisfied.

The modern Admin/Postgres publication flow, once deployed, requires updating the canonical
departure draft and publishing through the approved operator workflow. This repository change
does not claim a live DB write or customer-contract change.
