import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    // CMS images are already materialized/optimized by the build pipeline
    // (scripts/materialize-assets.ts) — no runtime Image Optimization API.
    unoptimized: true,
  },
};

export default nextConfig;
