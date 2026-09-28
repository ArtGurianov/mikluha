/**
 * SEO invariants of the exported site, checked by scripts/validate-static-export.ts
 * against the real /out files. Pure functions over HTML strings, so the rules
 * are unit-tested without a build.
 *
 * The HTML is Next's own static output, not arbitrary markup, which is why a
 * handful of regular expressions is enough here instead of an HTML parser.
 */

export interface PageSeo {
  titles: string[];
  descriptions: string[];
  robots: string[];
  canonicals: string[];
  h1Count: number;
  jsonLd: string[];
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

function decode(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity]);
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [, name, value] of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) result[name.toLowerCase()] = decode(value);
  return result;
}

export function extractPageSeo(html: string): PageSeo {
  const seo: PageSeo = { titles: [], descriptions: [], robots: [], canonicals: [], h1Count: 0, jsonLd: [] };

  for (const [, title] of html.matchAll(/<title>([^<]*)<\/title>/g)) seo.titles.push(decode(title).trim());
  for (const [tag] of html.matchAll(/<meta\s[^>]*>/g)) {
    const attrs = attributes(tag);
    if (attrs.name === "description") seo.descriptions.push(attrs.content?.trim() ?? "");
    if (attrs.name === "robots") seo.robots.push(attrs.content?.toLowerCase() ?? "");
  }
  for (const [tag] of html.matchAll(/<link\s[^>]*>/g)) {
    const attrs = attributes(tag);
    if (attrs.rel === "canonical") seo.canonicals.push(attrs.href ?? "");
  }
  seo.h1Count = html.match(/<h1[\s>]/g)?.length ?? 0;
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) seo.jsonLd.push(json);

  return seo;
}

/** Every `@type` in a JSON-LD document, however nested (arrays, `@graph`, sub-objects). */
export function jsonLdTypes(value: unknown, types: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) jsonLdTypes(item, types);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "@type") types.push(...(Array.isArray(item) ? item : [item]).map(String));
      else jsonLdTypes(item, types);
    }
  }
  return types;
}

export function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(([, loc]) => decode(loc.trim()));
}

export interface SiteAuditInput {
  /** Exported pages by URL path ("/", "/tours/altai/"), excluding the 404 artifacts. */
  pages: Map<string, string>;
  /** 404.html and its route copies — must never be indexable. */
  notFoundPages: Map<string, string>;
  robotsTxt: string;
  sitemapXml: string;
  /** siteSettings.siteUrl — the production origin. */
  siteUrl: string;
  /** What canonicals are built from (siteUrl in production, SITE_URL or staging.invalid on staging). */
  canonicalBase: string;
  isStaging: boolean;
  /** Pages the content deliberately keeps out of the index (report `noindex`). */
  noindexPaths: Set<string>;
}

export interface AuditResult {
  errors: string[];
  warnings: string[];
}

const needsBreadcrumbs = (path: string) => /^\/(?:tours|reports)\/[^/]+\/$/.test(path);

export function auditSite(input: SiteAuditInput): AuditResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const base = input.canonicalBase.replace(/\/$/, "");
  const productionBase = input.siteUrl.replace(/\/$/, "");
  const titleOwners = new Map<string, string>();

  for (const [path, html] of input.pages) {
    const seo = extractPageSeo(html);
    const where = `page ${path}`;

    if (seo.titles.length !== 1 || !seo.titles[0]) {
      errors.push(`${where} must have exactly one non-empty <title> (found ${seo.titles.length})`);
    }
    if (seo.descriptions.length !== 1 || !seo.descriptions[0]) {
      errors.push(`${where} must have exactly one non-empty meta description (found ${seo.descriptions.length})`);
    }
    if (seo.h1Count !== 1) errors.push(`${where} must have exactly one <h1> (found ${seo.h1Count})`);

    const expectedCanonical = `${base}${path}`;
    if (seo.canonicals.length !== 1 || seo.canonicals[0] !== expectedCanonical) {
      errors.push(
        `${where} must have exactly one self-referencing canonical ${expectedCanonical} ` +
          `(found ${seo.canonicals.length ? seo.canonicals.join(", ") : "none"})`,
      );
    }

    const robots = seo.robots.join(", ");
    if (input.isStaging) {
      if (!robots.includes("noindex") || !robots.includes("nofollow")) {
        errors.push(`${where} is a staging page without noindex, nofollow — it could leak into search results`);
      }
    } else if (input.noindexPaths.has(path)) {
      if (!robots.includes("noindex")) errors.push(`${where} is marked noindex in the CMS but the page is indexable`);
      if (robots.includes("nofollow")) errors.push(`${where} is noindex by choice and must stay "follow" (links to tours)`);
    } else if (robots.includes("noindex") || robots.includes("nofollow")) {
      errors.push(`${where} is a public production page but carries robots "${robots}"`);
    }

    // Checked on staging too, against what *would* be indexed in production.
    const title = seo.titles[0];
    if (title && !input.noindexPaths.has(path)) {
      if (titleOwners.has(title)) errors.push(`${where} duplicates the <title> of ${titleOwners.get(title)}: "${title}"`);
      else titleOwners.set(title, path);
    }

    const types: string[] = [];
    for (const json of seo.jsonLd) {
      try {
        jsonLdTypes(JSON.parse(json), types);
      } catch (error) {
        errors.push(`${where} has malformed JSON-LD: ${(error as Error).message}`);
      }
    }
    if (types.includes("Event")) {
      errors.push(`${where} marks something up as an Event — Google's Event guidelines exclude trip packages`);
    }
    if (needsBreadcrumbs(path) && !types.includes("BreadcrumbList")) {
      errors.push(`${where} has no BreadcrumbList JSON-LD`);
    }
  }

  for (const [path, html] of input.notFoundPages) {
    if (!extractPageSeo(html).robots.join(", ").includes("noindex")) {
      errors.push(`not-found page ${path} is missing noindex`);
    }
  }

  const disallowsAll = /^\s*disallow:\s*\/\s*$/im.test(input.robotsTxt);
  if (input.isStaging) {
    if (!disallowsAll) errors.push("staging robots.txt must be Disallow: / for every user agent");
    if (new URL(input.canonicalBase).origin === new URL(input.siteUrl).origin) {
      warnings.push(
        `this staging build targets the production domain ${input.siteUrl} (SITE_URL): every page is noindex, ` +
          `robots.txt is Disallow: /, and the public site will drop out of search. Publish production builds there ` +
          `(DEPLOY_ENV=production once siteSettings.launchReady is on).`,
      );
    }
  } else {
    if (disallowsAll) errors.push("production robots.txt blocks the whole site (Disallow: /)");
    const sitemapLine = `sitemap: ${productionBase}/sitemap.xml`;
    if (!input.robotsTxt.toLowerCase().split("\n").some((line) => line.trim() === sitemapLine.toLowerCase())) {
      errors.push(`production robots.txt must reference ${productionBase}/sitemap.xml`);
    }
  }

  const locs = parseSitemapLocs(input.sitemapXml);
  const listed = new Set<string>();
  for (const loc of locs) {
    if (!loc.startsWith(`${base}/`)) {
      errors.push(`sitemap URL ${loc} is not on the canonical origin ${base}`);
      continue;
    }
    const path = loc.slice(base.length);
    if (listed.has(path)) errors.push(`sitemap lists ${loc} more than once`);
    listed.add(path);
    if (!input.pages.has(path)) errors.push(`sitemap URL ${loc} has no exported page`);
    else if (input.noindexPaths.has(path)) errors.push(`sitemap lists ${loc}, which is noindex`);
  }
  for (const path of input.pages.keys()) {
    if (!input.noindexPaths.has(path) && !listed.has(path)) errors.push(`indexable page ${path} is missing from sitemap.xml`);
  }

  return { errors, warnings };
}
