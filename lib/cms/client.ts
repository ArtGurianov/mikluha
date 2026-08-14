import { createClient, type SanityClient } from "@sanity/client";
import { createImageUrlBuilder } from "@sanity/image-url";

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

/** Original (unresized) source asset URL — materialize-assets.ts downloads once and resizes locally itself. */
export function sanityImageUrl(env: SanityEnv, assetRef: string): string {
  const builder = createImageUrlBuilder({ projectId: env.projectId, dataset: env.dataset });
  return builder.image({ asset: { _ref: assetRef } }).url();
}
