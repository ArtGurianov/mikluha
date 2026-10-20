import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

// A pure static export served by the Control Room's own Nginx (nginx.conf.template). No server, no
// rewrites, no environment: everything dynamic is a same-origin call to /api/, which that Nginx
// proxies to the isolated Admin API and nowhere else.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  // Its own package inside the site's repository: never resolve the site's lockfile or PostCSS config.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
};

export default nextConfig;
