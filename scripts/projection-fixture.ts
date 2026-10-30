#!/usr/bin/env tsx
/**
 * A stand-in for Commerce's GET /public/v1/catalog (commerce/src/public-api.ts)
 * built from the committed content/ YAML, for running and smoke-testing the
 * SSR site without a database (TOUR-60). Never a production data source: it
 * offers no contract, so nothing it serves could be sold.
 *
 *   PORT=4010 pnpm exec tsx scripts/projection-fixture.ts
 *
 * Test controls (local only): PUT /__fixture/catalog replaces the document,
 * PUT /__fixture/down makes the catalog answer 503, PUT /__fixture/up undoes it.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";

import { loadContentYaml } from "../lib/cms/content-yaml";
import { PUBLIC_CATALOG_SCHEMA, type PublicCatalog } from "../lib/cms/projection";
import type { RawDeparture, RawOrganizer, RawReport, RawReview, RawTour } from "../lib/cms/types";

const CONTENT_DIR = path.resolve(process.cwd(), "test-fixtures/catalog");

async function collection<T>(folder: string): Promise<(T & { _slug: string })[]> {
  const dir = path.join(CONTENT_DIR, folder);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yml")).sort();
  return Promise.all(files.map(async (file) => ({
    ...(loadContentYaml(await readFile(path.join(dir, file), "utf-8")) as T),
    _slug: file.replace(/\.yml$/, ""),
  })));
}

/** Drops the fields the projection carries as its own columns, leaving the free-form document. */
function rest(doc: object, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "_slug" && !keys.includes(k)));
}

async function fixtureCatalog(): Promise<PublicCatalog> {
  const tours = (await collection<RawTour>("tours")).filter((t) => t.isListed === true);
  const listedTours = new Set(tours.map((t) => t._slug));
  const departures = (await collection<RawDeparture>("departures"))
    .filter((d) => d.isListed === true && d.tour !== null && listedTours.has(d.tour));
  const organizers = (await collection<RawOrganizer>("organizers")).filter((o) => o.isListed === true);
  const reports = (await collection<RawReport>("reports")).filter((r) => r.tour !== null && listedTours.has(r.tour));
  const reviews = (await collection<RawReview>("reviews"))
    .filter((r) => r.isListed === true && (!r.tour || listedTours.has(r.tour)));
  return {
    schema: PUBLIC_CATALOG_SCHEMA,
    legalPages: ["oferta", "privacy-policy", "soglasie-pd"].map((slug) => {
      const body = `Проверочная редакция Commerce: ${slug}. Только синтетические данные.`;
      return { slug, title: `Документ ${slug}`, body, publishedVersion: 1, effectiveOn: "2026-01-01",
        documentSha256: `sha256:${"a".repeat(64)}`,
        textSha256: `sha256:${createHash("sha256").update(body).digest("hex")}` };
    }),
    tours: tours.map((t) => ({ slug: t._slug, title: t.title ?? "", content: rest(t, "slug", "title", "isListed", "contract") })),
    departures: departures.map((d) => ({
      slug: d._slug, tourSlug: d.tour!, startsOn: d.startDate ?? "", endsOn: d.endDate ?? "",
      bookingStatus: d.bookingStatus ?? "CLOSED", priceKopecks: d.price == null ? null : d.price * 100,
      capacity: d.capacity ?? null, contract: null, isDemo: d.isDemo === true, content: {},
      organizers: d.organizers ?? [],
    })),
    organizers: organizers.map((o) => ({ slug: o._slug, name: o.name ?? "", isDemo: o.isDemo === true,
      content: rest(o, "name", "isListed", "isDemo") })),
    reports: reports.map((r) => ({ slug: r._slug, title: r.title ?? "", tourSlug: r.tour!, departureSlug: r.departure ?? null,
      date: r.date ?? null, noindex: r.noindex === true, content: rest(r, "slug", "title", "tour", "departure", "date", "noindex") })),
    reviews: reviews.map((r) => ({ slug: r._slug, authorName: r.authorName ?? "", tourSlug: r.tour ?? null,
      isDemo: r.isDemo === true, content: rest(r, "authorName", "tour", "isListed", "isDemo") })),
  };
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let catalog = await fixtureCatalog();
  let down = false;
  const port = Number(process.env.PORT ?? 4010);
  createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET" && req.url === "/public/v1/catalog") {
      if (down) json(503, { error: "FIXTURE_DOWN" });
      else json(200, catalog);
      return;
    }
    if (req.method === "PUT" && req.url === "/__fixture/catalog") { catalog = JSON.parse(await body(req)); json(200, { ok: true }); return; }
    if (req.method === "PUT" && req.url === "/__fixture/down") { down = true; json(200, { ok: true }); return; }
    if (req.method === "PUT" && req.url === "/__fixture/up") { down = false; json(200, { ok: true }); return; }
    json(404, { error: "NOT_FOUND" });
  }).listen(port, "0.0.0.0", () => {
    console.log(`[projection-fixture] http://0.0.0.0:${port}/public/v1/catalog — tours:${catalog.tours.length} ` +
      `departures:${catalog.departures.length}`);
  });
}

main().catch((error) => {
  console.error("[projection-fixture] failed:", error);
  process.exit(1);
});
