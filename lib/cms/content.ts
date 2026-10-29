import fs from "node:fs";
import path from "node:path";

import { connection } from "next/server";
import { cache } from "react";

import { assertCatalogLaunchReady } from "../launch-gate";
import { isSsr } from "../site";
import { mediaDeliveryFromEnv, withMediaDelivery } from "./media-delivery";
import { normalizeCatalog } from "./normalize";
import { fetchPublicCatalog, projectionToRaw } from "./projection";
import type { ContentSnapshot } from "./types";

const CACHE_PATH = path.join(process.cwd(), ".cms-cache", "content.json");

function loadSnapshot(): ContentSnapshot {
  if (!fs.existsSync(CACHE_PATH)) {
    throw new Error(
      "CMS content cache not found (.cms-cache/content.json). Run `pnpm run sync:content` first " +
        "(this happens automatically before `pnpm dev`, and is part of `pnpm run build:production`).",
    );
  }
  const raw = fs.readFileSync(CACHE_PATH, "utf-8");
  return JSON.parse(raw) as ContentSnapshot;
}

let cached: ContentSnapshot | null = null;

/**
 * Full normalized content snapshot, read once per build/process from the
 * local CMS cache. Under SSR only its site settings and legal pages are used:
 * they change with code, like the legal release Commerce is built from.
 */
export function getBakedContent(): ContentSnapshot {
  if (!cached) {
    cached = loadSnapshot();
  }
  return cached;
}

export type SiteContent = Pick<ContentSnapshot, "siteSettings" | "legalPages">;

/**
 * Site settings and legal pages only, never Commerce: the root layout and the
 * legal pages render through a Commerce outage. Under SSR it still waits for
 * the request, so the media delivery switch applies without a rebuild.
 */
export const loadSiteContent = cache(async (): Promise<SiteContent> => {
  const { siteSettings, legalPages } = getBakedContent();
  if (!isSsr) return { siteSettings, legalPages };
  await connection();
  return withMediaDelivery({ siteSettings, legalPages }, mediaDeliveryFromEnv());
});

/**
 * What a catalog page renders. Static export: the baked snapshot. SSR
 * (TOUR-60): one Commerce projection read per request, shared by metadata and
 * the page, with media URLs resolved for the current delivery mode. Never
 * prerendered: a build never reads production data. Once the site is
 * launch-ready, a catalog the static build would have refused is refused here
 * (lib/launch-gate.ts), so publishing cannot bypass the release gate.
 */
export const loadContent = cache(async (): Promise<ContentSnapshot> => {
  if (!isSsr) return getBakedContent();
  await connection();
  const baked = getBakedContent();
  const catalog = normalizeCatalog(projectionToRaw(await fetchPublicCatalog()));
  if (baked.siteSettings.launchReady) assertCatalogLaunchReady(catalog);
  return withMediaDelivery(
    { ...baked, ...catalog, source: "commerce", generatedAt: new Date().toISOString() },
    mediaDeliveryFromEnv(),
  );
});
