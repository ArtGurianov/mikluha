#!/usr/bin/env tsx
/**
 * Idempotent dev-only import of the mock/demo content set
 * into a REAL Sanity dataset, for testing the Studio + content model against
 * something other than production. NOT part of the production build pipeline
 * and NEVER runs automatically.
 *
 * Usage:
 *   SANITY_PROJECT_ID=... SANITY_DATASET=staging SANITY_API_TOKEN=... npm run seed:mock
 *
 * Refuses to run against a dataset that doesn't look like a dev/staging/test
 * dataset unless --allow-production is passed explicitly.
 */
import "dotenv/config";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { createSanityContentClient, readSanityEnv } from "../lib/cms/client";
import { FIXTURES_ASSETS_DIR, loadFixtureSet } from "../lib/cms/loadFixtures";
import type { RawDocument, RawImageRef } from "../lib/cms/types";

const ALLOW_PRODUCTION = process.argv.includes("--allow-production");
const LOCAL_REF_PREFIX = "local:";

/** Narrows to an image that actually carries an asset ref — the only kind this script rewrites. */
function isImageRef(node: unknown): node is RawImageRef & { asset: { _ref: string } } {
  return (
    !!node &&
    typeof node === "object" &&
    (node as RawImageRef)._type === "image" &&
    typeof (node as RawImageRef).asset?._ref === "string"
  );
}

function collectLocalImageRefs(node: unknown, refs: Set<string>) {
  if (Array.isArray(node)) {
    node.forEach((item) => collectLocalImageRefs(item, refs));
    return;
  }
  if (node && typeof node === "object") {
    if (isImageRef(node) && node.asset._ref.startsWith(LOCAL_REF_PREFIX)) {
      refs.add(node.asset._ref.slice(LOCAL_REF_PREFIX.length));
      return;
    }
    for (const value of Object.values(node)) collectLocalImageRefs(value, refs);
  }
}

function rewriteLocalImageRefs(node: unknown, assetIdByFilename: Map<string, string>) {
  if (Array.isArray(node)) {
    node.forEach((item) => rewriteLocalImageRefs(item, assetIdByFilename));
    return;
  }
  if (node && typeof node === "object") {
    if (isImageRef(node) && node.asset._ref.startsWith(LOCAL_REF_PREFIX)) {
      const filename = node.asset._ref.slice(LOCAL_REF_PREFIX.length);
      const assetId = assetIdByFilename.get(filename);
      if (!assetId) throw new Error(`No uploaded asset found for fixture image "${filename}"`);
      node.asset._ref = assetId;
      return;
    }
    for (const value of Object.values(node)) rewriteLocalImageRefs(value, assetIdByFilename);
  }
}

async function main() {
  const env = readSanityEnv();
  if (!env) {
    throw new Error("SANITY_PROJECT_ID and SANITY_DATASET must be set to seed mock content.");
  }
  if (!env.token) {
    throw new Error("SANITY_API_TOKEN (a write token) must be set to seed mock content.");
  }

  const looksSafe = /dev|staging|test|sandbox/i.test(env.dataset);
  if (!looksSafe && !ALLOW_PRODUCTION) {
    throw new Error(
      `Refusing to seed mock/demo content into dataset "${env.dataset}" — it doesn't look like a dev/staging dataset. ` +
        `Pass --allow-production if you really mean to do this.`,
    );
  }

  const client = createSanityContentClient(env);
  const fixtures = await loadFixtureSet();

  const documents: RawDocument[] = [
    fixtures.siteSettings,
    ...fixtures.tours,
    ...fixtures.departures,
    ...fixtures.reports,
    ...fixtures.reviews,
    ...fixtures.organizers,
    ...fixtures.legalPages,
  ];

  const localFilenames = new Set<string>();
  for (const doc of documents) collectLocalImageRefs(doc, localFilenames);

  console.log(`[seed-mock] uploading ${localFilenames.size} fixture image asset(s) to ${env.projectId}/${env.dataset}...`);
  const assetIdByFilename = new Map<string, string>();
  for (const filename of localFilenames) {
    const buffer = await readFile(path.join(FIXTURES_ASSETS_DIR, filename));
    const asset = await client.assets.upload("image", buffer, { filename });
    assetIdByFilename.set(filename, asset._id);
  }

  for (const doc of documents) rewriteLocalImageRefs(doc, assetIdByFilename);

  console.log(`[seed-mock] upserting ${documents.length} document(s)...`);
  for (const doc of documents) {
    await client.createOrReplace(doc as unknown as Record<string, unknown> & { _id: string; _type: string });
    console.log(` - ${doc._type}/${doc._id}`);
  }

  console.log("[seed-mock] done. Remember: every seeded document has isDemo=true where applicable — replace before launch.");
}

main().catch((error) => {
  console.error("[seed-mock] failed:", error);
  process.exit(1);
});
