import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RawContentSet } from "./types";

export const FIXTURES_DIR = path.resolve(process.cwd(), "lib/cms/fixtures");
export const FIXTURES_ASSETS_DIR = path.join(FIXTURES_DIR, "assets");

/**
 * Reads the local mock content set — used for dev/build without live Sanity
 * credentials, and as the payload for scripts/seed-mock-content.ts.
 *
 * Unlike the live path (where TypeGen's module augmentation types
 * `client.fetch` against the real schema), these fixtures cannot be checked at
 * compile time: importing the JSON widens every string literal, so `_type`,
 * `bookingStatus` and the Portable Text `style`/`_type` discriminators never
 * satisfy the generated unions. What does cover them is normalizeContentSet —
 * both paths funnel through it, and its `required()` assertions fail
 * `npm run sync:cms` with the offending document named.
 */
export async function loadFixtureSet(): Promise<RawContentSet> {
  const read = async (file: string) => JSON.parse(await readFile(path.join(FIXTURES_DIR, file), "utf-8"));
  return {
    siteSettings: await read("siteSettings.json"),
    tours: await read("tours.json"),
    departures: await read("departures.json"),
    reports: await read("reports.json"),
    reviews: await read("reviews.json"),
    organizers: await read("organizers.json"),
    legalPages: await read("legalPages.json"),
  };
}
