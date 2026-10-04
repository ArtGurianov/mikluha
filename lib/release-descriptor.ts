import { createHash } from "node:crypto";

import type { LegalPageDTO } from "./cms/types";

export const SOURCE_COMMIT_RE = /^[0-9a-f]{40}$/;

export interface SiteReleaseDescriptor {
  readonly schema: 1;
  readonly service: "mikluha-site";
  readonly sourceCommit: string;
  readonly termsRef: string;
  readonly termsHash: string;
  readonly pdConsentRef: string;
  readonly pdConsentHash: string;
}

const legalIdentity = (page: LegalPageDTO, name: string) => {
  if (!page.updatedAt) throw new Error(`RELEASE_LEGAL_VERSION_MISSING: ${name}`);
  return {
    ref: `${page.slug}@${page.updatedAt}`,
    hash: `sha256:${createHash("sha256").update(page.content, "utf8").digest("hex")}`,
  };
};

export function makeSiteReleaseDescriptor(
  sourceCommit: string,
  legalPages: readonly LegalPageDTO[],
): SiteReleaseDescriptor {
  if (!SOURCE_COMMIT_RE.test(sourceCommit)) throw new Error("RELEASE_SOURCE_COMMIT_INVALID");
  const termsPage = legalPages.find((page) => page.slug === "oferta");
  const consentPage = legalPages.find((page) => page.slug === "soglasie-pd");
  if (!termsPage || !consentPage) throw new Error("RELEASE_LEGAL_ARTIFACT_MISSING");
  const terms = legalIdentity(termsPage, "oferta");
  const consent = legalIdentity(consentPage, "soglasie-pd");
  return {
    schema: 1,
    service: "mikluha-site",
    sourceCommit,
    termsRef: terms.ref,
    termsHash: terms.hash,
    pdConsentRef: consent.ref,
    pdConsentHash: consent.hash,
  };
}

export function parseSiteReleaseDescriptor(value: unknown): SiteReleaseDescriptor {
  const v = value as Partial<SiteReleaseDescriptor> | null;
  if (v === null || typeof v !== "object" || v.schema !== 1 || v.service !== "mikluha-site"
    || typeof v.sourceCommit !== "string" || !SOURCE_COMMIT_RE.test(v.sourceCommit)
    || typeof v.termsRef !== "string" || typeof v.termsHash !== "string"
    || typeof v.pdConsentRef !== "string" || typeof v.pdConsentHash !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(v.termsHash)
    || !/^sha256:[0-9a-f]{64}$/.test(v.pdConsentHash)) {
    throw new Error("RELEASE_DESCRIPTOR_INVALID");
  }
  return v as SiteReleaseDescriptor;
}
