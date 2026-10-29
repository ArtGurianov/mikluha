import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCatalog } from "./cms/normalize";
import { projectionToRaw, PUBLIC_CATALOG_SCHEMA, type PublicCatalog } from "./cms/projection";
import { assertCatalogLaunchReady } from "./launch-gate";

const image = { image: "https://mikluha-maklai.s3.cloud.ru/cms/a.webp", alt: "" };
const contract = {
  tour: { destination: "Алтай", route: "Кемерово — Ая", program: [{ title: "День 1", items: ["Сростки"] }],
    included: ["Проезд"], excluded: [], insurance: null, risks: "Горы" },
  departure: { departureTime: "00:30", returnTime: "23:00", departurePoint: "Кемерово", returnPoint: "Кемерово",
    accommodation: { name: "Дом", address: "Ая", category: null, registryNumber: null, roomType: "2-местный", nights: 3,
      meals: "Завтраки", legalEntity: "ИП" },
    carrier: { legalName: "ООО Перевозчик", route: "Кемерово — Ая", vehicle: null, baggage: "20 кг", boarding: "Вокзал" },
    services: [] },
};

const catalog = (over: Partial<PublicCatalog["departures"][number]> = {}): PublicCatalog => ({
  schema: PUBLIC_CATALOG_SCHEMA,
  tours: [{ slug: "altai", title: "Алтай", content: { shortDescription: "Тур", coverImage: image } }],
  departures: [{ slug: "altai-2027", tourSlug: "altai", startsOn: "2027-06-01", endsOn: "2027-06-04", bookingStatus: "OPEN",
    priceKopecks: 3_400_000, capacity: 18, isDemo: false, content: {}, organizers: [], contract, ...over }],
  organizers: [], reports: [], reviews: [],
});
const gate = (c: PublicCatalog) => () => assertCatalogLaunchReady(normalizeCatalog(projectionToRaw(c)));

test("a complete, real catalog passes the launch gate", () => {
  assert.doesNotThrow(gate(catalog()));
});

test("what the static build refuses is refused at the SSR boundary too", () => {
  assert.throws(gate(catalog({ isDemo: true })), /departure altai-2027 is still marked "Демо-данные"/);
  assert.throws(gate(catalog({ contract: null })), /OPEN departure altai-2027 has incomplete tour contract data/);
  assert.throws(gate(catalog({ priceKopecks: null })), /OPEN departure altai-2027 has no price/);
  assert.throws(gate(catalog({ capacity: null })), /OPEN departure altai-2027 has no capacity/);
  const demoText = { ...contract, departure: { ...contract.departure, departurePoint: "демо точка" } };
  assert.throws(gate(catalog({ contract: demoText })), /explicit demo content/);
  // A CLOSED departure is not advertised for booking; only its demo flag matters.
  assert.doesNotThrow(gate(catalog({ bookingStatus: "CLOSED", contract: null, priceKopecks: null })));
});
