import type { ContentSnapshot, LegalPageDTO } from "./cms/types";

/**
 * Slugs a legalPage document must never take: app/[legalSlug]/ sits at the site
 * root, so a document claiming one of these would either shadow a real route or
 * collide with a build artifact in /out. Enforced twice — in the CMS, so the
 * editor finds out while typing (public/admin/config.yml's `slug` field `pattern`),
 * and in scripts/validate-content.ts, so a document written or hand-edited
 * outside the CMS can never reach a release.
 */
export const RESERVED_SLUGS = [
  "tours",
  "reports",
  "_next",
  "generated",
  "api",
  "index",
  "404",
  "robots.txt",
  "sitemap.xml",
  "icon.png",
  "apple-icon.png",
] as const;

/** A legalPage slug the router can actually serve: lowercase, URL-safe, no path separators. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Legal pages the site must not ship without, independent of which slugs are
 * *allowed*. The booking terms are referenced from the booking flow itself, so
 * a production release without them would link nowhere; everything else
 * (privacy policy, оферта, возврат) is optional and up to the owner.
 */
export const REQUIRED_LEGAL_SLUGS = ["booking-terms"] as const;

export function getLegalPageBySlug(content: ContentSnapshot, slug: string): LegalPageDTO | undefined {
  return content.legalPages.find((page) => page.slug === slug);
}

/** Footer/navigation order: required pages first, then the rest alphabetically by title. */
export function getLegalPagesSorted(content: ContentSnapshot): LegalPageDTO[] {
  const rank = (slug: string) => {
    const index = (REQUIRED_LEGAL_SLUGS as readonly string[]).indexOf(slug);
    return index === -1 ? REQUIRED_LEGAL_SLUGS.length : index;
  };
  return [...content.legalPages].sort(
    (a, b) => rank(a.slug) - rank(b.slug) || a.title.localeCompare(b.title, "ru"),
  );
}
