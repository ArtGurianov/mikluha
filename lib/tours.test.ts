import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContentSnapshot, DepartureDTO, ImageAsset, OrganizerDTO } from "./cms/types";
import {
  formatDepartureDateRange,
  formatDurationLabel,
  getNextBookableDeparture,
  getNextDeparture,
  resolveBookingDetails,
} from "./tours";

function image(alt: string): ImageAsset {
  return { alt, src: "/media/demo/test.webp" };
}

function organizer(id: string, overrides: Partial<OrganizerDTO> = {}): OrganizerDTO {
  return { id, name: "Организатор", phone: "+79039075547", isListed: true, isDemo: false, ...overrides };
}

function departure(overrides: Partial<DepartureDTO>): DepartureDTO {
  return {
    id: "dep",
    tourId: "tour-1",
    startDate: "2026-09-01",
    endDate: "2026-09-05",
    bookingStatus: "OPEN",
    organizerIds: [],
    isListed: true,
    isDemo: false,
    ...overrides,
  };
}

function baseContent(overrides: Partial<ContentSnapshot> = {}): ContentSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    source: "git",
    siteSettings: {
      siteName: "Тест",
      siteUrl: "https://example.com",
      timezone: "UTC",
      hero: { title: "t", image: image("hero") },
      booking: { isDemo: false },
      socials: {},
      company: { legalName: "ООО Миклуха Маклай", inn: "4205435867", ogrn: "1264200007631", phone: "+79039075547", isDemo: false },
      seo: { title: "t", description: "d" },
      launchReady: false,
    },
    tours: [],
    departures: [],
    reports: [],
    reviews: [],
    organizers: [],
    legalPages: [],
    ...overrides,
  };
}

test("getNextDeparture excludes CANCELLED but keeps CLOSED", () => {
  const content = baseContent({
    departures: [
      departure({ id: "cancelled-soon", startDate: "2026-08-20", bookingStatus: "CANCELLED" }),
      departure({ id: "closed-next", startDate: "2026-08-28", bookingStatus: "CLOSED" }),
      departure({ id: "open-later", startDate: "2026-09-12", bookingStatus: "OPEN" }),
    ],
  });

  const result = getNextDeparture(content, "tour-1", "2026-08-14");
  assert.equal(result?.id, "closed-next", "CANCELLED must never be the nearest departure, even if it's soonest");
});

test("getNextBookableDeparture skips CLOSED to find the next OPEN one", () => {
  const content = baseContent({
    departures: [
      departure({ id: "closed-next", startDate: "2026-08-28", bookingStatus: "CLOSED" }),
      departure({ id: "open-later", startDate: "2026-09-12", bookingStatus: "OPEN" }),
    ],
  });

  const result = getNextBookableDeparture(content, "tour-1", "2026-08-14");
  assert.equal(result?.id, "open-later");
});

test("getNextDeparture/getNextBookableDeparture ignore past dates", () => {
  const content = baseContent({
    departures: [departure({ id: "past", startDate: "2026-01-01", endDate: "2026-01-05", bookingStatus: "OPEN" })],
  });

  assert.equal(getNextDeparture(content, "tour-1", "2026-08-14"), undefined);
  assert.equal(getNextBookableDeparture(content, "tour-1", "2026-08-14"), undefined);
});

test("resolveBookingDetails: departure values win over siteSettings defaults", () => {
  const content = baseContent({
    organizers: [organizer("org-departure", { name: "Departure Organizer" }), organizer("org-default", { name: "Default Organizer" })],
  });
  content.siteSettings.booking = {
    defaultPrepaymentAmount: 1000,
    defaultQr: image("default qr"),
    defaultOrganizerId: "org-default",
    isDemo: false,
  };

  const d = departure({
    prepaymentAmount: 5000,
    paymentQr: image("departure qr"),
    organizerIds: ["org-departure"],
  });

  const resolved = resolveBookingDetails(content, d);
  assert.equal(resolved.prepaymentAmount, 5000);
  assert.equal(resolved.qr?.alt, "departure qr");
  assert.equal(resolved.organizer?.id, "org-departure");
});

test("resolveBookingDetails: falls back to siteSettings when departure omits fields", () => {
  const content = baseContent({ organizers: [organizer("org-default", { name: "Default Organizer" })] });
  content.siteSettings.booking = {
    defaultPrepaymentAmount: 1000,
    defaultQr: image("default qr"),
    defaultOrganizerId: "org-default",
    isDemo: false,
  };

  const d = departure({});
  const resolved = resolveBookingDetails(content, d);
  assert.equal(resolved.prepaymentAmount, 1000);
  assert.equal(resolved.qr?.alt, "default qr");
  assert.equal(resolved.organizer?.id, "org-default");
});

test("resolveBookingDetails: no fallback available leaves fields undefined (never invents a payment)", () => {
  const content = baseContent();
  const resolved = resolveBookingDetails(content, departure({}));
  assert.equal(resolved.prepaymentAmount, undefined);
  assert.equal(resolved.qr, undefined);
  assert.equal(resolved.organizer, undefined);
});

test("formatDepartureDateRange: same month collapses to a single day-month-year tail", () => {
  assert.equal(formatDepartureDateRange("2026-09-12", "2026-09-16"), "12–16 сентября 2026 г.");
});

test("formatDepartureDateRange: crosses a month boundary within the same year", () => {
  assert.equal(formatDepartureDateRange("2026-08-30", "2026-09-02"), "30 августа — 2 сентября 2026 г.");
});

test("formatDurationLabel: Russian pluralization edge cases", () => {
  assert.equal(formatDurationLabel("2026-09-01", "2026-09-01"), "1 день / 0 ночей");
  assert.equal(formatDurationLabel("2026-09-01", "2026-09-02"), "2 дня / 1 ночь");
  assert.equal(formatDurationLabel("2026-09-01", "2026-09-04"), "4 дня / 3 ночи");
  assert.equal(formatDurationLabel("2026-09-01", "2026-09-05"), "5 дней / 4 ночи");
  // 11 is the classic Russian pluralization trap: mod10 === 1 but mod100 === 11, so it's "дней", not "день".
  assert.equal(formatDurationLabel("2026-09-01", "2026-09-11"), "11 дней / 10 ночей");
});
