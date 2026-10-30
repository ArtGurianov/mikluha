import fs from "node:fs";
import path from "node:path";

import { connection } from "next/server";
import { cache } from "react";

import { assertCatalogLaunchReady } from "../launch-gate";
import { parsePublicLegalPages } from "./legal-projection";
import { mediaDeliveryFromEnv, withMediaDelivery } from "./media-delivery";
import { normalizeCatalog } from "./normalize";
import { fetchPublicCatalog, projectionToRaw } from "./projection";
import type { ContentSnapshot } from "./types";

const CACHE_PATH = path.join(process.cwd(), ".site-build", "content.json");

function loadSnapshot(): ContentSnapshot {
  if (!fs.existsSync(CACHE_PATH)) {
    throw new Error(
      "Packaged site content not found (.site-build/content.json). Run `pnpm run prepare:site` first " +
        "(this happens automatically before `pnpm dev`, and is part of `pnpm run build:production`).",
    );
  }
  const raw = fs.readFileSync(CACHE_PATH, "utf-8");
  return JSON.parse(raw) as ContentSnapshot;
}

let cached: ContentSnapshot | null = null;

/**
 * Build inputs, read once per process. Only settings are public runtime authority.
 */
export function getBakedContent(): ContentSnapshot {
  if (!cached) {
    cached = loadSnapshot();
  }
  return cached;
}

export type SiteContent = Pick<ContentSnapshot, "siteSettings" | "legalPages"> & { legalAvailable: boolean };

// Share the same Commerce read across page, metadata and footer in one render only.
const loadProjection = cache(fetchPublicCatalog);
export const loadLegalPages = cache(async () => {
  await connection();
  try { return parsePublicLegalPages((await loadProjection()).legalPages); }
  catch { return null; }
});

/**
 * The shell survives Commerce failure, but never substitutes packaged legal text.
 */
export const loadSiteContent = cache(async (): Promise<SiteContent> => {
  await connection();
  const { siteSettings } = getBakedContent();
  const legalPages = await loadLegalPages();
  return withMediaDelivery({ siteSettings, legalPages: legalPages ?? [], legalAvailable: legalPages !== null }, mediaDeliveryFromEnv());
});

/**
 * What a catalog page renders. SSR
 * (TOUR-60): one Commerce projection read per request, shared by metadata and
 * the page, with media URLs resolved for the current delivery mode. Never
 * prerendered: a build never reads production data. Once the site is
 * launch-ready, a catalog the static build would have refused is refused here
 * (lib/launch-gate.ts), so publishing cannot bypass the release gate.
 */
export const loadContent = cache(async (): Promise<ContentSnapshot> => {
  await connection();
  const baked = getBakedContent();
  const projection = await loadProjection();
  const catalog = normalizeCatalog(projectionToRaw(projection));
  const legalPages = parsePublicLegalPages(projection.legalPages);
  if (baked.siteSettings.launchReady) assertCatalogLaunchReady(catalog);
  return withMediaDelivery(
    { ...baked, ...catalog, legalPages, source: "commerce", generatedAt: new Date().toISOString() },
    mediaDeliveryFromEnv(),
  );
});

/** Only catalog pages degrade to a visible server-rendered state. No stale fallback. */
export const loadCatalogPage = cache(async (): Promise<ContentSnapshot | null> => {
  // Keep Next's request boundary outside the error handler (including prerender control flow).
  await connection();
  try { return await loadContent(); }
  catch { return null; }
});
