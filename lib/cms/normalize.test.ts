import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeContentSet } from "./normalize";
import type { RawContentSet, RawImageRef, RawReport, RawSiteSettings, RawTour } from "./types";

/**
 * These lock in the decisions normalize.ts has to make now that the Raw types
 * are generated from the real schema: Sanity's `validation` rules are Studio
 * affordances, so almost every field arrives optional and something has to say
 * what an absent one means.
 */

const systemFields = { _createdAt: "2026-01-01T00:00:00Z", _updatedAt: "2026-01-01T00:00:00Z", _rev: "rev" };

function imageRef(alt = "alt"): RawImageRef & { alt: string; _type: "image" } {
  return { _type: "image", asset: { _ref: "local:x.jpg", _type: "reference" }, alt };
}

function tour(overrides: Partial<RawTour> = {}): RawTour {
  return {
    ...systemFields,
    _id: "tour-1",
    _type: "tour",
    title: "Алтай",
    slug: { _type: "slug", current: "altai" },
    shortDescription: "коротко",
    coverImage: imageRef("обложка"),
    isListed: true,
    ...overrides,
  } as RawTour;
}

function report(overrides: Partial<RawReport> = {}): RawReport {
  return {
    ...systemFields,
    _id: "report-1",
    _type: "report",
    title: "Отчёт",
    slug: { _type: "slug", current: "altai-2026" },
    tour: { _ref: "tour-1", _type: "reference" },
    coverImage: imageRef("обложка отчёта"),
    ...overrides,
  } as RawReport;
}

function siteSettings(overrides: Partial<RawSiteSettings> = {}): RawSiteSettings {
  return {
    ...systemFields,
    _id: "siteSettings",
    _type: "siteSettings",
    siteName: "Тест",
    siteUrl: "https://example.com",
    timezone: "Europe/Moscow",
    hero: { title: "Заголовок", image: imageRef("hero") },
    company: { legalName: "ООО Миклуха Маклай", inn: "4205435867", ogrn: "1264200007631", phone: "+79039075547" },
    seo: { title: "t", description: "d" },
    ...overrides,
  } as RawSiteSettings;
}

function contentSet(overrides: Partial<RawContentSet> = {}): RawContentSet {
  return {
    siteSettings: siteSettings(),
    tours: [],
    departures: [],
    reports: [],
    reviews: [],
    organizers: [],
    legalPages: [],
    ...overrides,
  };
}

test("a required image with no uploaded asset fails the build, naming the document", () => {
  const broken = tour({ coverImage: { _type: "image", alt: "нет файла" } as RawTour["coverImage"] });

  assert.throws(
    () => normalizeContentSet(contentSet({ tours: [broken] }), "fixtures"),
    /tour "altai" coverImage/,
  );
});

test("an optional image with no uploaded asset degrades to undefined instead of throwing", () => {
  const content = normalizeContentSet(
    contentSet({
      siteSettings: siteSettings({ logo: { _type: "image" } as RawSiteSettings["logo"] }),
    }),
    "fixtures",
  );

  assert.equal(content.siteSettings.logo, undefined);
});

test("a report published without a gallery normalizes to an empty list", () => {
  // `gallery` carries min(1) but not required() in the schema, so Sanity will
  // happily store a report without one — this used to crash normalization.
  const content = normalizeContentSet(contentSet({ reports: [report({ gallery: undefined })] }), "fixtures");

  assert.deepEqual(content.reports[0].gallery, []);
});

test("absent isListed/isDemo flags resolve conservatively", () => {
  const content = normalizeContentSet(
    contentSet({ tours: [tour({ isListed: undefined })], siteSettings: siteSettings({ launchReady: undefined }) }),
    "fixtures",
  );

  // Only an explicit `true` publishes a document or clears the launch gate —
  // an absent flag must never do either implicitly. See DECISIONS.md #8.
  assert.equal(content.tours[0].isListed, false);
  assert.equal(content.siteSettings.launchReady, false);
});

test("a siteSettings document missing a whole required object fails the build by name", () => {
  assert.throws(
    () => normalizeContentSet(contentSet({ siteSettings: siteSettings({ hero: undefined }) }), "fixtures"),
    /siteSettings\.hero/,
  );
});

test("an absent siteSettings.booking object means 'no defaults', not a crash", () => {
  const content = normalizeContentSet(
    contentSet({ siteSettings: siteSettings({ booking: undefined }) }),
    "fixtures",
  );

  assert.equal(content.siteSettings.booking.defaultQr, undefined);
  assert.equal(content.siteSettings.booking.defaultPrepaymentAmount, undefined);
  assert.equal(content.siteSettings.booking.isDemo, false);
});
