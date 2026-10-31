export const SOURCE_COMMIT_RE = /^[0-9a-f]{40}$/;

/** Immutable code identity. Legal identity is mutable, owned by Commerce public_legal. */
export interface SiteReleaseDescriptor {
  readonly schema: 2;
  readonly service: "mikluha-site";
  readonly sourceCommit: string;
  readonly legalAuthority: "commerce";
}

export function makeSiteReleaseDescriptor(sourceCommit: string): SiteReleaseDescriptor {
  if (!SOURCE_COMMIT_RE.test(sourceCommit)) throw new Error("RELEASE_SOURCE_COMMIT_INVALID");
  return { schema: 2, service: "mikluha-site", sourceCommit, legalAuthority: "commerce" };
}

export function parseSiteReleaseDescriptor(value: unknown): SiteReleaseDescriptor {
  const v = value as Partial<SiteReleaseDescriptor> | null;
  if (v === null || typeof v !== "object" || v.schema !== 2 || v.service !== "mikluha-site"
    || typeof v.sourceCommit !== "string" || !SOURCE_COMMIT_RE.test(v.sourceCommit) || v.legalAuthority !== "commerce") {
    throw new Error("RELEASE_DESCRIPTOR_INVALID");
  }
  return v as SiteReleaseDescriptor;
}
