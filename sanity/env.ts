export const projectId =
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ?? process.env.SANITY_PROJECT_ID ?? "";

export const dataset =
  process.env.NEXT_PUBLIC_SANITY_DATASET ?? process.env.SANITY_DATASET ?? "production";

export const apiVersion =
  process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? process.env.SANITY_API_VERSION ?? "2025-01-01";
