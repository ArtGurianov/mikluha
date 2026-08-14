/** Build-time-only environment switch (PRD section 44) — no runtime env access, static export has no server. */
export const deployEnv = (process.env.DEPLOY_ENV === "staging" ? "staging" : "production") as
  | "production"
  | "staging";

export const isStaging = deployEnv === "staging";

/**
 * Canonical/OG base URL. On staging this MUST NOT be siteSettings.siteUrl
 * (PRD §44) — an optional SITE_URL build env var can point it at the actual
 * staging host; otherwise it falls back to a reserved (RFC 2606) non-resolving
 * placeholder so canonical/OG tags never leak the production domain.
 */
export function resolveCanonicalBase(productionSiteUrl: string): string {
  if (!isStaging) return productionSiteUrl;
  return process.env.SITE_URL?.trim() || "https://staging.invalid";
}
