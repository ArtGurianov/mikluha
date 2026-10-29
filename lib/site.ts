/**
 * How the site is built: `export` (static files behind Nginx, the current
 * production) or `ssr` (`next start` reading Commerce, TOUR-60). Inlined at
 * build by next.config.ts, so an image always runs the mode it was built in.
 */
export const isSsr = process.env.SITE_RENDERING === "ssr";

/** Build-time switch: a static export has no runtime, and next.config.ts inlines it into an SSR build. */
export const deployEnv = (process.env.DEPLOY_ENV === "staging" ? "staging" : "production") as
  | "production"
  | "staging";

export const isStaging = deployEnv === "staging";

/**
 * Canonical/OG base URL. On staging this MUST NOT be siteSettings.siteUrl
 * — an optional SITE_URL build env var can point it at the actual
 * staging host; otherwise it falls back to a reserved (RFC 2606) non-resolving
 * placeholder so canonical/OG tags never leak the production domain.
 */
export function resolveCanonicalBase(productionSiteUrl: string): string {
  if (!isStaging) return productionSiteUrl;
  return process.env.SITE_URL?.trim() || "https://staging.invalid";
}
