import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeContentSet } from "./normalize";
import type { RawContentSet, RawImageRef, RawReport, RawSiteSettings, RawTour } from "./types";

/**
 * These lock in the decisions normalize.ts has to make: a content file's
 * `required` widget in public/admin/config.yml is an editor-side affordance,
 * so almost every field can still arrive missing (hand-edited files, an old
 * document predating a content-model change), and something has to say what
 * an absent one means.
 */

function imageRef(alt = "alt"): RawImageRef {
  return { image: "/media/demo/x.webp", alt };
}

function tour(overrides: Partial<RawTour> = {}): RawTour {
  return {
    _slug: "altai",
    slug: "altai",
    title: "Алтай",
    shortDescription: "коротко",
    coverImage: imageRef("обложка"),
    isListed: true,
    ...overrides,
  };
}

function report(overrides: Partial<RawReport> = {}): RawReport {
  return {
    _slug: "altai-2026",
    slug: "altai-2026",
    title: "Отчёт",
    tour: "altai",
    coverImage: imageRef("обложка отчёта"),
    ...overrides,
  };
}

function siteSettings(overrides: Partial<RawSiteSettings> = {}): RawSiteSettings {
  return {
    siteName: "Тест",
    siteUrl: "https://example.com",
    commerceOrigin: "https://book.example.com",
    timezone: "Europe/Moscow",
    hero: { title: "Заголовок", image: imageRef("hero"), video: { file: "https://media.example/cms/hero.webm" } },
    company: { legalName: "ООО Миклуха Маклай", inn: "4205435867", ogrn: "1264200007631", phone: "+79039075547" },
    seo: { title: "t", description: "d" },
    ...overrides,
  };
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
  const broken = tour({ coverImage: { alt: "нет файла" } });

  assert.throws(() => normalizeContentSet(contentSet({ tours: [broken] }), "git"), /tour "altai" coverImage/);
});

test("an optional image with no uploaded asset degrades to undefined instead of throwing", () => {
  const content = normalizeContentSet(contentSet({ siteSettings: siteSettings({ logo: {} }) }), "git");

  assert.equal(content.siteSettings.logo, undefined);
});

test("a required image object saved as null fails with the document field name", () => {
  const broken = tour({ coverImage: null });
  assert.throws(() => normalizeContentSet(contentSet({ tours: [broken] }), "git"), /tour "altai" coverImage/);
});

test("a report published without a gallery normalizes to an empty list", () => {
  // `gallery` is a `min: 1` list in the CMS but not required, so a document
  // can exist without one — this used to crash normalization.
  const content = normalizeContentSet(contentSet({ reports: [report({ gallery: undefined })] }), "git");

  assert.deepEqual(content.reports[0].gallery, []);
});

test("absent isListed/isDemo flags resolve conservatively", () => {
  const content = normalizeContentSet(
    contentSet({ tours: [tour({ isListed: undefined })], siteSettings: siteSettings({ launchReady: undefined }) }),
    "git",
  );

  // Only an explicit `true` publishes a document or clears the launch gate —
  // an absent flag must never do either implicitly. See DECISIONS.md #8.
  assert.equal(content.tours[0].isListed, false);
  assert.equal(content.siteSettings.launchReady, false);
});

test("a siteSettings document missing a whole required object fails the build by name", () => {
  assert.throws(
    () => normalizeContentSet(contentSet({ siteSettings: siteSettings({ hero: undefined }) }), "git"),
    /siteSettings\.hero/,
  );
});

test("a Hero video becomes a direct WebM source", () => {
  const content = normalizeContentSet(contentSet(), "git");

  assert.equal(content.siteSettings.hero.video.src, "https://media.example/cms/hero.webm");
});

test("a required Hero video with no uploaded asset fails the build, naming the field", () => {
  const broken = siteSettings({
    hero: { title: "Заголовок", image: imageRef("hero"), video: {} },
  });

  assert.throws(
    () => normalizeContentSet(contentSet({ siteSettings: broken }), "git"),
    /siteSettings\.hero\.video/,
  );
});

test("a Hero video object saved as null fails the build, naming the field", () => {
  const broken = siteSettings({
    hero: { title: "Заголовок", image: imageRef("hero"), video: null },
  });

  assert.throws(
    () => normalizeContentSet(contentSet({ siteSettings: broken }), "git"),
    /siteSettings\.hero\.video/,
  );
});

test("SEO-only fields are optional: a missing heading/updatedAt/noindex leaves the page indexable with its short title", () => {
  const content = normalizeContentSet(contentSet({ tours: [tour()], reports: [report()] }), "git");

  assert.equal(content.tours[0].heading, undefined);
  assert.equal(content.tours[0].updatedAt, undefined);
  // Unlike isListed (fail-closed), noindex is opt-in: only an explicit `true`
  // takes a report out of search, so an old document stays indexable.
  assert.equal(content.reports[0].noindex, false);
  assert.equal(content.reports[0].updatedAt, undefined);
});

test("a report's noindex flag and a tour's heading/updatedAt survive normalization", () => {
  const content = normalizeContentSet(
    contentSet({
      tours: [tour({ heading: "Автобусный тур на Алтай из Кемерово", updatedAt: "2026-09-28" })],
      reports: [report({ noindex: true, updatedAt: "2026-07-05" })],
    }),
    "git",
  );

  assert.equal(content.tours[0].heading, "Автобусный тур на Алтай из Кемерово");
  assert.equal(content.tours[0].updatedAt, "2026-09-28");
  assert.equal(content.reports[0].noindex, true);
  assert.equal(content.reports[0].updatedAt, "2026-07-05");
});
