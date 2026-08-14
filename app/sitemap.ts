import type { MetadataRoute } from "next";

import { getContent } from "@/lib/cms/content";
import { getListedTours } from "@/lib/tours";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const content = getContent();
  const base = content.siteSettings.siteUrl.replace(/\/$/, "");

  const entries: MetadataRoute.Sitemap = [{ url: `${base}/`, changeFrequency: "weekly", priority: 1 }];

  for (const tour of getListedTours(content)) {
    entries.push({ url: `${base}/tours/${tour.slug}/`, changeFrequency: "weekly", priority: 0.8 });
  }
  for (const report of content.reports) {
    entries.push({ url: `${base}/reports/${report.slug}/`, changeFrequency: "monthly", priority: 0.5 });
  }
  for (const page of content.legalPages) {
    entries.push({ url: `${base}/${page.slug}/`, changeFrequency: "yearly", priority: 0.3 });
  }

  return entries;
}
