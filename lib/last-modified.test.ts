import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContentSnapshot, DepartureDTO, ReportDTO, TourDTO } from "./cms/types";
import { getDocumentLastModified, getHomeLastModified, getTourLastModified } from "./last-modified";

function tour(overrides: Partial<TourDTO> = {}): TourDTO {
  return {
    id: "altai",
    slug: "altai",
    title: "Алтай",
    shortDescription: "s",
    coverImage: { src: "/c.webp", alt: "" },
    gallery: [],
    isListed: true,
    sortOrder: 0,
    ...overrides,
  };
}

function departure(overrides: Partial<DepartureDTO>): DepartureDTO {
  return {
    id: "d",
    tourId: "altai",
    startDate: "2026-10-10",
    endDate: "2026-10-13",
    bookingStatus: "OPEN",
    organizerIds: [],
    isListed: true,
    isDemo: false,
    ...overrides,
  };
}

function report(overrides: Partial<ReportDTO> = {}): ReportDTO {
  return {
    id: "r",
    slug: "r",
    title: "r",
    tourId: "altai",
    coverImage: { src: "/r.webp", alt: "" },
    gallery: [],
    sortOrder: 0,
    noindex: false,
    ...overrides,
  };
}

function content(overrides: Partial<ContentSnapshot>): ContentSnapshot {
  return {
    generatedAt: "2026-09-28T10:00:00.000Z",
    source: "git",
    siteSettings: {} as ContentSnapshot["siteSettings"],
    tours: [],
    departures: [],
    reports: [],
    reviews: [],
    organizers: [],
    legalPages: [],
    ...overrides,
  };
}

const TODAY = "2026-09-28";

test("with no dated edits and no departed trips there is no lastmod — never the build time", () => {
  const snapshot = content({ tours: [tour()], departures: [departure({ startDate: "2026-10-10" })] });

  assert.equal(getTourLastModified(snapshot, tour(), TODAY), undefined);
  assert.equal(getHomeLastModified(snapshot, TODAY), undefined);
});

test("the day after a departure starts counts as a change: the page now shows a different nearest date", () => {
  const snapshot = content({
    departures: [
      departure({ id: "a", startDate: "2026-09-12" }),
      departure({ id: "b", startDate: "2026-09-25", bookingStatus: "CLOSED" }),
      departure({ id: "c", startDate: "2026-09-27", bookingStatus: "CANCELLED" }),
    ],
  });

  // "b" left the page on the 26th; the cancelled "c" was never on it.
  assert.equal(getTourLastModified(snapshot, tour(), TODAY), "2026-09-26");
});

test("the newest of tour, departure and report edits wins; edits after a trip started do not count", () => {
  const snapshot = content({
    departures: [
      departure({ id: "upcoming", startDate: "2026-10-10", updatedAt: "2026-09-20" }),
      departure({ id: "past", startDate: "2026-07-01", updatedAt: "2026-09-27" }),
    ],
    reports: [report({ updatedAt: "2026-09-21" })],
  });

  assert.equal(getTourLastModified(snapshot, tour({ updatedAt: "2026-09-01" }), TODAY), "2026-09-21");
});

test("hidden departures and dates in the future are ignored", () => {
  const snapshot = content({
    departures: [
      departure({ id: "hidden", startDate: "2026-09-01", isListed: false }),
      departure({ id: "typo", startDate: "2026-12-01", updatedAt: "2027-01-01" }),
    ],
  });

  assert.equal(getTourLastModified(snapshot, tour(), TODAY), undefined);
  assert.equal(getDocumentLastModified({ updatedAt: "2027-01-01" }, TODAY), undefined);
  assert.equal(getDocumentLastModified({ updatedAt: "2026-08-01" }, TODAY), "2026-08-01");
});

test("the home page takes the newest change of any listed tour or report", () => {
  const snapshot = content({
    tours: [tour(), tour({ id: "hidden", slug: "hidden", isListed: false, updatedAt: "2026-09-27" })],
    departures: [departure({ startDate: "2026-09-12" })],
    reports: [report({ tourId: "other", updatedAt: "2026-09-15" })],
  });

  assert.equal(getHomeLastModified(snapshot, TODAY), "2026-09-15");
});
