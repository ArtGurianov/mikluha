import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCatalog } from "./normalize";
import { parsePublicCatalog, projectionToRaw, PUBLIC_CATALOG_SCHEMA, type PublicCatalog } from "./projection";

const image = (name: string) => ({ image: `https://mikluha-maklai.s3.cloud.ru/cms/${name}.webp`, alt: name });

const catalog = (): PublicCatalog => ({
  schema: PUBLIC_CATALOG_SCHEMA,
  legalPages: [],
  tours: [{
    slug: "altai", title: "Алтай",
    // An editor's document cannot move the tour or unlist it: the projection's columns win.
    content: { slug: "elsewhere", isListed: false, shortDescription: "Четыре дня", coverImage: image("cover"), sortOrder: 2 },
  }],
  departures: [{
    slug: "altai-2027-06-01", tourSlug: "altai", startsOn: "2027-06-01", endsOn: "2027-06-04", bookingStatus: "OPEN",
    priceKopecks: 3_450_050, capacity: 18, isDemo: false, content: { price: 1 }, organizers: ["artur"],
    contract: {
      tour: { destination: "Алтай", route: "Кемерово — Ая", program: [{ title: "День 1", items: ["Сростки", "Катунь"] }],
        included: ["Проезд", "Проживание"], excluded: [], insurance: null, risks: "Горная местность" },
      departure: { departureTime: "00:30", returnTime: "23:00", departurePoint: "Кемерово", returnPoint: "Кемерово",
        accommodation: { name: "Дом", address: "Ая", category: null, registryNumber: null, roomType: "2-местный", nights: 3,
          meals: "Завтраки", legalEntity: "ИП" },
        carrier: { legalName: "ООО Перевозчик", route: "Кемерово — Ая", vehicle: null, baggage: "20 кг", boarding: "Вокзал" },
        services: [] },
    },
  }, {
    slug: "altai-2027-07-01", tourSlug: "altai", startsOn: "2027-07-01", endsOn: "2027-07-04", bookingStatus: "CLOSED",
    priceKopecks: null, capacity: null, isDemo: true, content: {}, organizers: [], contract: null,
  }],
  organizers: [{ slug: "artur", name: "Артур", isDemo: false, content: { phone: "+79039075547", photo: image("artur") } }],
  reports: [{ slug: "june", title: "Июнь", tourSlug: "altai", departureSlug: "altai-2027-06-01", date: null, noindex: true,
    content: { coverImage: image("june"), tour: "other" } }],
  reviews: [{ slug: "oleg", authorName: "Олег", tourSlug: null, isDemo: false, content: { image: image("oleg") } }],
});

test("the projection normalizes into the DTOs the pages already render", () => {
  const c = normalizeCatalog(projectionToRaw(catalog()));
  assert.deepEqual(c.tours.map((t) => [t.id, t.slug, t.isListed, t.shortDescription, t.sortOrder]),
    [["altai", "altai", true, "Четыре дня", 2]]);
  const [open, closed] = c.departures;
  assert.equal(open!.tourId, "altai");
  assert.equal(open!.price, 34_500.5);
  assert.equal(open!.capacity, 18);
  assert.deepEqual(open!.organizerIds, ["artur"]);
  assert.equal(open!.contract?.product?.program?.[0]?.items, "Сростки\nКатунь");
  assert.equal(open!.contract?.product?.included, "Проезд\nПроживание");
  assert.equal(open!.contract?.departureTime, "00:30");
  assert.equal(closed!.price, undefined);
  assert.equal(closed!.contract, undefined);
  assert.equal(closed!.isDemo, true);
  assert.equal(c.organizers[0]!.phone, "+79039075547");
  assert.equal(c.reports[0]!.tourId, "altai");
  assert.equal(c.reports[0]!.date, "2027-06-01", "a report with a departure takes its date");
  assert.equal(c.reports[0]!.noindex, true);
  assert.equal(c.reviews[0]!.isListed, true);
});

test("a document missing what a page needs fails the render, naming it", () => {
  const broken = catalog();
  broken.tours[0]!.content = {};
  assert.throws(() => normalizeCatalog(projectionToRaw(broken)), /tour "altai" shortDescription/);
});

test("only the catalog schema this site understands is accepted", () => {
  assert.equal(parsePublicCatalog(catalog()).tours.length, 1);
  assert.throws(() => parsePublicCatalog({ ...catalog(), schema: "mikluha.public-catalog/2" }), /PUBLIC_CATALOG_INVALID/);
  assert.throws(() => parsePublicCatalog({ ...catalog(), reviews: undefined }), /PUBLIC_CATALOG_INVALID/);
  assert.throws(() => parsePublicCatalog(null), /PUBLIC_CATALOG_INVALID/);
});

test("withdrawn media placeholders keep required covers and galleries renderable in direct SSR", () => {
  const data = catalog();
  const unavailable = { image: "/media/image-unavailable.svg", alt: "Фотография недоступна" };
  data.tours[0]!.content.coverImage = unavailable;
  data.tours[0]!.content.gallery = [unavailable];
  const normalized = normalizeCatalog(projectionToRaw(data));
  assert.equal(normalized.tours[0]!.coverImage.src, unavailable.image);
  assert.equal(normalized.tours[0]!.gallery[0]!.src, unavailable.image);
});
