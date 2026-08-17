#!/usr/bin/env tsx
/**
 * Final step of the production build pipeline — runs after
 * `next build` against the generated /out directory, before it is allowed to
 * become the candidate for the HTTP healthcheck / production switch.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import yaml from "js-yaml";

import {
  assertImageSource,
  assertVideoSource,
  createAssetSourcePolicy,
  type CmsMediaConfig,
} from "../lib/cms/asset-source";
import type { ContentSnapshot } from "../lib/cms/types";
import { resolveCanonicalBase } from "../lib/site";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "out");
const CACHE_FILE = path.join(ROOT, ".cms-cache", "content.json");
const ADMIN_CONFIG_FILE = path.join(ROOT, "public/admin/config.yml");

const errors: string[] = [];
function fail(message: string) {
  errors.push(message);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// .yml is deliberately excluded: /out/admin/config.yml contains the editor's
// Object Storage configuration, while this scan targets rendered public pages.
const SCANNABLE_EXT = new Set([".html", ".js", ".json", ".xml", ".txt"]);
const DIRECT_MEDIA_REF_RE = /\b(?:src|poster|href|content)=["']([^"']+\.(?:webp|webm))["']/gi;
const PROCESSED_IMAGE_RE = /\/_next\/image\?|\/generated\/cms\//i;
const LEGACY_IMAGE_RE = /<(?:img|video)\b[^>]*(?:src|poster)=["'][^"']+\.(?:jpe?g|png)["']/i;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true } as never);
  const files: string[] = [];
  for (const entry of entries as unknown as Array<{ name: string; parentPath?: string; path?: string; isFile(): boolean }>) {
    if (entry.isFile()) {
      const base = entry.parentPath ?? entry.path ?? dir;
      files.push(path.join(base, entry.name));
    }
  }
  return files;
}

async function main() {
  if (!(await exists(OUT_DIR))) {
    fail(`/out directory does not exist — did \`next build\` run?`);
    report();
    return;
  }

  if (!(await exists(path.join(OUT_DIR, "index.html")))) {
    fail("/out/index.html is missing");
  }
  if (!(await exists(path.join(OUT_DIR, "sitemap.xml")))) {
    fail("/out/sitemap.xml is missing");
  }
  if (!(await exists(path.join(OUT_DIR, "robots.txt")))) {
    fail("/out/robots.txt is missing");
  }
  if (!(await exists(path.join(OUT_DIR, "404.html")))) {
    fail("/out/404.html is missing (branded 404 required by section 35/48)");
  }
  for (const cmsFile of ["admin/index.html", "admin/config.yml", "admin/sveltia-cms.js"]) {
    if (!(await exists(path.join(OUT_DIR, cmsFile)))) {
      fail(`/out/${cmsFile} is missing — the CMS must ship as part of the static bundle`);
    }
  }

  let content: ContentSnapshot | undefined;
  if (await exists(CACHE_FILE)) {
    content = JSON.parse(await readFile(CACHE_FILE, "utf-8")) as ContentSnapshot;
    for (const tour of content.tours) {
      const routeFile = path.join(OUT_DIR, "tours", tour.slug, "index.html");
      if (!(await exists(routeFile))) fail(`Missing static route for tour "${tour.slug}": ${path.relative(ROOT, routeFile)}`);
    }
    for (const report of content.reports) {
      const routeFile = path.join(OUT_DIR, "reports", report.slug, "index.html");
      if (!(await exists(routeFile))) fail(`Missing static route for report "${report.slug}": ${path.relative(ROOT, routeFile)}`);
    }
    for (const page of content.legalPages) {
      const routeFile = path.join(OUT_DIR, page.slug, "index.html");
      if (!(await exists(routeFile))) fail(`Missing static route for legal page "${page.slug}": ${path.relative(ROOT, routeFile)}`);
    }
  } else {
    fail(`${path.relative(ROOT, CACHE_FILE)} not found — cannot verify dynamic routes against content`);
  }

  const files = await walk(OUT_DIR);
  const referencedMedia = new Set<string>();
  const adminConfig = yaml.load(await readFile(ADMIN_CONFIG_FILE, "utf-8")) as CmsMediaConfig;
  const mediaPolicy = createAssetSourcePolicy(adminConfig);
  const canonicalOrigin = content ? new URL(resolveCanonicalBase(content.siteSettings.siteUrl)).origin : undefined;

  for (const file of files) {
    const ext = path.extname(file);
    if (!SCANNABLE_EXT.has(ext)) continue;
    const text = await readFile(file, "utf-8");

    if (ext === ".html" && PROCESSED_IMAGE_RE.test(text)) {
      fail(`Found an image-processing URL in ${path.relative(ROOT, file)} — media must be referenced directly`);
    }
    if (ext === ".html" && LEGACY_IMAGE_RE.test(text)) {
      fail(`Found a JPEG/PNG page asset in ${path.relative(ROOT, file)} — public media must be WebP/WebM`);
    }

    for (const match of text.matchAll(DIRECT_MEDIA_REF_RE)) {
      referencedMedia.add(match[1]);
    }
  }

  for (const mediaRef of referencedMedia) {
    let policyRef = mediaRef;
    try {
      const absolute = new URL(mediaRef);
      if (absolute.origin === canonicalOrigin && !absolute.search && !absolute.hash) {
        policyRef = absolute.pathname;
      }
    } catch {
      // Root-relative demo media is handled as-is by the policy below.
    }

    try {
      if (policyRef.endsWith(".webm")) assertVideoSource(policyRef, mediaPolicy);
      else assertImageSource(policyRef, mediaPolicy);
    } catch (error) {
      fail(`Static output references invalid direct media "${mediaRef}": ${(error as Error).message}`);
      continue;
    }

    if (policyRef.startsWith("/")) {
      const abs = path.join(OUT_DIR, policyRef);
      if (!(await exists(abs))) {
        fail(`Referenced local media does not exist in /out: ${policyRef}`);
      }
    }
  }

  console.log(`[validate-out] scanned ${files.length} files, ${referencedMedia.size} unique direct media reference(s)`);
  report();
}

function report() {
  if (errors.length > 0) {
    console.error(`[validate-out] FAILED with ${errors.length} error(s):`);
    for (const error of errors) console.error(` - ${error}`);
    process.exit(1);
  }
  console.log("[validate-out] OK — static export passed all checks");
}

main().catch((error) => {
  console.error("[validate-out] failed:", error);
  process.exit(1);
});
