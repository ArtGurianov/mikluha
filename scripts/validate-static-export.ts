#!/usr/bin/env tsx
/**
 * Step 5 of the production build pipeline — runs after
 * `next build` against the generated /out directory, before it is allowed to
 * become the candidate for the HTTP healthcheck / production switch.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { ContentSnapshot } from "../lib/cms/types";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "out");
const CACHE_FILE = path.join(ROOT, ".cms-cache", "content.json");

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

// Every CMS image must have been materialized to a local /generated/cms path
// by scripts/materialize-assets.ts before `next build` runs — a leaked
// cloud.ru URL means that step was skipped for something.
const FORBIDDEN_HOST_RE = /s3\.cloud\.ru/i;
// .yml is deliberately excluded: /out/admin/config.yml legitimately names the
// cloud.ru host (it's the CMS media library's own config, not a materialized
// page), so scanning it would make FORBIDDEN_HOST_RE fail on every build.
// Don't add it here without also excluding public/admin/config.yml specifically.
const SCANNABLE_EXT = new Set([".html", ".js", ".json", ".xml", ".txt"]);
const ASSET_REF_RE = /\/generated\/cms\/[\w-]+\/[\w-]+\.(?:webp|png|jpg|jpeg|ico)/g;

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

  if (await exists(CACHE_FILE)) {
    const content = JSON.parse(await readFile(CACHE_FILE, "utf-8")) as ContentSnapshot;
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
  const referencedAssets = new Set<string>();

  for (const file of files) {
    const ext = path.extname(file);
    if (!SCANNABLE_EXT.has(ext)) continue;
    const text = await readFile(file, "utf-8");

    if (FORBIDDEN_HOST_RE.test(text)) {
      fail(`Found a cloud.ru object storage URL in ${path.relative(ROOT, file)} — production artifact must be fully local`);
    }

    for (const match of text.matchAll(ASSET_REF_RE)) {
      referencedAssets.add(match[0]);
    }
  }

  for (const assetPath of referencedAssets) {
    const abs = path.join(OUT_DIR, assetPath);
    if (!(await exists(abs))) {
      fail(`Referenced local asset does not exist in /out: ${assetPath}`);
    }
  }

  console.log(`[validate-out] scanned ${files.length} files, ${referencedAssets.size} unique local CMS asset reference(s)`);
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
