import type { MetadataRoute } from "next";

import { getContent } from "@/lib/cms/content";
import { getDocumentLastModified, getHomeLastModified, getTourLastModified } from "@/lib/last-modified";
import { resolveCanonicalBase } from "@/lib/site";
import { getListedTours, getTodayInTimezone } from "@/lib/tours";

export const dynamic = "force-static";

/**
 * Every indexable page, each with its own `lastmod` — see lib/last-modified.ts
 * for why that is never the build time. A report marked `noindex` is left out:
 * listing a URL the page itself asks not to index sends search engines
 * contradictory signals.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const content = getContent();
  const base = resolveCanonicalBase(content.siteSettings.siteUrl).replace(/\/$/, "");
  const today = getTodayInTimezone(content.siteSettings.timezone);

  const entries: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: getHomeLastModified(content, today), changeFrequency: "weekly", priority: 1 },
  ];

  for (const tour of getListedTours(content)) {
    entries.push({
      url: `${base}/tours/${tour.slug}/`,
      lastModified: getTourLastModified(content, tour, today),
      changeFrequency: "weekly",
      priority: 0.8,
    });
  }
  for (const report of content.reports.filter((r) => !r.noindex)) {
    entries.push({
      url: `${base}/reports/${report.slug}/`,
      lastModified: getDocumentLastModified(report, today),
      changeFrequency: "monthly",
      priority: 0.5,
    });
  }
  for (const page of content.legalPages) {
    entries.push({
      url: `${base}/${page.slug}/`,
      lastModified: getDocumentLastModified(page, today),
      changeFrequency: "yearly",
      priority: 0.3,
    });
  }

  return entries;
}
