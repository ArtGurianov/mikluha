#!/usr/bin/env tsx
/**
 * Candidate HTTP healthcheck — run against a running candidate
 * container/server BEFORE it is allowed to become production. Uses the anonymous
 * Commerce projection, never the retired static snapshot.
 *
 * Usage: HEALTHCHECK_BASE_URL=http://localhost:8080 pnpm run healthcheck
 */
import { fetchPublicCatalog } from "../lib/cms/projection";
const BASE_URL = (process.env.HEALTHCHECK_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

const errors: string[] = [];

async function check(urlPath: string, expectedStatus: number, label: string) {
  const url = `${BASE_URL}${urlPath}`;
  try {
    const res = await fetch(url, { redirect: "manual" });
    if (res.status !== expectedStatus) {
      errors.push(`${label}: GET ${url} → ${res.status}, expected ${expectedStatus}`);
    } else {
      console.log(`[healthcheck] OK  ${label} (${res.status})`);
    }
    return res;
  } catch (error) {
    errors.push(`${label}: GET ${url} failed — ${(error as Error).message}`);
    return null;
  }
}

async function main() {
  const content = await fetchPublicCatalog();

  await check("/", 200, "GET /");
  await check("/robots.txt", 200, "GET /robots.txt");
  await check("/sitemap.xml", 200, "GET /sitemap.xml");

  const firstTour = content.tours[0];
  if (firstTour) {
    await check(`/tours/${firstTour.slug}/`, 200, `GET /tours/${firstTour.slug}/`);
  } else {
    errors.push("No listed tour found in content snapshot to healthcheck — cannot verify /tours/<slug>/");
  }

  const firstReport = content.reports[0];
  if (firstReport) {
    await check(`/reports/${firstReport.slug}/`, 200, `GET /reports/${firstReport.slug}/`);
  }

  const notFoundRes = await check("/this-route-does-not-exist-healthcheck/", 404, "GET unknown route");
  if (notFoundRes) {
    const body = await notFoundRes.text();
    if (!body.includes("Страница не найдена")) {
      errors.push("Unknown route returned 404 but body doesn't look like the branded 404 page");
    }
  }

  if (errors.length > 0) {
    console.error(`[healthcheck] FAILED with ${errors.length} error(s):`);
    for (const error of errors) console.error(` - ${error}`);
    process.exit(1);
  }

  console.log("[healthcheck] OK — candidate passed all HTTP checks");
}

main().catch((error) => {
  console.error("[healthcheck] failed:", error);
  process.exit(1);
});
