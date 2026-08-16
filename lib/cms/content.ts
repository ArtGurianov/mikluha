import fs from "node:fs";
import path from "node:path";

import type { ContentSnapshot } from "./types";

const CACHE_PATH = path.join(process.cwd(), ".cms-cache", "content.json");

function loadSnapshot(): ContentSnapshot {
  if (!fs.existsSync(CACHE_PATH)) {
    throw new Error(
      "CMS content cache not found (.cms-cache/content.json). Run `pnpm run sync:content && pnpm run materialize:assets` first " +
        "(this happens automatically before `pnpm dev`, and is part of `pnpm run build:production`).",
    );
  }
  const raw = fs.readFileSync(CACHE_PATH, "utf-8");
  return JSON.parse(raw) as ContentSnapshot;
}

let cached: ContentSnapshot | null = null;

/** Full normalized content snapshot, read once per build/process from the local CMS cache. */
export function getContent(): ContentSnapshot {
  if (!cached) {
    cached = loadSnapshot();
  }
  return cached;
}
