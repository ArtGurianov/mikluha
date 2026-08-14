import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    // CMS images are already materialized into 5 fixed-width local WEBP
    // variants by the build pipeline (scripts/materialize-assets.ts). This
    // custom loader maps next/image's requested width to the nearest
    // variant, restoring real srcset/sizes without any runtime Image
    // Optimization API or remote origin — see lib/image-loader.ts.
    loader: "custom",
    loaderFile: "./lib/image-loader.ts",
    // Match exactly the 5 widths materialize-assets.ts actually generates, so
    // next/image never asks the loader for a width we don't have a real file
    // for (Next's own defaults go up to 3840px). imageSizes must stay empty:
    // Next builds its candidate-width list as [...deviceSizes, ...imageSizes]
    // with no de-duping, so setting both to the same array doubles every
    // srcset entry.
    deviceSizes: [400, 800, 1400, 2200, 2600],
    imageSizes: [],
  },
};

export default nextConfig;
