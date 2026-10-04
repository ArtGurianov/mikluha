#!/usr/bin/env tsx
/**
 * Final step of the production build pipeline — runs after
 * `next build` against the generated /out directory, before it is allowed to
 * become the candidate for the HTTP healthcheck / production switch.
 *
 * Besides routes and media, it enforces the SEO invariants in lib/seo-audit.ts
 * (indexability per environment, self-canonicals, titles/descriptions/H1,
 * sitemap ↔ pages, JSON-LD), so an SEO regression fails the release instead of
 * surfacing weeks later in Search Console / Yandex Webmaster.
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
import { auditSite } from "../lib/seo-audit";
import { isStaging, resolveCanonicalBase } from "../lib/site";
import { makeSiteReleaseDescriptor, parseSiteReleaseDescriptor, type SiteReleaseDescriptor } from "../lib/release-descriptor";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "out");
const CACHE_FILE = path.join(ROOT, ".cms-cache", "content.json");
const ADMIN_CONFIG_FILE = path.join(ROOT, "public/admin/config.yml");

const errors: string[] = [];
const warnings: string[] = [];
function fail(message: string) {
  errors.push(message);
}

/** Copies of the branded 404 that `next build` exports; they are never indexable pages. */
const NOT_FOUND_FILES = new Set(["404.html", "404/index.html", "_not-found/index.html"]);

/** "index.html" → "/", "tours/altai/index.html" → "/tours/altai/" (`trailingSlash: true`). */
function pagePath(relative: string): string {
  return `/${relative.replace(/(^|\/)index\.html$/, "$1")}`;
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
  const releaseFile = path.join(OUT_DIR, "release.json");
  let release: SiteReleaseDescriptor | undefined;
  if (!(await exists(releaseFile))) fail("/out/release.json is missing");
  else {
    try { release = parseSiteReleaseDescriptor(JSON.parse(await readFile(releaseFile, "utf8"))); }
    catch { fail("/out/release.json is invalid"); }
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
    try {
      const expected = makeSiteReleaseDescriptor(process.env.SOURCE_COMMIT ?? "", content.legalPages);
      if (release && JSON.stringify(release) !== JSON.stringify(expected)) {
        fail("/out/release.json does not match this build's source commit and legal artifacts");
      }
    } catch (error) {
      fail(`Cannot derive the release descriptor: ${(error as Error).message}`);
    }
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

  const pages = new Map<string, string>();
  const notFoundPages = new Map<string, string>();

  for (const file of files) {
    const ext = path.extname(file);
    if (!SCANNABLE_EXT.has(ext)) continue;
    const text = await readFile(file, "utf-8");

    const relative = path.relative(OUT_DIR, file).split(path.sep).join("/");
    if (ext === ".html" && !relative.startsWith("admin/")) {
      if (NOT_FOUND_FILES.has(relative)) notFoundPages.set(`/${relative}`, text);
      else pages.set(pagePath(relative), text);
    }
    if (!isStaging && text.includes("staging.invalid")) {
      fail(`${path.relative(ROOT, file)} references staging.invalid — a production build must only point at the production domain`);
    }

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

  if (content) {
    const seo = auditSite({
      pages,
      notFoundPages,
      robotsTxt: await readFile(path.join(OUT_DIR, "robots.txt"), "utf-8").catch(() => ""),
      sitemapXml: await readFile(path.join(OUT_DIR, "sitemap.xml"), "utf-8").catch(() => ""),
      siteUrl: content.siteSettings.siteUrl,
      canonicalBase: resolveCanonicalBase(content.siteSettings.siteUrl),
      isStaging,
      noindexPaths: new Set(content.reports.filter((r) => r.noindex).map((r) => `/reports/${r.slug}/`)),
    });
    errors.push(...seo.errors);
    warnings.push(...seo.warnings);
  }

  console.log(
    `[validate-out] scanned ${files.length} files, ${referencedMedia.size} unique direct media reference(s), ` +
      `${pages.size} page(s) SEO-checked`,
  );
  report();
}

function report() {
  for (const warning of warnings) console.warn(`[validate-out] WARN: ${warning}`);
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
