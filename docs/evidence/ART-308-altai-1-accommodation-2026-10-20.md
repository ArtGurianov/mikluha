# ART-308 — altai-1: registered accommodation and supplier contract gate

## Departure approved by owner

- `altai-1` (tour `altai`), **2027-01-05 00:30 — 2027-01-08 21:00**, timezone `Asia/Krasnoyarsk`.
- Four calendar dates, **three nights** of accommodation; 26,500 RUB/person; planned capacity **40**.
- Previously approved carrier and other trip details unchanged.
- `bookingStatus=CLOSED`, `isListed=false`. No production DB update, payment or ЕИС submission authorized.

## Confirmed accommodation identity

| Field | Value |
|---|---|
| Name | Мини-отель «Фараонова дача» |
| Registry number | **С042024009867** |
| Accommodation type | Гостиница |
| Category | нет категории |
| Type validity period | 01.09.2025–01.09.2028 |
| Building address | 649240, Республика Алтай, м.р-н Чемальский, с.п. Чемальское, с. Чемал, ул. Дворникова, **д. 7А** |
| Registered owner | ООО «АЖУР» |
| ИНН / ОГРН / КПП | **0400006053** / **1170400004697** / **040001001** |
| Contact phone | +7 903 919-24-25 |
| Email | faraon.04@yandex.ru |
| Website | faraon04.com |
| Official registry record | https://tourism.fsa.gov.ru/ru/resorts/hotels/6f7cd4f9-c606-11ef-92da-433c6a1ae649/about-resort |

Use the listed **building address** in the accommodation contract/Заявка/ЕИС fields.
The registry operator is identified but a contract between the relevant parties is still needed
to establish actual services for this tour.

## Single outstanding accommodation supplier gate

A valid **supplier contract document** between Mikluha and **ООО «АЖУР»** (or with an
authorized contracting intermediary) confirming:

- The selected hotel and the trip **5–8 January 2027**, with **3 nights**.
- An agreed accommodation service for the group in line with the published group capacity.
- General accommodation type and commercial conditions (used for the `roomType` field).
- Meal provisions: included/excluded and quantities if included (used for `meals`).
- Counterparty identity, signatories, dates and commercial/settlement terms.

The purpose is to have complete contract-level accommodation facts; **one document** can
satisfy the remaining supplier gate if it contains all these details. Do not treat
`roomType` and `meals` as separate approval demands when the contract already defines
them. Do not invent values to bypass the admission checks.

### Storage acceptance — existing Cloud.ru Evolution S3

Use the **existing Mikluha bucket** `mikluha-maklai`, with a distinct access-controlled
document prefix (planned `s3://mikluha-maklai/private/vendor-contracts/altai-1/`).
The prefix name alone **does not enforce privacy**: require effective private bucket/object
permissions and explicit anonymous-read refusal. Do not use the public CMS media/CDN
path or attach contract bytes to GitHub/Linear.

After upload, the operator checks **authenticated S3 read-back**, stores the exact
object key and SHA-256 evidence, and verifies the object is not publicly readable.
The actual key and uploaded state remain **unset until evidence exists**.

## Done when

1. The signed/effective supplier agreement covers the actual service and its terms.
2. The document is in the existing **private S3 location**, with successful authorized
   read-back and public-read denial.
3. The agreement's general accommodation facts are set in the departure contract/
   Заявка/ЕИС data needed to truthfully describe the service.

This completes **ART-308 only**. The itinerary, transport, customer contract, refund,
payment and Commerce production-admission gates are separate tasks and still govern
whether sales may open. Keep `CLOSED` until those gates independently pass.
