import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RawContentSet } from "./types";

export const FIXTURES_DIR = path.resolve(process.cwd(), "lib/cms/fixtures");
export const FIXTURES_ASSETS_DIR = path.join(FIXTURES_DIR, "assets");

/** Reads the local mock content set — used for dev/build without live Sanity credentials, and as the payload for scripts/seed-mock-content.ts. */
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
