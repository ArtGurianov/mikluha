import assert from "node:assert/strict";
import { test } from "node:test";

import { auditSite, extractPageSeo, jsonLdTypes, parseSitemapLocs, type SiteAuditInput } from "./seo-audit";

const SITE = "https://example.ru";

function page({
  path,
  title = `Страница ${path}`,
  robots = "index, follow",
  canonical = `${SITE}${path}`,
  h1 = 1,
  jsonLd = path.startsWith("/tours/") ? [{ "@type": "BreadcrumbList" }] : [],
}: {
  path: string;
  title?: string;
  robots?: string;
  canonical?: string;
  h1?: number;
  jsonLd?: unknown[];
}): string {
  return (
    `<html><head><title>${title}</title><meta name="description" content="Описание"/>` +
    `<meta name="robots" content="${robots}"/><link rel="canonical" href="${canonical}"/></head><body>` +
    jsonLd.map((data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`).join("") +
    "<h1>Заголовок</h1>".repeat(h1) +
    "</body></html>"
  );
}

function sitemap(paths: string[]): string {
  return `<urlset>${paths.map((p) => `<url><loc>${SITE}${p}</loc></url>`).join("")}</urlset>`;
}

function input(overrides: Partial<SiteAuditInput> = {}): SiteAuditInput {
  const pages = new Map([
    ["/", page({ path: "/" })],
    ["/tours/altai/", page({ path: "/tours/altai/" })],
  ]);
  return {
    pages,
    notFoundPages: new Map([["/404.html", '<meta name="robots" content="noindex"/>']]),
    robotsTxt: `User-Agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`,
    sitemapXml: sitemap(["/", "/tours/altai/"]),
    siteUrl: SITE,
    canonicalBase: SITE,
    isStaging: false,
    noindexPaths: new Set(),
    ...overrides,
  };
}

test("extractPageSeo reads Next's head tags and decodes entities", () => {
  const seo = extractPageSeo(
    '<title>Туры &amp; поездки</title><meta name="robots" content="noindex, nofollow"/>' +
      '<link rel="canonical" href="https://example.ru/"/><h1 class="x">А</h1>',
  );

  assert.deepEqual(seo.titles, ["Туры & поездки"]);
  assert.deepEqual(seo.robots, ["noindex, nofollow"]);
  assert.deepEqual(seo.canonicals, ["https://example.ru/"]);
  assert.equal(seo.h1Count, 1);
});

test("jsonLdTypes finds nested types; parseSitemapLocs lists every loc", () => {
  assert.deepEqual(jsonLdTypes([{ "@type": "TouristTrip", provider: { "@type": "TravelAgency" } }]), [
    "TouristTrip",
    "TravelAgency",
  ]);
  assert.deepEqual(parseSitemapLocs(sitemap(["/", "/a/"])), [`${SITE}/`, `${SITE}/a/`]);
});

test("a clean production export passes", () => {
  assert.deepEqual(auditSite(input()), { errors: [], warnings: [] });
});

test("production fails on noindex, a foreign canonical, a missing or extra H1, and a site-wide Disallow", () => {
  const { errors } = auditSite(
    input({
      pages: new Map([
        ["/", page({ path: "/", robots: "noindex, nofollow", canonical: "https://staging.invalid/" })],
        ["/tours/altai/", page({ path: "/tours/altai/", h1: 2 })],
      ]),
      robotsTxt: "User-Agent: *\nDisallow: /\n",
    }),
  );

  assert.ok(errors.some((e) => e.includes("page / is a public production page but carries robots")));
  assert.ok(errors.some((e) => e.includes("self-referencing canonical https://example.ru/")));
  assert.ok(errors.some((e) => e.includes("/tours/altai/ must have exactly one <h1> (found 2)")));
  assert.ok(errors.some((e) => e.includes("blocks the whole site")));
  assert.ok(errors.some((e) => e.includes("must reference https://example.ru/sitemap.xml")));
});

test("sitemap and exported pages must agree, and noindex pages stay out of it", () => {
  const { errors } = auditSite(
    input({
      pages: new Map([
        ["/", page({ path: "/" })],
        ["/tours/altai/", page({ path: "/tours/altai/" })],
        ["/reports/thin/", page({ path: "/reports/thin/", robots: "noindex, follow", jsonLd: [{ "@type": "BreadcrumbList" }] })],
      ]),
      noindexPaths: new Set(["/reports/thin/"]),
      sitemapXml: sitemap(["/", "/reports/thin/", "/gone/"]),
    }),
  );

  assert.ok(errors.some((e) => e.includes("sitemap lists https://example.ru/reports/thin/, which is noindex")));
  assert.ok(errors.some((e) => e.includes("sitemap URL https://example.ru/gone/ has no exported page")));
  assert.ok(errors.some((e) => e.includes("indexable page /tours/altai/ is missing from sitemap.xml")));
});

test("tour/report pages need breadcrumbs, no page may use Event, and JSON-LD must parse", () => {
  const broken = page({ path: "/tours/altai/", jsonLd: [{ "@type": "Event" }] }).replace(
    "</body>",
    '<script type="application/ld+json">{oops</script></body>',
  );
  const { errors } = auditSite(input({ pages: new Map([["/", page({ path: "/" })], ["/tours/altai/", broken]]) }));

  assert.ok(errors.some((e) => e.includes("has no BreadcrumbList")));
  assert.ok(errors.some((e) => e.includes("as an Event")));
  assert.ok(errors.some((e) => e.includes("malformed JSON-LD")));
});

test("duplicate titles among indexable pages fail", () => {
  const { errors } = auditSite(
    input({
      pages: new Map([
        ["/", page({ path: "/", title: "Одно и то же" })],
        ["/tours/altai/", page({ path: "/tours/altai/", title: "Одно и то же" })],
      ]),
    }),
  );

  assert.ok(errors.some((e) => e.includes("duplicates the <title> of /")));
});

test("staging must be noindex everywhere, and warns when it is published on the production domain", () => {
  const staging = input({
    isStaging: true,
    robotsTxt: "User-Agent: *\nDisallow: /\n",
    pages: new Map([
      ["/", page({ path: "/", robots: "noindex, nofollow" })],
      ["/tours/altai/", page({ path: "/tours/altai/" })],
    ]),
  });
  const result = auditSite(staging);

  assert.deepEqual(result.errors, [
    "page /tours/altai/ is a staging page without noindex, nofollow — it could leak into search results",
  ]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /targets the production domain/);

  const elsewhere = auditSite({
    ...staging,
    canonicalBase: "https://staging.invalid",
    pages: new Map(),
    sitemapXml: "<urlset></urlset>",
  });
  assert.deepEqual(elsewhere, { errors: [], warnings: [] });
});
