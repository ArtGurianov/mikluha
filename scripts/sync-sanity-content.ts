#!/usr/bin/env tsx
/**
 * Step 1 of the production build pipeline (see PRD section 34.2).
 *
 * Fetches the published content set — from live Sanity if SANITY_PROJECT_ID /
 * SANITY_DATASET env vars are set, otherwise from the local fixtures in
 * lib/cms/fixtures/ — normalizes it, and writes an intermediate snapshot to
 * .cms-cache/content.json. Images are left "unresolved" (alt + sourceRef)
 * at this stage; scripts/materialize-assets.ts downloads/resizes them and
 * rewrites the same file into its final, fully-resolved form.
 */
import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createSanityContentClient, readSanityEnv } from "../lib/cms/client";
import { loadFixtureSet } from "../lib/cms/loadFixtures";
import { normalizeContentSet } from "../lib/cms/normalize";
import {
  departuresQuery,
  legalPagesQuery,
  organizersQuery,
  reportsQuery,
  reviewsQuery,
  siteSettingsQuery,
  toursQuery,
} from "../lib/cms/queries";
import type { RawContentSet } from "../lib/cms/types";

const CACHE_DIR = path.resolve(process.cwd(), ".cms-cache");
const CACHE_FILE = path.join(CACHE_DIR, "content.json");

async function loadLiveSet(env: NonNullable<ReturnType<typeof readSanityEnv>>): Promise<RawContentSet> {
  const client = createSanityContentClient(env);
  const [siteSettings, tours, departures, reports, reviews, organizers, legalPages] = await Promise.all([
    client.fetch(siteSettingsQuery),
    client.fetch(toursQuery),
    client.fetch(departuresQuery),
    client.fetch(reportsQuery),
    client.fetch(reviewsQuery),
    client.fetch(organizersQuery),
    client.fetch(legalPagesQuery),
  ]);

  if (!siteSettings) {
    throw new Error(
      "siteSettings document not found in Sanity dataset. Create the singleton document before building.",
    );
  }

  return { siteSettings, tours, departures, reports, reviews, organizers, legalPages };
}

async function main() {
  const env = readSanityEnv();

  const source = env ? "sanity" : "fixtures";
  console.log(`[sync-cms] source: ${source}${env ? ` (${env.projectId}/${env.dataset})` : ""}`);

  const raw = env ? await loadLiveSet(env) : await loadFixtureSet();
  const snapshot = normalizeContentSet(raw, source);

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(snapshot, null, 2), "utf-8");

  console.log(
    `[sync-cms] wrote ${CACHE_FILE} — tours:${snapshot.tours.length} departures:${snapshot.departures.length} ` +
      `reports:${snapshot.reports.length} reviews:${snapshot.reviews.length} organizers:${snapshot.organizers.length} ` +
      `legalPages:${snapshot.legalPages.length}`,
  );
}

main().catch((error) => {
  console.error("[sync-cms] failed:", error);
  process.exit(1);
});
