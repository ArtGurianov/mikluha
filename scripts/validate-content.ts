#!/usr/bin/env tsx
/**
 * Step 2 of the production build pipeline.
 *
 * Validates the normalized content snapshot BEFORE asset materialization and
 * `next build` run:
 *  - referential integrity (every reference points at a real, listed document)
 *  - the launchReady + isDemo production-readiness gate
 *  - that every OPEN departure has a complete booking flow after fallback
 *
 * Exits non-zero (failing the build) on any violation.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { REQUIRED_LEGAL_SLUGS, RESERVED_SLUGS, SLUG_RE } from "../lib/legal";
import { findMarkdownPolicyViolations } from "../lib/cms/markdown-policy";
import { isStaging } from "../lib/site";
import type { ContentSnapshot } from "../lib/cms/types";

const CACHE_FILE = path.resolve(process.cwd(), ".cms-cache", "content.json");
const PHONE_RE = /^\+7\d{10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const errors: string[] = [];
const warnings: string[] = [];

function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function fail(message: string) {
  errors.push(message);
}

function warn(message: string) {
  warnings.push(message);
}

function validateMarkdown(markdown: string, documentField: string) {
  for (const violation of findMarkdownPolicyViolations(markdown)) {
    const location = `${documentField} at ${violation.line}:${violation.column}`;
    if (violation.kind === "image") {
      fail(
        `${location} contains an inline Markdown image (${violation.subject}); ` +
          "use a structured CMS image field so the asset is materialized",
      );
    } else {
      fail(
        `${location} contains raw HTML (${violation.subject}); raw HTML is not supported in CMS Markdown fields`,
      );
    }
  }
}

async function main() {
  const raw = await readFile(CACHE_FILE, "utf-8");
  const content = JSON.parse(raw) as ContentSnapshot<unknown>;

  const tourIds = new Set(content.tours.map((t) => t.id));
  const departureById = new Map(content.departures.map((d) => [d.id, d]));
  const organizerIds = new Set(content.organizers.map((o) => o.id));

  // Markdown is parsed with the same remark parser family as ReactMarkdown,
  // so code examples are ignored while rendered image/HTML nodes are reported
  // together, with their owning document, before expensive asset processing.
  for (const tour of content.tours) {
    if (tour.description) validateMarkdown(tour.description, `Tour ${tour.id} description`);
  }
  for (const page of content.legalPages) {
    validateMarkdown(page.content, `LegalPage ${page.id} content`);
  }

  if (!isHttpsUrl(content.siteSettings.siteUrl)) fail(`siteSettings.siteUrl must be an absolute HTTPS URL`);
  if (content.siteSettings.socials.maxChannelUrl && !isHttpsUrl(content.siteSettings.socials.maxChannelUrl)) {
    fail(`siteSettings.socials.maxChannelUrl must be an absolute HTTPS URL`);
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: content.siteSettings.timezone }).format();
  } catch {
    fail(`siteSettings.timezone "${content.siteSettings.timezone}" is not a valid IANA timezone`);
  }
  const defaultPrepayment = content.siteSettings.booking.defaultPrepaymentAmount;
  if (defaultPrepayment !== undefined && (!Number.isInteger(defaultPrepayment) || defaultPrepayment < 0)) {
    fail(`siteSettings.booking.defaultPrepaymentAmount must be a non-negative integer`);
  }

  // --- referential integrity ---------------------------------------------
  for (const d of content.departures) {
    if (!tourIds.has(d.tourId)) fail(`Departure ${d.id} references unknown tour ${d.tourId}`);
    if (!isCalendarDate(d.startDate) || !isCalendarDate(d.endDate)) {
      fail(`Departure ${d.id} has an invalid date; startDate/endDate must be YYYY-MM-DD`);
    } else if (d.endDate < d.startDate) {
      fail(`Departure ${d.id} ends before it starts (${d.startDate} → ${d.endDate})`);
    }
    if (!("OPEN" === d.bookingStatus || "CLOSED" === d.bookingStatus || "CANCELLED" === d.bookingStatus)) {
      fail(`Departure ${d.id} has unknown bookingStatus "${d.bookingStatus}"`);
    }
    for (const [label, amount] of [["price", d.price], ["prepaymentAmount", d.prepaymentAmount]] as const) {
      if (amount !== undefined && (!Number.isInteger(amount) || amount < 0)) {
        fail(`Departure ${d.id} ${label} must be a non-negative integer`);
      }
    }
    for (const orgId of d.organizerIds) {
      if (!organizerIds.has(orgId)) fail(`Departure ${d.id} references unknown organizer ${orgId}`);
    }
  }
  for (const r of content.reports) {
    if (!tourIds.has(r.tourId)) fail(`Report ${r.id} references unknown tour ${r.tourId}`);
    if (r.departureId) {
      const departure = departureById.get(r.departureId);
      if (!departure) fail(`Report ${r.id} references unknown departure ${r.departureId}`);
      else if (departure.tourId !== r.tourId) {
        fail(`Report ${r.id} links tour ${r.tourId} but departure ${r.departureId} belongs to ${departure.tourId}`);
      }
    }
    if (r.date && !isCalendarDate(r.date)) fail(`Report ${r.id} date must be a real YYYY-MM-DD calendar date`);
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
    if (!SLUG_RE.test(t.slug)) {
      fail(`Tour slug "${t.slug}" cannot be served as a URL — use lowercase latin letters, digits and hyphens (for example altai).`);
    }
  }
  for (const r of content.reports) {
    if (slugs.has(`report:${r.slug}`)) fail(`Duplicate report slug: ${r.slug}`);
    slugs.add(`report:${r.slug}`);
    if (!SLUG_RE.test(r.slug)) {
      fail(
        `Report slug "${r.slug}" cannot be served as a URL — use lowercase latin letters, digits and hyphens ` +
          `(for example altai-june-2026).`,
      );
    }
  }
  // Legal pages get a static route each from app/[legalSlug]/, so any slug is
  // allowed — but that route sits at the site root, so a slug must still be
  // servable and must not shadow an existing section or build artifact. Tours
  // and reports sit under a fixed /tours//reports/ prefix, so they only need
  // the URL-safety check above, not a reserved-word check. The CMS rejects
  // both while typing (public/admin/config.yml field `pattern`s); this is the
  // backstop for documents written or hand-edited outside it.
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
    if (p.updatedAt && !isCalendarDate(p.updatedAt)) {
      fail(`LegalPage ${p.id} updatedAt must be a real YYYY-MM-DD calendar date`);
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
    const resolvedPrepayment = d.prepaymentAmount ?? content.siteSettings.booking.defaultPrepaymentAmount;
    const resolvedQr = d.paymentQr ?? content.siteSettings.booking.defaultQr;
    const departureOrganizer = content.organizers.find((organizer) => organizer.id === d.organizerIds[0]);
    const fallbackOrganizer = content.organizers.find(
      (organizer) => organizer.id === content.siteSettings.booking.defaultOrganizerId,
    );
    const resolvedOrganizer = departureOrganizer ?? fallbackOrganizer;
    if (d.price === undefined) {
      // Unlike the QR/prepayment/organizer below, price has no siteSettings
      // fallback — it is per-date by definition, so nothing can stand in for it.
      fail(`OPEN departure ${d.id} has no price — a departure open for booking must show what it costs`);
    }
    if (resolvedPrepayment === undefined) {
      fail(`OPEN departure ${d.id} has no prepaymentAmount, even after siteSettings fallback`);
    }
    if (!resolvedQr) {
      fail(`OPEN departure ${d.id} has no payment QR, even after siteSettings fallback`);
    }
    if (!resolvedOrganizer) {
      fail(`OPEN departure ${d.id} has no organizer, even after siteSettings fallback`);
    } else if (!PHONE_RE.test(resolvedOrganizer.phone)) {
      fail(`OPEN departure ${d.id} resolves to organizer with invalid phone: ${resolvedOrganizer.phone}`);
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
      fail(`Production release blocked — ${blocker}. Replace it in the CMS and commit.`);
    }
  } else if (isStaging) {
    warn(
      "siteSettings.launchReady=false — building in demo/staging mode. This build must not be published as the public production release.",
    );
  } else {
    fail(
      'Production release blocked — "Сайт готов к публичному запуску" (siteSettings.launchReady) is off, ' +
        "so this content is still considered demo data. Turn it on in the CMS once the real details are in place, " +
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
