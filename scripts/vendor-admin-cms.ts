#!/usr/bin/env tsx
/**
 * Copies the Sveltia CMS browser bundle from node_modules into
 * public/admin/sveltia-cms.js so the /admin panel is served entirely from
 * this origin — no unpkg.com (or any other CDN) dependency, consistent with
 * docs/DECISIONS.md #1. Regenerated on every build, same as every other
 * public/generated/* artifact — never hand-edited or committed as a diff.
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE = path.resolve(process.cwd(), "node_modules/@sveltia/cms/dist/sveltia-cms.js");
const DEST_DIR = path.resolve(process.cwd(), "public/admin");
const DEST = path.join(DEST_DIR, "sveltia-cms.js");

async function main() {
  await mkdir(DEST_DIR, { recursive: true });
  await copyFile(SOURCE, DEST);
  console.log(`[vendor-admin] copied ${path.relative(process.cwd(), SOURCE)} -> ${path.relative(process.cwd(), DEST)}`);
}

main().catch((error) => {
  console.error("[vendor-admin] failed:", error);
  process.exit(1);
});
