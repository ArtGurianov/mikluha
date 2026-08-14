import { createClient, type SanityClient } from "@sanity/client";

export interface SanityEnv {
  projectId: string;
  dataset: string;
  apiVersion: string;
  token?: string;
}

export function readSanityEnv(): SanityEnv | null {
  const projectId = process.env.SANITY_PROJECT_ID?.trim();
  const dataset = process.env.SANITY_DATASET?.trim();
  if (!projectId || !dataset) return null;

  return {
    projectId,
    dataset,
    apiVersion: process.env.SANITY_API_VERSION?.trim() || "2025-01-01",
    token: process.env.SANITY_API_TOKEN?.trim(),
  };
}

/** Live Sanity Content Lake client. Build-time only — never imported by the app itself. */
export function createSanityContentClient(env: SanityEnv): SanityClient {
  return createClient({
    projectId: env.projectId,
    dataset: env.dataset,
    apiVersion: env.apiVersion,
    token: env.token,
    useCdn: false,
    perspective: "published",
  });
}

export function sanityImageUrl(env: SanityEnv, assetRef: string): string {
  // asset _ref format: image-<id>-<width>x<height>-<format>
  const match = /^image-([a-zA-Z0-9]+)-(\d+)x(\d+)-(\w+)$/.exec(assetRef);
  if (!match) {
    throw new Error(`Unrecognized Sanity image asset ref: ${assetRef}`);
  }
  const [, id, , , format] = match;
  return `https://cdn.sanity.io/images/${env.projectId}/${env.dataset}/${id}.${format}`;
}
