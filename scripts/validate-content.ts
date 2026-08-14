#!/usr/bin/env tsx
/**
 * Step 3 of the production build pipeline (PRD sections 29, 49.1, 34.3).
 *
 * Validates the materialized content snapshot BEFORE `next build` runs:
 *  - referential integrity (every reference points at a real, listed document)
 *  - the launchReady + isDemo production-readiness gate
 *  - that every OPEN departure has a complete booking flow after fallback
 *
 * Exits non-zero (failing the build) on any violation.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveBookingDetails } from "../lib/tours";
import type { ContentSnapshot } from "../lib/cms/types";

const CACHE_FILE = path.resolve(process.cwd(), ".cms-cache", "content.json");
const PHONE_RE = /^\+7\d{10}$/;

const errors: string[] = [];
const warnings: string[] = [];

function fail(message: string) {
  errors.push(message);
}

function warn(message: string) {
  warnings.push(message);
}

async function main() {
  const raw = await readFile(CACHE_FILE, "utf-8");
  const content = JSON.parse(raw) as ContentSnapshot;

  const tourIds = new Set(content.tours.map((t) => t.id));
  const organizerIds = new Set(content.organizers.map((o) => o.id));

  // --- referential integrity ---------------------------------------------
  for (const d of content.departures) {
    if (!tourIds.has(d.tourId)) fail(`Departure ${d.id} references unknown tour ${d.tourId}`);
    for (const orgId of d.organizerIds) {
      if (!organizerIds.has(orgId)) fail(`Departure ${d.id} references unknown organizer ${orgId}`);
    }
  }
  for (const r of content.reports) {
    if (!tourIds.has(r.tourId)) fail(`Report ${r.id} references unknown tour ${r.tourId}`);
  }
  for (const rv of content.reviews) {
    if (rv.tourId && !tourIds.has(rv.tourId)) fail(`Review ${rv.id} references unknown tour ${rv.tourId}`);
  }
  const defaultOrganizerId = content.siteSettings.booking.defaultOrganizerId;
  if (defaultOrganizerId && !organizerIds.has(defaultOrganizerId)) {
    fail(`siteSettings.booking.defaultOrganizer references unknown organizer ${defaultOrganizerId}`);
  }

  const slugs = new Set<string>();
  for (const t of content.tours) {
    if (slugs.has(`tour:${t.slug}`)) fail(`Duplicate tour slug: ${t.slug}`);
    slugs.add(`tour:${t.slug}`);
  }
  for (const r of content.reports) {
    if (slugs.has(`report:${r.slug}`)) fail(`Duplicate report slug: ${r.slug}`);
    slugs.add(`report:${r.slug}`);
  }
  for (const p of content.legalPages) {
    if (slugs.has(`legal:${p.slug}`)) fail(`Duplicate legal page slug: ${p.slug}`);
    slugs.add(`legal:${p.slug}`);
  }

  // --- OPEN departures must always resolve to a complete booking flow ----
  for (const d of content.departures) {
    if (d.bookingStatus !== "OPEN") continue;
    const resolved = resolveBookingDetails(content, d);
    if (resolved.prepaymentAmount === undefined) {
      fail(`OPEN departure ${d.id} has no prepaymentAmount, even after siteSettings fallback`);
    }
    if (!resolved.qr) {
      fail(`OPEN departure ${d.id} has no payment QR, even after siteSettings fallback`);
    }
    if (!resolved.organizer) {
      fail(`OPEN departure ${d.id} has no organizer, even after siteSettings fallback`);
    } else if (!PHONE_RE.test(resolved.organizer.phone)) {
      fail(`OPEN departure ${d.id} resolves to organizer with invalid phone: ${resolved.organizer.phone}`);
    }
  }

  // --- launchReady production gate (PRD 29, 49.1) -------------------------
  if (content.siteSettings.launchReady) {
    if (content.siteSettings.booking.isDemo) {
      fail("launchReady=true but siteSettings.booking.isDemo=true");
    }
    if (content.siteSettings.company.isDemo) {
      fail("launchReady=true but siteSettings.company.isDemo=true");
    }
    for (const d of content.departures) {
      if (d.isDemo) fail(`launchReady=true but departure ${d.id} has isDemo=true`);
    }
    for (const rv of content.reviews) {
      if (rv.isDemo) fail(`launchReady=true but review ${rv.id} has isDemo=true`);
    }
    for (const o of content.organizers) {
      if (o.isDemo) fail(`launchReady=true but organizer ${o.id} has isDemo=true`);
    }
    if (!PHONE_RE.test(content.siteSettings.company.phone)) {
      fail(`launchReady=true but company phone is not a valid +7XXXXXXXXXX number`);
    }
  } else {
    warn(
      "siteSettings.launchReady=false — building in demo mode. This build must not be published as the public production release.",
    );
  }

  for (const warning of warnings) console.warn(`[validate-content] WARN: ${warning}`);

  if (errors.length > 0) {
    console.error(`[validate-content] FAILED with ${errors.length} error(s):`);
    for (const error of errors) console.error(` - ${error}`);
    process.exit(1);
  }

  console.log(
    `[validate-content] OK — ${content.tours.length} tours, ${content.departures.length} departures, ` +
      `launchReady=${content.siteSettings.launchReady}`,
  );
}

main().catch((error) => {
  console.error("[validate-content] failed:", error);
  process.exit(1);
});
