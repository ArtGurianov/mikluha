#!/usr/bin/env tsx
/**
 * Step 3 of the production build pipeline.
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

import { REQUIRED_LEGAL_SLUGS, RESERVED_SLUGS, SLUG_RE } from "../lib/legal";
import { isStaging } from "../lib/site";
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
  // Legal pages get a static route each from app/[legalSlug]/, so any slug is
  // allowed — but that route sits at the site root, so a slug must still be
  // servable and must not shadow an existing section or build artifact. The
  // Studio rejects both while typing; this is the backstop for documents
  // written through the API.
  for (const p of content.legalPages) {
    if (slugs.has(`legal:${p.slug}`)) fail(`Duplicate legal page slug: ${p.slug}`);
    slugs.add(`legal:${p.slug}`);
    if (!SLUG_RE.test(p.slug)) {
      fail(
        `LegalPage slug "${p.slug}" cannot be served as a URL — use lowercase latin letters, digits and hyphens ` +
          `(for example public-offer).`,
      );
    }
    if ((RESERVED_SLUGS as readonly string[]).includes(p.slug)) {
      fail(`LegalPage slug "${p.slug}" would shadow an existing route or build artifact — rename it.`);
    }
  }

  // Which documents MUST exist is a separate question from which slugs are
  // allowed: the booking flow links to the booking terms, so a release without
  // them links nowhere. Everything else is the owner's call.
  for (const requiredSlug of REQUIRED_LEGAL_SLUGS) {
    if (!content.legalPages.some((p) => p.slug === requiredSlug)) {
      fail(`Missing required legal page "${requiredSlug}" — the booking flow links to it.`);
    }
  }

  // --- OPEN departures must always resolve to a complete booking flow ----
  for (const d of content.departures) {
    if (d.bookingStatus !== "OPEN") continue;
    const resolved = resolveBookingDetails(content, d);
    if (d.price === undefined) {
      // Unlike the QR/prepayment/organizer below, price has no siteSettings
      // fallback — it is per-date by definition, so nothing can stand in for it.
      fail(`OPEN departure ${d.id} has no price — a departure open for booking must show what it costs`);
    }
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

  // --- launchReady production gate ----------------------------------------
  // A production release must never carry placeholder payment details: the
  // demo QR sends real money to a test account and the demo phone reaches
  // nobody. Every blocker is collected up front so the operator gets the whole
  // list in one build rather than discovering them one failed build at a time.
  const demoBlockers: string[] = [];
  if (content.siteSettings.booking.isDemo) {
    demoBlockers.push('siteSettings.booking is still marked "Демо-данные" (default QR / prepayment / organizer)');
  }
  if (content.siteSettings.company.isDemo) {
    demoBlockers.push('siteSettings.company is still marked "Демо-данные" (legal name / ИНН / ОГРН / phone)');
  }
  for (const d of content.departures) {
    if (d.isDemo) demoBlockers.push(`departure ${d.id} is still marked "Демо-данные"`);
  }
  for (const rv of content.reviews) {
    if (rv.isDemo) demoBlockers.push(`review ${rv.id} is still marked "Демо-данные"`);
  }
  for (const o of content.organizers) {
    if (o.isDemo) demoBlockers.push(`organizer ${o.id} is still marked "Демо-данные"`);
  }
  if (!PHONE_RE.test(content.siteSettings.company.phone)) {
    demoBlockers.push(
      `siteSettings.company.phone "${content.siteSettings.company.phone}" is not a valid +7XXXXXXXXXX number`,
    );
  }

  if (content.siteSettings.launchReady) {
    for (const blocker of demoBlockers) {
      fail(`Production release blocked — ${blocker}. Replace it in Sanity Studio and republish.`);
    }
  } else if (isStaging) {
    warn(
      "siteSettings.launchReady=false — building in demo/staging mode. This build must not be published as the public production release.",
    );
  } else {
    fail(
      'Production release blocked — "Сайт готов к публичному запуску" (siteSettings.launchReady) is off, ' +
        "so this content is still considered demo data. Turn it on in Sanity Studio once the real details are in place, " +
        "or build with DEPLOY_ENV=staging for a demo/preview release." +
        (demoBlockers.length > 0
          ? `\n   Still to replace before it can be turned on:\n${demoBlockers.map((b) => `     - ${b}`).join("\n")}`
          : ""),
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
