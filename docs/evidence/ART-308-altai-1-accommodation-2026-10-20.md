# ART-308 — altai-1: hotel registry extract and outstanding accommodation gate

## Scope / unaltered commercial boundary

- Departure `altai-1`, tour `altai`: **2027-01-05 00:30** to **2027-01-08 21:00** (Asia/Krasnoyarsk).
- 4 calendar dates, **3 planned hotel nights** (January 5, 6, 7; **not a confirmed allocation**).
- Price 26,500 RUB/person; nominal group capacity 40 (not proof of 40 available beds).
- The original operator/carrier values and all unconfirmed conditions are unchanged.
- `bookingStatus=CLOSED`, `isListed=false`. No deployment, database write, payments or ЕИС filing.

## 2026-10-20 — owner-provided primary-registry extract (two JPEG pages)

The owner supplied an **extract from the Unified Register of Classification Objects in the Tourism Industry**, generated **20.10.2026**, and its second-page address annex. The visual text on the documents identifies:

| Field | Extract / appendix |
|---|---|
| Registry entry number | **С042024009867** |
| Type of accommodation | **Гостиница** |
| Type validity dates | **01.09.2025–01.09.2028** |
| Accommodation name | **Мини-отель «Фараонова дача» ООО «АЖУР»** |
| Hotel category | **нет категории** (not a star classification) |
| Region | **Республика Алтай** |
| **Building address** | **649240, Республика Алтай, м.р-н Чемальский, с.п. Чемальское, с Чемал, ул Дворникова, д. 7А** |
| Land plot address | **649240, Республика Алтай, м.р-н Чемальский, с.п. Чемальское, с Чемал, ул Дворникова, з/у 7А** |
| Owner | **ООО «АЖУР»**, ОГРН **1170400004697**, ИНН **0400006053**, КПП **040001001** |
| Contact phone | **+7 903 919-24-25** |
| Email | **faraon.04@yandex.ru** |
| Website | **faraon04.com** |
| Official record link (shown on extract) | https://tourism.fsa.gov.ru/ru/resorts/hotels/6f7cd4f9-c606-11ef-92da-433c6a1ae649/about-resort |

### Provenance / verification limitations

Two JPGs were provided in the project conversation on 2026-10-20. For matching the source
images during operator evidence archiving (filenames are not necessarily stable):

- Extract page 1: SHA-256 `6bde49e4b8d1fee01fbcdf1d8dac6685b73dcd2159ddbc3fbeeeaeb4b66224d2`.
- Appendix page 2: SHA-256 `8f7fe04a9c8912752aaf7ae9e7edf7aca8467259e1d3f5eb706bac7c5334a52f`.

**Original JPGs are not committed or archived by this PR.** Owner must save original pages in
the controlled supplier-evidence store and link them by hash or document reference to `altai-1`.
These are user-provided images of an official-style register extract, **not an independent online
read-back or cryptographic proof of authenticity**. The official URL timed out when checked from
the research environment. Re-check the current primary record in the operator's official
account/browser before supplier admission if a fresh confirmation is required.

The annex resolves conflicting third-party address claims (Дворникова 5, 7А, 9) in favor of
**building 7А**; the **land plot `з/у 7А` is NOT the lodging building address**.
The legal entity now has exact identifiers on the extract. Do not mistake this for proof of a
signed agreement with that entity or a confirmed reservation.

## Still required for the supplier / EIS / customer-contract gate

1. **Counterparty / contracting right:** obtain written confirmation that ООО «АЖУР» (the
   registry owner) itself provides the accommodation to Mikluha, or document any authorized
   contracting intermediary. Confirm the actual contract/signatory and settlement details.
2. **January 5–8, 2027 accommodation:** written booking/availability, exactly which building
   and rooms are used, room category/type, bed configuration and confirmed numbers for the
   planned group; verify ability to house up to 40 participants. Three *planned* nights do
   not establish a three-night accommodation contract.
3. **Food:** establish exact meals actually included in the paid tourism product (or explicitly
   none), meal counts and who provides them. Existing approved inclusions must not change
   merely because a hotel listing advertises an optional kitchen/food service.
4. **Check-in/out / winter operations:** confirm dates and practical check-in/out with the supplier
   for the midnight bus departure and return, including any availability constraints.
5. **Product and carrier prerequisites:** the departure already has missing route/program,
   inclusions, and carrier implementation details. Remain independent admission blockers.
6. **Legal/operational transfer:** store dated supplier documents, and ensure the final published
   per-departure contract, frozen Заявка, and ЕИС packet truthfully use the same accommodation.

## Current draft representation

The approved `content/departures/altai-1.yml` draft may store the hotel's registry number,
official building address, name, category, legal entity with identifiers, and the **three
planned nights**. `roomType` and `meals` remain `null` pending supplier confirmation.
Other incomplete contract and carrier fields are deliberately unchanged.

Do **not** mark ART-308 complete, publish the departure as sellable, change the global sales
switch, collect customer payments or file a live ЕИС record until the actual group agreement
and supplier/contract/EIS evidence are reviewed. Even after supplier acceptance, independent
global payment/refund/legal gates may remain blocked.

The current approved Admin/Postgres workflow will require a separate controlled draft/publish
action to write canonical live departure data; a repository PR alone does not claim a live DB
or immutable customer-contract update.
