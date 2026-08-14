import type { MetadataRoute } from "next";

import { getContent } from "@/lib/cms/content";
import { isStaging } from "@/lib/site";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  if (isStaging) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  const { siteUrl } = getContent().siteSettings;
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${siteUrl.replace(/\/$/, "")}/sitemap.xml`,
  };
}
