#!/usr/bin/env tsx
/**
 * Step 2 of the production build pipeline (see PRD section 34.2 and 42).
 *
 * Reads .cms-cache/content.json (written by sync-sanity-content.ts, still
 * containing "unresolved" images as {alt, sourceRef}), downloads/reads each
 * unique source image exactly once, generates local responsive WEBP variants
 * under public/generated/cms/<hash>/, and rewrites the cache file in place so
 * every image becomes {alt, width, height, variants}. Also derives the site
 * favicon / apple touch icon from siteSettings.favicon (falling back to
 * siteSettings.logo) into app/icon.png and app/apple-icon.png.
 */
import "dotenv/config";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { readSanityEnv, sanityImageUrl } from "../lib/cms/client";
import type { ImageVariants, UnresolvedContentSnapshot } from "../lib/cms/types";

const CACHE_FILE = path.resolve(process.cwd(), ".cms-cache", "content.json");
const FIXTURES_ASSETS_DIR = path.resolve(process.cwd(), "lib/cms/fixtures/assets");
const GENERATED_DIR = path.resolve(process.cwd(), "public/generated/cms");
const APP_DIR = path.resolve(process.cwd(), "app");

const VARIANTS: Array<{ name: keyof ImageVariants; width: number }> = [
  { name: "thumbnail", width: 400 },
  { name: "card", width: 800 },
  { name: "gallery", width: 1400 },
  { name: "hero", width: 2200 },
  { name: "lightbox", width: 2600 },
];

async function loadSourceBuffer(sourceRef: string): Promise<Buffer> {
  if (sourceRef.startsWith("local:")) {
    const filename = sourceRef.slice("local:".length);
    return readFile(path.join(FIXTURES_ASSETS_DIR, filename));
  }

  const env = readSanityEnv();
  if (!env) {
    throw new Error(`Cannot resolve remote asset ref "${sourceRef}" without SANITY_PROJECT_ID/SANITY_DATASET set.`);
  }
  const url = sanityImageUrl(env, sourceRef);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Sanity asset ${sourceRef}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

interface Resolved {
  width: number;
  height: number;
  variants: ImageVariants;
}

const resolvedCache = new Map<string, Promise<Resolved>>();

async function resolveImage(sourceRef: string): Promise<Resolved> {
  const cached = resolvedCache.get(sourceRef);
  if (cached) return cached;

  const promise = (async (): Promise<Resolved> => {
    const buffer = await loadSourceBuffer(sourceRef);
    const hash = createHash("sha256").update(buffer).update(sourceRef).digest("hex").slice(0, 16);
    const outDir = path.join(GENERATED_DIR, hash);
    await mkdir(outDir, { recursive: true });

    const metadata = await sharp(buffer).metadata();
    const sourceWidth = metadata.width ?? Infinity;
    const variants = {} as ImageVariants;

    // Variants are ascending by width. Once a variant's target width reaches
    // the source's actual width, `withoutEnlargement` caps every larger
    // nominal variant at that same native size, so its encoded bytes are
    // identical to the first such variant. We still copy that buffer to each
    // variant's own <name>.webp file (never re-encode it) — the custom image
    // loader (lib/image-loader.ts) reconstructs a variant's URL purely from
    // its name, so every <hash>/<name>.webp path MUST physically exist.
    let nativeSizeBuffer: Buffer | null = null;

    for (const variant of VARIANTS) {
      const outFile = path.join(outDir, `${variant.name}.webp`);

      if (nativeSizeBuffer) {
        await writeFile(outFile, nativeSizeBuffer);
        variants[variant.name] = `/generated/cms/${hash}/${variant.name}.webp`;
        continue;
      }

      const encoded = await sharp(buffer)
        .resize({ width: variant.width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      await writeFile(outFile, encoded);
      variants[variant.name] = `/generated/cms/${hash}/${variant.name}.webp`;

      if (variant.width >= sourceWidth) nativeSizeBuffer = encoded;
    }

    return { width: metadata.width ?? 0, height: metadata.height ?? 0, variants };
  })();

  resolvedCache.set(sourceRef, promise);
  return promise;
}

function isUnresolvedImage(node: unknown): node is { alt: string; sourceRef: string } {
  if (!node || typeof node !== "object") return false;
  const keys = Object.keys(node as Record<string, unknown>).sort();
  return (
    keys.length === 2 &&
    keys[0] === "alt" &&
    keys[1] === "sourceRef" &&
    typeof (node as Record<string, unknown>).sourceRef === "string"
  );
}

function collectSourceRefs(node: unknown, refs: Set<string>) {
  if (Array.isArray(node)) {
    node.forEach((item) => collectSourceRefs(item, refs));
    return;
  }
  if (node && typeof node === "object") {
    if (isUnresolvedImage(node)) {
      refs.add(node.sourceRef);
      return;
    }
    for (const value of Object.values(node)) {
      collectSourceRefs(value, refs);
    }
  }
}

function applyResolved(node: unknown, cache: Map<string, Resolved>) {
  if (Array.isArray(node)) {
    node.forEach((item) => applyResolved(item, cache));
    return;
  }
  if (node && typeof node === "object") {
    if (isUnresolvedImage(node)) {
      const resolved = cache.get(node.sourceRef);
      if (!resolved) throw new Error(`Missing resolved image for ${node.sourceRef}`);
      const mutable = node as Record<string, unknown>;
      delete mutable.sourceRef;
      mutable.width = resolved.width;
      mutable.height = resolved.height;
      mutable.variants = resolved.variants;
      return;
    }
    for (const value of Object.values(node)) {
      applyResolved(value, cache);
    }
  }
}

async function materializeBrandIcons(iconSourceRef: string | undefined) {
  if (!iconSourceRef) return;

  const buffer = await loadSourceBuffer(iconSourceRef);

  await sharp(buffer)
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(APP_DIR, "icon.png"));

  await sharp(buffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(180, 180, { fit: "contain", background: { r: 255, g: 255, b: 255 } })
    .png()
    .toFile(path.join(APP_DIR, "apple-icon.png"));

  console.log("[materialize-assets] wrote app/icon.png and app/apple-icon.png");
}

async function main() {
  const raw = await readFile(CACHE_FILE, "utf-8");
  const snapshot = JSON.parse(raw) as UnresolvedContentSnapshot;

  const iconSourceRef = snapshot.siteSettings.favicon?.sourceRef ?? snapshot.siteSettings.logo?.sourceRef;

  const refs = new Set<string>();
  collectSourceRefs(snapshot, refs);

  console.log(`[materialize-assets] resolving ${refs.size} unique image asset(s)...`);

  const cache = new Map<string, Resolved>();
  for (const ref of refs) {
    cache.set(ref, await resolveImage(ref));
  }

  applyResolved(snapshot, cache);

  await writeFile(CACHE_FILE, JSON.stringify(snapshot, null, 2), "utf-8");
  console.log(`[materialize-assets] wrote ${refs.size} image(s) to ${path.relative(process.cwd(), GENERATED_DIR)}/`);

  await materializeBrandIcons(iconSourceRef);
}

main().catch((error) => {
  console.error("[materialize-assets] failed:", error);
  process.exit(1);
});
