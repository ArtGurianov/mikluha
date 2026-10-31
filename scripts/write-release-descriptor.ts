#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { makeSiteReleaseDescriptor } from "../lib/release-descriptor";

async function main() {
  const root = process.cwd();
  const descriptor = makeSiteReleaseDescriptor(process.env.SOURCE_COMMIT ?? "");
  await mkdir(path.join(root, "public"), { recursive: true });
  await writeFile(path.join(root, "public", "release.json"), `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", mode: 0o444 });
  console.log(`[release] wrote immutable descriptor for ${descriptor.sourceCommit}`);
}

main().catch((error) => {
  console.error('[release] failed:', error);
  process.exit(1);
});
