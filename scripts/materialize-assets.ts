#!/usr/bin/env tsx
/**
 * Step 2 of the production build pipeline.
 *
 * Reads .cms-cache/content.json (written by sync-content.ts, still containing
 * "unresolved" images as {alt, sourceRef}), downloads/reads each unique
 * source image exactly once, generates local responsive WEBP variants under
 * public/generated/cms/<hash>/, and rewrites the cache file in place so every
 * image becomes {alt, width, height, variants}. Also derives the site
 * favicon / apple touch icon from siteSettings.favicon (falling back to
 * siteSettings.logo) into app/icon.png and app/apple-icon.png.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import yaml from "js-yaml";
import sharp from "sharp";

import type { ImageVariants, UnresolvedContentSnapshot } from "../lib/cms/types";

const CACHE_FILE = path.resolve(process.cwd(), ".cms-cache", "content.json");
const CONTENT_ASSETS_DIR = path.resolve(process.cwd(), "content/assets");
const GENERATED_DIR = path.resolve(process.cwd(), "public/generated/cms");
const APP_DIR = path.resolve(process.cwd(), "app");
const ADMIN_CONFIG_FILE = path.resolve(process.cwd(), "public/admin/config.yml");

const VARIANTS: Array<{ name: keyof ImageVariants; width: number }> = [
  { name: "thumbnail", width: 400 },
  { name: "card", width: 800 },
  { name: "gallery", width: 1400 },
  { name: "hero", width: 2200 },
  { name: "lightbox", width: 2600 },
];

/**
 * A content file's `sourceRef` can be anything someone typed or hand-edited —
 * only the URL prefix Sveltia's own S3 media library would actually produce
 * (`public_url`, falling back to `endpoint/bucket`, both read from
 * public/admin/config.yml) is allowed through `fetch()` here. Without this, a
 * bad edit or a compromised content file could make the build download
 * arbitrary bytes from anywhere into the release image.
 */
async function loadAllowedAssetHostPrefixes(): Promise<string[]> {
  const configText = await readFile(ADMIN_CONFIG_FILE, "utf-8");
  const config = yaml.load(configText) as {
    media_libraries?: { aws_s3?: { endpoint?: string; bucket?: string; public_url?: string } };
  };
  const s3 = config.media_libraries?.aws_s3;
  if (!s3) return [];

  // Trailing slash matters: Sveltia always joins with `/`
  // (`${public_url}/${key}`), so without it "https://s3.cloud.ru/mybucket"
  // would also admit "https://s3.cloud.ru/mybucket-attacker/x.jpg".
  const prefixes: string[] = [];
  if (s3.public_url) prefixes.push(`${s3.public_url.replace(/\/+$/, "")}/`);
  if (s3.endpoint && s3.bucket) prefixes.push(`${s3.endpoint.replace(/\/+$/, "")}/${s3.bucket}/`);
  return prefixes;
}

async function loadSourceBuffer(sourceRef: string, allowedPrefixes: string[]): Promise<Buffer> {
  if (sourceRef.startsWith("local:")) {
    const filename = sourceRef.slice("local:".length);
    return readFile(path.join(CONTENT_ASSETS_DIR, filename));
  }

  // Anything else is a real asset URL — the cloud.ru object the Sveltia media
  // library uploaded to and wrote directly into the content file.
  if (!allowedPrefixes.some((prefix) => sourceRef.startsWith(prefix))) {
    throw new Error(
      `Refusing to download "${sourceRef}" — it doesn't match the configured media library host ` +
        `(public/admin/config.yml media_libraries.aws_s3). Fix the content file or the config.`,
    );
  }

  const response = await fetch(sourceRef);
  if (!response.ok) {
    throw new Error(`Failed to download CMS asset ${sourceRef}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

interface Resolved {
  width: number;
  height: number;
  variants: ImageVariants;
}

const resolvedCache = new Map<string, Promise<Resolved>>();

async function resolveImage(sourceRef: string, allowedPrefixes: string[]): Promise<Resolved> {
  const cached = resolvedCache.get(sourceRef);
  if (cached) return cached;

  const promise = (async (): Promise<Resolved> => {
    const buffer = await loadSourceBuffer(sourceRef, allowedPrefixes);
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

async function materializeBrandIcons(iconSourceRef: string | undefined, allowedPrefixes: string[]) {
  if (!iconSourceRef) return;

  const buffer = await loadSourceBuffer(iconSourceRef, allowedPrefixes);

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
  const allowedPrefixes = await loadAllowedAssetHostPrefixes();

  const iconSourceRef = snapshot.siteSettings.favicon?.sourceRef ?? snapshot.siteSettings.logo?.sourceRef;

  const refs = new Set<string>();
  collectSourceRefs(snapshot, refs);

  console.log(`[materialize-assets] resolving ${refs.size} unique image asset(s)...`);

  const cache = new Map<string, Resolved>();
  for (const ref of refs) {
    cache.set(ref, await resolveImage(ref, allowedPrefixes));
  }

  applyResolved(snapshot, cache);

  await writeFile(CACHE_FILE, JSON.stringify(snapshot, null, 2), "utf-8");
  console.log(`[materialize-assets] wrote ${refs.size} image(s) to ${path.relative(process.cwd(), GENERATED_DIR)}/`);

  await materializeBrandIcons(iconSourceRef, allowedPrefixes);
}

main().catch((error) => {
  console.error("[materialize-assets] failed:", error);
  process.exit(1);
});
