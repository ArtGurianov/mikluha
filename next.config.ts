import type { NextConfig } from "next";

/** Security headers for every SSR response. */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  trailingSlash: true,
  poweredByHeader: false,
  env: {
    DEPLOY_ENV: process.env.DEPLOY_ENV === "staging" ? "staging" : "production",
    SITE_URL: process.env.SITE_URL ?? "",
  },
  // The release read-back (ADR v2.3 §8): the build-baked descriptor, never a runtime env
  // (Coolify sets SOURCE_COMMIT=HEAD in the container).
  // beforeFiles: ahead of the root-level legal route, which would otherwise claim the path.
  async rewrites() {
    return { beforeFiles: [{ source: "/identity", destination: "/release.json" }], afterFiles: [], fallback: [] };
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
