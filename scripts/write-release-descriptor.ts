#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ContentSnapshot } from "../lib/cms/types";
import { makeSiteReleaseDescriptor } from "../lib/release-descriptor";

async function main() {
  const root = process.cwd();
  const snapshot = JSON.parse(await readFile(path.join(root, ".cms-cache", "content.json"), "utf8")) as ContentSnapshot;
  const descriptor = makeSiteReleaseDescriptor(process.env.SOURCE_COMMIT ?? "", snapshot.legalPages);
  await mkdir(path.join(root, "public"), { recursive: true });
  await writeFile(path.join(root, "public", "release.json"), `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", mode: 0o444 });
  console.log(`[release] wrote immutable descriptor for ${descriptor.sourceCommit}`);
}

main().catch((error) => {
  console.error('[release] failed:', error);
  process.exit(1);
});
