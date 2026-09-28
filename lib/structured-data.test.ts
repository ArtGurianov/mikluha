import assert from "node:assert/strict";
import { test } from "node:test";

import type { DepartureDTO, ReportDTO, SiteSettingsDTO, TourDTO } from "./cms/types";
import {
  buildBreadcrumbJsonLd,
  buildOrganizationJsonLd,
  buildTouristTripJsonLd,
  getReportBreadcrumbs,
  getTourBreadcrumbs,
} from "./structured-data";

const BASE = "https://example.ru";

function tour(overrides: Partial<TourDTO> = {}): TourDTO {
  return {
    id: "altai",
    slug: "altai",
    title: "Алтай",
    shortDescription: "Четыре дня на Алтае",
    coverImage: { src: "/media/demo/altai-cover.webp", alt: "Алтай" },
    gallery: [],
    isListed: true,
    sortOrder: 0,
    ...overrides,
  };
}

function departure(overrides: Partial<DepartureDTO> = {}): DepartureDTO {
  return {
    id: "altai-2026-10-10",
    tourId: "altai",
    startDate: "2026-10-10",
    endDate: "2026-10-13",
    bookingStatus: "OPEN",
    price: 34000,
    organizerIds: [],
    isListed: true,
    isDemo: false,
    ...overrides,
  };
}

function report(overrides: Partial<ReportDTO> = {}): ReportDTO {
  return {
    id: "altai-june-2026",
    slug: "altai-june-2026",
    title: "Алтай — июнь 2026",
    tourId: "altai",
    coverImage: { src: "/media/demo/report.webp", alt: "Отчёт" },
    gallery: [],
    sortOrder: 0,
    noindex: false,
    ...overrides,
  };
}

function settings(overrides: Partial<SiteSettingsDTO["company"]> = {}): SiteSettingsDTO {
  return {
    siteName: "Миклуха Маклай",
    siteUrl: BASE,
    timezone: "Asia/Krasnoyarsk",
    logo: { src: "/media/demo/brand-logo.webp", alt: "Логотип" },
    hero: { title: "t", image: { src: "/h.webp", alt: "" }, video: { src: "/h.webm" } },
    booking: { isDemo: false },
    socials: { maxChannelUrl: "https://max.ru/join/abc" },
    company: {
      legalName: "ООО Миклуха Маклай",
      inn: "4205435867",
      ogrn: "1264200007631",
      phone: "+79039075547",
      email: "artur@example.ru",
      city: "Кемерово",
      isDemo: false,
      ...overrides,
    },
    seo: { title: "t", description: "d" },
    launchReady: true,
  };
}

test("the organization node carries factual entity data and absolute URLs", () => {
  const org = buildOrganizationJsonLd(settings(), BASE);

  assert.equal(org["@type"], "TravelAgency");
  assert.equal(org["@id"], "https://example.ru/#organization");
  assert.equal(org.url, "https://example.ru/");
  assert.equal(org.logo, "https://example.ru/media/demo/brand-logo.webp");
  assert.equal(org.legalName, "ООО Миклуха Маклай");
  assert.equal(org.taxID, "4205435867");
  assert.deepEqual(org.identifier, { "@type": "PropertyValue", propertyID: "ОГРН", value: "1264200007631" });
  assert.deepEqual(org.sameAs, ["https://max.ru/join/abc"]);
  assert.deepEqual(org.address, { "@type": "PostalAddress", addressLocality: "Кемерово", addressCountry: "RU" });
});

test("no city means no address at all — never a guessed one", () => {
  const org = buildOrganizationJsonLd(settings({ city: undefined }), BASE);

  assert.equal("address" in org, false);
});

test("a tour is a TouristTrip, never an Event, linked to the organization", () => {
  const trip = buildTouristTripJsonLd(tour({ heading: "Автобусный тур на Алтай" }), [departure()], BASE);

  assert.equal(trip["@type"], "TouristTrip");
  assert.equal(trip.name, "Автобусный тур на Алтай");
  assert.equal(trip.url, "https://example.ru/tours/altai/");
  assert.deepEqual(trip.image, ["https://example.ru/media/demo/altai-cover.webp"]);
  assert.deepEqual(trip.provider, { "@id": "https://example.ru/#organization" });
  assert.doesNotMatch(JSON.stringify(trip), /"Event"/);

  const [subTrip] = trip.subTrip ?? [];
  assert.equal(subTrip.departureTime, "2026-10-10");
  assert.equal(subTrip.arrivalTime, "2026-10-13");
  assert.deepEqual(subTrip.offers, {
    "@type": "Offer",
    price: 34000,
    priceCurrency: "RUB",
    availability: "https://schema.org/InStock",
    url: "https://example.ru/tours/altai/",
  });
});

test("a closed departure is SoldOut, and a departure without a price has no Offer", () => {
  const closed = buildTouristTripJsonLd(tour(), [departure({ bookingStatus: "CLOSED" })], BASE);
  assert.equal(closed.subTrip?.[0].offers?.availability, "https://schema.org/SoldOut");

  const unpriced = buildTouristTripJsonLd(tour(), [departure({ price: undefined })], BASE);
  assert.equal(unpriced.subTrip?.[0].offers, undefined);

  const undated = buildTouristTripJsonLd(tour(), [], BASE);
  assert.equal("subTrip" in undated, false);
});

test("breadcrumbs: tour and report trails, with absolute item URLs in JSON-LD", () => {
  assert.deepEqual(getTourBreadcrumbs(tour()), [
    { name: "Главная", path: "/" },
    { name: "Алтай", path: "/tours/altai/" },
  ]);

  const trail = getReportBreadcrumbs(report(), tour());
  assert.deepEqual(
    trail.map((crumb) => crumb.path),
    ["/", "/tours/altai/", "/reports/altai-june-2026/"],
  );

  const jsonLd = buildBreadcrumbJsonLd(trail, BASE);
  assert.equal(jsonLd["@type"], "BreadcrumbList");
  assert.deepEqual(
    jsonLd.itemListElement.map((item) => [item.position, item.item]),
    [
      [1, "https://example.ru/"],
      [2, "https://example.ru/tours/altai/"],
      [3, "https://example.ru/reports/altai-june-2026/"],
    ],
  );
});

test("a report of a hidden tour skips the tour crumb instead of linking to a page that does not exist", () => {
  const trail = getReportBreadcrumbs(report(), tour({ isListed: false }));

  assert.deepEqual(
    trail.map((crumb) => crumb.path),
    ["/", "/reports/altai-june-2026/"],
  );
});
