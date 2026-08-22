#!/usr/bin/env tsx
/**
 * Step 1 of the production build pipeline.
 *
 * Reads the Git-committed content set from content/ (written either by hand or
 * through the Sveltia CMS admin panel, which commits directly to this repo via
 * the GitHub API), normalizes it, and writes the final snapshot to
 * .cms-cache/content.json. Media remains as direct Object Storage or tracked
 * demo URLs; no build step downloads or transforms it.
 */
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { loadContentYaml } from "../lib/cms/content-yaml";
import { normalizeContentSet } from "../lib/cms/normalize";
import type { RawContentSet } from "../lib/cms/types";

const CONTENT_DIR = path.resolve(process.cwd(), "content");
const CACHE_DIR = path.resolve(process.cwd(), ".cms-cache");
const CACHE_FILE = path.join(CACHE_DIR, "content.json");

/** Reads every *.yml file in a content/ subfolder, tagging each with its filename as `_slug`. */
async function readCollection<T>(folder: string): Promise<(T & { _slug: string })[]> {
  const dir = path.join(CONTENT_DIR, folder);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf-8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const yamlEntries = entries.filter((entry) => entry.name.endsWith(".yml"));
  for (const entry of yamlEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`content/${path.join(folder, entry.name)} must be a regular file inside content/.`);
    }
  }
  const files = yamlEntries.map((entry) => entry.name).sort();
  return Promise.all(
    files.map(async (file) => {
      const raw = await readFile(path.join(dir, file), "utf-8");
      const doc = loadContentYaml(raw);
      // An empty or malformed file parses to `undefined`/a scalar, not an
      // object — spreading that below would silently produce a document with
      // only `_slug` set, which then surfaces as a confusing normalize.ts
      // error about some unrelated missing field. Name the actual file
      // instead, at the point where the real problem is.
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        throw new Error(`${path.join(folder, file)} did not parse to a YAML object — check its contents.`);
      }
      return { ...(doc as T), _slug: file.replace(/\.yml$/, "") };
    }),
  );
}

async function readSingleton<T>(file: string): Promise<T> {
  const filePath = path.join(CONTENT_DIR, file);
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`content/${file} must be a regular file inside content/.`);
  }
  const raw = await readFile(filePath, "utf-8");
  const doc = loadContentYaml(raw);
  // Same failure mode readCollection guards against: an empty/malformed file
  // parses to `undefined`, and without this check the first symptom is a
  // TypeError deep inside normalize.ts naming some unrelated field instead of
  // this file.
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error(`content/${file} did not parse to a YAML object — check its contents.`);
  }
  return doc as T;
}

async function loadContentSet(): Promise<RawContentSet> {
  const [siteSettings, tours, departures, reports, reviews, organizers, legalPages] = await Promise.all([
    readSingleton<RawContentSet["siteSettings"]>("site-settings.yml"),
    readCollection<RawContentSet["tours"][number]>("tours"),
    readCollection<RawContentSet["departures"][number]>("departures"),
    readCollection<RawContentSet["reports"][number]>("reports"),
    readCollection<RawContentSet["reviews"][number]>("reviews"),
    readCollection<RawContentSet["organizers"][number]>("organizers"),
    readCollection<RawContentSet["legalPages"][number]>("legal"),
  ]);

  return { siteSettings, tours, departures, reports, reviews, organizers, legalPages };
}

async function main() {
  console.log(`[sync-content] source: ${path.relative(process.cwd(), CONTENT_DIR)}/`);

  const raw = await loadContentSet();
  const snapshot = normalizeContentSet(raw, "git");

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(snapshot, null, 2), "utf-8");

  console.log(
    `[sync-content] wrote ${CACHE_FILE} — tours:${snapshot.tours.length} departures:${snapshot.departures.length} ` +
      `reports:${snapshot.reports.length} reviews:${snapshot.reviews.length} organizers:${snapshot.organizers.length} ` +
      `legalPages:${snapshot.legalPages.length}`,
  );
}

main().catch((error) => {
  console.error("[sync-content] failed:", error);
  process.exit(1);
});
