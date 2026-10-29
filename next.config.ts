import type { NextConfig } from "next";

/**
 * SITE_RENDERING picks the build (lib/site.ts):
 *   export (default)  static files for Nginx — the production release until the
 *                     owner-authorized SSR hard cut (TOUR-67); Dockerfile.
 *   ssr               `next start` (standalone) reading Commerce on every
 *                     request (ADR v2.3 §2, TOUR-60); Dockerfile.ssr.
 * Mode, DEPLOY_ENV and SITE_URL are inlined, so an SSR image behaves as it was
 * built whatever the runtime environment says. Only the Commerce address and
 * the media delivery switch are read at request time.
 */
const ssr = process.env.SITE_RENDERING === "ssr";

/** What nginx.conf sends for every static response, kept for SSR. */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
];

const nextConfig: NextConfig = ssr
  ? {
      output: "standalone",
      trailingSlash: true,
      poweredByHeader: false,
      env: {
        SITE_RENDERING: "ssr",
        DEPLOY_ENV: process.env.DEPLOY_ENV === "staging" ? "staging" : "production",
        SITE_URL: process.env.SITE_URL ?? "",
      },
      // The release read-back (ADR v2.3 §8): the build-baked descriptor, never a runtime env
      // (Coolify sets SOURCE_COMMIT=HEAD in the container).
      async rewrites() {
        return [{ source: "/identity", destination: "/release.json" }];
      },
      async headers() {
        return [{ source: "/:path*", headers: securityHeaders }];
      },
    }
  : {
      output: "export",
      trailingSlash: true,
      env: { SITE_RENDERING: "export" },
    };

export default nextConfig;
