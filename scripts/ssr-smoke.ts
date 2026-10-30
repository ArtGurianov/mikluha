#!/usr/bin/env tsx
/**
 * Smoke test of a running SSR site (TOUR-60, ADR v2.3 §9 item 8) and of the
 * media delivery switch (TOUR-56). Run against a candidate container, never
 * against production:
 *
 *   SMOKE_BASE_URL=http://127.0.0.1:3000   the SSR site
 *   EXPECT_COMMIT=<40 hex>                 what /identity must report
 *   EXPECT_MEDIA=direct|cdn                the delivery mode the site must render
 *   MEDIA_ORIGIN_BASE, MEDIA_CDN_BASE      the bases lib/cms/media-delivery.ts uses
 *   FIXTURE_URL=http://127.0.0.1:4010      optional: scripts/projection-fixture.ts,
 *                                          to prove render-on-request and the outage state
 */
const BASE = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const FIXTURE = process.env.FIXTURE_URL?.replace(/\/$/, "");
const EXPECT_COMMIT = process.env.EXPECT_COMMIT ?? "";
const EXPECT_MEDIA = process.env.EXPECT_MEDIA ?? "direct";
const ORIGIN_BASE = process.env.MEDIA_ORIGIN_BASE ?? "";
const CDN_BASE = process.env.MEDIA_CDN_BASE ?? "";

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`[ssr-smoke] ${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

async function page(path: string) {
  const res = await fetch(`${BASE}${path}`, { redirect: "follow" });
  return { res, html: await res.text() };
}

function uncachedNoCookie(res: Response, path: string) {
  check(/\bno-store\b/.test(res.headers.get("cache-control") ?? ""), `${path} Cache-Control has no-store`);
  check(res.headers.get("set-cookie") === null, `${path} sets no cookie`);
}

/** Absolute media URLs the HTML points browsers at (img src, video poster/src). */
const mediaUrls = (html: string) =>
  [...html.matchAll(/\s(?:src|poster)="(https:\/\/[^"]+)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));

async function fixture(path: string, body?: unknown) {
  const res = await fetch(`${FIXTURE}${path}`, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`fixture ${path}: ${res.status}`);
}

async function main() {
  const home = await page("/");
  check(home.res.status === 200, "GET / is 200");
  uncachedNoCookie(home.res, "/");

  const tourSlug = /href="\/tours\/([a-z0-9-]+)\/"/.exec(home.html)?.[1];
  check(tourSlug !== undefined, "home page links a tour");
  if (tourSlug) {
    const tour = await page(`/tours/${tourSlug}/`);
    check(tour.res.status === 200, `GET /tours/${tourSlug}/ is 200`);
    uncachedNoCookie(tour.res, `/tours/${tourSlug}/`);
  }

  for (const path of ["/admin/", "/admin/config.yml", "/admin/sveltia-cms.js"]) {
    check((await page(path)).res.status === 404, `${path} is retired`);
  }
  const legal = await page("/oferta/");
  check(legal.res.status === 200, "GET /oferta/ is 200");

  const sitemap = await page("/sitemap.xml");
  check(sitemap.res.status === 200 && (tourSlug === undefined || sitemap.html.includes(`/tours/${tourSlug}/`)),
    "GET /sitemap.xml lists the published tour");

  const identity = await fetch(`${BASE}/identity`, { redirect: "follow" });
  const id = identity.ok ? await identity.json() as { service?: string; sourceCommit?: string } : {};
  check(id.service === "mikluha-site" && id.sourceCommit === EXPECT_COMMIT,
    `/identity reports mikluha-site ${EXPECT_COMMIT} (got ${id.service} ${id.sourceCommit})`);

  const media = mediaUrls(home.html);
  const viaCdn = CDN_BASE ? media.filter((u) => u.startsWith(CDN_BASE)) : [];
  const viaOrigin = ORIGIN_BASE ? media.filter((u) => u.startsWith(ORIGIN_BASE)) : [];
  if (EXPECT_MEDIA === "cdn") {
    check(viaCdn.length > 0 && viaOrigin.length === 0, `media via CDN only (${viaCdn.length} CDN, ${viaOrigin.length} origin)`);
  } else {
    check(viaOrigin.length > 0 && viaCdn.length === 0, `media direct only (${viaOrigin.length} origin, ${viaCdn.length} CDN)`);
  }

  if (FIXTURE && tourSlug) {
    const catalog = await (await fetch(`${FIXTURE}/public/v1/catalog`)).json() as {
      tours: { slug: string; title: string }[];
      departures: { slug: string; tourSlug: string; priceKopecks: number | null }[];
    };
    const marker = `Проверка SSR ${Date.now()}`;
    await fixture("/__fixture/catalog", {
      ...catalog,
      tours: catalog.tours.map((t) => t.slug === tourSlug ? { ...t, title: marker } : t),
      // One future, closed departure of that tour with kopecks in its price: the page shows it next.
      departures: [...catalog.departures, { ...catalog.departures.find((d) => d.tourSlug === tourSlug)!,
        slug: "ssr-smoke-kopecks", startsOn: "2099-06-01", endsOn: "2099-06-04", bookingStatus: "CLOSED",
        priceKopecks: 3_450_050 }],
    });
    try {
      const changed = await page(`/tours/${tourSlug}/`);
      check(changed.html.includes(marker), "a projection change shows on the next request");
      check(/34\s500,50\s₽/u.test(changed.html), "a price with kopecks is shown as Commerce has it (34 500,50 ₽)");
    } finally {
      await fixture("/__fixture/catalog", catalog);
    }

    await fixture("/__fixture/down");
    try {
      const outage = await page("/");
      check(outage.res.status === 200 && outage.html.includes("Расписание временно недоступно"), `Commerce outage: GET / is an error (${outage.res.status})`);
      // Read the raw response: no hydration is needed for the outage message.
      check(!outage.html.includes("₽") && !outage.html.includes('href="/tours/') && !outage.html.includes("/book"),
        "Commerce outage: no prices, tours or booking links");
      uncachedNoCookie(outage.res, "outage");
      check(outage.html.includes('name="robots" content="noindex, nofollow"'), "outage is noindex");
      for (const path of [`/tours/${tourSlug}/`, "/reports/altai-june-2026/"]) {
        const result = await page(path);
        check(result.html.includes("Расписание временно недоступно") && !result.html.includes("₽"), `${path} outage visible without JS, no prices`);
      }
      check((await page("/oferta/")).res.status === 200, "Commerce outage: GET /oferta/ is still 200");
    } finally {
      await fixture("/__fixture/up");
    }
    check((await page("/")).res.status === 200, "Commerce back: GET / is 200 again");
  }

  if (failures.length > 0) {
    console.error(`[ssr-smoke] ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("[ssr-smoke] OK");
}

main().catch((error) => {
  console.error("[ssr-smoke] failed:", error);
  process.exit(1);
});
